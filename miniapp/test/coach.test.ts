/**
 * Runs whole lessons against fake glasses and a fake Claude API.
 *   bun test
 *
 * What each test proves, and what no test proves: docs/TESTING.md
 *
 * These tests prove the app's own logic. They do not prove the real glasses
 * or the real Claude API behave the way the fakes do.
 */

import {afterEach, beforeEach, expect, test} from "bun:test"
import type {AppState} from "../src/shared/channels"
import {Coach, type Device} from "../src/background/coach"
import {parseCommand} from "../src/background/commands"

const GOOD_KEY = "sk-ant-test-key-1234"
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQ"

// ---------- fake Claude ----------

interface FakeClaude {
  requests: any[]
  headers: Record<string, string>[]
  verdicts: {result: string; say: string}[]
  rejectLinks: boolean
  failPlan: boolean
}

let claude: FakeClaude
const realFetch = globalThis.fetch

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}})
}

function installFakeClaude(): void {
  claude = {requests: [], headers: [], verdicts: [], rejectLinks: false, failPlan: false}
  globalThis.fetch = (async (url: string, init: any) => {
    if (url !== "https://api.anthropic.com/v1/messages") throw new Error(`Unexpected request to ${url}`)
    const body = JSON.parse(init.body)
    claude.requests.push(body)
    claude.headers.push(init.headers)

    if (init.headers["x-api-key"] !== GOOD_KEY) {
      return reply(401, {type: "error", error: {type: "authentication_error", message: "invalid x-api-key"}})
    }
    if (body.max_tokens === 1) return reply(200, {content: [{type: "text", text: "h"}], stop_reason: "max_tokens"})

    if (claude.rejectLinks && init.body.includes('"type":"url"')) {
      return reply(400, {type: "error", error: {type: "invalid_request_error", message: "Unable to download the file."}})
    }

    const json = (value: unknown) => reply(200, {content: [{type: "text", text: JSON.stringify(value)}], stop_reason: "end_turn"})

    if (body.model === "claude-sonnet-5-5") {
      if (claude.failPlan) return reply(529, {type: "error", error: {type: "overloaded_error", message: "Overloaded"}})
      const captures = body.messages[0].content.filter((b: any) => b.type === "text" && b.text.startsWith("Capture "))
      return json({
        title: "Making matcha",
        materials: ["bowl", "whisk"],
        steps: captures.map((_: unknown, i: number) => ({
          number: 99, // the app renumbers
          instruction: `Do thing ${i + 1}.`,
          done_looks_like: `Thing ${i + 1} is visible.`,
          common_mistake: "",
          story: i === 0 ? "My grandmother taught me this." : "",
          source_capture: i + 1,
        })),
      })
    }
    return json(claude.verdicts.shift() ?? {result: "pass", say: "Nice work."})
  }) as unknown as typeof fetch
}

// ---------- fake glasses ----------

interface Fake {
  device: Device
  said: string[]
  lights: string[]
  storage: Map<string, string>
  kept: Map<string, string>
  states: AppState[]
  clock: {now: number}
  photoFails: boolean
  downloads: string[]
  photos: number
}

function fakeGlasses(storage = new Map<string, string>(), kept = new Map<string, string>()): Fake {
  const fake: Fake = {
    said: [],
    lights: [],
    storage,
    kept,
    states: [],
    clock: {now: 1_000_000},
    photoFails: false,
    downloads: [],
    photos: 0,
    device: {
      async takePhoto() {
        if (fake.photoFails) throw {code: "INTERNAL", message: "glasses not connected"}
        fake.photos += 1
        return {url: `https://photos.example/p${fake.photos}.jpg`, mediaType: "image/jpeg"}
      },
      async speak(text) {
        fake.said.push(text)
      },
      light(color, times) {
        fake.lights.push(`${color}x${times}`)
      },
      async downloadPhoto(url) {
        fake.downloads.push(url)
        return JPEG_BASE64
      },
      async savePhoto(key) {
        fake.kept.set(key, JPEG_BASE64)
      },
      async loadPhoto(key) {
        return fake.kept.get(key) ?? null
      },
      async deletePhoto(key) {
        fake.kept.delete(key)
      },
      async storageGet(key) {
        return fake.storage.get(key) ?? null
      },
      async storageSet(key, value) {
        fake.storage.set(key, value)
      },
      async storageDelete(key) {
        fake.storage.delete(key)
      },
      now: () => fake.clock.now,
      onState: (state) => fake.states.push(state),
    },
  }
  return fake
}

/** Wait until the coach has finished the command it is running. */
async function settle(coach: Coach): Promise<void> {
  for (let i = 0; i < 500; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (!coach.state().busy) return
  }
  throw new Error("The coach stayed busy.")
}

/** Say one finished sentence, after the quiet gap that follows the app's own speech. */
async function say(fake: Fake, coach: Coach, sentence: string): Promise<void> {
  fake.clock.now += 2000
  coach.heard(sentence, true)
  await settle(coach)
}

async function coachWithKey(fake: Fake): Promise<Coach> {
  const coach = new Coach(fake.device)
  await coach.load()
  expect(await coach.setKey(GOOD_KEY)).toEqual({ok: true, error: ""})
  return coach
}

/** Record a three-step lesson by voice. */
async function teachThreeSteps(fake: Fake, coach: Coach): Promise<void> {
  await say(fake, coach, "Start teaching.")
  await say(fake, coach, "First I sift two scoops of matcha into the bowl.")
  await say(fake, coach, "My grandmother taught me this. Next step.")
  await say(fake, coach, "Then I pour in a little hot water. Next step.")
  await say(fake, coach, "Now I whisk in a zigzag until it foams.")
  await say(fake, coach, "Finish lesson.")
}

beforeEach(installFakeClaude)
afterEach(() => {
  globalThis.fetch = realFetch
})

// ---------- tests ----------

test("a command counts only at the end of a sentence", () => {
  expect(parseCommand("teaching", "The next step is to whisk.")).toBeNull()
  expect(parseCommand("teaching", "Whisk until it foams. Next step.")).toEqual({command: "capture", before: "Whisk until it foams."})
  expect(parseCommand("teaching", "Next step")).toEqual({command: "capture", before: ""})
  expect(parseCommand("teaching", "Okay, finish the lesson!")?.command).toBe("finish")
  expect(parseCommand("coaching", "Okay, I think I'm done.")?.command).toBe("check")
  expect(parseCommand("coaching", "I don't know why")).toBeNull()
  expect(parseCommand("coaching", "Why?")?.command).toBe("story")
  expect(parseCommand("idle", "next step")).toBeNull()
  expect(parseCommand("building", "start lesson")).toBeNull()
})

test("the key is tested before it is saved", async () => {
  const fake = fakeGlasses()
  const coach = new Coach(fake.device)
  await coach.load()

  expect((await coach.setKey("hello")).ok).toBe(false)
  const rejected = await coach.setKey("sk-ant-wrong")
  expect(rejected.ok).toBe(false)
  expect(rejected.error).toContain("rejected")
  expect(fake.storage.has("claudeKey")).toBe(false)

  expect((await coach.setKey(`  ${GOOD_KEY}  `)).ok).toBe(true)
  expect(fake.storage.get("claudeKey")).toBe(GOOD_KEY)
  expect(coach.state().keyHint).toBe("1234")
  expect(claude.headers.at(-1)!["anthropic-version"]).toBe("2023-06-01")
})

test("without a key the app asks for one", async () => {
  const fake = fakeGlasses()
  const coach = new Coach(fake.device)
  await coach.load()
  await say(fake, coach, "start teaching")
  expect(coach.state().mode).toBe("idle")
  expect(fake.said.at(-1)).toContain("Add the Claude key")
})

test("teach a lesson by voice, then coach a learner through it", async () => {
  const fake = fakeGlasses()
  const coach = await coachWithKey(fake)

  await teachThreeSteps(fake, coach)

  // Three photos: two from "next step", one for the last step that was only explained.
  expect(fake.photos).toBe(3)
  expect(coach.state().mode).toBe("idle")
  expect(coach.state().lessonTitle).toBe("Making matcha")
  expect(coach.state().steps.map((s) => s.number)).toEqual([1, 2, 3])
  expect(fake.said).toContain("Step 1 saved.")
  expect(fake.said.at(-1)).toBe("Lesson saved. Making matcha. It has 3 steps. Say start lesson to begin.")
  expect(JSON.parse(fake.storage.get("lesson")!).steps).toHaveLength(3)
  expect(fake.kept.size).toBe(3)

  // What Claude received: the expert's own words and fresh photo links.
  const plan = claude.requests.find((r) => r.model === "claude-sonnet-5-5")
  const blocks = plan.messages[0].content
  expect(blocks[0].text).toBe(
    'Capture 1. The expert said: "First I sift two scoops of matcha into the bowl. My grandmother taught me this."',
  )
  expect(blocks.filter((b: any) => b.type === "image").map((b: any) => b.source.type)).toEqual(["url", "url", "url"])
  expect(plan.output_config.format.type).toBe("json_schema")

  // Coaching.
  claude.verdicts = [
    {result: "fix", say: "Sift the powder first."},
    {result: "pass", say: "Good."},
    {result: "unclear", say: "Look at the bowl and try again."},
    {result: "pass", say: "Good."},
    {result: "pass", say: "Lovely foam."},
  ]
  await say(fake, coach, "Start lesson.")
  expect(coach.state().mode).toBe("coaching")
  expect(fake.said.at(-1)).toBe("Making matcha. You need bowl and whisk. Say check when you finish a step. Step 1. Do thing 1.")

  await say(fake, coach, "Why?")
  expect(fake.said.at(-1)).toBe("My grandmother taught me this.")

  await say(fake, coach, "Okay, I think I'm done.")
  expect(fake.said.at(-1)).toBe("Sift the powder first.")
  expect(fake.lights.at(-1)).toBe("redx2")
  expect(coach.state().stepNumber).toBe(1)

  // The check sent the expert's photo first, the learner's second, and what the learner said.
  const check = claude.requests.at(-1)
  expect(check.model).toBe("claude-haiku-5-5")
  const images = check.messages[0].content.filter((b: any) => b.type === "image")
  expect(images.map((b: any) => b.source.url)).toEqual(["https://photos.example/p1.jpg", "https://photos.example/p4.jpg"])
  expect(check.messages[0].content.at(-1).text).toContain(`The learner just said: "Okay, I think I'm done."`)

  await say(fake, coach, "check")
  expect(fake.said.at(-1)).toBe("Good. Step 2. Do thing 2.")
  expect(fake.lights.at(-1)).toBe("greenx2")

  await say(fake, coach, "check")
  expect(fake.lights.at(-1)).toBe("orangex2")
  expect(coach.state().stepNumber).toBe(2)

  await say(fake, coach, "Repeat.")
  expect(fake.said.at(-1)).toBe("Step 2. Do thing 2.")

  await say(fake, coach, "done")
  expect(coach.state().stepNumber).toBe(3)
  await say(fake, coach, "is this right")
  expect(fake.said.at(-1)).toBe("Lovely foam. That was the last step. You finished Making matcha.")
  expect(coach.state().mode).toBe("idle")
})

test("the app does not react to its own voice", async () => {
  const fake = fakeGlasses()
  const coach = await coachWithKey(fake)
  await say(fake, coach, "start teaching")

  // No clock advance: this arrives inside the quiet gap right after the app spoke.
  coach.heard("Say next step when it is finished. Next step.", true)
  await settle(coach)
  expect(fake.photos).toBe(0)
  expect(coach.state().narration).toBe("")

  coach.heard("half a sentence that is not final", false)
  expect(coach.state().narration).toBe("")
})

test("when Claude cannot open photo links, the photo bytes are sent instead", async () => {
  const fake = fakeGlasses()
  const coach = await coachWithKey(fake)
  claude.rejectLinks = true

  await teachThreeSteps(fake, coach)
  expect(coach.state().lessonTitle).toBe("Making matcha")
  const plans = claude.requests.filter((r) => r.model === "claude-sonnet-5-5")
  expect(plans).toHaveLength(2) // links first, then bytes
  const sent = plans[1].messages[0].content.filter((b: any) => b.type === "image")
  expect(sent.map((b: any) => b.source.type)).toEqual(["base64", "base64", "base64"])
  expect(sent[0].source.media_type).toBe("image/jpeg")

  // Later calls skip the links straight away.
  const before = claude.requests.length
  await say(fake, coach, "start lesson")
  await say(fake, coach, "check")
  expect(claude.requests.length).toBe(before + 1)
  expect(fake.said.at(-1)).toBe("Nice work. Step 2. Do thing 2.")
})

test("a lesson survives an app restart, and old links fall back to the saved photos", async () => {
  const fake = fakeGlasses()
  const coach = await coachWithKey(fake)
  await teachThreeSteps(fake, coach)

  // Restart: a new coach on the same phone storage, one hour later.
  const later = fakeGlasses(fake.storage, fake.kept)
  later.clock.now = fake.clock.now + 60 * 60 * 1000
  const restarted = new Coach(later.device)
  await restarted.load()
  expect(restarted.state().hasKey).toBe(true)
  expect(restarted.state().lessonTitle).toBe("Making matcha")

  await say(later, restarted, "start lesson")
  await say(later, restarted, "check")
  const images = claude.requests.at(-1).messages[0].content.filter((b: any) => b.type === "image")
  // Expert photo: saved bytes, because its link is an hour old. Learner photo: a fresh link.
  expect(images.map((b: any) => b.source.type)).toEqual(["base64", "url"])
  expect(later.said.at(-1)).toBe("Nice work. Step 2. Do thing 2.")
})

test("a failed photo does not break teaching or coaching", async () => {
  const fake = fakeGlasses()
  const coach = await coachWithKey(fake)
  await say(fake, coach, "start teaching")
  fake.photoFails = true
  await say(fake, coach, "I fold the cloth in half. Next step.")
  expect(fake.said.at(-1)).toBe("Step 1 saved without a photo.")
  expect(coach.state().error).toContain("glasses not connected")
  await say(fake, coach, "finish lesson")
  expect(coach.state().steps).toHaveLength(1) // built from the words alone

  await say(fake, coach, "start lesson")
  await say(fake, coach, "check")
  expect(fake.said.at(-1)).toBe("I could not take a photo. Say check to try again.")
  expect(coach.state().stepNumber).toBe(1)

  fake.photoFails = false
  await say(fake, coach, "check")
  expect(fake.said.at(-1)).toBe("Nice work. That was the last step. You finished Making matcha.")
})

test("when Claude fails to build the lesson, the recording is kept for a retry", async () => {
  const fake = fakeGlasses()
  const coach = await coachWithKey(fake)
  claude.failPlan = true
  await teachThreeSteps(fake, coach)
  expect(coach.state().mode).toBe("teaching")
  expect(coach.state().error).toContain("Overloaded")
  expect(fake.said.at(-1)).toBe("I could not build the lesson. Say finish lesson to try again.")

  claude.failPlan = false
  await say(fake, coach, "finish lesson")
  expect(coach.state().mode).toBe("idle")
  expect(coach.state().steps).toHaveLength(3)
  expect(fake.photos).toBe(3) // no extra photos on the retry
})

test("the glasses button and the phone buttons run the same commands", async () => {
  const fake = fakeGlasses()
  const coach = await coachWithKey(fake)

  coach.button("short") // no lesson yet: start teaching
  await settle(coach)
  expect(coach.state().mode).toBe("teaching")

  fake.clock.now += 2000
  coach.heard("I tie the first knot.", true)
  coach.button("short") // save the step
  coach.button("short") // pressed again while the photo is in progress: dropped
  await settle(coach)
  expect(fake.photos).toBe(1)

  coach.button("long") // finish the lesson
  await settle(coach)
  expect(coach.state().mode).toBe("idle")
  expect(coach.state().steps).toHaveLength(1)

  await coach.act("learn")
  expect(coach.state().mode).toBe("coaching")
  await coach.act("stop")
  expect(coach.state().mode).toBe("idle")

  await coach.act("deleteLesson")
  expect(coach.state().lessonTitle).toBe("")
  expect(fake.storage.has("lesson")).toBe(false)
  expect(fake.kept.size).toBe(0)
})
