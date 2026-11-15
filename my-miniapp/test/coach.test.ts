/**
 * coach.test.ts: runs whole lessons against fake glasses and a fake Claude.
 *   bun test test/coach.test.ts
 *
 * WHAT IS FAKE
 *   The `Device` (photos, speech, light, storage, kept photos, the messages to
 *   the phone screen) and the `Brain` (the four Claude requests). Both are the
 *   interfaces in src/background/contracts.ts. The clock is fake too: a test
 *   moves it forward by hand, so nothing here waits for real time.
 *
 * WHAT THESE TESTS PROVE
 *   The app's own logic: which events the screen gets and what is in them, the
 *   exact sentences spoken, what is saved on the phone, and what Claude is
 *   asked. They do not prove that the real glasses or the real Claude API
 *   behave the way the fakes do. test/claude.test.ts covers the requests and
 *   test/phone.test.ts covers the wiring to the Mentra SDK.
 *
 * HOW A TEST WAITS
 *   Every input is followed by `await coach.whenIdle()`. It resolves when no
 *   command is running and none is waiting. No test polls or sleeps.
 */

import {expect, jest, test} from "bun:test"
import type {
  AssistantState,
  Channels,
  Snapshot,
  StepVerdict,
  TeachingState,
  TranscriptEntry,
  TutorialModel,
  UiCommandChannel,
  UiEventChannel,
} from "../src/shared/channels"
import {Coach} from "../src/background/coach"
import {helpText, normalize, parseCommand, type Mode} from "../src/background/commands"
import {BrainError, type Brain, type CaptureInput, type Device, type Hardware, type LessonDraft, type Verdict} from "../src/background/contracts"
import {BUILT_IN_TUTORIALS} from "../src/background/seed"

const GOOD_KEY = "sk-ant-test-key-1234"
/** The first characters of a JPEG file in base64. The Coach reads the image type from them. */
const JPEG = "/9j/4AAQSkZJRgABAQ"
const BUILT_IN = BUILT_IN_TUTORIALS[0]!
const MODES: Mode[] = ["idle", "recording", "processing", "review", "learning"]

const RECORDING_INTRO = "Recording. Do one step and explain it. Say next step when it is finished. Say finish lesson at the end."
const LESSON_READY_3 = "Lesson ready. Making matcha. It has 3 steps. Say publish lesson to save it, or review it on the phone."

/**
 * Every sentence any fake device was asked to speak, in any test of this file.
 * The last test checks that none of them could be taken for a command.
 */
const everythingSaid: string[] = []

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
/** Let everything that can run without real time passing run. Used while a photo, a sentence or Claude is held. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
/** The same without a timer, for the one test that replaces the timers. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

// ---------- fake glasses and phone ----------

interface Emitted {
  channel: UiEventChannel
  payload: any
}

interface FakeDevice {
  device: Device
  /** Every sentence passed to `speak`, in order. */
  said: string[]
  /** For example "greenx2". */
  lights: string[]
  /** Every call to `takePhoto`, including the ones that failed. */
  photoCalls: Array<{sound: boolean}>
  /** Photos that worked. Photo number N has the link https://photos.example/pN.jpg. */
  photos: number
  /** Switch: true makes every photo fail. */
  photoFails: boolean
  /** Switch: a message makes every `speak` fail with it. */
  speechFails: string
  /** Switch: a message makes every `storageSet` fail with it. */
  storageFails: string
  storage: Map<string, string>
  /** Kept photo copies: name -> base64. */
  kept: Map<string, string>
  /** Names read with `loadPhoto`. */
  loads: string[]
  /** Links read with `downloadPhoto`. */
  downloads: string[]
  vocabulary: string[][]
  /** Every message sent to the phone screen, copied at the moment it was sent. */
  events: Emitted[]
  /** The fake clock. Tests add milliseconds to `now`. */
  clock: {now: number}
  hardware: Hardware
  /** Make speech hang. The returned function lets it finish. */
  holdSpeech(): () => void
  /** Make photos hang. The returned function lets them finish. */
  holdPhoto(): () => void
  /** All payloads sent on one channel. */
  of<C extends UiEventChannel>(channel: C): Array<Channels[C]>
  /** The newest payload sent on one channel. */
  last<C extends UiEventChannel>(channel: C): Channels[C] | undefined
}

function fakeDevice(options: {storage?: Map<string, string>; kept?: Map<string, string>; track?: boolean} = {}): FakeDevice {
  let speechGate: Promise<void> | null = null
  let photoGate: Promise<void> | null = null
  const hold = (set: (gate: Promise<void> | null) => void): (() => void) => {
    let open = (): void => {}
    set(new Promise<void>((resolve) => (open = resolve)))
    return () => {
      set(null)
      open()
    }
  }

  const fake: FakeDevice = {
    said: [],
    lights: [],
    photoCalls: [],
    photos: 0,
    photoFails: false,
    speechFails: "",
    storageFails: "",
    storage: options.storage ?? new Map(),
    kept: options.kept ?? new Map(),
    loads: [],
    downloads: [],
    vocabulary: [],
    events: [],
    clock: {now: 1_000_000},
    hardware: {glassesConnected: true, hasCamera: true, hasMic: true},
    holdSpeech: () => hold((gate) => (speechGate = gate)),
    holdPhoto: () => hold((gate) => (photoGate = gate)),
    of: (channel) => fake.events.filter((event) => event.channel === channel).map((event) => event.payload),
    last: (channel) => fake.of(channel).at(-1),
    device: {
      async takePhoto(photoOptions) {
        fake.photoCalls.push({sound: photoOptions.sound})
        if (photoGate) await photoGate
        // The shape of a failed SDK call: a plain object, not an Error.
        if (fake.photoFails) throw {code: "INTERNAL", message: "glasses not connected"}
        fake.photos += 1
        return {url: `https://photos.example/p${fake.photos}.jpg`, mediaType: "image/jpeg"}
      },
      async speak(text) {
        fake.said.push(text)
        if (options.track !== false) everythingSaid.push(text)
        if (speechGate) await speechGate
        if (fake.speechFails) throw new Error(fake.speechFails)
      },
      light(color, times) {
        fake.lights.push(`${color}x${times}`)
      },
      setVocabulary(words) {
        fake.vocabulary.push([...words])
      },
      hardware: () => fake.hardware,
      async downloadPhoto(url) {
        fake.downloads.push(url)
        return JPEG
      },
      async savePhoto(key) {
        fake.kept.set(key, JPEG)
      },
      async loadPhoto(key) {
        fake.loads.push(key)
        return fake.kept.get(key) ?? null
      },
      async deletePhoto(key) {
        fake.kept.delete(key)
      },
      async storageGet(key) {
        return fake.storage.get(key) ?? null
      },
      async storageSet(key, value) {
        if (fake.storageFails) throw new Error(fake.storageFails)
        fake.storage.set(key, value)
      },
      async storageDelete(key) {
        fake.storage.delete(key)
      },
      now: () => fake.clock.now,
      emit(channel, payload) {
        // Copied the way the real bridge does it: as JSON, at this moment.
        fake.events.push({channel, payload: clone(payload)})
      },
    },
  }
  return fake
}

// ---------- fake Claude ----------

interface BrainCall {
  method: "testKey" | "buildLesson" | "checkStep" | "answer"
  apiKey: string
  /** The arguments, copied at the moment of the call. */
  input: any
}

interface FakeBrain {
  brain: Brain
  calls: BrainCall[]
  /** Answers for `checkStep`, used in order. When empty: a pass that says "Nice work." */
  verdicts: Verdict[]
  /** Answers for `answer`, used in order. When empty: "About eighty degrees, not boiling." */
  answers: string[]
  /** Replaces the lesson the fake writes. */
  draft: ((captures: CaptureInput[]) => LessonDraft) | null
  /** Switch: a status makes every request fail with a BrainError of that status. */
  failStatus: number | null
  failMessage: string
  /** Switch: makes every request fail with this error, which is not a BrainError. */
  failError: Error | null
  /** Switch: true makes every request that carries a photo LINK fail with status 400. */
  rejectLinks: boolean
  /** Called at the start of every request. A test uses it to look at the Coach while Claude "works". */
  during: ((method: BrainCall["method"]) => void) | null
  /** Make requests hang. The returned function lets them finish. */
  hold(): () => void
  of(method: BrainCall["method"]): BrainCall[]
}

/** The lesson the fake Claude writes: one step for every capture the expert saved with "next step". */
function defaultDraft(captures: CaptureInput[]): LessonDraft {
  const saved = captures.map((capture, i) => ({capture, number: i + 1})).filter((item) => item.capture.kind === "step")
  return {
    title: "Making matcha",
    description: "Whisk a bowl of matcha.",
    category: "Tea",
    estimated_duration_minutes: 500, // the Coach limits this to 120
    tools_required: ["bowl", "whisk"],
    ingredients_required: ["matcha powder"],
    steps: saved.map((item, i) => ({
      title: `Thing ${i + 1}`,
      instruction_spoken: `Do thing ${i + 1}.`,
      instruction_detailed: i === 1 ? "" : `Thing ${i + 1} matters because of the foam.`,
      tips: i === 0 ? ["Use a dry bowl", "Sift slowly.", "A third tip."] : [],
      done_looks_like: `Thing ${i + 1} is visible.`,
      common_mistake: "",
      story: i === 0 ? "My grandmother taught me this." : "",
      source_capture: item.number,
    })),
  }
}

function fakeBrain(): FakeBrain {
  let gate: Promise<void> | null = null

  async function request<T>(method: BrainCall["method"], apiKey: string, input: unknown, produce: () => T): Promise<T> {
    mind.calls.push({method, apiKey, input: clone(input ?? null)})
    mind.during?.(method)
    if (gate) await gate
    if (mind.failError) throw mind.failError
    if (mind.failStatus !== null) throw new BrainError(mind.failStatus, mind.failMessage)
    if (mind.rejectLinks && JSON.stringify(input ?? null).includes('"kind":"url"')) {
      throw new BrainError(400, "Unable to download the file.")
    }
    return produce()
  }

  const mind: FakeBrain = {
    calls: [],
    verdicts: [],
    answers: [],
    draft: null,
    failStatus: null,
    failMessage: "Overloaded",
    failError: null,
    rejectLinks: false,
    during: null,
    hold() {
      let open = (): void => {}
      gate = new Promise<void>((resolve) => (open = resolve))
      return () => {
        gate = null
        open()
      }
    },
    of: (method) => mind.calls.filter((call) => call.method === method),
    brain: {
      testKey: (apiKey) =>
        request("testKey", apiKey, null, () => {
          if (apiKey !== GOOD_KEY) throw new BrainError(401, "invalid x-api-key")
        }),
      buildLesson: (apiKey, input) => request("buildLesson", apiKey, input, () => (mind.draft ?? defaultDraft)(input.captures)),
      checkStep: (apiKey, input) =>
        request("checkStep", apiKey, input, () => mind.verdicts.shift() ?? {result: "pass" as const, say: "Nice work."}),
      answer: (apiKey, input) => request("answer", apiKey, input, () => mind.answers.shift() ?? "About eighty degrees, not boiling."),
    },
  }
  return mind
}

// ---------- helpers ----------

interface Rig {
  fake: FakeDevice
  mind: FakeBrain
  coach: Coach
}

/** A Coach on fake glasses, loaded, with a saved key unless `key: false`. */
async function start(options: {key?: boolean; storage?: Map<string, string>; kept?: Map<string, string>; track?: boolean} = {}): Promise<Rig> {
  const fake = fakeDevice(options)
  const mind = fakeBrain()
  const coach = new Coach(fake.device, mind.brain)
  await coach.load()
  if (options.key !== false) expect(await coach.setKey(GOOD_KEY)).toEqual({ok: true, error: ""})
  return {fake, mind, coach}
}

/**
 * Say one finished sentence into the glasses and wait for the app to be done with it.
 * The clock moves 3 seconds first: past the quiet gap that follows the app's own speech.
 */
async function hear(rig: Rig, sentence: string, afterMs = 3000): Promise<void> {
  rig.fake.clock.now += afterMs
  rig.coach.heard(sentence, true)
  await rig.coach.whenIdle()
}

/** Tap a button on the phone screen and wait for the app to be done with it. */
async function tap<C extends UiCommandChannel>(rig: Rig, channel: C, payload: unknown = {}): Promise<void> {
  rig.coach.command(channel, payload as Channels[C])
  await rig.coach.whenIdle()
}

/** Press the button on the glasses and wait for the app to be done with it. */
async function press(rig: Rig, kind: "short" | "long"): Promise<void> {
  rig.coach.button(kind)
  await rig.coach.whenIdle()
}

/** Record a three-step lesson by voice. It ends in review, with a draft. */
async function teachThreeSteps(rig: Rig): Promise<void> {
  await hear(rig, "Start teaching.")
  await hear(rig, "First I sift two scoops of matcha into the bowl.")
  await hear(rig, "My grandmother taught me this. Next step.")
  await hear(rig, "Then I pour in a little hot water. Next step.")
  await hear(rig, "Now I whisk in a zigzag until it foams.")
  await hear(rig, "Finish lesson.")
}

/** Record and publish the three-step lesson "Making matcha". */
async function teachAndPublish(rig: Rig): Promise<TutorialModel> {
  await teachThreeSteps(rig)
  await hear(rig, "Publish lesson.")
  expect(rig.fake.said.at(-1)).toBe("Lesson published.")
  return rig.coach.snapshot().tutorials[0]!
}

/** A saved lesson, for tests that start with a library already on the phone. */
function savedLesson(id: string, title: string, extra: Partial<TutorialModel> = {}): TutorialModel {
  return {
    id,
    title,
    description: "",
    total_steps: 3,
    estimated_duration_minutes: 2,
    created_at: "2026-11-01T10:00:00.000Z",
    status: "published",
    tools_required: [],
    ingredients_required: [],
    steps: [
      {
        id: `${id}_1`,
        step_number: 1,
        title: "Loop",
        instruction_spoken: "Make a small loop in the rope.",
        instruction_detailed: "The loop is the hole the rabbit comes out of.",
        story: "Sailors have tied it this way for centuries.",
        tips: ["Keep the loop small", "Hold it with your thumb.", "A third tip that is never spoken."],
      },
      {
        id: `${id}_2`,
        step_number: 2,
        title: "Through",
        instruction_spoken: "Pass the end up through the loop.",
        instruction_detailed: "Up through the loop means from below.",
      },
      {id: `${id}_3`, step_number: 3, title: "Tighten", instruction_spoken: "Pull the knot tight.", instruction_detailed: ""},
    ],
    ...extra,
  }
}

function libraryOnPhone(...lessons: TutorialModel[]): Map<string, string> {
  return new Map([["library", JSON.stringify(lessons)]])
}

/** The text of the conversation lines, as "speaker: text". */
function lines(snapshot: Snapshot): string[] {
  return snapshot.transcript.map((line) => `${line.speaker}: ${line.text}`)
}

const IDLE_TEACHING: TeachingState = {status: "idle", elapsedSeconds: 0, frameCount: 0, stepCount: 0, narration: ""}

/**
 * Rebuild the screen's picture from the single messages, the way the phone
 * screen does. `snapshot()` must give the same picture.
 */
function fold(events: Emitted[]): Snapshot {
  let connection: any = null
  let tutorials: TutorialModel[] = []
  let teaching: TeachingState = IDLE_TEACHING
  let draft: TutorialModel | null = null
  let learning: any = null
  let session = ""
  let lastVerdict: StepVerdict | null = null
  let transcript: TranscriptEntry[] = []
  let assistant: AssistantState = "idle"
  for (const {channel, payload} of events) {
    if (channel === "connectionStatus") connection = payload
    else if (channel === "tutorialList") tutorials = payload.tutorials
    else if (channel === "teachingState") {
      teaching = payload
      if (payload.status !== "review") draft = null
    } else if (channel === "tutorialGenerated") draft = payload.status === "success" ? payload.tutorial : null
    else if (channel === "learningState") {
      if (payload.sessionId !== session) lastVerdict = null // a new lesson starts without a verdict
      session = payload.sessionId
      learning = payload.active ? payload : null
    } else if (channel === "stepVerdict") lastVerdict = payload
    else if (channel === "transcriptionUpdate") {
      const index = transcript.findIndex((line) => line.id === payload.id)
      if (index >= 0) transcript[index] = payload
      else transcript = [...transcript, payload].slice(-40)
    } else if (channel === "assistantState") assistant = payload.state
  }
  return {
    connection,
    tutorials,
    teaching,
    draft,
    // The screen keeps one assistant state. The newest message about it wins.
    learning: learning ? {...learning, assistantState: assistant} : null,
    lastVerdict,
    transcript,
    assistant,
    // The screen has no busy message. It reads "busy" from the assistant state.
    busy: assistant === "thinking" || assistant === "speaking",
  }
}

// ---------- spoken commands ----------

test("a command counts only at the end of a sentence, and only in its own mode", () => {
  expect(normalize("  I'm DONE. ")).toBe("im done")

  expect(parseCommand("recording", "The next step is to whisk.")).toBeNull()
  expect(parseCommand("recording", "Whisk until it foams. Next step.")).toEqual({command: "capture", before: "Whisk until it foams."})
  expect(parseCommand("recording", "Next step")).toEqual({command: "capture", before: ""})
  expect(parseCommand("recording", "Save this step.")?.command).toBe("capture")
  expect(parseCommand("recording", "Okay, finish the lesson!")).toEqual({command: "finish", before: "Okay,"})
  expect(parseCommand("recording", "That is all. Stop recording.")).toEqual({command: "finish", before: "That is all."})
  expect(parseCommand("recording", "End lesson")?.command).toBe("finish")
  expect(parseCommand("recording", "Cancel the lesson.")?.command).toBe("discard")
  expect(parseCommand("review", "Discard lesson")?.command).toBe("discard")
  expect(parseCommand("review", "Looks good, save the lesson.")?.command).toBe("publish")
  expect(parseCommand("idle", "Please record a lesson")?.command).toBe("teach")
  expect(parseCommand("idle", "Coach me.")?.command).toBe("learn")

  // Apostrophes and capitals do not matter, and the words before the command are kept as spoken.
  expect(parseCommand("learning", "Okay, I think I'm done.")).toEqual({command: "check", before: "Okay, I think"})
  expect(parseCommand("learning", "How does this look?")?.command).toBe("check")
  expect(parseCommand("learning", "Go back")?.command).toBe("previous")
  expect(parseCommand("learning", "Say that again")?.command).toBe("repeat")
  expect(parseCommand("learning", "What do I need?")?.command).toBe("materials")
  expect(parseCommand("learning", "Stop the lesson")?.command).toBe("stop")

  // The same words mean different things in different modes, or nothing.
  expect(parseCommand("learning", "Next step.")?.command).toBe("next")
  expect(parseCommand("idle", "next step")).toBeNull()
  expect(parseCommand("recording", "publish lesson")).toBeNull()
  expect(parseCommand("processing", "start lesson")).toBeNull()
  expect(parseCommand("learning", "end lesson")?.command).toBe("stop")
  for (const mode of MODES) expect(parseCommand(mode, "Um, what can I say?")?.command).toBe("help")
  expect(parseCommand("learning", "")).toBeNull()
})

test("short words are commands only when they are the whole sentence", () => {
  expect(parseCommand("learning", "Why?")).toEqual({command: "story", before: ""})
  expect(parseCommand("learning", "I don't know why")).toBeNull()
  expect(parseCommand("learning", "Tell me why.")?.command).toBe("story")
  expect(parseCommand("learning", "Next.")?.command).toBe("next")
  expect(parseCommand("learning", "Skip")?.command).toBe("next")
  expect(parseCommand("learning", "What comes next")).toBeNull()
  expect(parseCommand("learning", "I will skip")).toBeNull()
  expect(parseCommand("learning", "Tips?")?.command).toBe("tips")
  expect(parseCommand("learning", "tip")?.command).toBe("tips")
  expect(parseCommand("learning", "That is a good tip")).toBeNull()
  expect(parseCommand("learning", "Give me a tip.")?.command).toBe("tips")
})

test("a question starts with the name Tinker, and only while a lesson is being learned", () => {
  expect(parseCommand("learning", "Hey Tinker, how hot should the water be?")).toEqual({
    command: "ask",
    before: "",
    question: "how hot should the water be?",
  })
  expect(parseCommand("learning", "Tinker what is a chasen")).toEqual({command: "ask", before: "", question: "what is a chasen"})
  expect(parseCommand("learning", "OK, Tinker: why is it lumpy?")).toEqual({command: "ask", before: "", question: "why is it lumpy?"})
  expect(parseCommand("learning", "Okay Tinker.")).toEqual({command: "ask", before: "", question: ""})

  // The name must be at the START, as a word of its own.
  expect(parseCommand("learning", "I like to tinker with it")).toBeNull()
  expect(parseCommand("learning", "Tinkering is fun")).toBeNull()
  // A question that happens to end in command words is still a question.
  expect(parseCommand("learning", "Hey Tinker, what is the next step?")).toEqual({
    command: "ask",
    before: "",
    question: "what is the next step?",
  })
  // The name in front of a plain command is that command, not a question for Claude.
  expect(parseCommand("learning", "Hey Tinker, I'm done.")).toEqual({command: "check", before: ""})
  expect(parseCommand("learning", "Tinker, stop the lesson")).toEqual({command: "stop", before: ""})
  // Outside a lesson the name does nothing.
  for (const mode of ["idle", "recording", "processing", "review"] as Mode[]) {
    expect(parseCommand(mode, "Tinker, how hot should the water be?")).toBeNull()
  }
})

// ---------- the key ----------

test("the key is tested before it is saved, and a rejected key is not saved", async () => {
  const {fake, mind, coach} = await start({key: false})
  // What load() told the screen: no key yet, and the library holds the built-in lesson.
  expect(fake.last("connectionStatus")).toEqual({glassesConnected: true, hasCamera: true, hasMic: true, claudeReady: false, keyHint: ""})
  expect(fake.last("tutorialList")!.tutorials.map((lesson) => lesson.id)).toEqual([BUILT_IN.id])

  expect(await coach.setKey("hello")).toEqual({ok: false, error: "That is not a Claude key. A Claude key starts with sk-ant-."})
  expect(mind.calls).toHaveLength(0) // not even sent to Claude

  expect(await coach.setKey("sk-ant-test-wrong")).toEqual({
    ok: false,
    error: "Claude rejected this key. Copy it again from the Claude Console.",
  })
  expect(mind.of("testKey").map((call) => call.apiKey)).toEqual(["sk-ant-test-wrong"])
  expect(fake.storage.has("claudeKey")).toBe(false)
  expect(coach.snapshot().connection.claudeReady).toBe(false)

  mind.failStatus = 0
  mind.failMessage = "No connection to Claude."
  expect(await coach.setKey(GOOD_KEY)).toEqual({ok: false, error: "The test request failed. No connection to Claude."})
  expect(fake.storage.has("claudeKey")).toBe(false)
  mind.failStatus = null

  expect(await coach.setKey(`  ${GOOD_KEY}  `)).toEqual({ok: true, error: ""})
  expect(fake.storage.get("claudeKey")).toBe(GOOD_KEY)
  expect(fake.last("connectionStatus")).toEqual({glassesConnected: true, hasCamera: true, hasMic: true, claudeReady: true, keyHint: "1234"})
  expect(coach.snapshot().connection.keyHint).toBe("1234")

  // An empty key removes the saved one.
  expect(await coach.setKey("")).toEqual({ok: true, error: ""})
  expect(fake.storage.has("claudeKey")).toBe(false)
  expect(fake.last("connectionStatus")).toMatchObject({claudeReady: false, keyHint: ""})
})

test("without a key, teaching is refused out loud and on the screen", async () => {
  const rig = await start({key: false})
  const {fake, coach} = rig
  await hear(rig, "Start teaching.")
  expect(fake.said).toEqual(["Add the Claude key on the phone screen first."])
  expect(fake.last("teachingState")).toEqual({...IDLE_TEACHING, error: "Add the Claude key on the phone screen first."})
  expect(coach.snapshot().teaching.status).toBe("idle")
  expect(fake.photoCalls).toHaveLength(0)

  // Saving a key takes the message off the screen again.
  expect((await coach.setKey(GOOD_KEY)).ok).toBe(true)
  expect(fake.last("teachingState")).toEqual(IDLE_TEACHING)
})

// ---------- teaching ----------

test("teach a lesson by voice, review the draft, publish it with an edited title", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig

  await hear(rig, "Start teaching.")
  expect(fake.said.at(-1)).toBe(RECORDING_INTRO)
  expect(fake.last("teachingState")).toEqual({status: "recording", elapsedSeconds: 0, frameCount: 0, stepCount: 0, narration: "", sessionId: "1003000"})

  await hear(rig, "First I sift two scoops of matcha into the bowl.")
  expect(fake.last("teachingState")).toMatchObject({elapsedSeconds: 3, narration: "First I sift two scoops of matcha into the bowl."})
  expect(fake.photoCalls).toHaveLength(0)

  await hear(rig, "My grandmother taught me this. Next step.")
  expect(fake.photoCalls).toEqual([{sound: true}])
  expect(fake.said.at(-1)).toBe("Step 1 saved.")
  expect(fake.last("photoCapture")).toEqual({photoUrl: "https://photos.example/p1.jpg", frameIndex: 1, timestampSeconds: 6, kind: "step"})
  expect(fake.last("teachingState")).toMatchObject({status: "recording", frameCount: 1, stepCount: 1, narration: ""})

  await hear(rig, "Then I pour in a little hot water. Next step.")
  expect(fake.said.at(-1)).toBe("Step 2 saved.")
  await hear(rig, "Now I whisk in a zigzag until it foams.")
  await hear(rig, "Finish lesson.")

  // Three photos: two from "next step", one for the last step that was only explained.
  expect(fake.photos).toBe(3)
  expect(fake.said.slice(-2)).toEqual(["Building the lesson.", LESSON_READY_3])
  expect(fake.of("teachingState").map((state) => state.status)).toContain("processing")
  expect(fake.last("teachingState")).toEqual({status: "review", elapsedSeconds: 15, frameCount: 3, stepCount: 3, narration: "", sessionId: "1003000"})

  // What Claude was asked: the expert's own words, when they were said, and fresh photo links.
  expect(mind.of("buildLesson")).toHaveLength(1)
  expect(mind.of("buildLesson")[0]).toEqual({
    method: "buildLesson",
    apiKey: GOOD_KEY,
    input: {
      skillHint: "",
      captures: [
        {
          transcript: "First I sift two scoops of matcha into the bowl. My grandmother taught me this.",
          atSeconds: 6,
          kind: "step",
          image: {kind: "url", url: "https://photos.example/p1.jpg"},
        },
        {transcript: "Then I pour in a little hot water.", atSeconds: 9, kind: "step", image: {kind: "url", url: "https://photos.example/p2.jpg"}},
        {
          transcript: "Now I whisk in a zigzag until it foams.",
          atSeconds: 15,
          kind: "step",
          image: {kind: "url", url: "https://photos.example/p3.jpg"},
        },
      ],
    },
  })

  // The draft: Claude's text plus ids, numbers and the expert's photos.
  const draft: TutorialModel = {
    id: "tut_1003000",
    title: "Making matcha",
    description: "Whisk a bowl of matcha.",
    category: "Tea",
    total_steps: 3,
    estimated_duration_minutes: 120,
    created_at: new Date(1_018_000).toISOString(),
    status: "draft",
    tools_required: ["bowl", "whisk"],
    ingredients_required: ["matcha powder"],
    steps: [
      {
        id: "step_1003000_1",
        step_number: 1,
        title: "Thing 1",
        instruction_spoken: "Do thing 1.",
        instruction_detailed: "Thing 1 matters because of the foam.",
        tips: ["Use a dry bowl", "Sift slowly.", "A third tip."],
        done_looks_like: "Thing 1 is visible.",
        story: "My grandmother taught me this.",
        source_timestamp_seconds: 6,
        reference_image_url: "https://photos.example/p1.jpg",
        photo_key: "shot-1003000-1",
        photo_taken_at: 1_009_000,
      },
      {
        id: "step_1003000_2",
        step_number: 2,
        title: "Thing 2",
        instruction_spoken: "Do thing 2.",
        instruction_detailed: "",
        done_looks_like: "Thing 2 is visible.",
        source_timestamp_seconds: 9,
        reference_image_url: "https://photos.example/p2.jpg",
        photo_key: "shot-1003000-2",
        photo_taken_at: 1_012_000,
      },
      {
        id: "step_1003000_3",
        step_number: 3,
        title: "Thing 3",
        instruction_spoken: "Do thing 3.",
        instruction_detailed: "Thing 3 matters because of the foam.",
        done_looks_like: "Thing 3 is visible.",
        source_timestamp_seconds: 15,
        reference_image_url: "https://photos.example/p3.jpg",
        photo_key: "shot-1003000-3",
        photo_taken_at: 1_018_000,
      },
    ],
  }
  expect(fake.last("tutorialGenerated")).toEqual({status: "success", tutorial: draft})
  expect(coach.snapshot().draft).toEqual(draft)
  // A draft is not in the library and not on the phone's storage yet. Its photos are kept.
  expect(coach.snapshot().tutorials.map((lesson) => lesson.id)).toEqual([BUILT_IN.id])
  expect(fake.storage.has("library")).toBe(false)
  expect([...fake.kept.keys()]).toEqual(["shot-1003000-1", "shot-1003000-2", "shot-1003000-3"])

  // Publish from the phone screen. Only the title and the description are taken from the screen:
  // an empty description means "not edited", and the steps sent back are ignored.
  await tap(rig, "publishTutorial", {tutorial: {...draft, title: "  Grandma's matcha  ", description: "", steps: [], status: "draft"}})
  const published = {...draft, title: "Grandma's matcha", status: "published"}
  expect(fake.said.at(-1)).toBe("Lesson published.")
  expect(fake.last("tutorialList")).toEqual({tutorials: [published, BUILT_IN]})
  expect(JSON.parse(fake.storage.get("library")!)).toEqual([published]) // the built-in lesson is not stored
  expect(fake.last("teachingState")).toEqual(IDLE_TEACHING)
  expect(coach.snapshot().draft).toBeNull()
  expect(fake.kept.size).toBe(3)
})

test("what the expert typed as the skill reaches Claude, and a spoken publish uses the draft as it is", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  await tap(rig, "startTeaching", {targetSkill: "  whisking matcha  "})
  expect(fake.said.at(-1)).toBe(RECORDING_INTRO)
  await hear(rig, "I whisk in a zigzag. Save step.")
  await tap(rig, "stopTeaching")
  expect(mind.of("buildLesson")[0]!.input.skillHint).toBe("whisking matcha")
  expect(fake.said.at(-1)).toBe("Lesson ready. Making matcha. It has 1 step. Say publish lesson to save it, or review it on the phone.")

  await hear(rig, "Publish lesson.")
  expect(fake.said.at(-1)).toBe("Lesson published.")
  expect(coach.snapshot().tutorials[0]).toMatchObject({title: "Making matcha", status: "published", total_steps: 1})
})

test("a timed photo is taken after 20 seconds, silently, and never while a command runs", async () => {
  const rig = await start()
  const {fake, coach} = rig
  await tap(rig, "startTeaching")
  const saidSoFar = fake.said.length

  // Every tick moves the clock on the screen. No photo before 20 seconds have passed.
  coach.tick()
  fake.clock.now += 19_000
  coach.tick()
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(0)
  expect(fake.last("teachingState")).toMatchObject({status: "recording", elapsedSeconds: 19})

  // At 20 seconds: a photo without the shutter sound. The expert is in the middle of a sentence.
  fake.clock.now += 1_000
  coach.heard("I hold the rope in my left hand.", true)
  coach.heard("Then I", false)
  const assistantBefore = fake.of("assistantState").length
  coach.tick()
  // The screen is not told about a silent photo: not busy, not thinking.
  expect(coach.snapshot().busy).toBe(false)
  expect(coach.snapshot().assistant).toBe("listening")
  await coach.whenIdle()
  expect(fake.photoCalls).toEqual([{sound: false}])
  expect(fake.said).toHaveLength(saidSoFar)
  expect(fake.of("assistantState")).toHaveLength(assistantBefore)
  expect(fake.last("photoCapture")).toEqual({photoUrl: "https://photos.example/p1.jpg", frameIndex: 1, timestampSeconds: 20, kind: "auto"})
  // The words said so far went into the timed capture. It is not a step.
  expect(fake.last("teachingState")).toMatchObject({frameCount: 1, stepCount: 0, narration: ""})
  expect(fake.kept.has(`shot-${fake.last("teachingState")!.sessionId}-1`)).toBe(true)
  coach.heard("Then I make a loop.", true)

  // Not while a command runs: "save this step" is waiting for its photo.
  const letPhotoFinish = fake.holdPhoto()
  coach.command("captureStep", {})
  fake.clock.now += 30_000
  coach.tick()
  coach.tick()
  expect(fake.photoCalls).toHaveLength(2) // the timed one from before, and the step photo in progress
  letPhotoFinish()
  await coach.whenIdle()
  expect(fake.said.at(-1)).toBe("Step 1 saved.")

  // The 20 seconds count from the last photo of either kind: the step photo was taken just now.
  coach.tick()
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(2)

  // Not while the app speaks either, even though a timed photo is due by then.
  const letSpeechFinish = fake.holdSpeech()
  coach.command("captureStep", {})
  await flush()
  expect(coach.snapshot().assistant).toBe("speaking")
  fake.clock.now += 25_000
  coach.tick()
  expect(fake.photoCalls).toHaveLength(3)
  letSpeechFinish()
  await coach.whenIdle()
  expect(fake.said.at(-1)).toBe("Step 2 saved.")
  // It is taken on the first tick after the command has ended.
  coach.tick()
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(4)
  expect(fake.photoCalls.at(-1)).toEqual({sound: false})
  fake.clock.now += 19_000
  coach.tick()
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(4)

  // A timed photo that fails adds nothing, says nothing, and the wait starts again.
  fake.photoFails = true
  fake.clock.now += 1_000
  const linesBefore = coach.snapshot().transcript.length
  coach.tick()
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(5)
  expect(fake.last("teachingState")).toMatchObject({frameCount: 4, stepCount: 2})
  expect(coach.snapshot().transcript).toHaveLength(linesBefore)
  coach.tick()
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(5)
  fake.photoFails = false
  fake.clock.now += 20_000
  coach.tick()
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(6)
  expect(fake.photoCalls.at(-1)).toEqual({sound: false})
  expect(fake.last("photoCapture")).toMatchObject({frameIndex: 5, kind: "auto"})
  expect(fake.said).toHaveLength(saidSoFar + 2) // only the two "Step N saved." sentences
})

test("a command given during a silent timed photo is not lost", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  await tap(rig, "startTeaching")
  fake.clock.now += 20_000
  const letPhotoFinish = fake.holdPhoto()
  coach.tick() // the timed photo starts and hangs
  coach.heard("I fold the cloth in half. Next step.", true) // the expert cannot know a photo is being taken
  await flush()
  expect(fake.photoCalls).toEqual([{sound: false}])
  letPhotoFinish()
  await coach.whenIdle()
  expect(fake.photoCalls).toEqual([{sound: false}, {sound: true}])
  expect(fake.said.at(-1)).toBe("Step 1 saved.")
  expect(fake.last("teachingState")).toMatchObject({frameCount: 2, stepCount: 1, narration: ""})

  // What was said while the timed photo was being taken belongs to the step, not to the timed photo.
  await tap(rig, "stopTeaching")
  expect(mind.of("buildLesson")[0]!.input.captures).toEqual([
    {transcript: "", atSeconds: 20, kind: "auto", image: {kind: "url", url: "https://photos.example/p1.jpg"}},
    {transcript: "I fold the cloth in half.", atSeconds: 20, kind: "step", image: {kind: "url", url: "https://photos.example/p2.jpg"}},
  ])
})

test("Claude gets at most 12 photos: every step photo first, then timed photos spread evenly", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  await tap(rig, "startTeaching")
  for (let i = 0; i < 3; i++) {
    fake.clock.now += 5_000
    await tap(rig, "captureStep")
  }
  // Timed photos until the recording is full. The second one gets some words.
  for (let i = 0; i < 45; i++) {
    fake.clock.now += 20_000
    if (i === 1) coach.heard("A detail about the second knot.", true)
    coach.tick()
    await coach.whenIdle()
  }
  expect(fake.photos).toBe(40) // 3 steps and 37 timed photos, then no more
  expect(fake.last("teachingState")).toMatchObject({frameCount: 40, stepCount: 3})

  await tap(rig, "stopTeaching")
  expect(fake.photos).toBe(40) // nothing was left to save, so no extra photo
  const captures: CaptureInput[] = mind.of("buildLesson")[0]!.input.captures
  expect(captures).toHaveLength(40)
  expect(captures.map((capture) => capture.kind)).toEqual([...Array(3).fill("step"), ...Array(37).fill("auto")])
  const withPhoto = captures.flatMap((capture, i) => (capture.image ? [i] : []))
  expect(withPhoto).toHaveLength(12)
  expect(withPhoto.slice(0, 3)).toEqual([0, 1, 2]) // every step photo
  expect(withPhoto[3]).toBe(3) // the first timed photo
  expect(withPhoto.at(-1)).toBe(39) // and the last one
  const gaps = withPhoto.slice(4).map((index, i) => index - withPhoto[i + 3]!)
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1) // evenly spread
  // A capture that lost its photo keeps its words.
  expect(captures[4]).toEqual({transcript: "A detail about the second knot.", atSeconds: expect.any(Number), kind: "auto", image: null})

  // Kept copies that no step of the draft uses are deleted from the phone.
  const id = fake.last("teachingState")!.sessionId
  expect([...fake.kept.keys()].sort()).toEqual([`shot-${id}-1`, `shot-${id}-2`, `shot-${id}-3`])
})

test("with more than 12 step photos, 12 of them are sent", async () => {
  const rig = await start()
  const {mind} = rig
  await tap(rig, "startTeaching")
  for (let i = 0; i < 14; i++) await tap(rig, "captureStep")
  await tap(rig, "stopTeaching")
  const captures: CaptureInput[] = mind.of("buildLesson")[0]!.input.captures
  const withPhoto = captures.flatMap((capture, i) => (capture.image ? [i] : []))
  expect(captures).toHaveLength(14)
  expect(withPhoto).toHaveLength(12)
  expect(withPhoto[0]).toBe(0)
  expect(withPhoto.at(-1)).toBe(13)
})

test("when Claude fails to build the lesson, the recording is kept and the error is shown", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  mind.failStatus = 529
  await teachThreeSteps(rig)

  expect(fake.said.at(-1)).toBe("I could not build the lesson. Say finish lesson to try again.")
  expect(fake.last("tutorialGenerated")).toEqual({status: "error", error: "The lesson was not built. Overloaded"})
  expect(fake.last("teachingState")).toEqual({
    status: "recording",
    elapsedSeconds: 15,
    frameCount: 3,
    stepCount: 3,
    narration: "",
    sessionId: "1003000",
    error: "The lesson was not built. Overloaded",
  })
  expect(coach.snapshot().draft).toBeNull()
  expect(fake.kept.size).toBe(3)
  expect(coach.snapshot().busy).toBe(false)

  // The same two words one second later are still the echo of "Say finish lesson to try again".
  mind.failStatus = null
  await hear(rig, "Finish lesson.", 1000)
  expect(mind.of("buildLesson")).toHaveLength(1)
  // Said by the expert a moment later, they are the command.
  await hear(rig, "Finish lesson.", 2000)
  expect(fake.said.at(-1)).toBe(LESSON_READY_3)
  expect(fake.last("teachingState")).toMatchObject({status: "review"})
  expect(fake.last("teachingState")!.error).toBeUndefined()
  expect(fake.photos).toBe(3) // no extra photos on the retry
  expect(mind.of("buildLesson")[1]!.input).toEqual(mind.of("buildLesson")[0]!.input)
})

test("a lesson Claude wrote without steps or without an instruction is refused, not saved", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  mind.draft = (captures) => ({...defaultDraft(captures), steps: []})
  await tap(rig, "startTeaching")
  await hear(rig, "I tie a knot. Next step.")
  await tap(rig, "stopTeaching")
  expect(fake.last("tutorialGenerated")).toEqual({status: "error", error: "The lesson was not built. Claude returned a lesson with no steps."})
  expect(fake.last("teachingState")).toMatchObject({status: "recording", stepCount: 1})

  mind.draft = (captures) => {
    const draft = defaultDraft(captures)
    draft.steps[0]!.instruction_spoken = "   "
    return draft
  }
  await tap(rig, "stopTeaching")
  expect(fake.last("tutorialGenerated")).toEqual({status: "error", error: "The lesson was not built. Claude left step 1 without an instruction."})
  expect(coach.snapshot().draft).toBeNull()
  expect(coach.snapshot().tutorials.map((lesson) => lesson.id)).toEqual([BUILT_IN.id])
})

test("finish with nothing recorded says so and keeps recording", async () => {
  const rig = await start()
  const {fake, mind} = rig
  await tap(rig, "startTeaching")
  fake.photoFails = true // no words and no photo: there is nothing to build a lesson from
  await tap(rig, "stopTeaching")
  expect(fake.said.at(-1)).toBe("Nothing is recorded yet. Do a step and explain it, then say next step to save it.")
  expect(fake.last("teachingState")).toMatchObject({status: "recording", frameCount: 0, stepCount: 0})
  expect(mind.of("buildLesson")).toHaveLength(0)
})

test("a failed photo does not break teaching or checking", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  await tap(rig, "startTeaching")
  fake.photoFails = true
  await hear(rig, "I fold the cloth in half. Next step.")
  expect(fake.said.at(-1)).toBe("Step 1 saved without a photo.")
  expect(lines(coach.snapshot())).toContain("system: Photo failed. glasses not connected")
  expect(fake.of("photoCapture")).toHaveLength(0)
  expect(fake.last("teachingState")).toMatchObject({frameCount: 0, stepCount: 1})

  // The lesson is built from the words alone. The step has a time but no photo.
  await tap(rig, "stopTeaching")
  expect(mind.of("buildLesson")[0]!.input.captures).toEqual([{transcript: "I fold the cloth in half.", atSeconds: 3, kind: "step", image: null}])
  const step = coach.snapshot().draft!.steps[0]!
  expect(step.source_timestamp_seconds).toBe(3)
  expect(step.reference_image_url).toBeUndefined()
  expect(step.photo_key).toBeUndefined()
  expect(step.photo_taken_at).toBeUndefined()

  await hear(rig, "Publish lesson.")
  await hear(rig, "Start lesson.")
  await hear(rig, "check")
  expect(fake.said.at(-1)).toBe("I could not take a photo. Say check to try again.")
  expect(coach.snapshot().learning!.currentStep).toBe(1)
  expect(mind.of("checkStep")).toHaveLength(0)

  fake.photoFails = false
  await hear(rig, "check")
  expect(mind.of("checkStep")[0]!.input.reference).toBeNull() // the expert's step had no photo
  expect(fake.said.at(-1)).toBe("Nice work. That was the last step. You finished Making matcha.")
})

test("discard deletes the kept photos, of a recording and of a draft", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig

  // A recording, discarded by voice.
  await hear(rig, "Start teaching.")
  await hear(rig, "I fold the cloth. Next step.")
  await hear(rig, "And again. Next step.")
  expect(fake.kept.size).toBe(2)
  await hear(rig, "Cancel the lesson.")
  expect(fake.said.at(-1)).toBe("Recording discarded.")
  expect(fake.kept.size).toBe(0)
  expect(fake.last("teachingState")).toEqual(IDLE_TEACHING)
  expect(mind.of("buildLesson")).toHaveLength(0)

  // A draft, discarded from the phone screen.
  await teachThreeSteps(rig)
  expect(fake.kept.size).toBe(3)
  expect(coach.snapshot().draft).not.toBeNull()
  await tap(rig, "discardTeaching")
  expect(fake.said.at(-1)).toBe("Draft discarded.")
  expect(fake.kept.size).toBe(0)
  expect(coach.snapshot().draft).toBeNull()
  expect(fake.last("teachingState")).toEqual(IDLE_TEACHING)
  expect(fake.storage.has("library")).toBe(false)

  // "Discard" tapped while Claude is still writing: it is remembered and runs when the draft arrives.
  await hear(rig, "Start teaching.")
  await hear(rig, "I fold the cloth. Next step.")
  const letClaudeAnswer = mind.hold()
  coach.command("stopTeaching", {})
  await flush()
  expect(coach.snapshot().teaching.status).toBe("processing")
  coach.command("discardTeaching", {})
  letClaudeAnswer()
  await coach.whenIdle()
  expect(fake.said.slice(-2)).toEqual(["Lesson ready. Making matcha. It has 1 step. Say publish lesson to save it, or review it on the phone.", "Draft discarded."])
  expect(coach.snapshot().draft).toBeNull()
  expect(coach.snapshot().teaching.status).toBe("idle")
  expect(fake.kept.size).toBe(0)
})

test("the library holds 20 recorded lessons: one more removes the oldest and its photos", async () => {
  const lessons = Array.from({length: 20}, (_, i) => savedLesson(`tut_old_${i}`, `Old lesson ${i}`))
  lessons[19]!.steps[0]!.photo_key = "shot-old-19-1" // the oldest lesson is last
  const kept = new Map([["shot-old-19-1", JPEG]])
  const rig = await start({storage: libraryOnPhone(...lessons), kept})
  const {fake, coach} = rig
  expect(coach.snapshot().tutorials).toHaveLength(21)

  await teachAndPublish(rig)
  const ids = coach.snapshot().tutorials.map((lesson) => lesson.id)
  expect(ids).toHaveLength(21) // 20 recorded and the built-in one
  expect(ids[0]).toBe("tut_1003000")
  expect(ids).not.toContain("tut_old_19")
  expect(ids.at(-1)).toBe(BUILT_IN.id)
  expect(fake.kept.has("shot-old-19-1")).toBe(false)
  expect(JSON.parse(fake.storage.get("library")!)).toHaveLength(20)
})

// ---------- learning ----------

test("learn by voice: a fix and an unclear photo stay on the step, a pass moves on", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  const lesson = await teachAndPublish(rig)
  mind.verdicts = [
    {result: "fix", say: "Sift the powder first."},
    {result: "pass", say: "Good."},
    {result: "unclear", say: "Look at the bowl and try again."},
  ]

  await hear(rig, "Start lesson.")
  expect(fake.said.at(-1)).toBe("Making matcha. Say check when a step is done. Step 1. Do thing 1.")
  expect(fake.last("learningState")).toMatchObject({
    active: true,
    finished: false,
    tutorialId: "tut_1003000",
    currentStep: 1,
    totalSteps: 3,
    stepData: lesson.steps[0],
  })
  expect(lines(coach.snapshot())).toContain("system: Started: Making matcha")
  expect(fake.vocabulary.at(-1)).toEqual(["Making", "matcha", "bowl", "whisk", "powder"])
  expect(coach.snapshot().lastVerdict).toBeNull()

  // A fix: red light, the correction is spoken, the step stays.
  await hear(rig, "Okay, I think I'm done.")
  expect(fake.photoCalls.at(-1)).toEqual({sound: true})
  expect(fake.said.at(-1)).toBe("Sift the powder first.")
  expect(fake.lights.at(-1)).toBe("redx2")
  expect(fake.last("stepVerdict")).toEqual({step: 1, result: "fix", say: "Sift the powder first.", photoUrl: "https://photos.example/p4.jpg"})
  expect(coach.snapshot().lastVerdict).toEqual(fake.last("stepVerdict")!)
  expect(coach.snapshot().learning!.currentStep).toBe(1)
  // What Claude was asked: the step, the expert's photo, the learner's photo, and what the learner said.
  expect(mind.of("checkStep")[0]).toEqual({
    method: "checkStep",
    apiKey: GOOD_KEY,
    input: {
      tutorialTitle: "Making matcha",
      step: lesson.steps[0],
      learner: {kind: "url", url: "https://photos.example/p4.jpg"},
      reference: {kind: "url", url: "https://photos.example/p1.jpg"},
      heard: "Okay, I think I'm done.",
    },
  })
  expect(fake.kept.size).toBe(3) // the learner's photo is not kept

  // A pass: green light, and the praise and the next step are ONE spoken sentence group.
  const spokenBefore = fake.said.length
  await hear(rig, "check")
  expect(fake.said.slice(spokenBefore)).toEqual(["Good. Step 2. Do thing 2."])
  expect(fake.lights.at(-1)).toBe("greenx2")
  expect(fake.last("stepVerdict")).toMatchObject({step: 1, result: "pass", say: "Good."})
  expect(fake.last("learningState")).toMatchObject({active: true, currentStep: 2, stepData: lesson.steps[1]})
  expect(coach.snapshot().transcript.at(-1)).toMatchObject({speaker: "tinker", text: "Good. Step 2. Do thing 2.", timestamp: "Step 2", step: 2})

  // An unclear photo: orange light, stay.
  await tap(rig, "checkStep")
  expect(fake.said.at(-1)).toBe("Look at the bowl and try again.")
  expect(fake.lights.at(-1)).toBe("orangex2")
  expect(fake.last("stepVerdict")).toMatchObject({step: 2, result: "unclear"})
  expect(coach.snapshot().learning!.currentStep).toBe(2)
  expect(mind.of("checkStep")[2]!.input).toMatchObject({step: lesson.steps[1], heard: ""}) // tapped, not spoken
})

test("a pass on the last step ends the lesson", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  await teachAndPublish(rig)
  mind.verdicts = [{result: "pass", say: "Good."}, {result: "pass", say: "Good."}, {result: "pass", say: "Lovely foam."}]
  await hear(rig, "Start lesson.")
  await hear(rig, "done")
  await hear(rig, "finished")
  expect(coach.snapshot().learning!.currentStep).toBe(3)

  await hear(rig, "Is this right?")
  expect(fake.said.at(-1)).toBe("Lovely foam. That was the last step. You finished Making matcha.")
  expect(fake.lights.at(-1)).toBe("greenx2")
  expect(fake.last("stepVerdict")).toMatchObject({step: 3, result: "pass", say: "Lovely foam."})
  expect(fake.last("learningState")).toMatchObject({active: false, finished: true, tutorialId: "tut_1003000", currentStep: 3, totalSteps: 3})
  expect(coach.snapshot().learning).toBeNull()

  // The lesson is over: "check" is no command any more.
  const photos = fake.photoCalls.length
  await hear(rig, "check")
  expect(fake.photoCalls).toHaveLength(photos)
  expect(mind.of("checkStep")).toHaveLength(3)
})

test("when Claude cannot check, the step stays and the reason is on the screen", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  await hear(rig, "Start lesson.") // the built-in lesson
  mind.failStatus = 529
  await hear(rig, "check")
  expect(fake.said.at(-1)).toBe("I could not check that. Say check to try again.")
  expect(lines(coach.snapshot()).at(-2)).toBe("system: The check failed. Overloaded")
  expect(fake.of("stepVerdict")).toHaveLength(0)
  expect(coach.snapshot().learning!.currentStep).toBe(1)
  expect(coach.snapshot().busy).toBe(false)

  // An error that is not a BrainError, and an answer that makes no sense, end the same way.
  mind.failStatus = null
  mind.failError = new Error("boom")
  await hear(rig, "check")
  expect(lines(coach.snapshot()).at(-2)).toBe("system: The check failed. boom")
  mind.failError = null
  mind.verdicts = [{result: "maybe" as Verdict["result"], say: "Hm."}]
  await hear(rig, "check")
  expect(fake.said.at(-1)).toBe("I could not check that. Say check to try again.")
  expect(fake.of("stepVerdict")).toHaveLength(0)
  expect(coach.snapshot().busy).toBe(false)

  // The built-in lesson has no expert photos, so Claude gets the learner's photo only.
  await hear(rig, "check")
  expect(mind.of("checkStep").at(-1)!.input).toMatchObject({tutorialTitle: BUILT_IN.title, reference: null, step: BUILT_IN.steps[0]})
  expect(fake.last("learningState")).toMatchObject({currentStep: 2})
})

test("next, previous, repeat, why, tips and materials need no key, no photo and no Claude", async () => {
  const bare = savedLesson("tut_bare", "A bare lesson")
  const knot = savedLesson("tut_knot", "Tying a bowline", {
    tools_required: ["rope", "post", "gloves", "knife", "tape"],
    ingredients_required: ["wax", "oil", "chalk", "a ninth thing"],
  })
  const rig = await start({key: false, storage: libraryOnPhone(knot, bare)})
  const {fake, mind, coach} = rig

  await hear(rig, "Start lesson.") // by voice: the first lesson of the library
  expect(fake.said.at(-1)).toBe("Tying a bowline. Say check when a step is done. Step 1. Make a small loop in the rope.")
  expect(fake.last("learningState")).toMatchObject({tutorialId: "tut_knot", currentStep: 1, totalSteps: 3})

  await hear(rig, "Why?")
  expect(fake.said.at(-1)).toBe("Sailors have tied it this way for centuries.")
  await hear(rig, "Any tips?")
  expect(fake.said.at(-1)).toBe("Keep the loop small. Hold it with your thumb.") // two at most
  await hear(rig, "What do I need?")
  expect(fake.said.at(-1)).toBe("You need rope, post, gloves, knife, tape, wax, oil and chalk.") // eight at most
  await hear(rig, "Go back.")
  expect(fake.said.at(-1)).toBe("This is the first step. Step 1. Make a small loop in the rope.")
  expect(coach.snapshot().learning!.currentStep).toBe(1)

  await hear(rig, "Next step.")
  expect(fake.said.at(-1)).toBe("Step 2. Pass the end up through the loop.")
  expect(fake.last("learningState")).toMatchObject({active: true, currentStep: 2, stepData: knot.steps[1]})
  await hear(rig, "Tell me why.")
  expect(fake.said.at(-1)).toBe("Up through the loop means from below.") // no story: the written explanation
  await hear(rig, "Repeat.")
  expect(fake.said.at(-1)).toBe("Step 2. Pass the end up through the loop.")

  await tap(rig, "navigateStep", {direction: "next"})
  expect(fake.said.at(-1)).toBe("Step 3. Pull the knot tight.")
  await hear(rig, "Why this step?")
  expect(fake.said.at(-1)).toBe("The expert gave no reason for this step.")
  await hear(rig, "Tips")
  expect(fake.said.at(-1)).toBe("There are no tips for this step.")
  await tap(rig, "navigateStep", {direction: "previous"})
  expect(fake.said.at(-1)).toBe("Step 2. Pass the end up through the loop.")
  expect(fake.last("learningState")).toMatchObject({currentStep: 2})
  await tap(rig, "navigateStep", {direction: "repeat"})
  expect(fake.said.at(-1)).toBe("Step 2. Pass the end up through the loop.")
  await tap(rig, "navigateStep", {direction: "sideways"}) // not a direction: nothing happens
  expect(fake.said.at(-1)).toBe("Step 2. Pass the end up through the loop.")

  // "skip" and "next" as whole sentences. On the last step, next ends the lesson as finished.
  await hear(rig, "Skip.")
  expect(fake.last("learningState")).toMatchObject({currentStep: 3})
  await hear(rig, "Next.")
  expect(fake.said.at(-1)).toBe("That was the last step. You finished Tying a bowline.")
  expect(fake.last("learningState")).toMatchObject({active: false, finished: true, tutorialId: "tut_knot"})
  expect(coach.snapshot().learning).toBeNull()

  // A lesson picked on the phone screen, by its id. It lists no materials.
  await tap(rig, "startLearning", {tutorialId: "tut_bare"})
  expect(fake.last("learningState")).toMatchObject({active: true, tutorialId: "tut_bare", currentStep: 1})
  await hear(rig, "What do I need?")
  expect(fake.said.at(-1)).toBe("This lesson lists no materials.")
  await hear(rig, "Stop lesson.")
  expect(fake.said.at(-1)).toBe("Lesson stopped.")
  expect(fake.last("learningState")).toMatchObject({active: false, finished: false, tutorialId: "tut_bare"})

  // A lesson that is not on the phone.
  await tap(rig, "startLearning", {tutorialId: "tut_gone"})
  expect(fake.said.at(-1)).toBe("That lesson is not on this phone.")
  expect(coach.snapshot().learning).toBeNull()

  expect(fake.photoCalls).toHaveLength(0)
  expect(mind.calls).toHaveLength(0)
})

test("a question with the name Tinker, and a typed question, are answered by Claude", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  await hear(rig, "Start lesson.") // the built-in lesson
  const intro = fake.said.at(-1)!
  mind.answers = ["About eighty degrees.", "It breaks up the lumps."]

  // Spoken. While Claude works the screen shows "thinking".
  const seen: Array<{assistant: string; busy: boolean}> = []
  mind.during = () => seen.push({assistant: coach.snapshot().assistant, busy: coach.snapshot().busy})
  await hear(rig, "Hey Tinker, how hot should the water be?")
  mind.during = null
  expect(seen).toEqual([{assistant: "thinking", busy: true}])
  expect(fake.said.at(-1)).toBe("About eighty degrees.")
  expect(mind.of("answer")[0]).toEqual({
    method: "answer",
    apiKey: GOOD_KEY,
    input: {
      tutorial: BUILT_IN,
      stepNumber: 1,
      question: "how hot should the water be?",
      // What was said before the question. Notes for the screen and the question itself are left out.
      recent: [
        {speaker: "user", text: "Start lesson."},
        {speaker: "tinker", text: intro},
      ],
    },
  })
  expect(coach.snapshot().transcript.slice(-2)).toEqual([
    {id: expect.any(String), speaker: "user", text: "Hey Tinker, how hot should the water be?", isFinal: true, timestamp: "You", step: 1},
    {id: expect.any(String), speaker: "tinker", text: "About eighty degrees.", isFinal: true, timestamp: "Step 1", step: 1},
  ])

  // Typed on the phone. The question is added to the conversation first.
  await tap(rig, "askTinker", {text: "  Why sift the powder?  "})
  expect(fake.said.at(-1)).toBe("It breaks up the lumps.")
  expect(lines(coach.snapshot()).slice(-2)).toEqual(["user: Why sift the powder?", "tinker: It breaks up the lumps."])
  expect(mind.of("answer")[1]!.input).toMatchObject({
    question: "Why sift the powder?",
    recent: [
      {speaker: "user", text: "Start lesson."},
      {speaker: "tinker", text: intro},
      {speaker: "user", text: "Hey Tinker, how hot should the water be?"},
      {speaker: "tinker", text: "About eighty degrees."},
    ],
  })

  // Claude gets the last six lines at most, oldest first.
  await tap(rig, "askTinker", {text: "And then?"})
  await tap(rig, "askTinker", {text: "And after that?"})
  const recent = mind.of("answer").at(-1)!.input.recent
  expect(recent).toEqual([
    {speaker: "user", text: "Hey Tinker, how hot should the water be?"},
    {speaker: "tinker", text: "About eighty degrees."},
    {speaker: "user", text: "Why sift the powder?"},
    {speaker: "tinker", text: "It breaks up the lumps."},
    {speaker: "user", text: "And then?"},
    {speaker: "tinker", text: "About eighty degrees, not boiling."},
  ])

  // Without the name, a sentence that is no command is not answered. It only shows on the screen.
  const asked = mind.of("answer").length
  const spoken = fake.said.length
  await hear(rig, "How hot should the water be?")
  expect(mind.of("answer")).toHaveLength(asked)
  expect(fake.said).toHaveLength(spoken)
  expect(lines(coach.snapshot()).at(-1)).toBe("user: How hot should the water be?")

  // Claude fails: the reason goes on the screen, a short sentence is spoken, the lesson goes on.
  mind.failStatus = 500
  mind.failMessage = "Server error"
  await hear(rig, "Tinker, what is a chasen?")
  expect(fake.said.at(-1)).toBe("I could not answer that. Ask again.")
  expect(lines(coach.snapshot()).slice(-2)).toEqual(["system: The question failed. Server error", "tinker: I could not answer that. Ask again."])
  expect(coach.snapshot().learning!.active).toBe(true)
  expect(coach.snapshot().busy).toBe(false)
  mind.failStatus = null

  // An empty typed question does nothing. A typed question with no lesson running is refused.
  const before = mind.of("answer").length
  await tap(rig, "askTinker", {text: "   "})
  expect(mind.of("answer")).toHaveLength(before)
  await tap(rig, "endLearning")
  await tap(rig, "askTinker", {text: "Why sift the powder?"})
  expect(fake.said.at(-1)).toBe("Start a lesson first.")
  expect(mind.of("answer")).toHaveLength(before)
})

test("the name alone gets a short reply, and the next sentence is the question", async () => {
  const rig = await start()
  const {fake, mind} = rig
  await hear(rig, "Start lesson.")

  await hear(rig, "Hey Tinker.")
  expect(fake.said.at(-1)).toBe("Yes?")
  expect(mind.of("answer")).toHaveLength(0)
  // One word alone is no question. It may be the app hearing its own "Yes?".
  await hear(rig, "Yes", 1000)
  expect(mind.of("answer")).toHaveLength(0)
  await hear(rig, "How long do I whisk?", 2000)
  expect(mind.of("answer")[0]!.input.question).toBe("How long do I whisk?")
  expect(fake.said.at(-1)).toBe("About eighty degrees, not boiling.")

  // The invitation lasts 8 seconds and is used up by one question.
  await hear(rig, "And how much water?")
  expect(mind.of("answer")).toHaveLength(1)
  await hear(rig, "Okay Tinker")
  expect(fake.said.at(-1)).toBe("Yes?")
  await hear(rig, "How long do I whisk?", 9000)
  expect(mind.of("answer")).toHaveLength(1)
})

test("without a key, questions and checks are refused and nothing is sent to Claude", async () => {
  const rig = await start({key: false})
  const {fake, mind, coach} = rig
  await hear(rig, "Start lesson.") // starting needs no key
  expect(coach.snapshot().learning).toMatchObject({active: true, tutorialId: BUILT_IN.id})

  await hear(rig, "Tinker, how hot should the water be?")
  expect(fake.said.at(-1)).toBe("Add the Claude key on the phone screen to ask questions.")
  await tap(rig, "askTinker", {text: "Why sift?"})
  expect(fake.said.at(-1)).toBe("Add the Claude key on the phone screen to ask questions.")
  expect(lines(coach.snapshot())).toContain("user: Why sift?")
  await hear(rig, "check")
  expect(fake.said.at(-1)).toBe("Add the Claude key on the phone screen to use checks.")
  await hear(rig, "Hey Tinker")
  expect(fake.said.at(-1)).toBe("Add the Claude key on the phone screen to ask questions.")

  expect(mind.calls).toHaveLength(0)
  expect(fake.photoCalls).toHaveLength(0)
  expect(coach.snapshot().learning!.currentStep).toBe(1)
})

test("teaching and learning never run at the same time", async () => {
  const rig = await start()
  const {fake, coach} = rig

  await hear(rig, "Start lesson.")
  await tap(rig, "startTeaching", {targetSkill: "knots"})
  expect(fake.said.at(-1)).toBe("Stop the lesson first.")
  expect(coach.snapshot().learning!.active).toBe(true)
  expect(coach.snapshot().teaching.status).toBe("idle")
  await tap(rig, "endLearning")

  await tap(rig, "startTeaching")
  await tap(rig, "startLearning", {tutorialId: BUILT_IN.id})
  expect(fake.said.at(-1)).toBe("Finish or cancel the recording first.")
  expect(coach.snapshot().teaching.status).toBe("recording")
  expect(coach.snapshot().learning).toBeNull()
  // A second "start" on the same side does nothing.
  const spoken = fake.said.length
  await tap(rig, "startTeaching")
  expect(fake.said).toHaveLength(spoken)

  await hear(rig, "I fold the cloth. Next step.")
  await tap(rig, "stopTeaching")
  expect(coach.snapshot().teaching.status).toBe("review")
  await tap(rig, "startLearning", {tutorialId: BUILT_IN.id})
  expect(fake.said.at(-1)).toBe("Finish or cancel the recording first.")
  expect(coach.snapshot().teaching.status).toBe("review")
})

// ---------- the microphone ----------

test("the app does not react to its own voice", async () => {
  const rig = await start()
  const {fake, coach} = rig
  await hear(rig, "Start teaching.")
  const linesBefore = coach.snapshot().transcript.length

  // No clock advance: this arrives inside the quiet gap right after the app spoke.
  coach.heard("Say next step when it is finished. Next step.", true)
  coach.heard("half a sentence that is not final", false)
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(0)
  expect(coach.snapshot().teaching.narration).toBe("")
  expect(coach.snapshot().transcript).toHaveLength(linesBefore)
  expect(coach.snapshot().assistant).toBe("idle")

  // While the app is speaking, everything is ignored too, however late it is.
  const letSpeechFinish = fake.holdSpeech()
  coach.command("testAudio", {})
  await flush()
  fake.clock.now += 60_000
  coach.heard("I fold the cloth. Next step.", true)
  letSpeechFinish()
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(0)
  expect(coach.snapshot().teaching.narration).toBe("")
  expect(fake.said.at(-1)).toBe("This is the Tinker audio check. If you hear this in the glasses, sound works.")
})

test("an echo of the app's own sentence is dropped for 10 seconds, a real sentence is not", async () => {
  const rig = await start()
  const {fake, coach} = rig
  await tap(rig, "startTeaching")
  fake.clock.now += 15_000 // the instructions are out of the echo window
  await tap(rig, "captureStep")
  expect(fake.said.at(-1)).toBe("Step 1 saved.")
  const linesBefore = coach.snapshot().transcript.length
  const eventsBefore = fake.events.length

  // Two seconds later, well past the quiet gap, speech-to-text delivers the app's own words.
  fake.clock.now += 2_000
  coach.heard("Step 1 saved.", true)
  coach.heard("Step one saved", true) // the same words as speech-to-text may write them
  coach.heard("step 1", false) // pieces of the sentence, finished or not
  coach.heard("1 saved", true)
  await coach.whenIdle()
  expect(coach.snapshot().teaching.narration).toBe("")
  expect(coach.snapshot().transcript).toHaveLength(linesBefore)
  expect(fake.events).toHaveLength(eventsBefore) // nothing at all reached the screen
  expect(fake.photoCalls).toHaveLength(1)

  // A real sentence in the same window is heard, and its command runs.
  coach.heard("Now I pour the water. Next step.", true)
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(2)
  expect(fake.said.at(-1)).toBe("Step 2 saved.")
  expect(lines(coach.snapshot())).toContain("user: Now I pour the water. Next step.")

  // The same words again: an echo for 10 seconds after the speech ended, then a sentence like any other.
  fake.clock.now += 9_999
  coach.heard("Step 2 saved", true)
  expect(coach.snapshot().teaching.narration).toBe("")
  fake.clock.now += 1
  coach.heard("Step 2 saved", true)
  expect(coach.snapshot().teaching.narration).toBe("Step 2 saved")
})

test("an echo that ends in command words cannot start a command", async () => {
  const rig = await start()
  const {fake, coach} = rig
  await tap(rig, "startTeaching")
  expect(fake.said.at(-1)).toBe(RECORDING_INTRO)

  // Pieces of the instructions that END in a command, one second after they were spoken.
  fake.clock.now += 1_000
  coach.heard("Say next step", true)
  coach.heard("Do one step and explain it. Say next step", true)
  coach.heard("when it is finished say finish lesson", true)
  coach.heard("next step", true) // even the bare command: this soon it can only be the echo
  coach.heard("say next step when ready", true) // 4 of its 5 words are the app's, in order: exactly 80 percent
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(0)
  expect(coach.snapshot().teaching).toMatchObject({status: "recording", stepCount: 0, narration: ""})
  // 4 of 6 words is not enough to call it an echo. The expert's sentence is kept.
  coach.heard("Do one step and fold this", true)
  expect(coach.snapshot().teaching.narration).toBe("Do one step and fold this")

  // Later, a longer piece is still an echo. The bare command is the expert answering.
  fake.clock.now += 2_000
  coach.heard("Say next step", true)
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(0)
  coach.heard("Next step.", true)
  await coach.whenIdle()
  expect(fake.photoCalls).toHaveLength(1)
  expect(fake.said.at(-1)).toBe("Step 1 saved.")
  expect(fake.last("teachingState")).toMatchObject({stepCount: 1, narration: ""})
})

test("an unfinished sentence and its finished version are one conversation line", async () => {
  const rig = await start()
  const {fake, coach} = rig

  coach.heard("Start", false)
  coach.heard("Start teach", false)
  expect(coach.snapshot().assistant).toBe("listening")
  expect(coach.snapshot().busy).toBe(false)
  coach.heard("Start teaching.", true)
  await coach.whenIdle()

  const updates = fake.of("transcriptionUpdate")
  expect(updates.slice(0, 3)).toEqual([
    {id: updates[0]!.id, speaker: "user", text: "Start", isFinal: false, timestamp: "You"},
    {id: updates[0]!.id, speaker: "user", text: "Start teach", isFinal: false, timestamp: "You"},
    {id: updates[0]!.id, speaker: "user", text: "Start teaching.", isFinal: true, timestamp: "You"},
  ])
  expect(updates[3]).toEqual({id: expect.any(String), speaker: "tinker", text: RECORDING_INTRO, isFinal: true, timestamp: "Tinker"})
  expect(updates[3]!.id).not.toBe(updates[0]!.id)
  expect(lines(coach.snapshot())).toEqual(["user: Start teaching.", `tinker: ${RECORDING_INTRO}`])
  // Listening on the first piece. The command takes over without an "idle" in between.
  expect(fake.of("assistantState")).toEqual([{state: "listening"}, {state: "speaking"}, {state: "idle"}])

  // A sentence without a command: listening, then idle.
  fake.clock.now += 3_000
  coach.heard("First I", false)
  coach.heard("First I sift the powder.", true)
  expect(fake.of("assistantState").slice(-2)).toEqual([{state: "listening"}, {state: "idle"}])

  // A sentence that is cut off by the app speaking is closed, so no line stays unfinished.
  fake.clock.now += 3_000
  coach.heard("And then I", false)
  const open = fake.last("transcriptionUpdate")!
  expect(open.isFinal).toBe(false)
  const letSpeechFinish = fake.holdSpeech()
  coach.command("captureStep", {})
  await flush() // the photo is taken and the app is saying "Step 1 saved."
  coach.heard("And then I whisk.", true) // the end of the sentence arrives while the app talks, and is ignored
  letSpeechFinish()
  await coach.whenIdle()
  expect(fake.of("transcriptionUpdate").filter((line) => line.id === open.id).at(-1)).toMatchObject({text: "And then I", isFinal: true})
  expect(coach.snapshot().transcript.every((line) => line.isFinal)).toBe(true)

  // Every line has its own id.
  const ids = coach.snapshot().transcript.map((line) => line.id)
  expect(new Set(ids).size).toBe(ids.length)
})

// ---------- photos for Claude ----------

test("when Claude cannot open photo links, the bytes are sent instead, and that is remembered", async () => {
  const rig = await start()
  const {fake, mind} = rig
  mind.rejectLinks = true

  await teachThreeSteps(rig)
  expect(fake.said.at(-1)).toBe(LESSON_READY_3)
  const builds = mind.of("buildLesson")
  expect(builds).toHaveLength(2) // links first, then bytes
  expect(builds[0]!.input.captures.map((capture: CaptureInput) => capture.image?.kind)).toEqual(["url", "url", "url"])
  expect(builds[1]!.input.captures.map((capture: CaptureInput) => capture.image)).toEqual([
    {kind: "base64", data: JPEG, mediaType: "image/jpeg"},
    {kind: "base64", data: JPEG, mediaType: "image/jpeg"},
    {kind: "base64", data: JPEG, mediaType: "image/jpeg"},
  ])
  // The bytes came from the copies kept on the phone, not from a download.
  expect(fake.loads).toEqual(["shot-1003000-1", "shot-1003000-2", "shot-1003000-3"])
  expect(fake.downloads).toEqual([])

  // Later calls skip the links straight away: one request, bytes for both photos.
  await hear(rig, "Publish lesson.")
  await hear(rig, "Start lesson.")
  await hear(rig, "check")
  expect(mind.of("checkStep")).toHaveLength(1)
  expect(mind.of("checkStep")[0]!.input.learner).toEqual({kind: "base64", data: JPEG, mediaType: "image/jpeg"})
  expect(mind.of("checkStep")[0]!.input.reference).toEqual({kind: "base64", data: JPEG, mediaType: "image/jpeg"})
  expect(fake.downloads).toEqual(["https://photos.example/p4.jpg"]) // the learner's photo has no kept copy
  expect(fake.loads).toHaveLength(3) // the expert's photo was still in memory
  expect(fake.said.at(-1)).toBe("Nice work. Step 2. Do thing 2.")
})

test("a status 400 that is not about the links does not make the app give up on links", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  await hear(rig, "Start lesson.")

  mind.failStatus = 400 // fails with links AND with bytes
  mind.failMessage = "Bad request"
  await hear(rig, "check")
  expect(mind.of("checkStep").map((call) => call.input.learner.kind)).toEqual(["url", "base64"])
  expect(fake.said.at(-1)).toBe("I could not check that. Say check to try again.")
  expect(lines(coach.snapshot())).toContain("system: The check failed. Bad request")

  // The retry with bytes did not succeed, so links are still tried first.
  mind.failStatus = null
  await hear(rig, "check")
  expect(mind.of("checkStep")).toHaveLength(3)
  expect(mind.of("checkStep")[2]!.input.learner).toEqual({kind: "url", url: "https://photos.example/p2.jpg"})

  // Any other failure is not retried with bytes.
  mind.failStatus = 529
  await hear(rig, "check")
  expect(mind.of("checkStep")).toHaveLength(4)
})

test("a lesson and the key survive a restart, and old photo links fall back to the kept copies", async () => {
  const rig = await start()
  await teachAndPublish(rig)

  // Restart: a new Coach on the same phone storage, one hour later.
  const later = fakeDevice({storage: rig.fake.storage, kept: rig.fake.kept})
  later.clock.now = rig.fake.clock.now + 60 * 60 * 1000
  const mind = fakeBrain()
  const coach = new Coach(later.device, mind.brain)
  await coach.load()
  const restarted: Rig = {fake: later, mind, coach}

  expect(mind.calls).toHaveLength(0) // loading does not touch the network
  expect(later.last("connectionStatus")).toMatchObject({claudeReady: true, keyHint: "1234"})
  expect(later.last("tutorialList")!.tutorials.map((lesson) => lesson.title)).toEqual(["Making matcha", BUILT_IN.title])
  expect(coach.snapshot().tutorials[0]).toMatchObject({id: "tut_1003000", status: "published", total_steps: 3})

  await hear(restarted, "Start lesson.")
  expect(later.said.at(-1)).toBe("Making matcha. Say check when a step is done. Step 1. Do thing 1.")
  await hear(restarted, "check")
  // Expert photo: the kept bytes, because its link is an hour old. Learner photo: a fresh link.
  expect(mind.of("checkStep")[0]!.input.reference).toEqual({kind: "base64", data: JPEG, mediaType: "image/jpeg"})
  expect(mind.of("checkStep")[0]!.input.learner).toEqual({kind: "url", url: "https://photos.example/p1.jpg"})
  expect(mind.of("checkStep")[0]!.apiKey).toBe(GOOD_KEY)
  expect(later.loads).toEqual(["shot-1003000-1"])
  expect(later.downloads).toEqual([])
  expect(later.said.at(-1)).toBe("Nice work. Step 2. Do thing 2.")
})

test("a damaged library on the phone does not stop the app from starting", async () => {
  const good = savedLesson("tut_good", "A good lesson")
  const storage = new Map([["library", JSON.stringify([good, null, {id: "tut_no_steps", title: "Empty", steps: []}, "text", {...BUILT_IN}])]])
  const rig = await start({key: false, storage})
  expect(rig.coach.snapshot().tutorials.map((lesson) => lesson.id)).toEqual(["tut_good", BUILT_IN.id])

  const broken = await start({key: false, storage: new Map([["library", "{not json"]])})
  expect(broken.coach.snapshot().tutorials.map((lesson) => lesson.id)).toEqual([BUILT_IN.id])
})

// ---------- one command at a time ----------

test("End session pressed while the app is speaking still ends the lesson", async () => {
  const rig = await start()
  const {fake, coach} = rig
  await hear(rig, "Start lesson.")
  const assistantBefore = fake.of("assistantState").length

  const letSpeechFinish = fake.holdSpeech()
  coach.command("navigateStep", {direction: "repeat"}) // the app starts to speak and does not stop
  await flush()
  expect(coach.snapshot()).toMatchObject({busy: true, assistant: "speaking"})

  coach.command("checkStep", {}) // an ordinary command: dropped
  coach.command("endLearning", {}) // "stop": remembered
  let idle = false
  void coach.whenIdle().then(() => (idle = true))
  await flush()
  expect(idle).toBe(false) // still speaking, and a command is waiting
  expect(coach.snapshot().learning!.active).toBe(true)

  letSpeechFinish()
  await coach.whenIdle()
  expect(fake.said.slice(-2)).toEqual([`Step 1. ${BUILT_IN.steps[0]!.instruction_spoken}`, "Lesson stopped."])
  expect(fake.last("learningState")).toMatchObject({active: false, finished: false, tutorialId: BUILT_IN.id})
  expect(coach.snapshot().learning).toBeNull()
  expect(coach.snapshot().busy).toBe(false)
  expect(fake.photoCalls).toHaveLength(0) // the dropped check never ran
  // The screen saw no "idle" between the two commands, and exactly one at the end.
  expect(fake.of("assistantState").slice(assistantBefore)).toEqual([{state: "speaking"}, {state: "idle"}])
})

test("while a command runs the screen is told thinking or speaking, never idle, and idle once at the end", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  const working = (state: {state: AssistantState}): boolean => state.state === "thinking" || state.state === "speaking"

  // A lesson build: a photo, then a sentence and the Claude request at the same time, then a sentence.
  await tap(rig, "startTeaching")
  await hear(rig, "First I sift the powder. Next step.")
  await hear(rig, "Then I whisk in a zigzag.")
  let from = fake.of("assistantState").length
  const letClaudeAnswer = mind.hold()
  coach.command("stopTeaching", {})
  await flush() // "Building the lesson." is over, Claude has not answered yet
  expect(fake.last("assistantState")).toEqual({state: "thinking", message: "Thinking"})
  expect(coach.snapshot()).toMatchObject({busy: true, assistant: "thinking"})
  letClaudeAnswer()
  await coach.whenIdle()
  let during = fake.of("assistantState").slice(from)
  expect(during).toEqual([
    {state: "thinking", message: "Taking a photo"},
    {state: "speaking"},
    {state: "thinking", message: "Thinking"},
    {state: "speaking"},
    {state: "idle"},
  ])
  expect(during.slice(0, -1).every(working)).toBe(true)
  expect(coach.snapshot()).toMatchObject({busy: false, assistant: "idle"})
  await hear(rig, "Publish lesson.")

  // A check: a photo, the Claude request, a sentence. Looked at while each one is in progress.
  await hear(rig, "Start lesson.")
  from = fake.of("assistantState").length
  const eventsFrom = fake.events.length
  const letPhotoFinish = fake.holdPhoto()
  const seen: Snapshot[] = []
  mind.during = () => seen.push(coach.snapshot())
  coach.command("checkStep", {})
  expect(coach.snapshot()).toMatchObject({busy: true, assistant: "thinking"})
  expect(fake.last("assistantState")).toEqual({state: "thinking", message: "Taking a photo"})
  letPhotoFinish()
  await coach.whenIdle()
  mind.during = null
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({busy: true, assistant: "thinking"})
  during = fake.of("assistantState").slice(from)
  expect(during).toEqual([{state: "thinking", message: "Taking a photo"}, {state: "thinking", message: "Thinking"}, {state: "speaking"}, {state: "idle"}])
  expect(during.filter((state) => state.state === "idle")).toHaveLength(1)
  expect(during.slice(0, -1).every(working)).toBe(true)
  // The step number sent during the command does not say "idle" either.
  const learningDuring = fake.events.slice(eventsFrom).filter((event) => event.channel === "learningState")
  expect(learningDuring.map((event) => event.payload.assistantState)).toEqual(["thinking"])

  // A command that only speaks.
  from = fake.of("assistantState").length
  await hear(rig, "Repeat.")
  expect(fake.of("assistantState").slice(from)).toEqual([{state: "speaking"}, {state: "idle"}])

  // A command that has nothing to do in this mode still ends in exactly one idle.
  from = fake.of("assistantState").length
  await tap(rig, "captureStep")
  expect(fake.of("assistantState").slice(from)).toEqual([{state: "thinking"}, {state: "idle"}])
})

test("no failure leaves the app stuck", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig

  // Speech fails: the reason is on the screen, and the command still ends.
  fake.speechFails = "audio route lost"
  await hear(rig, "Start lesson.")
  expect(coach.snapshot()).toMatchObject({busy: false, assistant: "idle"})
  expect(lines(coach.snapshot()).at(-1)).toBe("system: Speech failed. audio route lost")
  expect(coach.snapshot().learning!.active).toBe(true)
  fake.speechFails = ""
  await tap(rig, "endLearning")

  // The phone cannot save the library: the lesson still works, and the screen says it was not saved.
  await teachThreeSteps(rig)
  fake.storageFails = "disk full"
  await hear(rig, "Publish lesson.")
  expect(fake.said.at(-1)).toBe("Lesson published.")
  expect(lines(coach.snapshot())).toContain("system: The lesson works now but was not saved to the phone. disk full")
  expect(coach.snapshot().tutorials[0]!.title).toBe("Making matcha")
  expect(fake.storage.has("library")).toBe(false)
  expect(coach.snapshot().busy).toBe(false)

  // The phone cannot save the key: the screen gets an answer with the reason.
  expect(await coach.setKey(GOOD_KEY)).toEqual({ok: false, error: "The phone could not save the key. disk full"})
  fake.storageFails = ""

  // A Claude answer for a question that is empty.
  await hear(rig, "Start lesson.")
  mind.answers = ["   "]
  await hear(rig, "Tinker, how hot should the water be?")
  expect(fake.said.at(-1)).toBe("I could not answer that. Ask again.")
  expect(lines(coach.snapshot())).toContain("system: The question failed. Claude gave an empty answer.")
  expect(coach.snapshot().busy).toBe(false)
  await coach.whenIdle()
})

// ---------- the screen ----------

test("snapshot() gives the same picture as the single messages", async () => {
  const rig = await start({key: false})
  const {fake, mind, coach} = rig
  const same = (): void => expect(coach.snapshot()).toEqual(fold(fake.events))

  same() // right after load()
  await coach.setKey(GOOD_KEY)
  same()
  await hear(rig, "Start teaching.")
  same()
  await hear(rig, "First I sift two scoops of matcha into the bowl.")
  same()
  await hear(rig, "My grandmother taught me this. Next step.")
  same()
  fake.clock.now += 20_000
  coach.tick() // a clock tick and a timed photo
  await coach.whenIdle()
  same()
  await hear(rig, "Then I whisk. Next step.")
  await hear(rig, "Finish lesson.")
  expect(coach.snapshot().draft).not.toBeNull()
  same()
  await hear(rig, "Publish lesson.")
  same()

  mind.verdicts = [{result: "fix", say: "Sift the powder first."}]
  await hear(rig, "Start lesson.")
  same()
  await hear(rig, "check")
  expect(coach.snapshot().lastVerdict).toMatchObject({result: "fix"})
  same()
  await hear(rig, "check")
  expect(coach.snapshot().learning).toMatchObject({currentStep: 2})
  same()
  await tap(rig, "askTinker", {text: "Why sift the powder?"})
  same()
  coach.heard("I am not", false) // an unfinished sentence
  same()
  coach.heard("I am not sure.", true)
  same()

  // More than 40 conversation lines: the snapshot keeps the newest 40.
  for (let i = 0; i < 25; i++) await tap(rig, "navigateStep", {direction: "repeat"})
  expect(coach.snapshot().transcript).toHaveLength(40)
  expect(coach.snapshot().transcript.at(-1)).toMatchObject({speaker: "tinker", text: "Step 2. Do thing 2.", step: 2})
  same()

  await tap(rig, "endLearning")
  expect(coach.snapshot().learning).toBeNull()
  same()
  // A new lesson starts without the old verdict.
  await tap(rig, "startLearning", {tutorialId: BUILT_IN.id})
  expect(coach.snapshot().lastVerdict).toBeNull()
  same()
  await tap(rig, "endLearning")
  await tap(rig, "deleteTutorial", {tutorialId: coach.snapshot().tutorials[0]!.id})
  same()

  // While a command runs, the picture also agrees, busy included.
  const letSpeechFinish = fake.holdSpeech()
  coach.command("testAudio", {})
  await flush()
  expect(coach.snapshot().busy).toBe(true)
  same()
  letSpeechFinish()
  await coach.whenIdle()
  same()
})

test("a recorded lesson can be deleted, but not while it is being learned", async () => {
  const rig = await start()
  const {fake, coach} = rig
  const lesson = await teachAndPublish(rig)
  expect(fake.kept.size).toBe(3)

  // Not while it is being learned.
  await tap(rig, "startLearning", {tutorialId: lesson.id})
  await tap(rig, "deleteTutorial", {tutorialId: lesson.id})
  expect(fake.last("tutorialList")!.tutorials.map((item) => item.id)).toEqual([lesson.id, BUILT_IN.id])
  expect(JSON.parse(fake.storage.get("library")!)).toHaveLength(1)
  expect(fake.kept.size).toBe(3)

  // Once the lesson is over it can go. Its photos go with it, and the phone's copy of the library is updated.
  await tap(rig, "endLearning")
  const listsBefore = fake.of("tutorialList").length
  await tap(rig, "deleteTutorial", {tutorialId: lesson.id})
  expect(fake.of("tutorialList")).toHaveLength(listsBefore + 1)
  expect(fake.last("tutorialList")).toEqual({tutorials: [BUILT_IN]})
  expect(coach.snapshot().tutorials).toEqual([BUILT_IN])
  expect(fake.storage.get("library")).toBe("[]")
  expect(fake.kept.size).toBe(0)

  // It works while the app is talking, too: deleting does not wait for a command to end.
  const second = await teachAndPublish(rig)
  const letSpeechFinish = fake.holdSpeech()
  coach.command("testAudio", {})
  await flush()
  coach.command("deleteTutorial", {tutorialId: second.id})
  expect(coach.snapshot().tutorials).toEqual([BUILT_IN])
  letSpeechFinish()
  await coach.whenIdle()
  expect(fake.storage.get("library")).toBe("[]")
  expect(fake.kept.size).toBe(0)
})

test("the built-in lesson cannot be deleted", async () => {
  const rig = await start()
  const {fake, coach} = rig
  await tap(rig, "deleteTutorial", {tutorialId: BUILT_IN.id})
  await tap(rig, "deleteTutorial", {tutorialId: "tut_unknown"})
  await tap(rig, "deleteTutorial", {})
  expect(coach.snapshot().tutorials).toEqual([BUILT_IN])
  expect(fake.last("tutorialList")).toEqual({tutorials: [BUILT_IN]}) // the screen is shown the real list again
  expect(fake.storage.has("library")).toBe(false) // nothing was written
  expect(BUILT_IN.built_in).toBe(true)

  // It is always last in the library, and it can be learned.
  await tap(rig, "startLearning", {tutorialId: BUILT_IN.id})
  expect(fake.said.at(-1)).toBe(`${BUILT_IN.title}. Say check when a step is done. Step 1. ${BUILT_IN.steps[0]!.instruction_spoken}`)
  await hear(rig, "What do I need?")
  expect(fake.said.at(-1)).toBe(
    "You need Chawan (Tea Bowl), Chasen (100-prong Bamboo Whisk), Chashaku (Bamboo Scoop), Fine Mesh Sifter, Ceremonial Grade Matcha (2g) and Filtered Hot Water at 80°C / 175°F (70ml).",
  )
})

test("the button on the glasses: what a short and a long press do in every mode", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig

  // idle, long: start teaching.
  await press(rig, "long")
  expect(coach.snapshot().teaching.status).toBe("recording")
  expect(fake.said.at(-1)).toBe(RECORDING_INTRO)

  // recording, short: save the step. A second press while the photo is in progress is dropped.
  fake.clock.now += 3000
  coach.heard("I tie the first knot.", true)
  coach.button("short")
  coach.button("short")
  await coach.whenIdle()
  expect(fake.photos).toBe(1)
  expect(fake.said.at(-1)).toBe("Step 1 saved.")
  await press(rig, "short")
  expect(fake.said.at(-1)).toBe("Step 2 saved.")

  // recording, long: finish. While Claude writes the lesson (processing) the button does nothing.
  const letClaudeAnswer = mind.hold()
  coach.button("long")
  await flush()
  expect(coach.snapshot().teaching.status).toBe("processing")
  coach.button("short")
  coach.button("long")
  letClaudeAnswer()
  await coach.whenIdle()
  expect(coach.snapshot().teaching.status).toBe("review")
  expect(mind.of("buildLesson")).toHaveLength(1)

  // review, long: nothing. review, short: publish.
  const spoken = fake.said.length
  await press(rig, "long")
  expect(fake.said).toHaveLength(spoken)
  expect(coach.snapshot().teaching.status).toBe("review")
  await press(rig, "short")
  expect(fake.said.at(-1)).toBe("Lesson published.")
  expect(coach.snapshot().tutorials[0]).toMatchObject({id: fake.last("tutorialGenerated")!.tutorial!.id, status: "published"})

  // idle, short: learn the newest lesson.
  await press(rig, "short")
  expect(fake.last("learningState")).toMatchObject({active: true, tutorialId: coach.snapshot().tutorials[0]!.id, currentStep: 1, totalSteps: 2})

  // learning, short: check. learning, long: next step.
  await press(rig, "short")
  expect(mind.of("checkStep")).toHaveLength(1)
  expect(fake.said.at(-1)).toBe("Nice work. Step 2. Do thing 2.")
  await press(rig, "long")
  expect(fake.said.at(-1)).toBe("That was the last step. You finished Making matcha.")
  expect(fake.last("learningState")).toMatchObject({active: false, finished: true})
  expect(mind.of("checkStep")).toHaveLength(1) // next took no photo and asked nothing
  expect(fake.photos).toBe(3)
})

test("the small screen messages: ping, the library, the audio check, the connection, help", async () => {
  const rig = await start()
  const {fake, coach} = rig

  fake.clock.now = 2_000_000
  coach.command("ping", {at: 1_999_950})
  expect(fake.last("pong")).toEqual({at: 2_000_000, roundtripMs: 50, backgroundVersion: "tinker-2"})

  const lists = fake.of("tutorialList").length
  coach.command("requestTutorials", {})
  expect(fake.of("tutorialList")).toHaveLength(lists + 1)
  expect(fake.last("tutorialList")).toEqual({tutorials: [BUILT_IN]})

  await tap(rig, "testAudio")
  expect(fake.said.at(-1)).toBe("This is the Tinker audio check. If you hear this in the glasses, sound works.")
  expect(coach.snapshot().transcript.at(-1)).toMatchObject({speaker: "tinker", timestamp: "Tinker", isFinal: true})

  fake.hardware = {glassesConnected: false, hasCamera: false, hasMic: false}
  coach.hardwareChanged()
  expect(fake.last("connectionStatus")).toEqual({glassesConnected: false, hasCamera: false, hasMic: false, claudeReady: true, keyHint: "1234"})
  expect(coach.snapshot().connection.glassesConnected).toBe(false)

  // "What can I say" in every mode a person can speak in.
  await hear(rig, "What can I say?")
  expect(fake.said.at(-1)).toBe(helpText("idle"))
  await hear(rig, "Start lesson.")
  await hear(rig, "What can I say?")
  expect(fake.said.at(-1)).toBe(helpText("learning"))
  // Right after the list of commands, one of them is said. It is in the app's own sentence, and it still works.
  await hear(rig, "Stop lesson.")
  expect(fake.said.at(-1)).toBe("Lesson stopped.")
  await hear(rig, "Start teaching.")
  await hear(rig, "I fold the cloth. What can I say?")
  expect(fake.said.at(-1)).toBe(helpText("recording"))
  expect(coach.snapshot().teaching.narration).toBe("I fold the cloth.")
  await hear(rig, "Finish lesson.")
  await hear(rig, "What can I say?")
  expect(fake.said.at(-1)).toBe(helpText("review"))
  await hear(rig, "Cancel lesson.")
  expect(fake.said.at(-1)).toBe("Draft discarded.")
  expect(new Set(MODES.map((mode) => helpText(mode))).size).toBe(MODES.length)
})

test("an old photo link is not sent: the kept copy is used, then a download, then no photo", async () => {
  const rig = await start()
  const {fake, mind} = rig
  await teachAndPublish(rig)

  // 25 minutes later the links are too old to hand to Claude, but they still work for a few minutes.
  fake.clock.now += 25 * 60 * 1000
  const png = "iVBORw0KGgoAAAANSUhEUg"
  fake.kept.set("shot-1003000-1", png) // the kept copy is a PNG, whatever label the camera gave
  fake.kept.delete("shot-1003000-2")
  fake.kept.delete("shot-1003000-3")
  await hear(rig, "Start lesson.")

  // Step 1: the copy kept on the phone. The image type is read from the bytes.
  await hear(rig, "check")
  expect(mind.of("checkStep")[0]!.input.reference).toEqual({kind: "base64", data: png, mediaType: "image/png"})
  expect(mind.of("checkStep")[0]!.input.learner).toEqual({kind: "url", url: "https://photos.example/p4.jpg"})
  expect(fake.loads).toEqual(["shot-1003000-1"])
  expect(fake.downloads).toEqual([])

  // Step 2: no kept copy, the link is younger than 28 minutes: the phone downloads it.
  await hear(rig, "check")
  expect(mind.of("checkStep")[1]!.input.reference).toEqual({kind: "base64", data: JPEG, mediaType: "image/jpeg"})
  expect(fake.downloads).toEqual(["https://photos.example/p2.jpg"])

  // Step 3: no kept copy and the link is dead. The check goes on without the expert's photo.
  fake.clock.now += 10 * 60 * 1000
  await hear(rig, "check")
  expect(mind.of("checkStep")[2]!.input.reference).toBeNull()
  expect(mind.of("checkStep")[2]!.input.learner.kind).toBe("url")
  expect(fake.downloads).toHaveLength(1)
  expect(fake.said.at(-1)).toBe("Nice work. That was the last step. You finished Making matcha.")
})

test("narration keeps the last 1500 characters", async () => {
  const rig = await start()
  const {coach} = rig
  await tap(rig, "startTeaching")
  await hear(rig, `${"a".repeat(900)} first.`)
  await hear(rig, `${"b".repeat(900)} last words.`)
  const narration = coach.snapshot().teaching.narration
  expect(narration).toHaveLength(1500)
  expect(narration.endsWith("b last words.")).toBe(true)
  expect(narration.includes("first.")).toBe(true)
})

test("speech that never ends and a Claude request that never answers do not freeze the app", async () => {
  const rig = await start()
  const {fake, mind, coach} = rig
  jest.useFakeTimers()
  try {
    // Speech: the app stops waiting after 6 seconds plus 110 ms for every character. It does not fail.
    const sentence = `${BUILT_IN.title}. Say check when a step is done. Step 1. ${BUILT_IN.steps[0]!.instruction_spoken}`
    const letSpeechFinish = fake.holdSpeech()
    fake.clock.now += 3000
    coach.heard("Start lesson.", true)
    await microtasks()
    expect(fake.said.at(-1)).toBe(sentence)
    jest.advanceTimersByTime(6000 + sentence.length * 110 - 1)
    await microtasks()
    expect(coach.snapshot()).toMatchObject({busy: true, assistant: "speaking"})
    jest.advanceTimersByTime(1)
    await coach.whenIdle()
    expect(coach.snapshot()).toMatchObject({busy: false, assistant: "idle"})
    expect(coach.snapshot().learning).toMatchObject({active: true, currentStep: 1})
    expect(lines(coach.snapshot()).some((line) => line.startsWith("system: Speech failed"))).toBe(false)
    letSpeechFinish()

    // Claude: the app stops waiting after 90 seconds and says so.
    const letClaudeAnswer = mind.hold()
    fake.clock.now += 3000
    coach.heard("check", true)
    await microtasks()
    expect(fake.last("assistantState")).toEqual({state: "thinking", message: "Thinking"})
    jest.advanceTimersByTime(89_999)
    await microtasks()
    expect(coach.snapshot().busy).toBe(true)
    jest.advanceTimersByTime(1)
    await coach.whenIdle()
    expect(fake.said.at(-1)).toBe("I could not check that. Say check to try again.")
    expect(lines(coach.snapshot())).toContain("system: The check failed. Claude did not answer in time.")
    expect(coach.snapshot()).toMatchObject({busy: false, assistant: "idle"})
    letClaudeAnswer()
  } finally {
    jest.useRealTimers()
  }
})

// ---------- the app must not be able to command itself ----------

test("a sentence from Claude that ends in a command is made harmless before it is spoken", async () => {
  // Not counted in `everythingSaid`: these sentences are made up to be dangerous.
  const lesson = savedLesson("tut_risky", "How to check")
  lesson.steps[1]!.instruction_spoken = "Fold it over, then repeat."
  const rig = await start({storage: libraryOnPhone(lesson), track: false})
  const {fake, mind} = rig
  mind.verdicts = [{result: "fix", say: "Keep whisking until it is done."}]
  mind.answers = ["Tinker here. Use cooler water."]

  await hear(rig, "Start lesson.")
  await hear(rig, "check")
  expect(fake.said.at(-1)).toBe("Keep whisking until it is done. Okay.")
  expect(fake.last("stepVerdict")!.say).toBe("Keep whisking until it is done.") // the screen shows Claude's own words
  await hear(rig, "Tinker, how hot should the water be?")
  expect(fake.said.at(-1)).toBe("So, Tinker here. Use cooler water.")
  await hear(rig, "Next step.")
  expect(fake.said.at(-1)).toBe("Step 2. Fold it over, then repeat. Okay.")
  await hear(rig, "Skip.")
  await hear(rig, "Next.")
  expect(fake.said.at(-1)).toBe("That was the last step. You finished How to check. Okay.")

  for (const sentence of fake.said) {
    for (const mode of MODES) expect(parseCommand(mode, sentence)).toBeNull()
  }
})

test("nothing the app said in any test above could be taken for a command", () => {
  const sentences = [...new Set([...everythingSaid, ...MODES.map((mode) => helpText(mode))])]
  // The tests above made the app say all of its fixed sentences.
  expect(sentences.length).toBeGreaterThan(45)
  for (const sentence of [
    RECORDING_INTRO,
    LESSON_READY_3,
    "Nothing is recorded yet. Do a step and explain it, then say next step to save it.",
    "I could not build the lesson. Say finish lesson to try again.",
    "This is the Tinker audio check. If you hear this in the glasses, sound works.",
    "The expert gave no reason for this step.",
    "Yes?",
  ]) {
    expect(sentences).toContain(sentence)
  }

  for (const sentence of sentences) {
    for (const mode of MODES) {
      const hit = parseCommand(mode, sentence)
      // The message names the sentence, so a failure says which one to reword.
      expect(hit === null ? "no command" : `"${sentence}" is the command "${hit.command}" in mode ${mode}`).toBe("no command")
    }
    // None of them needed the safety net that the test before this one covers.
    expect(sentence.endsWith(" Okay.")).toBe(false)
    expect(sentence.startsWith("So, ")).toBe(false)
  }
})
