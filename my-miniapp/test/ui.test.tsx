/**
 * ui.test.tsx: a smoke test of the phone screen (src/ui).
 *
 * WHY THIS FILE EXISTS
 *   The screen must show only what the background tells it. These tests render
 *   the real <App /> inside the real <MentraProvider> in a fake browser
 *   (happy-dom), with a fake `mentra` object in place of the Mentra App. The
 *   fake records every `send` and `request` and lets a test push events, the
 *   way the background would. No glasses, no phone, no network. The fake
 *   browser and the fake Mentra App are in test/ui-dom.tsx.
 *
 * WHAT IT PROVES
 *   - before the first snapshot nothing is claimed ("Connecting...")
 *   - every screen is drawn from background events, never from a tap
 *   - buttons send the right command and nothing else
 *   - errors from the background are visible
 *   - the back gesture and the busy rule behave as designed
 *
 * MORE SCREEN TESTS
 *   test/ui-render.test.tsx  timers, the key box, photos, history, busy, the fixes of the review
 *   test/ui-coach.test.ts    the screen's data fed by the REAL Coach, and a fuzzer
 *
 * WHAT IT CANNOT PROVE
 *   Layout, colours and the real Mentra bridge. Those were checked by eye in a
 *   headless browser (pictures in /home/claude/reports/ui-shots).
 *
 * Run it with:  bun test test/ui.test.tsx
 */

import {afterAll, afterEach, beforeEach, describe, expect, test} from "bun:test"
import type {TeachingState, TutorialModel} from "../src/shared/channels"
import {
  BUILT_IN,
  FakeMentra,
  NOTHING,
  READY,
  RECORDED,
  TEACH_IDLE,
  all,
  button,
  click,
  emit,
  lesson,
  mount,
  resetPage,
  screenText,
  settle,
  snapshot,
  startDom,
  step,
  stopDom,
  type,
  unmountPage,
} from "./ui-dom"

// The fake browser must exist before React is loaded, so React comes from startDom(), not from an import.
const {act, applyEvent, EMPTY, isBusy} = await startDom()

let fake: FakeMentra

// ---------------------------------------------------------------- setup

beforeEach(async () => {
  fake = await resetPage()
})

afterEach(unmountPage)

// `bun test` runs every test file in one process. Take the fake browser away
// again, so the background tests that run after this file see a plain engine
// with no `window` and no `document`.
afterAll(stopDom)

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
    // onOpen asked for the full picture, with a time limit so unanswered requests do not pile up.
    expect(fake.requests[0]).toEqual({channel: "getSnapshot", payload: {}, options: {timeout: 5000}})
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

    // A correction for another step does not sit under this one. (A PASS of the step
    // just before does show, as a note: see "the pass note" in ui-render.test.tsx.)
    await emit("stepVerdict", {step: 1, result: "fix", say: "Sentence for another step."})
    expect(screenText()).not.toContain("Sentence for another step.")
    expect(all(".verdict-chip")).toHaveLength(0)
    await emit("stepVerdict", {step: 3, result: "pass", say: "Sentence for a later step."})
    expect(screenText()).not.toContain("Sentence for a later step.")
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
    // The screen gives up waiting after 30 seconds (see ui-render.test.tsx for what it then says).
    expect(fake.requestsOn("setKey")).toEqual([{channel: "setKey", payload: {key: "sk-ant-test-wrong"}, options: {timeout: 30000}}])
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

  test("a saved key shows its last four characters, and Remove asks twice, then sends an empty key", async () => {
    fake.answers.setKey = async () => ({ok: true, error: ""})
    await mount()
    await emit("snapshot", snapshot())
    expect(screenText()).toContain("Key saved, ends in 9xQz")

    // Text in the box must not travel with a removal.
    await type(document.querySelector("#claude-key"), "sk-ant-test-typed-but-not-saved")
    await click(button("Remove key"))
    // The first tap only asks. Nothing is sent: the key sits next to Save, and a slip would remove it.
    expect(fake.requestsOn("setKey")).toHaveLength(0)
    await click(button("Sure? Tap again"))
    expect(fake.requestsOn("setKey")).toEqual([{channel: "setKey", payload: {key: ""}, options: {timeout: 30000}}])
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
