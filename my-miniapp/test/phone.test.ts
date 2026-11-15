/**
 * Runs the BUILT app (dist/background/index.js, the exact file the phone
 * loads) against a simulated phone.
 *
 * The app runs in an empty JavaScript sandbox that has only what Mentra's
 * background engine has: console, timers, fetch, and the bridge to the phone.
 * The simulated phone answers the bridge the way the Mentra App does:
 * it "takes" photos, "speaks", stores values, and sends speech, button and
 * screen events. Claude is faked too.
 *
 * WHAT THIS PROVES
 *   The real Coach, the real Brain, the Mentra SDK inside the bundle, and the
 *   wiring in index.ts work together: a lesson is recorded, built, reviewed,
 *   published, learned, checked from a photo, and a question is answered.
 *
 * WHAT IT DOES NOT PROVE
 *   That real glasses behave like the fake, or that the real Claude API
 *   accepts these requests. scripts/real-claude-test.ts covers the second.
 *
 * The message format between the SDK and the phone is written down in docs/TESTING.md.
 */

import {beforeAll, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import vm from "node:vm"

const ROOT = join(import.meta.dir, "..")
const KEY = "sk-ant-test-key-9876"

interface Sent {
  type: string
  requestId?: string
  [field: string]: unknown
}

const sent: Sent[] = [] // everything the app sent to the phone
const spoken: string[] = []
const storage = new Map<string, string>()
const claudeCalls: any[] = []
let photos = 0
let sandbox: any

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until `check` returns something truthy. */
async function until<T>(what: string, check: () => T | undefined | false | null): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = check()
    if (value) return value
    await sleep(10)
  }
  throw new Error(`Timed out waiting for ${what}. The glasses said: ${JSON.stringify(spoken.slice(-4))}`)
}

/** Phone to app. */
function deliver(payload: Record<string, unknown>, requestId?: string): void {
  sandbox.__mentraDeliverBridgeRaw(JSON.stringify(requestId ? {payload, requestId} : {payload}))
}

function event(streamType: string, data: unknown): void {
  deliver({type: "miniapp_event", streamType, data})
}

/** The phone's answer to one request from the app. */
function answer(payload: Sent): unknown {
  switch (payload.type) {
    case "miniapp_storage_get":
      return {value: storage.get(payload.key as string) ?? null}
    case "miniapp_storage_set":
      storage.set(payload.key as string, payload.value as string)
      return null
    case "miniapp_storage_delete":
      storage.delete(payload.key as string)
      return null
    case "miniapp_speak":
      spoken.push(payload.text as string)
      return {completed: true}
    case "miniapp_photo":
      photos += 1
      return {requestId: `photo-${photos}`, photoUrl: `https://photos.example/p${photos}.jpg`, mimeType: "image/jpeg", size: 1234}
    case "miniapp_blob_set_from_url":
      return {key: payload.key, mimeType: "image/jpeg", size: 1234, createdAt: 1, updatedAt: 1, uri: "file:///blob"}
    case "miniapp_rgb_led":
      return {type: "rgb_led_control_response", state: "success", requestId: payload.requestId}
    default:
      return null
  }
}

/** App to phone. Mentra's SDK calls this for every message. */
function dispatch(iface: string, method: string, argsJson: string): null {
  if (iface !== "__bridge" || method !== "send") return null
  const [raw] = JSON.parse(argsJson) as [string]
  const envelope = JSON.parse(raw) as {payload: Sent; requestId?: string}
  // A request carries its id on the envelope. A reply to the phone screen carries it inside the payload.
  const payload = {...envelope.payload, requestId: envelope.requestId ?? envelope.payload.requestId}
  sent.push(payload)

  if (payload.type === "miniapp_connect") {
    queueMicrotask(() =>
      deliver({
        type: "miniapp_connect_ack",
        userId: "test-user",
        packageName: "com.mentra.tinker",
        capabilities: {hasCamera: true},
        visibility: "foreground",
        colorScheme: "light",
        permissions: {camera: true, microphone: true},
      }),
    )
  } else if (envelope.requestId) {
    const requestId = envelope.requestId
    queueMicrotask(() => deliver({type: "miniapp_request_result", ok: true, data: answer(payload)}, requestId))
  }
  return null
}

/** A stand-in for the Claude API. It tells the four kinds of request apart the way claude.ts builds them. */
async function fakeFetch(url: string, init: any): Promise<Response> {
  if (url !== "https://api.anthropic.com/v1/messages") throw new Error(`Unexpected request to ${url}`)
  const body = JSON.parse(init.body)
  claudeCalls.push({body, headers: init.headers})
  const text = (value: string) => new Response(JSON.stringify({content: [{type: "text", text: value}], stop_reason: "end_turn"}))
  const json = (value: unknown) => text(JSON.stringify(value))

  if (init.headers["x-api-key"] !== KEY) return new Response(JSON.stringify({error: {message: "invalid x-api-key"}}), {status: 401})
  if (body.max_tokens === 1) return text("h") // the key test
  if (body.model === "claude-sonnet-5-5") {
    return json({
      title: "Making matcha",
      description: "Sift matcha powder into a bowl.",
      category: "Tea",
      estimated_duration_minutes: 3,
      tools_required: ["bowl", "sifter"],
      ingredients_required: ["matcha powder"],
      steps: [
        {
          title: "Sift the matcha",
          instruction_spoken: "Sift two scoops of matcha into the bowl.",
          instruction_detailed: "Sifting removes lumps.",
          tips: [],
          done_looks_like: "Green powder in the bowl with no lumps.",
          common_mistake: "Skipping the sifter.",
          story: "",
          source_capture: 1,
        },
      ],
    })
  }
  if (body.output_config) return json({result: "pass", say: "Nice work."}) // a photo check
  return text("About eighty degrees Celsius, so let boiled water cool for two minutes.") // a question
}

/** Messages the app sent to the phone screen on one channel. */
function screen(channel: string): any[] {
  return sent.filter((p) => p.type === "UI_SEND" && p.channel === channel).map((p) => p.payload)
}

function last(channel: string): any {
  return screen(channel).at(-1)
}

/** A plain message from the phone screen. */
let seq = 0
function fromScreen(channel: string, payload: unknown): void {
  event("_ui", {type: "UI_MESSAGE", channel, payload, seq: ++seq})
}

/** A request from the phone screen that expects an answer. */
async function ask(channel: string, payload: unknown): Promise<any> {
  const requestId = `rpc-${++seq}`
  event("_ui", {type: "UI_MESSAGE", channel, payload, seq, requestId})
  const reply = await until(`the answer to ${channel}`, () => sent.find((p) => p.type === "UI_SEND" && p.requestId === requestId))
  // The SDK wraps a handler's return value: {ok: true, result} or {ok: false, error}.
  const wrapped = reply.payload as {ok: boolean; result?: unknown; error?: {message?: string}}
  if (!wrapped.ok) throw new Error(`The app's handler for ${channel} failed: ${wrapped.error?.message}`)
  return wrapped.result
}

/** Say one finished sentence into the glasses, after the app's quiet gap. */
async function sayToGlasses(text: string): Promise<void> {
  await sleep(900)
  event("transcription:en-US", {text, isFinal: true})
}

beforeAll(() => {
  const build = Bun.spawnSync(["bun", "run", "build"], {cwd: ROOT})
  if (build.exitCode !== 0) throw new Error(`Build failed:\n${build.stderr.toString()}\n${build.stdout.toString()}`)

  // Only what Mentra's docs list for the background engine. No window, document, process or require.
  sandbox = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    AbortController,
    AbortSignal,
    crypto: {getRandomValues: (array: Uint8Array) => crypto.getRandomValues(array), randomUUID: () => crypto.randomUUID()},
    fetch: fakeFetch,
    __dispatch: dispatch,
  })
  vm.runInContext(readFileSync(join(ROOT, "dist/background/index.js"), "utf8"), sandbox)
  sandbox.__mentraInitCallback("session-1")
})

test("the built app records, builds, publishes, teaches and answers on a simulated phone", async () => {
  // ---- start-up: the app connects and reads its saved key and lessons
  await until("the app to read storage", () => sent.filter((p) => p.type === "miniapp_storage_get").length >= 2)

  // ---- the phone screen opens and gets the whole picture in one message
  event("_ui", {type: "UI_OPEN"})
  const first = await until("the first snapshot", () => last("snapshot"))
  expect(first.connection.claudeReady).toBe(false)
  expect(first.tutorials).toHaveLength(1)
  expect(first.tutorials[0].built_in).toBe(true)
  expect(first.teaching.status).toBe("idle")
  expect(first.learning).toBeNull()
  expect((await ask("getSnapshot", {})).tutorials[0].id).toBe("tut_matcha_ceremonial_01")

  // ---- the glasses connect
  event("glasses_connection", {connected: true, modelName: "Mentra Live"})
  const connected = await until("the connection status", () => screen("connectionStatus").find((s) => s.glassesConnected))
  expect(connected.hasCamera).toBe(true)

  // ---- the key is pasted on the phone screen and tested
  expect(await ask("setKey", {key: "sk-ant-wrong"})).toMatchObject({ok: false})
  expect(await ask("setKey", {key: KEY})).toEqual({ok: true, error: ""})
  expect(storage.get("claudeKey")).toBe(KEY)
  expect(last("connectionStatus")).toMatchObject({claudeReady: true, keyHint: "9876"})

  // ---- TEACH: started from the screen, narrated by voice
  fromScreen("startTeaching", {targetSkill: "making matcha"})
  await until("the recording intro", () => spoken.some((s) => s.startsWith("Recording.")))
  expect(last("teachingState").status).toBe("recording")

  await sayToGlasses("First I sift two scoops of matcha into the bowl. Next step.")
  await until("step 1 to be saved", () => spoken.includes("Step 1 saved."))
  const photoRequest = sent.find((p) => p.type === "miniapp_photo")!
  expect(photoRequest).toMatchObject({size: "medium", compress: "medium", sound: true})
  expect(sent.some((p) => p.type === "miniapp_blob_set_from_url" && p.url === "https://photos.example/p1.jpg")).toBe(true)
  expect(last("photoCapture")).toMatchObject({photoUrl: "https://photos.example/p1.jpg", kind: "step"})
  expect(last("teachingState")).toMatchObject({status: "recording", stepCount: 1, frameCount: 1})
  // index.ts ticks the Coach once per second, so the recording clock on the screen moves.
  await until("the recording clock to move", () => screen("teachingState").some((s) => s.elapsedSeconds >= 1))

  await sayToGlasses("Finish lesson.")
  const generated = await until("the lesson to be built", () => last("tutorialGenerated"))
  expect(generated.status).toBe("success")
  expect(generated.tutorial).toMatchObject({title: "Making matcha", status: "draft", total_steps: 1})
  expect(generated.tutorial.steps[0]).toMatchObject({
    step_number: 1,
    instruction_spoken: "Sift two scoops of matcha into the bowl.",
    reference_image_url: "https://photos.example/p1.jpg",
  })
  await until("the review prompt", () => spoken.some((s) => s.startsWith("Lesson ready. Making matcha. It has 1 step.")))
  expect(spoken).toContain("Building the lesson.")
  expect(last("teachingState").status).toBe("review")

  // What Claude was really asked: the right model, thinking switched off the way that model needs,
  // the expert's own words, and the photo as a fresh link.
  const plan = claudeCalls.find((c) => c.body.model === "claude-sonnet-5-5")
  expect(plan.headers["anthropic-version"]).toBe("2023-06-01")
  expect(plan.body.thinking).toEqual({type: "between_tools"})
  expect(plan.body.messages[0].content[0].text).toContain('The expert said: "First I sift two scoops of matcha into the bowl."')
  expect(plan.body.messages[0].content[1]).toEqual({type: "image", source: {type: "url", url: "https://photos.example/p1.jpg"}})
  expect(JSON.stringify(plan.body.messages[0].content.at(-1))).toContain("making matcha")

  // ---- REVIEW: the expert edits the title on the phone and publishes
  fromScreen("publishTutorial", {tutorial: {...generated.tutorial, title: "My matcha"}})
  await until("the lesson to be published", () => spoken.includes("Lesson published."))
  const library = last("tutorialList").tutorials
  expect(library.map((t: any) => t.title)).toEqual(["My matcha", "How to Make Matcha: Traditional Ceremonial Method"])
  expect(library[0].status).toBe("published")
  expect(JSON.parse(storage.get("library")!)).toHaveLength(1) // the built-in lesson is not stored
  expect(last("teachingState").status).toBe("idle")

  // ---- LEARN the recorded lesson: started from the screen, checked with the glasses button
  fromScreen("startLearning", {tutorialId: library[0].id})
  await until("step 1 to be read aloud", () => spoken.some((s) => s.includes("Step 1. Sift two scoops of matcha into the bowl.")))
  expect(last("learningState")).toMatchObject({active: true, currentStep: 1, totalSteps: 1})

  await sleep(900)
  event("button_press", {buttonId: "camera", pressType: "short"})
  const verdict = await until("the verdict", () => last("stepVerdict"))
  expect(verdict).toMatchObject({step: 1, result: "pass", say: "Nice work.", photoUrl: "https://photos.example/p2.jpg"})
  await until("the end of the lesson", () => spoken.some((s) => s.includes("That was the last step. You finished My matcha.")))
  expect(last("learningState")).toMatchObject({active: false, finished: true})
  expect(sent.some((p) => p.type === "miniapp_rgb_led" && p.color === "green")).toBe(true)

  const check = claudeCalls.findLast((c) => c.body.output_config && c.body.model === "claude-haiku-5-5")
  expect(check.body.thinking).toEqual({type: "disabled"})
  const urls = check.body.messages[0].content.filter((b: any) => b.type === "image").map((b: any) => b.source.url)
  expect(urls).toEqual(["https://photos.example/p1.jpg", "https://photos.example/p2.jpg"]) // expert first, learner second

  // ---- LEARN the built-in lesson: a spoken question, then moving on by voice, then ending from the screen
  fromScreen("startLearning", {tutorialId: "tut_matcha_ceremonial_01"})
  await until("the built-in lesson to start", () => spoken.some((s) => s.includes("Step 1. Pour hot water into your tea bowl")))

  await sayToGlasses("Tinker, how hot should the water be?")
  await until("the answer", () => spoken.some((s) => s.startsWith("About eighty degrees Celsius")))
  const question = claudeCalls.at(-1)
  expect(question.body.output_config).toBeUndefined()
  expect(JSON.stringify(question.body.messages)).toContain("how hot should the water be")

  await sayToGlasses("Next step.")
  await until("step 2", () => spoken.some((s) => s.startsWith("Step 2. Place your fine-mesh sifter")))
  expect(last("learningState")).toMatchObject({active: true, currentStep: 2, totalSteps: 6})

  fromScreen("endLearning", {})
  await until("the lesson to stop", () => spoken.includes("Lesson stopped."))
  expect(last("learningState")).toMatchObject({active: false, finished: false})

  // ---- the transcript the screen was fed has the learner's question and the answer
  const lines = screen("transcriptionUpdate")
  expect(lines.some((l) => l.speaker === "user" && l.isFinal && /how hot should the water be/i.test(l.text))).toBe(true)
  expect(lines.some((l) => l.speaker === "tinker" && l.text.startsWith("About eighty degrees"))).toBe(true)

  // ---- the screen closes and opens again: it gets the same truth back
  event("_ui", {type: "UI_CLOSE"})
  event("_ui", {type: "UI_OPEN"})
  const again = await until("a new snapshot", () => (screen("snapshot").length >= 2 ? last("snapshot") : null))
  expect(again.tutorials).toHaveLength(2)
  expect(again.connection.claudeReady).toBe(true)
  expect(again.learning).toBeNull()
  expect(again.busy).toBe(false)
}, 60000)
