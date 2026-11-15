/**
 * ui.test.tsx: a smoke test of the phone screen (src/ui).
 *
 * WHY THIS FILE EXISTS
 *   The screen must show only what the background tells it. These tests render
 *   the real <App /> inside the real <MentraProvider> in a fake browser
 *   (happy-dom), with a fake `mentra` object in place of the Mentra App. The
 *   fake records every `send` and `request` and lets a test push events, the
 *   way the background would. No glasses, no phone, no network.
 *
 * WHAT IT PROVES
 *   - before the first snapshot nothing is claimed ("Connecting...")
 *   - every screen is drawn from background events, never from a tap
 *   - buttons send the right command and nothing else
 *   - errors from the background are visible
 *   - the back gesture and the busy rule behave as designed
 *
 * WHAT IT CANNOT PROVE
 *   Layout, colours and the real Mentra bridge. Those were checked by eye in a
 *   headless browser at 380 px wide (pictures in /home/claude/reports/ui-shots).
 *
 * Run it with:  bun test test/ui.test.tsx
 */

import {afterAll, afterEach, beforeEach, describe, expect, test} from "bun:test"
import {GlobalRegistrator} from "@happy-dom/global-registrator"
import type {
  Channels,
  ConnectionStatus,
  LearningState,
  Snapshot,
  TeachingState,
  TutorialModel,
  TutorialStepModel,
} from "../src/shared/channels"

// The fake browser must exist before React is loaded, so React is imported
// further down with `await import`, not at the top of the file.
GlobalRegistrator.register()
// Tells React that `act` is in use, so it does not print a warning on every update.
;(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------- a history that can go back

/**
 * happy-dom's `history.go()` does nothing, but the screen's tabs and views use
 * the browser history (useHistoryState). This stand-in keeps a real stack and
 * fires `popstate` a moment later, like a browser does.
 */
function installHistory(): {reset: () => void} {
  let stack: unknown[] = [null]
  let index = 0
  const clone = (value: unknown) => (value === null || value === undefined ? null : JSON.parse(JSON.stringify(value)))
  const h = window.history
  Object.defineProperty(h, "state", {configurable: true, get: () => stack[index]})
  h.pushState = (state: unknown) => {
    stack = [...stack.slice(0, index + 1), clone(state)]
    index++
  }
  h.replaceState = (state: unknown) => {
    stack[index] = clone(state)
  }
  h.go = (delta = 0) => {
    const next = index + delta
    if (next < 0 || next >= stack.length) return
    setTimeout(() => {
      index = next
      window.dispatchEvent(new window.PopStateEvent("popstate", {state: stack[index]}))
    }, 0)
  }
  h.back = () => h.go(-1)
  return {
    reset() {
      stack = [null]
      index = 0
    },
  }
}
const fakeHistory = installHistory()

// ---------------------------------------------------------------- the fake Mentra App

type Handler = (payload: unknown) => void

/** Stands in for the `mentra` object the Mentra App adds to the page. */
class FakeMentra {
  sent: Array<{channel: string; payload: unknown}> = []
  requests: Array<{channel: string; payload: unknown}> = []
  readyCalls = 0
  /** What `request` answers, per channel. With no entry the request never settles. */
  answers: Record<string, (payload: unknown) => Promise<unknown>> = {}
  private handlers = new Map<string, Set<Handler>>()
  private openCallbacks: Array<() => void> = []

  send = (channel: string, payload: unknown) => {
    this.sent.push({channel, payload})
  }
  on = (channel: string, cb: Handler) => {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set())
    this.handlers.get(channel)?.add(cb)
    return () => {
      this.handlers.get(channel)?.delete(cb)
    }
  }
  request = (channel: string, payload: unknown) => {
    this.requests.push({channel, payload})
    const answer = this.answers[channel]
    return answer ? answer(payload) : new Promise(() => {})
  }
  // Like the real bridge: onOpen callbacks run once `ready()` has been called.
  onOpen = (cb: () => void) => {
    if (this.readyCalls > 0) cb()
    else this.openCallbacks.push(cb)
    return () => {}
  }
  onClose = () => () => {}
  ready = () => {
    this.readyCalls++
    if (this.readyCalls === 1) this.openCallbacks.forEach((cb) => cb())
  }

  /** Deliver one event from the "background" to the screen. */
  emit<C extends keyof Channels>(channel: C, payload: Channels[C]) {
    for (const cb of this.handlers.get(channel) ?? []) cb(payload)
  }
  /** How many listeners the screen has on a channel. */
  listeners(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0
  }
  sentOn(channel: string): unknown[] {
    return this.sent.filter((message) => message.channel === channel).map((message) => message.payload)
  }
}

// React and the screen are loaded only now, after the fake browser exists.
const {act} = await import("react")
const {createRoot} = await import("react-dom/client")
const {MentraProvider} = await import("@mentra/miniapp/ui")
const {App} = await import("../src/ui/App")
const {applyEvent, EMPTY, isBusy} = await import("../src/ui/state")

let fake: FakeMentra
let root: ReturnType<typeof createRoot> | null = null

/** Mount the whole screen exactly as main.tsx does. */
async function mount(): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <MentraProvider>
        <App />
      </MentraProvider>,
    )
  })
}

/** Push one background event and let React redraw. */
async function emit<C extends keyof Channels>(channel: C, payload: Channels[C]): Promise<void> {
  await act(async () => {
    fake.emit(channel, payload)
  })
  await settle()
}

/** Let timers that are due (the fake history's popstate) and promises finish. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

async function click(element: Element | undefined | null): Promise<void> {
  if (!element) throw new Error("click: the element is not on the screen")
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

/** Type into a React input: set the value the way a browser would, then fire `input`. */
async function type(element: Element | null, value: string): Promise<void> {
  if (!element) throw new Error("type: the input is not on the screen")
  const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new window.Event("input", {bubbles: true}))
  })
}

const screenText = () => (document.body.textContent ?? "").replace(/\s+/g, " ")
const all = (selector: string) => Array.from(document.querySelectorAll(selector))
/** The button whose visible text (or aria-label) is exactly `label`. */
const button = (label: string) =>
  all("button").find((b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label) as
    | HTMLButtonElement
    | undefined

// ---------------------------------------------------------------- test data

const step = (n: number, extra: Partial<TutorialStepModel> = {}): TutorialStepModel => ({
  id: `step_0${n}`,
  step_number: n,
  title: `Title of step ${n}`,
  instruction_spoken: `Library text of step ${n}.`,
  instruction_detailed: `Detail of step ${n}.`,
  ...extra,
})

const BUILT_IN: TutorialModel = {
  id: "tut_matcha_ceremonial_01",
  title: "How to Make Matcha",
  description: "The built-in lesson.",
  category: "Culinary Arts",
  total_steps: 3,
  estimated_duration_minutes: 5,
  created_at: "2026-11-14T15:00:00Z",
  status: "published",
  steps: [step(1), step(2), step(3)],
  built_in: true,
}

const RECORDED: TutorialModel = {
  id: "tut_1763140000000",
  title: "Tie a Bowline Knot",
  description: "A loop that does not slip.",
  total_steps: 2,
  estimated_duration_minutes: 2,
  created_at: "2026-11-14T17:00:00Z",
  status: "published",
  steps: [step(1), step(2)],
}

const READY: ConnectionStatus = {glassesConnected: true, hasCamera: true, hasMic: true, claudeReady: true, keyHint: "9xQz"}
const NOTHING: ConnectionStatus = {glassesConnected: false, hasCamera: false, hasMic: false, claudeReady: false, keyHint: ""}
const TEACH_IDLE: TeachingState = {status: "idle", elapsedSeconds: 0, frameCount: 0, stepCount: 0, narration: ""}

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  connection: READY,
  tutorials: [RECORDED, BUILT_IN],
  teaching: TEACH_IDLE,
  draft: null,
  learning: null,
  lastVerdict: null,
  transcript: [],
  assistant: "idle",
  busy: false,
  ...over,
})

const lesson = (over: Partial<LearningState> = {}): LearningState => ({
  active: true,
  finished: false,
  sessionId: "session-1",
  tutorialId: BUILT_IN.id,
  currentStep: 2,
  totalSteps: 3,
  // Deliberately NOT the text in the library: the screen must show `stepData`.
  stepData: step(2, {instruction_spoken: "Sift two scoops into the dry bowl."}),
  assistantState: "idle",
  ...over,
})

// ---------------------------------------------------------------- setup

beforeEach(() => {
  fakeHistory.reset()
  document.body.innerHTML = ""
  document.documentElement.className = ""
  fake = new FakeMentra()
  ;(globalThis as unknown as {mentra: unknown}).mentra = fake
})

afterEach(async () => {
  // Unmount so timers (the snapshot retry) stop, and let a pending popstate land.
  await act(async () => {
    root?.unmount()
  })
  root = null
  await new Promise((resolve) => setTimeout(resolve, 5))
})

// `bun test` runs every test file in one process. Take the fake browser away
// again, so the background tests that run after this file see a plain engine
// with no `window` and no `document`.
afterAll(async () => {
  delete (globalThis as unknown as {mentra?: unknown}).mentra
  delete (globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

// ---------------------------------------------------------------- the tests

describe("before the first snapshot", () => {
  test("renders without a crash, claims nothing, and asks for a snapshot", async () => {
    await mount()

    expect(screenText()).toContain("Connecting...")
    // No fake "ready" values: no green pill, no "connected", no lesson.
    expect(all(".status-pill.connected")).toHaveLength(0)
    expect(screenText()).not.toContain("Glasses connected")
    expect(screenText()).not.toContain("Claude key ready")
    expect(all(".tutorial-card")).toHaveLength(0)

    // The provider called ready() once, after the listeners were attached.
    expect(fake.readyCalls).toBe(1)
    expect(fake.listeners("snapshot")).toBe(1)
    expect(fake.listeners("learningState")).toBe(1)
    // onOpen asked for the full picture.
    expect(fake.requests[0]).toEqual({channel: "getSnapshot", payload: {}})
    // Nothing was sent that changes anything.
    expect(fake.sent).toHaveLength(0)
  })

  test("the answer to getSnapshot is applied", async () => {
    fake.answers.getSnapshot = async () => snapshot()
    await mount()
    await settle()
    expect(screenText()).toContain("Glasses connected")
    expect(screenText()).toContain("How to Make Matcha")
  })
})

describe("library", () => {
  test("a snapshot with the built-in lesson shows it, tagged, without Delete", async () => {
    await mount()
    await emit("snapshot", snapshot({tutorials: [BUILT_IN], connection: NOTHING}))

    expect(screenText()).not.toContain("Connecting...")
    expect(screenText()).toContain("Glasses not connected")
    expect(screenText()).toContain("Claude key missing")
    const cards = all(".tutorial-card")
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain("How to Make Matcha")
    expect(cards[0].textContent).toContain("Built in")
    expect(cards[0].textContent).not.toContain("Delete")
  })

  test("a recorded lesson has Delete, which asks twice and then sends deleteTutorial", async () => {
    await mount()
    await emit("snapshot", snapshot())

    const cards = all(".tutorial-card")
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toContain("Tie a Bowline Knot")
    expect(cards[0].textContent).not.toContain("Built in")

    await click(button("Delete"))
    expect(fake.sentOn("deleteTutorial")).toHaveLength(0)
    await click(button("Sure?"))
    expect(fake.sentOn("deleteTutorial")).toEqual([{tutorialId: RECORDED.id}])
    // The card is still there: only the background can remove it.
    expect(all(".tutorial-card")).toHaveLength(2)

    await emit("tutorialList", {tutorials: [BUILT_IN]})
    expect(all(".tutorial-card")).toHaveLength(1)
  })

  test("Start Learning sends the command and waits for the background", async () => {
    await mount()
    await emit("snapshot", snapshot())

    await click(all(".tutorial-card")[1].querySelector(".card-start"))
    expect(fake.sentOn("startLearning")).toEqual([{tutorialId: BUILT_IN.id}])
    // No optimistic session view.
    expect(button("Check my step")).toBeUndefined()
    expect(all(".tutorial-card")).toHaveLength(2)
  })
})

describe("learning session", () => {
  test("an active learningState shows the step from stepData and a Check button that sends checkStep", async () => {
    await mount()
    await emit("snapshot", snapshot())
    await emit("learningState", lesson())

    expect(screenText()).toContain("Sift two scoops into the dry bowl.")
    // The library's own text for step 2 is NOT what is shown.
    expect(screenText()).not.toContain("Library text of step 2.")
    expect(screenText()).toContain("Step 2 of 3")

    await click(button("Check my step"))
    expect(fake.sentOn("checkStep")).toEqual([{}])

    await click(button("Next"))
    await click(button("Repeat"))
    await click(button("Previous"))
    expect(fake.sentOn("navigateStep")).toEqual([{direction: "next"}, {direction: "repeat"}, {direction: "previous"}])
    // Three taps on step buttons did not move the step. Only the background does.
    expect(screenText()).toContain("Step 2 of 3")

    await emit("learningState", lesson({currentStep: 3, stepData: step(3, {instruction_spoken: "Pour the water."})}))
    expect(screenText()).toContain("Pour the water.")
    expect(screenText()).toContain("Step 3 of 3")
  })

  test("a verdict shows only under the step it belongs to", async () => {
    await mount()
    await emit("snapshot", snapshot())
    await emit("learningState", lesson())

    await emit("stepVerdict", {step: 1, result: "pass", say: "Sentence for another step."})
    expect(screenText()).not.toContain("Sentence for another step.")
    expect(all(".verdict-chip")).toHaveLength(0)

    await emit("stepVerdict", {step: 2, result: "fix", say: "The powder is still lumpy.", photoUrl: "https://photos.test/learner.jpg"})
    expect(screenText()).toContain("The powder is still lumpy.")
    expect(all(".verdict-chip.fix")).toHaveLength(1)
    expect(screenText()).toContain("Needs a fix")

    // Moving to the next step hides the old verdict.
    await emit("learningState", lesson({currentStep: 3, stepData: step(3)}))
    expect(screenText()).not.toContain("The powder is still lumpy.")
  })

  test("photos show when their link loads and remove themselves when it fails", async () => {
    await mount()
    await emit("snapshot", snapshot())
    await emit("learningState", lesson({stepData: step(2, {reference_image_url: "https://photos.test/expert.jpg"})}))
    await emit("stepVerdict", {step: 2, result: "unclear", say: "I cannot see the bowl.", photoUrl: "https://photos.test/learner.jpg"})

    const figures = () => all(".photo-figure") as HTMLElement[]
    expect(figures()).toHaveLength(2)
    // Not shown until loaded.
    expect(figures().every((figure) => figure.hidden)).toBe(true)

    await act(async () => {
      figures()[0].querySelector("img")?.dispatchEvent(new window.Event("load"))
    })
    expect(figures()[0].hidden).toBe(false)
    expect(figures()[0].textContent).toContain("The expert's photo")

    // The learner's link is dead: its picture and caption go away.
    await act(async () => {
      figures()[1].querySelector("img")?.dispatchEvent(new window.Event("error"))
    })
    expect(figures()).toHaveLength(1)
    expect(screenText()).not.toContain("Your photo")
  })

  test("an unfinished transcript line is replaced by its finished version", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))

    await emit("transcriptionUpdate", {id: "u7", speaker: "user", text: "tinker how", isFinal: false, timestamp: "You"})
    await emit("transcriptionUpdate", {id: "u7", speaker: "user", text: "tinker how much", isFinal: false, timestamp: "You"})
    expect(all(".transcript-item.user")).toHaveLength(1)
    expect(all(".transcript-item.unfinished")).toHaveLength(1)

    await emit("transcriptionUpdate", {id: "u7", speaker: "user", text: "Tinker, how much powder?", isFinal: true, timestamp: "You"})
    const lines = all(".transcript-item.user")
    expect(lines).toHaveLength(1)
    expect(lines[0].textContent).toContain("Tinker, how much powder?")
    expect(all(".transcript-item.unfinished")).toHaveLength(0)

    // A different id is a new line.
    await emit("transcriptionUpdate", {id: "t8", speaker: "tinker", text: "Two scoops.", isFinal: true, timestamp: "Step 2", step: 2})
    expect(all(".transcript-item")).toHaveLength(2)
  })

  test("a typed question is sent, and is not added to the transcript by the screen", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))

    await type(document.querySelector(".ask-input"), "  is this enough?  ")
    await click(button("Send the question"))
    expect(fake.sentOn("askTinker")).toEqual([{text: "is this enough?"}])
    expect(all(".transcript-item.user")).toHaveLength(0)
  })

  test("busy: thinking and speaking disable command buttons, but never End Session", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))
    expect(button("Check my step")?.disabled).toBe(false)

    await emit("assistantState", {state: "thinking"})
    expect(button("Check my step")?.disabled).toBe(true)
    expect(button("Next")?.disabled).toBe(true)
    expect(button("Repeat")?.disabled).toBe(true)
    expect(button("End Session")?.disabled).toBe(false)

    await emit("assistantState", {state: "speaking"})
    expect(button("Check my step")?.disabled).toBe(true)

    await emit("assistantState", {state: "idle"})
    expect(button("Check my step")?.disabled).toBe(false)

    await click(button("End Session"))
    expect(fake.sentOn("endLearning")).toEqual([{}])
  })

  test("busy: a snapshot that says busy holds until the assistant is at rest again", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson(), busy: true}))
    expect(button("Check my step")?.disabled).toBe(true)
    // A step change alone does not clear it.
    await emit("learningState", lesson({currentStep: 3, stepData: step(3)}))
    expect(button("Check my step")?.disabled).toBe(true)
    await emit("assistantState", {state: "listening"})
    expect(button("Check my step")?.disabled).toBe(false)
  })

  test("without a key the check button is off and says why", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson(), connection: {...READY, claudeReady: false, keyHint: ""}}))
    expect(button("Check my step")?.disabled).toBe(true)
    expect(screenText()).toContain("Photo checks need the Claude key")
  })

  test("back shows the library with a lesson in progress, Resume returns, and the end shows a note", async () => {
    await mount()
    await emit("snapshot", snapshot())
    await emit("learningState", lesson())
    expect(button("Check my step")).toBeDefined()

    // The phone's back gesture.
    await act(async () => {
      history.back()
    })
    await settle()
    expect(button("Check my step")).toBeUndefined()
    expect(screenText()).toContain("Lesson in progress")
    expect(all(".tutorial-card")).toHaveLength(2)
    // Going back did not end the lesson.
    expect(fake.sentOn("endLearning")).toHaveLength(0)
    // Another lesson cannot be started meanwhile.
    expect((all(".card-start")[0] as HTMLButtonElement).disabled).toBe(true)

    await click(button("Resume"))
    expect(button("Check my step")).toBeDefined()

    // The background ends the lesson as finished: library again, with a note.
    await emit("learningState", lesson({active: false, finished: true, currentStep: 3}))
    expect(button("Check my step")).toBeUndefined()
    expect(screenText()).toContain("Lesson finished")
    expect(screenText()).not.toContain("Lesson in progress")
    expect(all(".tutorial-card")).toHaveLength(2)
  })

  test("End on the in-progress card sends endLearning", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))
    await act(async () => {
      history.back()
    })
    await settle()
    await click(button("End"))
    expect(fake.sentOn("endLearning")).toEqual([{}])
    // Still in progress until the background says otherwise.
    expect(screenText()).toContain("Lesson in progress")
    await emit("learningState", lesson({active: false, finished: false}))
    expect(screenText()).not.toContain("Lesson in progress")
    expect(screenText()).not.toContain("Lesson finished")
  })
})

describe("teaching", () => {
  const recording: TeachingState = {
    status: "recording",
    elapsedSeconds: 83,
    frameCount: 0,
    stepCount: 2,
    narration: "the rabbit comes out of the hole",
    sessionId: "1763140000000",
  }

  test("Start Recording sends what was typed, no built-in skill name, and waits for the background", async () => {
    await mount()
    await emit("snapshot", snapshot())
    await click(button("Teaching"))

    await click(button("Start Recording"))
    expect(fake.sentOn("startTeaching")).toEqual([{}])
    // Still the idle screen: the tap changed nothing here.
    expect(button("Start Recording")).toBeDefined()
    expect(button("Save this step")).toBeUndefined()

    await type(document.querySelector("#teach-skill"), " tying a bowline ")
    await click(button("Start Recording"))
    expect(fake.sentOn("startTeaching")[1]).toEqual({targetSkill: "tying a bowline"})
  })

  test("a recording teachingState with an error shows the error and the real counts", async () => {
    await mount()
    await emit("snapshot", snapshot())
    await emit("teachingState", {...recording, error: "Claude could not be reached."})

    // The screen moved to the Teaching tab by itself when the recording opened.
    expect(all(".error-line").map((line) => line.textContent)).toEqual(["Claude could not be reached."])
    expect(screenText()).toContain("01:23")
    expect(screenText()).toContain("Steps saved: 2")
    // 83 seconds and no photo: the count stays 0, nothing is invented.
    expect(screenText()).toContain("Photos: 0")
    expect(screenText()).toContain("the rabbit comes out of the hole")
    expect(screenText()).toContain("No photo yet")

    await click(button("Save this step"))
    await click(button("Finish lesson"))
    expect(fake.sentOn("captureStep")).toEqual([{}])
    expect(fake.sentOn("stopTeaching")).toEqual([{}])
    // Still recording on screen until the background says "processing".
    expect(button("Save this step")).toBeDefined()

    // Discard asks twice, and stays enabled while the app is busy.
    await emit("assistantState", {state: "speaking"})
    expect(button("Save this step")?.disabled).toBe(true)
    expect(button("Discard")?.disabled).toBe(false)
    await click(button("Discard"))
    expect(fake.sentOn("discardTeaching")).toHaveLength(0)
    await click(button("Sure? Tap again"))
    expect(fake.sentOn("discardTeaching")).toEqual([{}])
  })

  test("a failed lesson build is shown and stays through the clock ticks", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: recording}))
    await emit("teachingState", {...recording, status: "processing"})
    expect(screenText()).toContain("Building the lesson")
    expect(screenText()).not.toContain("%")

    await emit("tutorialGenerated", {status: "error", error: "Claude answered with no steps."})
    await emit("teachingState", {...recording, error: "Claude answered with no steps."})
    // Same sentence from both events: shown once.
    expect(all(".error-line").map((line) => line.textContent)).toEqual(["Claude answered with no steps."])

    // The next clock tick carries no error. The reason is still on screen.
    await emit("teachingState", {...recording, elapsedSeconds: 84})
    expect(all(".error-line")).toHaveLength(1)

    // A new try clears it.
    await emit("teachingState", {...recording, status: "processing"})
    expect(all(".error-line")).toHaveLength(0)
  })

  test("the last photo shows, and a dead link falls back to plain words", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: recording}))
    await emit("photoCapture", {photoUrl: "https://photos.test/5.jpg", frameIndex: 5, timestampSeconds: 80, kind: "step"})
    const image = document.querySelector(".viewfinder-preview img")
    expect(image?.getAttribute("src")).toBe("https://photos.test/5.jpg")
    expect(screenText()).toContain("Saved step")

    await act(async () => {
      image?.dispatchEvent(new window.Event("error"))
    })
    expect(document.querySelector(".viewfinder-preview img")).toBeNull()
    expect(screenText()).toContain("The last photo could not be shown")
  })

  test("review: edit, publish the draft with the new title, then follow the background to the library", async () => {
    const draft: TutorialModel = {
      ...RECORDED,
      id: "tut_1763150000000",
      status: "draft",
      steps: [step(1, {done_looks_like: "A small loop lies flat."}), step(2)],
    }
    await mount()
    await emit("snapshot", snapshot({tutorials: [BUILT_IN], teaching: {...recording, status: "processing"}}))
    await emit("tutorialGenerated", {status: "success", tutorial: draft})
    await emit("teachingState", {...recording, status: "review"})

    expect(screenText()).toContain("Review & Publish")
    expect(screenText()).toContain("Step 1: Title of step 1")
    expect(screenText()).toContain("Library text of step 1.")
    expect(screenText()).toContain("A small loop lies flat.")
    expect((document.querySelector("#tut-title") as HTMLInputElement).value).toBe("Tie a Bowline Knot")

    await type(document.querySelector("#tut-title"), "Bowline in ten seconds")
    await type(document.querySelector("#tut-desc"), "Rabbit, hole, tree.")
    await click(button("Publish to Library"))

    const sent = fake.sentOn("publishTutorial") as Array<{tutorial: TutorialModel}>
    expect(sent).toHaveLength(1)
    expect(sent[0].tutorial.id).toBe(draft.id)
    expect(sent[0].tutorial.title).toBe("Bowline in ten seconds")
    expect(sent[0].tutorial.description).toBe("Rabbit, hole, tree.")
    expect(sent[0].tutorial.steps).toEqual(draft.steps)
    // Still on review: the screen does not publish by itself.
    expect(screenText()).toContain("Review & Publish")

    // The background confirms: the lesson is in the list and teaching is idle.
    const published = {...draft, title: "Bowline in ten seconds", status: "published" as const}
    await emit("tutorialList", {tutorials: [published, BUILT_IN]})
    await emit("teachingState", TEACH_IDLE)
    expect(all(".tutorial-card")).toHaveLength(2)
    expect(screenText()).toContain("Lesson published: Bowline in ten seconds")
  })

  test("without a key the Teaching tab shows the key box, and a refused start shows its reason", async () => {
    await mount()
    await emit("snapshot", snapshot({connection: {...READY, claudeReady: false, keyHint: ""}}))
    await click(button("Teaching"))
    expect(document.querySelector("#claude-key")).not.toBeNull()
    expect(screenText()).toContain("No key saved")

    await emit("teachingState", {...TEACH_IDLE, error: "Add the Claude key on the phone screen first."})
    expect(all(".error-line").map((line) => line.textContent)).toEqual(["Add the Claude key on the phone screen first."])
    expect(button("Start Recording")).toBeDefined()
  })
})

describe("settings", () => {
  test("saving a key calls setKey and shows the error the background returns", async () => {
    let resolveAnswer: (value: {ok: boolean; error: string}) => void = () => {}
    fake.answers.setKey = () => new Promise((resolve) => (resolveAnswer = resolve))
    await mount()
    await emit("snapshot", snapshot({connection: {...READY, claudeReady: false, keyHint: ""}}))

    const input = document.querySelector("#claude-key") as HTMLInputElement
    expect(input.type).toBe("password")
    expect(input.getAttribute("autocapitalize")).toBe("off")
    expect(input.getAttribute("autocorrect")).toBe("off")
    expect(input.getAttribute("spellcheck")).toBe("false")
    expect(button("Save key")?.disabled).toBe(true)

    await type(input, "sk-ant-test-wrong")
    await click(button("Save key"))
    expect(fake.requests.filter((r) => r.channel === "setKey")).toEqual([{channel: "setKey", payload: {key: "sk-ant-test-wrong"}}])
    expect(screenText()).toContain("Testing the key...")

    await act(async () => {
      resolveAnswer({ok: false, error: "Claude rejected this key. Copy it again from the Claude Console."})
    })
    expect(screenText()).not.toContain("Testing the key...")
    expect(all(".error-line").map((line) => line.textContent)).toEqual([
      "Claude rejected this key. Copy it again from the Claude Console.",
    ])
    // The screen does not decide that a key is saved.
    expect(screenText()).toContain("No key saved")
  })

  test("a saved key shows its last four characters, and Remove sends an empty key", async () => {
    fake.answers.setKey = async () => ({ok: true, error: ""})
    await mount()
    await emit("snapshot", snapshot())
    expect(screenText()).toContain("Key saved, ends in 9xQz")

    await click(button("Remove key"))
    expect(fake.requests.filter((r) => r.channel === "setKey")).toEqual([{channel: "setKey", payload: {key: ""}}])
    expect(screenText()).toContain("Key removed.")
    // Still "saved" on screen until connectionStatus arrives.
    expect(screenText()).toContain("Key saved, ends in 9xQz")
    await emit("connectionStatus", {...READY, claudeReady: false, keyHint: ""})
    expect(screenText()).toContain("No key saved")
    expect(screenText()).toContain("Claude key missing")
  })

  test("Test glasses audio sends testAudio, and the spoken commands are listed", async () => {
    await mount()
    await emit("snapshot", snapshot())
    await click(button("Test glasses audio"))
    expect(fake.sentOn("testAudio")).toEqual([{}])
    for (const phrase of ["start teaching", "next step", "finish lesson", "start lesson", "check", "repeat", "Tinker, ...", "stop lesson"]) {
      expect(screenText()).toContain(`"${phrase}"`)
    }
  })
})

describe("the whole screen", () => {
  test("never names a Claude model version", async () => {
    await mount()
    const seen: string[] = []
    await emit("snapshot", snapshot())
    seen.push(screenText())
    await emit("learningState", lesson())
    seen.push(screenText())
    await emit("learningState", lesson({active: false}))
    await emit("teachingState", {status: "processing", elapsedSeconds: 9, frameCount: 1, stepCount: 1, narration: ""})
    seen.push(screenText())
    for (const text of seen) {
      expect(text).not.toMatch(/sonnet|haiku|opus|3\.5|claude-/i)
      expect(text).not.toContain("Backend")
    }
  })

  test("dark mode: the provider mirrors the Mentra App's theme onto <html>", async () => {
    ;(window as unknown as {MentraOS?: unknown}).MentraOS = {colorScheme: "dark", safeAreaInsets: {top: 47, bottom: 34, left: 0, right: 0}}
    await mount()
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    // The root is padded by the safe-area insets on every side.
    const rootStyle = (document.querySelector(".tinker-root") as HTMLElement).style
    expect(rootStyle.paddingTop).toBe("47px")
    expect(rootStyle.paddingBottom).toBe("34px")
    delete (window as unknown as {MentraOS?: unknown}).MentraOS
  })
})

describe("applyEvent (the one place that changes the screen's data)", () => {
  test("starts from nothing and is replaced by a snapshot", () => {
    expect(EMPTY.loaded).toBe(false)
    expect(EMPTY.connection.glassesConnected).toBe(false)
    expect(EMPTY.tutorials).toHaveLength(0)
    const state = applyEvent(EMPTY, {channel: "snapshot", payload: snapshot({busy: true})})
    expect(state.loaded).toBe(true)
    expect(state.tutorials).toHaveLength(2)
    expect(isBusy(state)).toBe(true)
    // A newer snapshot that is not busy clears it.
    expect(isBusy(applyEvent(state, {channel: "snapshot", payload: snapshot()}))).toBe(false)
  })

  test("processing counts as busy, and a new lesson starts without the old verdict", () => {
    let state = applyEvent(EMPTY, {channel: "snapshot", payload: snapshot({learning: lesson()})})
    state = applyEvent(state, {channel: "stepVerdict", payload: {step: 2, result: "pass", say: "Good."}})
    expect(state.verdict?.say).toBe("Good.")
    state = applyEvent(state, {channel: "learningState", payload: lesson({sessionId: "session-2", currentStep: 1})})
    expect(state.verdict).toBeNull()

    state = applyEvent(state, {channel: "teachingState", payload: {...TEACH_IDLE, status: "processing"}})
    expect(isBusy(state)).toBe(true)
  })

  test("an empty tutorialList empties the library", () => {
    let state = applyEvent(EMPTY, {channel: "snapshot", payload: snapshot()})
    state = applyEvent(state, {channel: "tutorialList", payload: {tutorials: []}})
    expect(state.tutorials).toHaveLength(0)
  })
})
