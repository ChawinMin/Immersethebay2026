/**
 * ui-render.test.tsx: more tests of the phone screen, for what test/ui.test.tsx missed.
 *
 * WHY THIS FILE EXISTS
 *   A review of the screens (round 3) broke the screen code on purpose in 33
 *   small ways. 25 of the broken versions still passed test/ui.test.tsx. The
 *   tests here are the ones that catch them, plus one test for each fix made
 *   after that review: the 2 second re-request while busy, the pass note,
 *   the scroll reset, the photo count of a screen reopened mid-recording, the
 *   key box, the plain words for known failures, and the "Ending after this
 *   sentence..." note.
 *
 *   Same fake browser and fake Mentra App as test/ui.test.tsx (test/ui-dom.tsx).
 *   Tests that need time to pass use bun's fake timers, so a 10 second wait
 *   takes no real time.
 *
 * Run it with:  bun test test/ui-render.test.tsx
 */

import {afterAll, afterEach, beforeEach, describe, expect, jest, test} from "bun:test"
import type {Channels, TeachingState, TutorialModel} from "../src/shared/channels"
import {
  BUILT_IN,
  FakeMentra,
  NOTHING,
  READY,
  RECORDED,
  SEED,
  TEACH_IDLE,
  all,
  button,
  click,
  emit,
  historyDepth,
  lesson,
  mount,
  notes,
  resetPage,
  screenText,
  settle,
  snapshot,
  startDom,
  step,
  stopDom,
  timeoutError,
  type,
  unmount,
  unmountPage,
} from "./ui-dom"
import {MATCHA_ID, rig} from "./ui-rig"

const {act, applyEvent, EMPTY} = await startDom()

let fake: FakeMentra

beforeEach(async () => {
  fake = await resetPage()
})
afterEach(async () => {
  jest.useRealTimers()
  await unmountPage()
})
afterAll(stopDom)

// ---------------------------------------------------------------- helpers for fake time

/** Deliver an event without waiting on a real timer (for tests that run on fake timers). */
async function push<C extends keyof Channels>(channel: C, payload: Channels[C]): Promise<void> {
  await act(async () => {
    fake.emit(channel, payload)
  })
}

/** Move the fake clock on, then let the answers that became due arrive. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const snapshotRequests = () => fake.requestsOn("getSnapshot").length

const recording: TeachingState = {
  status: "recording",
  elapsedSeconds: 83,
  frameCount: 5,
  stepCount: 2,
  narration: "",
  sessionId: "1763140000000",
}

// ---------------------------------------------------------------- the 2 second re-request

describe("the re-request of a snapshot while the screen needs one", () => {
  test("busy learned from an EVENT is re-checked: a lost 'idle' does not lock the buttons for good", async () => {
    jest.useFakeTimers()
    let answer = snapshot({learning: lesson()})
    fake.answers.getSnapshot = async () => answer
    await mount()
    await advance(0)
    expect(button("Check my step")?.disabled).toBe(false)
    const before = snapshotRequests()

    // A check starts. While it runs, the background says busy when asked.
    answer = snapshot({learning: lesson(), busy: true, assistant: "thinking"})
    await push("assistantState", {state: "thinking", message: "Taking a photo"})
    expect(button("Check my step")?.disabled).toBe(true)
    await advance(2000)
    expect(snapshotRequests()).toBe(before + 1)
    expect(button("Check my step")?.disabled).toBe(true)

    // The check ends, but its closing "idle" never arrives (the background restarted, or the
    // phone paused this page while it was sent). The next snapshot says "at rest" and unlocks.
    answer = snapshot({learning: lesson()})
    await advance(2000)
    expect(snapshotRequests()).toBe(before + 2)
    expect(button("Check my step")?.disabled).toBe(false)
    // At rest, the screen stops asking.
    await advance(10000)
    expect(snapshotRequests()).toBe(before + 2)
  })

  test("'processing' seen in an event is re-checked too", async () => {
    jest.useFakeTimers()
    fake.answers.getSnapshot = async () => snapshot({teaching: {...recording, status: "review"}, draft: {...RECORDED, id: "tut_d", status: "draft"}})
    await mount()
    await push("snapshot", snapshot({teaching: recording}))
    const before = snapshotRequests()
    await push("teachingState", {...recording, status: "processing"})
    await advance(2000)
    expect(snapshotRequests()).toBe(before + 1)
    expect(screenText()).toContain("Review & Publish")
  })

  test("with no snapshot yet it keeps asking every 2 s, and the timer stops when the screen closes", async () => {
    jest.useFakeTimers()
    fake.answers.getSnapshot = () => Promise.reject(new Error("no handler registered"))
    await mount()
    await advance(6500)
    // One at open, then one every 2 seconds.
    expect(snapshotRequests()).toBe(4)
    expect(screenText()).toContain("Connecting...")
    await unmount()
    await advance(10000)
    expect(snapshotRequests()).toBe(4)
  })

  test("a snapshot that says busy is re-checked, and an idle one ends the asking", async () => {
    jest.useFakeTimers()
    let busy = true
    fake.answers.getSnapshot = async () => snapshot({learning: lesson(), busy, assistant: busy ? "speaking" : "idle"})
    await mount()
    await advance(0)
    expect(button("Check my step")?.disabled).toBe(true)
    const first = snapshotRequests()
    await advance(2000)
    expect(snapshotRequests()).toBe(first + 1)
    busy = false
    await advance(2000)
    expect(button("Check my step")?.disabled).toBe(false)
    const settled = snapshotRequests()
    await advance(10000)
    expect(snapshotRequests()).toBe(settled)
  })
})

describe("when the background does not answer", () => {
  test("getSnapshot failing for about 10 s: the Connecting card adds 'Close Tinker and open it again.'", async () => {
    jest.useFakeTimers()
    let fail = true
    fake.answers.getSnapshot = () => (fail ? Promise.reject(new Error("no handler registered")) : Promise.resolve(snapshot()))
    await mount()
    await advance(8000)
    expect(screenText()).toContain("Waiting for Tinker to answer.")
    expect(screenText()).not.toContain("Close Tinker and open it again.")
    await advance(2000)
    expect(screenText()).toContain("Close Tinker and open it again.")

    // Tinker answers again: the advice goes, the screen loads.
    fail = false
    await advance(2000)
    expect(screenText()).not.toContain("Close Tinker and open it again.")
    expect(screenText()).toContain("Glasses connected")
  })

  test("requests that time out count from when they were sent", async () => {
    jest.useFakeTimers()
    // Like the real bridge: a request with a time limit that gets no answer is rejected when the limit runs out.
    fake.answers.getSnapshot = () => new Promise((_, reject) => setTimeout(() => reject(timeoutError()), 5000))
    await mount()
    await advance(9500)
    expect(screenText()).not.toContain("Close Tinker and open it again.")
    // The request sent at 6 s fails at 11 s: 11 seconds of nothing but failures.
    await advance(1600)
    expect(screenText()).toContain("Close Tinker and open it again.")
  })

  test("loaded but busy, and every re-request fails: 'Tinker is not answering. Close Tinker and open it again.'", async () => {
    jest.useFakeTimers()
    fake.answers.getSnapshot = () => Promise.reject(new Error("gone"))
    await mount()
    await push("snapshot", snapshot({learning: lesson(), busy: true, assistant: "speaking"}))
    await advance(9000)
    expect(notes()).not.toContain("Tinker is not answering. Close Tinker and open it again.")
    await advance(4000)
    expect(notes()).toContain("Tinker is not answering. Close Tinker and open it again.")
    // At rest the screen needs nothing, so nothing is failing.
    await push("assistantState", {state: "idle"})
    expect(notes()).not.toContain("Tinker is not answering. Close Tinker and open it again.")
  })
})

// ---------------------------------------------------------------- the key box

describe("the key box", () => {
  test("a successful save clears the field and never shows the key: only its last four characters", async () => {
    fake.answers.setKey = async () => ({ok: true, error: ""})
    await mount()
    await emit("snapshot", snapshot({connection: NOTHING}))
    const input = document.querySelector("#claude-key") as HTMLInputElement
    await type(input, "sk-ant-test-secret-WXYZ")
    await click(button("Save key"))
    await emit("connectionStatus", {...READY, keyHint: "WXYZ"})

    expect(input.value).toBe("")
    expect(input.type).toBe("password")
    expect(notes()).toContain("Key saved.")
    expect(screenText()).toContain("Key saved, ends in WXYZ")
    // Not in any text, and not in any attribute.
    expect(screenText()).not.toContain("sk-ant-test-secret")
    expect(document.body.innerHTML).not.toContain("sk-ant-test-secret")
  })

  test("a request that fails shows its reason, and keeps nothing on screen", async () => {
    fake.answers.setKey = () => Promise.reject(new Error("no handler registered"))
    await mount()
    await emit("snapshot", snapshot({connection: NOTHING}))
    await type(document.querySelector("#claude-key"), "sk-ant-test-key-1234")
    await click(button("Save key"))
    expect(all(".error-line").map((line) => line.textContent)).toEqual([
      "The key was not saved. Close this screen, open it again, and retry.",
    ])
    expect(screenText()).not.toContain("Testing the key...")
    expect(button("Save key")?.disabled).toBe(false)
  })

  test("no answer within 30 s: 'No answer from Tinker. Try again.', and the buttons work again", async () => {
    jest.useFakeTimers()
    // Like the real bridge: the request is rejected when its own time limit runs out.
    fake.answers.setKey = () => new Promise(() => {})
    const realRequest = fake.request
    fake.request = (channel, payload, options) => {
      const pending = realRequest(channel, payload, options)
      if (channel !== "setKey" || !options?.timeout) return pending
      return new Promise((_, reject) => setTimeout(() => reject(timeoutError()), options.timeout))
    }
    await mount()
    await push("snapshot", snapshot({connection: NOTHING}))
    await type(document.querySelector("#claude-key"), "sk-ant-test-key-1234")
    await act(async () => {
      button("Save key")?.click()
    })
    await advance(29000)
    expect(screenText()).toContain("Testing the key...")
    await advance(1000)
    expect(screenText()).not.toContain("Testing the key...")
    expect(all(".error-line").map((line) => line.textContent)).toEqual(["No answer from Tinker. Try again."])
    expect(button("Save key")?.disabled).toBe(false)
  })

  test("Teaching tab: 'Key saved.' shows for a moment before the key card goes away", async () => {
    jest.useFakeTimers()
    let answer: (value: {ok: boolean; error: string}) => void = () => {}
    fake.answers.setKey = () => new Promise((resolve) => (answer = resolve))
    await mount()
    await push("snapshot", snapshot({connection: {...READY, claudeReady: false, keyHint: ""}}))
    await act(async () => {
      button("Teaching")?.click()
    })
    await type(document.querySelector("#claude-key"), "sk-ant-test-key-1234")
    await act(async () => {
      button("Save key")?.click()
    })
    // The real order (coach.ts setKey): connectionStatus first, then the answer.
    await push("connectionStatus", READY)
    expect(document.querySelector("#claude-key")).not.toBeNull()
    await act(async () => {
      answer({ok: true, error: ""})
    })
    expect(notes()).toContain("Key saved.")
    expect(document.querySelector("#claude-key")).not.toBeNull()
    await advance(2600)
    expect(document.querySelector("#claude-key")).toBeNull()
    expect(screenText()).toContain("Start Recording")
  })
})

// ---------------------------------------------------------------- photos

describe("photos", () => {
  test("viewfinder: one dead link does not hide the photos after it", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: recording}))
    const img = () => document.querySelector(".viewfinder-preview img")
    await emit("photoCapture", {photoUrl: "https://photos.test/1.jpg", frameIndex: 1, timestampSeconds: 1, kind: "step"})
    await act(async () => {
      img()?.dispatchEvent(new window.Event("error"))
    })
    expect(img()).toBeNull()
    expect(screenText()).toContain("The last photo could not be shown")

    await emit("photoCapture", {photoUrl: "https://photos.test/2.jpg", frameIndex: 2, timestampSeconds: 2, kind: "auto"})
    expect(img()?.getAttribute("src")).toBe("https://photos.test/2.jpg")
    expect(screenText()).toContain("Timed photo")
    await emit("photoCapture", {photoUrl: "https://photos.test/3.jpg", frameIndex: 3, timestampSeconds: 3, kind: "auto"})
    await act(async () => {
      img()?.dispatchEvent(new window.Event("error"))
    })
    expect(img()).toBeNull()
    await emit("photoCapture", {photoUrl: "https://photos.test/4.jpg", frameIndex: 4, timestampSeconds: 4, kind: "step"})
    expect(img()?.getAttribute("src")).toBe("https://photos.test/4.jpg")
  })

  test("check card: a dead link's status does not stick to the next link", async () => {
    await mount()
    await emit("snapshot", snapshot())
    await emit("learningState", lesson({stepData: step(2, {reference_image_url: "https://photos.test/dead.jpg"})}))
    const figures = () => all(".photo-figure") as HTMLElement[]
    await act(async () => {
      figures()[0]?.querySelector("img")?.dispatchEvent(new window.Event("error"))
    })
    expect(figures()).toHaveLength(0)
    expect(document.querySelector(".check-card")).toBeNull()

    // The next step has a link that works: it gets its own try.
    await emit("learningState", lesson({currentStep: 3, stepData: step(3, {reference_image_url: "https://photos.test/live.jpg"})}))
    expect(figures()).toHaveLength(1)
    expect(figures()[0]!.hidden).toBe(true)
    await act(async () => {
      figures()[0]?.querySelector("img")?.dispatchEvent(new window.Event("load"))
    })
    expect(figures()[0]!.hidden).toBe(false)
    expect(screenText()).toContain("The expert's photo")

    // Same for the learner's photo: a dead one, then a check with a new photo.
    await emit("stepVerdict", {step: 3, result: "fix", say: "Lumpy.", photoUrl: "https://photos.test/learner-dead.jpg"})
    await act(async () => {
      figures()[1]?.querySelector("img")?.dispatchEvent(new window.Event("error"))
    })
    expect(screenText()).not.toContain("Your photo")
    await emit("stepVerdict", {step: 3, result: "unclear", say: "Hold it up.", photoUrl: "https://photos.test/learner-live.jpg"})
    await act(async () => {
      figures()[1]?.querySelector("img")?.dispatchEvent(new window.Event("load"))
    })
    expect(screenText()).toContain("Your photo")
  })

  test("a photo that arrives after a newer one is ignored, and a new recording starts its own count", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: recording}))
    const src = () => document.querySelector(".viewfinder-preview img")?.getAttribute("src")
    await emit("photoCapture", {photoUrl: "https://photos.test/5.jpg", frameIndex: 5, timestampSeconds: 50, kind: "step"})
    await emit("photoCapture", {photoUrl: "https://photos.test/3.jpg", frameIndex: 3, timestampSeconds: 30, kind: "auto"})
    expect(src()).toBe("https://photos.test/5.jpg")

    // The recording is discarded and another one starts: its photo 1 shows, the old photo does not.
    await emit("teachingState", TEACH_IDLE)
    await emit("teachingState", {...recording, sessionId: "1763149999999", frameCount: 0, stepCount: 0})
    expect(src()).toBeUndefined()
    expect(screenText()).toContain("No photo yet")
    await emit("photoCapture", {photoUrl: "https://photos.test/new-1.jpg", frameIndex: 1, timestampSeconds: 4, kind: "step"})
    expect(src()).toBe("https://photos.test/new-1.jpg")
  })

  test("reopened in the middle of a recording: the photo box agrees with the photo count", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: recording}))
    expect(screenText()).toContain("Photos: 5")
    expect(screenText()).toContain("The next photo will show here")
    expect(screenText()).not.toContain("No photo yet")
  })

  test("a recording with no photo yet says so", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: {...recording, frameCount: 0}}))
    expect(screenText()).toContain("No photo yet")
  })
})

// ---------------------------------------------------------------- the pass note

describe("the pass note", () => {
  test("a pass moves the lesson on at once, so it shows above the new step as 'Step N passed.'", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson({currentStep: 1, stepData: step(1)})}))
    // The real order: the verdict for step 1, then the lesson moves to step 2.
    await emit("stepVerdict", {step: 1, result: "pass", say: "Nice work, that looks right.", photoUrl: "https://photos.test/l.jpg"})
    await emit("learningState", lesson({currentStep: 2}))

    expect(notes()).toContain("Step 1 passed. Nice work, that looks right.")
    // Above the step card, so it is the first thing seen after the step changes.
    const note = all(".pass-note")[0]!
    const card = document.querySelector(".step-card")!
    expect(note.compareDocumentPosition(card) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // It is a note, not a verdict chip of the new step.
    expect(all(".verdict-chip")).toHaveLength(0)
  })

  test("the next check hides it (and an old correction) at once: 'Taking a photo' means a new check started", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson(), lastVerdict: {step: 1, result: "pass", say: "Good."}}))
    expect(notes()).toContain("Step 1 passed. Good.")
    await emit("assistantState", {state: "thinking", message: "Taking a photo"})
    expect(notes().some((n) => n.includes("passed"))).toBe(false)

    await emit("assistantState", {state: "idle"})
    await emit("stepVerdict", {step: 2, result: "fix", say: "The powder is lumpy."})
    expect(all(".verdict-chip.fix")).toHaveLength(1)
    await emit("assistantState", {state: "thinking", message: "Taking a photo"})
    expect(all(".verdict-chip")).toHaveLength(0)
    expect(screenText()).not.toContain("The powder is lumpy.")
  })

  test("only a pass of the step just before shows: not a correction, not an older pass", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson({currentStep: 3, stepData: step(3)}), lastVerdict: {step: 1, result: "pass", say: "Old praise."}}))
    expect(screenText()).not.toContain("Old praise.")
    await emit("stepVerdict", {step: 2, result: "fix", say: "A correction."})
    expect(screenText()).not.toContain("A correction.")
  })

  test("a pass on the last step: the library says 'Lesson finished: TITLE.' with the praise", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson({currentStep: 3, stepData: step(3)})}))
    await emit("stepVerdict", {step: 3, result: "pass", say: "Beautiful, enjoy it."})
    await emit("learningState", lesson({currentStep: 3, stepData: step(3), active: false, finished: true}))
    expect(notes()).toContain("Lesson finished: How to Make Matcha. Beautiful, enjoy it.")
  })

  test("a lesson finished without a check: 'Lesson finished: TITLE.' and no praise", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson({currentStep: 3, stepData: step(3)}), lastVerdict: {step: 2, result: "pass", say: "Older praise."}}))
    await emit("learningState", lesson({currentStep: 3, stepData: step(3), active: false, finished: true}))
    expect(notes()).toContain("Lesson finished: How to Make Matcha.")
    expect(screenText()).not.toContain("Older praise.")
  })

  test("with the REAL Coach: check, pass, and the note is on the screen at rest; the last pass ends with the praise", async () => {
    const r = await rig({listener: (channel, payload) => fake.emit(channel as keyof Channels, payload as never)})
    fake.answers.getSnapshot = async () => JSON.parse(JSON.stringify(r.coach.snapshot()))
    await mount()
    await settle()
    r.open()
    const run = async (work: () => void) => {
      await act(async () => {
        work()
        await r.coach.whenIdle()
      })
      await settle()
    }
    await run(() => r.coach.command("startLearning", {tutorialId: MATCHA_ID}))
    expect(screenText()).toContain("Step 1 of 6")
    r.verdicts.push({result: "pass", say: "Nice work, that looks right."})
    await run(() => r.coach.command("checkStep", {}))
    expect(screenText()).toContain("Step 2 of 6")
    expect(notes()).toContain("Step 1 passed. Nice work, that looks right.")
    expect(button("Check my step")?.disabled).toBe(false)

    for (let n = 2; n < 6; n++) await run(() => r.coach.command("navigateStep", {direction: "next"}))
    expect(screenText()).toContain("Step 6 of 6")
    r.verdicts.push({result: "pass", say: "Beautiful, enjoy it."})
    await run(() => r.coach.command("checkStep", {}))
    expect(notes()).toContain(`Lesson finished: ${SEED.title}. Beautiful, enjoy it.`)
  })
})

// ---------------------------------------------------------------- the back gesture and the scroll

describe("history and scroll", () => {
  test("a lesson that ends leaves no history entry behind", async () => {
    await mount()
    await emit("snapshot", snapshot())
    const start = historyDepth()
    await emit("learningState", lesson())
    expect(historyDepth().index).toBe(start.index + 1)
    await emit("learningState", lesson({active: false, finished: true}))
    await settle()
    // The entry the lesson pushed was gone back over: the next back gesture leaves the app.
    expect(historyDepth().index).toBe(start.index)
    expect(screenText()).toContain("Lesson finished")
  })

  test("lessons that end while the Teaching tab shows do not grow the history", async () => {
    await mount()
    await emit("snapshot", snapshot())
    for (let round = 1; round <= 3; round++) {
      await emit("learningState", lesson({sessionId: `s${round}`}))
      await click(button("Teaching"))
      await emit("learningState", lesson({sessionId: `s${round}`, active: false, finished: true}))
    }
    // Each round: one entry for the lesson view, one for the tab. Nothing more.
    expect(historyDepth().length).toBeLessThanOrEqual(4)
    // And the Learning tab shows the library, not a stale lesson view.
    await click(button("Learning"))
    expect(all(".tutorial-card")).toHaveLength(2)
    expect(button("Check my step")).toBeUndefined()
  })

  test("a new view starts at the top of the page", async () => {
    await mount()
    await emit("snapshot", snapshot())
    // Scrolled down to the last lesson card, then the lesson starts.
    await act(async () => {
      window.scrollTo(0, 700)
    })
    await emit("learningState", lesson())
    expect(window.scrollY).toBe(0)

    // Reading the transcript at the bottom when the lesson ends: the library opens at its top.
    await act(async () => {
      window.scrollTo(0, 900)
    })
    await emit("learningState", lesson({active: false, finished: true}))
    expect(window.scrollY).toBe(0)

    // A tab switch, and a new panel on the Teaching tab, start at the top too.
    await act(async () => {
      window.scrollTo(0, 400)
    })
    await click(button("Teaching"))
    expect(window.scrollY).toBe(0)
    await act(async () => {
      window.scrollTo(0, 400)
    })
    await emit("teachingState", {...recording, frameCount: 0})
    expect(window.scrollY).toBe(0)
  })

  test("inside a lesson the tagline and the status pills are hidden; a lost glasses link still shows", async () => {
    await mount()
    await emit("snapshot", snapshot())
    expect((document.querySelector(".tinker-header") as HTMLElement).hidden).toBe(false)
    await emit("learningState", lesson())
    expect((document.querySelector(".tinker-header") as HTMLElement).hidden).toBe(true)
    expect(notes()).not.toContain("Glasses not connected.")
    await emit("connectionStatus", {...READY, glassesConnected: false})
    expect(notes()).toContain("Glasses not connected.")
    await emit("learningState", lesson({active: false}))
    expect((document.querySelector(".tinker-header") as HTMLElement).hidden).toBe(false)
  })

  test("the root is padded by the safe area on all four sides", async () => {
    ;(window as unknown as {MentraOS?: unknown}).MentraOS = {colorScheme: "light", safeAreaInsets: {top: 47, bottom: 34, left: 12, right: 16}}
    try {
      await mount()
      const style = (document.querySelector(".tinker-root") as HTMLElement).style
      expect([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]).toEqual(["47px", "16px", "34px", "12px"])
    } finally {
      delete (window as unknown as {MentraOS?: unknown}).MentraOS
    }
  })
})

// ---------------------------------------------------------------- the busy rule

describe("buttons that start a command respect busy", () => {
  test("recording: Save this step and Finish lesson are off while the glasses talk, Discard is not", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: recording}))
    expect(button("Finish lesson")?.disabled).toBe(false)
    await emit("assistantState", {state: "speaking"})
    expect(button("Save this step")?.disabled).toBe(true)
    expect(button("Finish lesson")?.disabled).toBe(true)
    expect(button("Discard")?.disabled).toBe(false)
  })

  test("review: Publish is off while busy, Discard is not", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: {...recording, status: "review"}, draft: {...RECORDED, id: "tut_d", status: "draft"}}))
    expect(button("Publish to Library")?.disabled).toBe(false)
    await emit("assistantState", {state: "speaking"})
    expect(button("Publish to Library")?.disabled).toBe(true)
    expect(button("Discard")?.disabled).toBe(false)
  })

  test("the typed question is not sent while busy, not even by pressing Enter", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))
    await emit("assistantState", {state: "thinking"})
    await type(document.querySelector(".ask-input"), "is this enough?")
    expect(button("Send the question")?.disabled).toBe(true)
    await act(async () => {
      document.querySelector(".ask-form")?.dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}))
    })
    expect(fake.sentOn("askTinker")).toHaveLength(0)
    await emit("assistantState", {state: "idle"})
    await act(async () => {
      document.querySelector(".ask-form")?.dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}))
    })
    expect(fake.sentOn("askTinker")).toEqual([{text: "is this enough?"}])
  })

  test("Start Recording is off while a lesson runs, and says why", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))
    await click(button("Teaching"))
    expect(button("Start Recording")?.disabled).toBe(true)
    expect(notes()).toContain("A lesson is running. End it before you record.")
  })

  test("the lesson being learned cannot be deleted; another recorded lesson can", async () => {
    const other: TutorialModel = {...RECORDED, id: "tut_other", title: "Other lesson"}
    await mount()
    await emit("snapshot", snapshot({tutorials: [RECORDED, other, BUILT_IN], learning: lesson({tutorialId: RECORDED.id})}))
    await act(async () => {
      history.back()
    })
    await settle()
    const deletes = all(".tutorial-card").map((card) => card.querySelector("button.btn-small") as HTMLButtonElement | null)
    expect(deletes[0]?.disabled).toBe(true)
    expect(deletes[1]?.disabled).toBe(false)
    expect(deletes[2]).toBeNull()
  })

  test("Previous is off on the first step", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson({currentStep: 1, stepData: step(1)})}))
    expect(button("Previous")?.disabled).toBe(true)
    await emit("learningState", lesson({currentStep: 2}))
    expect(button("Previous")?.disabled).toBe(false)
  })
})

// ---------------------------------------------------------------- "Ending after this sentence..."

describe("End and Discard while the glasses talk", () => {
  test("End Session: 'Ending after this sentence...' until the background ends the lesson", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))
    await emit("assistantState", {state: "speaking"})
    await click(button("End Session"))
    expect(fake.sentOn("endLearning")).toEqual([{}])
    expect(notes()).toContain("Ending after this sentence...")
    await emit("learningState", lesson({active: false}))
    expect(notes()).not.toContain("Ending after this sentence...")
    expect(all(".tutorial-card")).toHaveLength(2)
  })

  test("End Session at rest needs no note: the background acts at once", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))
    await click(button("End Session"))
    expect(fake.sentOn("endLearning")).toEqual([{}])
    expect(notes()).not.toContain("Ending after this sentence...")
  })

  test("End on the in-progress card shows the note too", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson(), assistant: "speaking", busy: true}))
    await act(async () => {
      history.back()
    })
    await settle()
    await click(button("End"))
    expect(notes()).toContain("Ending after this sentence...")
  })

  test("Discard while recording: the note, until the background reports the recording gone", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: recording}))
    await emit("assistantState", {state: "speaking"})
    await click(button("Discard"))
    await click(button("Sure? Tap again"))
    expect(fake.sentOn("discardTeaching")).toEqual([{}])
    expect(notes()).toContain("Ending after this sentence...")
    await emit("teachingState", TEACH_IDLE)
    expect(notes()).not.toContain("Ending after this sentence...")
  })

  test("the note goes when the screen is at rest again, even with no confirmation", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))
    await emit("assistantState", {state: "speaking"})
    await click(button("End Session"))
    await emit("assistantState", {state: "idle"})
    expect(notes()).not.toContain("Ending after this sentence...")
  })
})

// ---------------------------------------------------------------- what the background said, as it said it

describe("the screen follows snapshots and events exactly", () => {
  test("a snapshot replaces the old transcript, verdict and draft", () => {
    let state = applyEvent(EMPTY, {
      channel: "snapshot",
      payload: snapshot({
        learning: lesson(),
        lastVerdict: {step: 2, result: "fix", say: "Old."},
        transcript: [{id: "t1", speaker: "tinker", text: "Old line.", isFinal: true, timestamp: "Step 2"}],
      }),
    })
    state = applyEvent(state, {channel: "transcriptionUpdate", payload: {id: "t2", speaker: "user", text: "Another old line.", isFinal: true, timestamp: "You"}})
    const fresh = snapshot({
      teaching: {...recording, status: "review"},
      draft: {...RECORDED, id: "tut_new", status: "draft"},
      transcript: [{id: "t9", speaker: "system", text: "New line.", isFinal: true, timestamp: "Note"}],
    })
    state = applyEvent(state, {channel: "snapshot", payload: fresh})
    expect(state.transcript.map((line) => line.id)).toEqual(["t9"])
    expect(state.verdict).toBeNull()
    expect(state.draft?.id).toBe("tut_new")

    // And the other way: a snapshot with no draft removes the one the screen had.
    state = applyEvent(state, {channel: "snapshot", payload: snapshot()})
    expect(state.draft).toBeNull()
    expect(state.transcript).toEqual([])
  })

  test("a snapshot after a finished lesson keeps the 'Lesson finished' note", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))
    await emit("learningState", lesson({active: false, finished: true}))
    expect(notes().some((n) => n.startsWith("Lesson finished"))).toBe(true)
    // The 2 second re-request, or a reopened link, brings a snapshot with no lesson in it.
    await emit("snapshot", snapshot())
    expect(notes().some((n) => n.startsWith("Lesson finished"))).toBe(true)
  })

  test("events before the first snapshot do not claim anything", async () => {
    await mount()
    await emit("connectionStatus", READY)
    await emit("tutorialList", {tutorials: [BUILT_IN]})
    expect(screenText()).toContain("Connecting...")
    expect(screenText()).not.toContain("Glasses connected")
    expect(all(".tutorial-card")).toHaveLength(0)
  })

  test("the transcript keeps the newest 100 lines", async () => {
    let state = applyEvent(EMPTY, {channel: "snapshot", payload: snapshot({learning: lesson()})})
    for (let i = 1; i <= 105; i++) {
      state = applyEvent(state, {channel: "transcriptionUpdate", payload: {id: `t${i}`, speaker: "tinker", text: `Line ${i}`, isFinal: true, timestamp: "Step 2"}})
    }
    expect(state.transcript).toHaveLength(100)
    expect(state.transcript[0]!.id).toBe("t6")
    expect(state.transcript.at(-1)!.id).toBe("t105")
  })

  test("a new recording shows no photo from the last one, and a discard clears the old build error", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: recording}))
    await emit("photoCapture", {photoUrl: "https://photos.test/old.jpg", frameIndex: 5, timestampSeconds: 80, kind: "step"})
    await emit("tutorialGenerated", {status: "error", error: "The lesson was not built. Claude found no steps in the recording."})
    expect(all(".error-line")).toHaveLength(1)

    // Discard: the idle panel shows no old error.
    await emit("teachingState", TEACH_IDLE)
    expect(all(".error-line")).toHaveLength(0)
    // A new recording: no old photo, no old error.
    await emit("teachingState", {...recording, sessionId: "1763149999999", frameCount: 0})
    expect(document.querySelector(".viewfinder-preview img")).toBeNull()
    expect(all(".error-line")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- words on the screen

describe("words", () => {
  test("known failures are said in plain words first, with the background's own words after them in smaller type", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: {...recording, error: "The lesson was not built. Overloaded"}}))
    const line = all(".error-line")[0]!
    expect(line.textContent).toBe("Claude is busy right now. Try again in a moment. The lesson was not built. Overloaded")
    expect(line.querySelector("small.error-detail")?.textContent).toBe("The lesson was not built. Overloaded")

    await emit("teachingState", {...recording, error: "The lesson was not built. Claude answered with HTTP 529."})
    expect(all(".error-line")[0]!.textContent).toStartWith("Claude is busy right now. Try again in a moment.")
    await emit("teachingState", {...recording, error: "The lesson was not built. No connection to Claude. Network request failed"})
    expect(all(".error-line")[0]!.textContent).toStartWith("No internet connection to Claude.")

    // A failure with no plain version is shown as it is, without a second copy.
    await emit("teachingState", {...recording, error: "The lesson was not built. Claude found no steps in the recording."})
    expect(all(".error-line")[0]!.textContent).toBe("The lesson was not built. Claude found no steps in the recording.")
    expect(all(".error-line")[0]!.querySelector("small")).toBeNull()
  })

  test("a failed check in the transcript: 'Claude rejected the key.' first", async () => {
    await mount()
    await emit("snapshot", snapshot({learning: lesson()}))
    await emit("transcriptionUpdate", {id: "t5", speaker: "system", text: "The check failed. invalid x-api-key", isFinal: true, timestamp: "Note"})
    const line = all(".transcript-item.system")[0]!
    expect(line.textContent).toContain("Claude rejected the key. The check failed. invalid x-api-key")
    // What the glasses said is never rewritten.
    await emit("transcriptionUpdate", {id: "t6", speaker: "tinker", text: "Overloaded words in a sentence.", isFinal: true, timestamp: "Step 2"})
    expect(all(".transcript-item.tinker")[0]!.textContent).not.toContain("Claude is busy")
  })

  test("one step is '1 Step', in the library and on the review", async () => {
    const one: TutorialModel = {...RECORDED, steps: [step(1)], total_steps: 1}
    await mount()
    await emit("snapshot", snapshot({tutorials: [one, BUILT_IN]}))
    const metas = all(".tutorial-meta").map((m) => (m.textContent ?? "").replace(/\s+/g, " "))
    expect(metas[0]).toStartWith("1 Step")
    expect(metas[0]).not.toContain("Steps")
    expect(metas[1]).toStartWith("3 Steps")

    await emit("teachingState", {...recording, status: "review"})
    await emit("tutorialGenerated", {status: "success", tutorial: {...one, id: "tut_draft", status: "draft"}})
    expect(document.querySelector(".review-heading .tutorial-tag")?.textContent).toBe("1 Step")
  })

  test("while a draft waits, the library says so (not 'A recording is open')", async () => {
    await mount()
    await emit("snapshot", snapshot({teaching: {...recording, status: "review"}, draft: {...RECORDED, id: "tut_d", status: "draft"}}))
    await click(button("Learning"))
    expect(notes()).toContain(
      "A draft lesson is waiting for review on the Teaching tab. Publish or discard it before you start a lesson.",
    )
    expect(screenText()).not.toContain("A recording is open")
    await emit("teachingState", {...recording, status: "processing"})
    expect(notes()).toContain("Claude is writing a lesson on the Teaching tab. You can start a lesson when it is ready.")
    await emit("teachingState", recording)
    expect(notes()).toContain("A recording is open on the Teaching tab. Finish or discard it before you start a lesson.")
  })
})

// ---------------------------------------------------------------- typed text survives a tab switch

describe("typed text", () => {
  test("the skill box survives a tab switch, and is empty again for the next recording", async () => {
    await mount()
    await emit("snapshot", snapshot())
    await click(button("Teaching"))
    await type(document.querySelector("#teach-skill"), "tying a bowline")
    await click(button("Learning"))
    await click(button("Teaching"))
    expect((document.querySelector("#teach-skill") as HTMLInputElement).value).toBe("tying a bowline")

    await emit("teachingState", {...recording, frameCount: 0})
    await emit("teachingState", TEACH_IDLE)
    expect((document.querySelector("#teach-skill") as HTMLInputElement).value).toBe("")
  })

  test("review edits survive a tab switch and are what Publish sends; a new draft starts from Claude's text", async () => {
    const draft: TutorialModel = {...RECORDED, id: "tut_d1", status: "draft"}
    await mount()
    await emit("snapshot", snapshot({teaching: {...recording, status: "review"}, draft}))
    await type(document.querySelector("#tut-title"), "Bowline in ten seconds")
    await type(document.querySelector("#tut-desc"), "Rabbit, hole, tree.")
    await click(button("Learning"))
    await click(button("Teaching"))
    expect((document.querySelector("#tut-title") as HTMLInputElement).value).toBe("Bowline in ten seconds")
    await click(button("Publish to Library"))
    const sent = fake.sentOn("publishTutorial") as Array<{tutorial: TutorialModel}>
    expect(sent[0]?.tutorial.title).toBe("Bowline in ten seconds")
    expect(sent[0]?.tutorial.description).toBe("Rabbit, hole, tree.")

    // Another draft: the old edits do not apply to it.
    await emit("tutorialGenerated", {status: "success", tutorial: {...draft, id: "tut_d2", title: "Claude's new title"}})
    expect((document.querySelector("#tut-title") as HTMLInputElement).value).toBe("Claude's new title")
  })
})

// ---------------------------------------------------------------- main.tsx

describe("main.tsx", () => {
  test("mounts the screen inside the provider and turns off the browser's scroll restoring", async () => {
    // main.tsx keeps its React root to itself, so this test cannot unmount it. An answered
    // snapshot leaves that screen loaded and at rest: it then runs no timer into later tests.
    fake.answers.getSnapshot = async () => snapshot()
    expect(history.scrollRestoration).toBe("auto")
    const host = document.createElement("div")
    host.id = "root"
    document.body.append(host)
    await act(async () => {
      await import("../src/ui/main")
    })
    await settle()
    expect(history.scrollRestoration).toBe("manual")
    expect(fake.readyCalls).toBe(1)
    expect(host.textContent).toContain("Glasses connected")
  })
})
