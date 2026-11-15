/**
 * Runs the BUILT app (dist/background/index.js, the exact file the phone
 * loads) against a simulated phone.
 *
 * The app runs in an empty JavaScript sandbox that has only what Mentra's
 * background engine has: console, timers, fetch, and the bridge to the phone.
 * The simulated phone answers the bridge the way the Mentra App does:
 * it "takes" photos, "speaks", stores values, and sends speech and button
 * events. Claude is faked too.
 *
 * The message format between the SDK and the phone is written down in docs/TESTING.md.
 *
 * This proves the app, the Mentra SDK inside it, and the wiring between them
 * work together. It does not prove the real glasses behave like the fake.
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
async function until<T>(what: string, check: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = check()
    if (value) return value
    await sleep(10)
  }
  throw new Error(`Timed out waiting for ${what}.`)
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
        packageName: "com.tinker.app",
        capabilities: null,
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

async function fakeFetch(url: string, init: any): Promise<Response> {
  if (url !== "https://api.anthropic.com/v1/messages") throw new Error(`Unexpected request to ${url}`)
  const body = JSON.parse(init.body)
  claudeCalls.push({body, headers: init.headers})
  const reply = (value: unknown, raw = false) =>
    new Response(JSON.stringify({content: [{type: "text", text: raw ? value : JSON.stringify(value)}], stop_reason: "end_turn"}))

  if (init.headers["x-api-key"] !== KEY) return new Response(JSON.stringify({error: {message: "invalid x-api-key"}}), {status: 401})
  if (body.max_tokens === 1) return reply("h", true)
  if (body.model === "claude-sonnet-5-5") {
    return reply({
      title: "Making matcha",
      materials: ["bowl", "whisk"],
      steps: [
        {
          number: 1,
          instruction: "Sift two scoops of matcha into the bowl.",
          done_looks_like: "Green powder in the bowl with no lumps.",
          common_mistake: "Skipping the sifter.",
          story: "",
          source_capture: 1,
        },
      ],
    })
  }
  return reply({result: "pass", say: "Nice work."})
}

/** Messages the app sent to the phone screen. */
function screenMessages(channel: string): Sent[] {
  return sent.filter((p) => p.type === "UI_SEND" && p.channel === channel)
}

function lastState(): any {
  return screenMessages("state").at(-1)?.payload
}

/** Say one finished sentence into the glasses, after the app's quiet gap. */
async function sayToGlasses(text: string): Promise<void> {
  await sleep(800)
  event("transcription:en-US", {text, isFinal: true})
}

beforeAll(() => {
  const build = Bun.spawnSync(["bun", "run", "build"], {cwd: ROOT})
  if (build.exitCode !== 0) throw new Error(`Build failed:\n${build.stderr.toString()}`)

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

test("the built app teaches and coaches a lesson on a simulated phone", async () => {
  // Startup: the app connects and reads its saved key and lesson.
  await until("the app to read storage", () => sent.filter((p) => p.type === "miniapp_storage_get").length >= 2)

  // The phone screen opens and gets the first state.
  event("_ui", {type: "UI_OPEN"})
  const first = await until("the first state", lastState)
  expect(first.mode).toBe("idle")
  expect(first.hasKey).toBe(false)

  // The key is pasted on the phone screen.
  event("_ui", {type: "UI_MESSAGE", channel: "set-key", payload: {key: KEY}, seq: 1, requestId: "rpc-1"})
  const saved = await until("the set-key reply", () => sent.find((p) => p.type === "UI_SEND" && p.requestId === "rpc-1"))
  expect(JSON.stringify(saved)).toContain('"ok":true')
  expect(storage.get("claudeKey")).toBe(KEY)

  // TEACH, by voice.
  await sayToGlasses("Start teaching.")
  await until("the teaching intro", () => spoken.some((s) => s.startsWith("Teaching mode.")))

  await sayToGlasses("First I sift two scoops of matcha into the bowl. Next step.")
  await until("step 1 to be saved", () => spoken.includes("Step 1 saved."))
  const photoRequest = sent.find((p) => p.type === "miniapp_photo")!
  expect(photoRequest.size).toBe("medium")
  expect(photoRequest.compress).toBe("medium")
  expect(sent.some((p) => p.type === "miniapp_blob_set_from_url" && p.url === "https://photos.example/p1.jpg")).toBe(true)

  await sayToGlasses("Finish lesson.")
  await until("the lesson to be saved", () => spoken.some((s) => s.startsWith("Lesson saved. Making matcha. It has 1 step.")))
  expect(spoken).toContain("Building the lesson.")
  expect(JSON.parse(storage.get("lesson")!).title).toBe("Making matcha")

  const plan = claudeCalls.find((c) => c.body.model === "claude-sonnet-5-5")
  expect(plan.headers["anthropic-version"]).toBe("2023-06-01")
  expect(plan.body.messages[0].content[0].text).toBe(
    'Capture 1. The expert said: "First I sift two scoops of matcha into the bowl."',
  )
  expect(plan.body.messages[0].content[1]).toEqual({type: "image", source: {type: "url", url: "https://photos.example/p1.jpg"}})

  // LEARN: start by voice, check with the button on the glasses.
  await sayToGlasses("Start lesson.")
  await until("step 1 to be read aloud", () => spoken.some((s) => s.includes("Step 1. Sift two scoops of matcha into the bowl.")))
  expect(lastState().mode).toBe("coaching")

  await sleep(800)
  event("button_press", {buttonId: "camera", pressType: "short"})
  await until("the verdict", () => spoken.includes("Nice work. That was the last step. You finished Making matcha."))
  expect(photos).toBe(2)

  const check = claudeCalls.at(-1)
  expect(check.body.model).toBe("claude-haiku-5-5")
  const urls = check.body.messages[0].content.filter((b: any) => b.type === "image").map((b: any) => b.source.url)
  expect(urls).toEqual(["https://photos.example/p1.jpg", "https://photos.example/p2.jpg"]) // expert first, learner second
  expect(sent.some((p) => p.type === "miniapp_rgb_led" && p.color === "green")).toBe(true)
  expect(lastState().mode).toBe("idle")
}, 30000)
