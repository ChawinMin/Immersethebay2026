/**
 * ui-rig.ts: the REAL Coach on fake glasses, with every event it sends fed to the screen's data.
 *
 * WHY THIS FILE EXISTS
 *   The screen tests in test/ui.test.tsx push hand-made events. Those show
 *   what the screen does with an event, not whether the background really
 *   sends events in that order. This rig runs the real Coach
 *   (src/background/coach.ts) with fake glasses and a fake Claude, and pipes
 *   every event it emits into `applyEvent` (src/ui/state.ts), exactly as the
 *   phone would. A test can then compare that screen with a freshly opened one.
 *   It is not a test file itself. It was first written by the screen review
 *   (round 3) and kept here.
 *
 * WHAT IS FAKE
 *   The glasses: photos always work unless `photoFails`, speech ends at once
 *   unless `holdSpeech()`. Claude: answers at once unless `holdBrain()` or
 *   `brainFail`. The clock: `clock.now`, moved by hand.
 */

import type {Channels, Snapshot, UiCommandChannel, UiEventChannel} from "../src/shared/channels"
import {Coach} from "../src/background/coach"
import {BrainError, type Brain, type CaptureInput, type Device, type LessonDraft, type Verdict} from "../src/background/contracts"
import {applyEvent, EMPTY, type ScreenEvent, type ScreenState} from "../src/ui/state"

export const GOOD_KEY = "sk-ant-test-key-1234"
export const MATCHA_ID = "tut_matcha_ceremonial_01"

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export interface Rig {
  coach: Coach
  clock: {now: number}
  /** Every event the Coach sent, in order. */
  events: Array<{channel: UiEventChannel; payload: unknown}>
  /** The screen's data, fed by every event since `open()`. */
  screen: ScreenState
  /** True once the screen is open. Events sent before are lost, like on the phone. */
  attached: boolean
  /** The next answers of the photo check. When empty, a check passes with "Nice work." */
  verdicts: Verdict[]
  /** When set, every Claude request fails with this. */
  brainFail: Error | null
  /** When true, every photo fails. */
  photoFails: boolean
  /** Every sentence the glasses said. */
  said: string[]
  /** Claude does not answer until the returned function is called. */
  holdBrain(): () => void
  /** The glasses keep talking until the returned function is called. */
  holdSpeech(): () => void
  /** A finished sentence from the microphone, `ms` after the last thing that happened. */
  hear(text: string, ms?: number): Promise<void>
  /** A tap on the phone screen, then wait until the Coach is idle. */
  tap<C extends UiCommandChannel>(channel: C, payload?: unknown): Promise<void>
  /** The screen opens now: it gets a snapshot, then every later event. */
  open(): void
}

/** What Claude writes for a recording: one step per "next step" capture. */
function draftFor(captures: CaptureInput[]): LessonDraft {
  const saved = captures.map((capture, i) => ({capture, n: i + 1})).filter((x) => x.capture.kind === "step")
  return {
    title: "Making matcha",
    description: "Whisk a bowl.",
    category: "Tea",
    estimated_duration_minutes: 3,
    tools_required: ["bowl"],
    ingredients_required: ["matcha"],
    steps: saved.map((x, i) => ({
      title: `Thing ${i + 1}`,
      instruction_spoken: `Do thing ${i + 1}.`,
      instruction_detailed: "Because.",
      tips: [],
      done_looks_like: "Visible.",
      common_mistake: "",
      story: "",
      source_capture: x.n,
    })),
  }
}

/**
 * Build the rig. `listener` (optional) also gets every event, for a test that
 * renders the real screen: it can forward the event to the fake Mentra App.
 */
export async function rig(options: {key?: boolean; listener?: (channel: UiEventChannel, payload: unknown) => void} = {}): Promise<Rig> {
  let brainGate: Promise<void> | null = null
  let speechGate: Promise<void> | null = null
  const hold = (set: (gate: Promise<void> | null) => void) => {
    let release = (): void => {}
    set(new Promise<void>((resolve) => (release = resolve)))
    return () => {
      set(null)
      release()
    }
  }
  let photos = 0
  const storage = new Map<string, string>()
  const r = {
    clock: {now: 1_000_000},
    events: [],
    screen: EMPTY,
    attached: false,
    verdicts: [],
    brainFail: null,
    photoFails: false,
    said: [],
    holdBrain: () => hold((gate) => (brainGate = gate)),
    holdSpeech: () => hold((gate) => (speechGate = gate)),
  } as unknown as Rig

  const device: Device = {
    async takePhoto() {
      if (r.photoFails) throw {code: "INTERNAL", message: "glasses not connected"}
      photos++
      return {url: `https://photos.example/p${photos}.jpg`, mediaType: "image/jpeg"}
    },
    async speak(text) {
      r.said.push(text)
      if (speechGate) await speechGate
    },
    light() {},
    setVocabulary() {},
    hardware: () => ({glassesConnected: true, hasCamera: true, hasMic: true}),
    async downloadPhoto() {
      return "/9j/4AAQ"
    },
    async savePhoto() {},
    async loadPhoto() {
      return null
    },
    async deletePhoto() {},
    async storageGet(key) {
      return storage.get(key) ?? null
    },
    async storageSet(key, value) {
      storage.set(key, value)
    },
    async storageDelete(key) {
      storage.delete(key)
    },
    now: () => r.clock.now,
    emit(channel, payload) {
      // A copy, as if it had travelled as JSON over the bridge.
      const event = {channel, payload: clone(payload)}
      r.events.push(event)
      if (!r.attached) return
      r.screen = applyEvent(r.screen, event as unknown as ScreenEvent)
      options.listener?.(channel, event.payload)
    },
  }

  const request = async <T>(produce: () => T): Promise<T> => {
    if (brainGate) await brainGate
    if (r.brainFail) throw r.brainFail
    return produce()
  }
  const brain: Brain = {
    testKey: (key) =>
      request(() => {
        if (key !== GOOD_KEY) throw new BrainError(401, "invalid x-api-key")
      }),
    buildLesson: (_key, input) => request(() => draftFor(input.captures)),
    checkStep: () => request(() => r.verdicts.shift() ?? {result: "pass" as const, say: "Nice work."}),
    answer: () => request(() => "About eighty degrees."),
  }

  r.coach = new Coach(device, brain)
  await r.coach.load()
  if (options.key !== false) await r.coach.setKey(GOOD_KEY)
  r.hear = async (text, ms = 3000) => {
    r.clock.now += ms
    r.coach.heard(text, true)
    await r.coach.whenIdle()
  }
  r.tap = async (channel, payload = {}) => {
    r.coach.command(channel, payload as Channels[typeof channel])
    await r.coach.whenIdle()
  }
  r.open = () => {
    r.attached = true
    r.screen = applyEvent(EMPTY, {channel: "snapshot", payload: clone(r.coach.snapshot()) as Snapshot})
  }
  return r
}

/** What a screen that opens NOW would hold. */
export function fresh(r: Rig): ScreenState {
  return applyEvent(EMPTY, {channel: "snapshot", payload: clone(r.coach.snapshot())})
}

/**
 * The parts of the screen's data that a person can see or that lock buttons.
 * Two screens with the same `core` look the same. The clock is left out: it moves.
 */
export function core(s: ScreenState, isBusy: (state: ScreenState) => boolean) {
  return {
    teaching: {...s.teaching, elapsedSeconds: 0},
    draft: s.draft?.id ?? null,
    learningActive: s.learning?.active ?? false,
    step: s.learning?.active ? s.learning.currentStep : 0,
    stepId: s.learning?.active ? s.learning.stepData?.id : "",
    tutorials: s.tutorials.map((t) => t.id + t.title),
    assistant: s.assistant,
    busy: isBusy(s),
    transcript: s.transcript.slice(-40).map((line) => `${line.id}:${line.isFinal}:${line.text}`),
    connection: s.connection,
    verdict: s.verdict,
  }
}
