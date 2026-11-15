/**
 * ui-coach.test.ts: the screen's data, fed by the REAL Coach.
 *
 * WHY THIS FILE EXISTS
 *   The screen keeps no truth of its own (src/ui/state.ts). It is right only
 *   if, after any series of events the background really sends, it shows the
 *   same as a screen that opens fresh and asks for a snapshot. These tests run
 *   the real Coach (src/background/coach.ts) through test/ui-rig.ts and check
 *   exactly that, first along whole lessons, then with a fuzzer that throws
 *   random speech, taps, button presses, clock ticks, slow speech, slow or
 *   failing Claude requests, failing photos, mid-command snapshots and screen
 *   reopenings at it.
 *
 *   These tests need no browser. What the screen DRAWS from this data is
 *   tested in test/ui.test.tsx and test/ui-render.test.tsx.
 *
 * Run it with:  bun test test/ui-coach.test.ts
 */

import {describe, expect, test} from "bun:test"
import type {Snapshot} from "../src/shared/channels"
import {applyEvent, isBusy} from "../src/ui/state"
import {MATCHA_ID, core, fresh, rig} from "./ui-rig"

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
/** Lets the Coach's promise chains run. Its fakes answer at once, so no real time needs to pass. */
const tick = () => new Promise((resolve) => setImmediate(resolve))
/** The screen as drawn data, next to the screen a fresh snapshot would give. */
const same = (r: Awaited<ReturnType<typeof rig>>) => expect(core(r.screen, isBusy)).toEqual(core(fresh(r), isBusy))

describe("whole lessons with the real Coach", () => {
  test("learning: at every rest the screen equals a freshly opened one, and it ends unlocked", async () => {
    const r = await rig()
    r.open()
    await r.tap("startLearning", {tutorialId: MATCHA_ID})
    same(r)
    r.verdicts.push({result: "fix", say: "Still lumpy."})
    await r.tap("checkStep")
    same(r)
    await r.tap("checkStep") // pass
    same(r)
    await r.tap("askTinker", {text: "how hot?"})
    same(r)
    await r.tap("navigateStep", {direction: "previous"})
    await r.tap("navigateStep", {direction: "repeat"})
    await r.tap("endLearning")
    same(r)
    expect(isBusy(r.screen)).toBe(false)
  })

  test("teaching with a failed build: the error shows, the retry clears it, publish lands in the library", async () => {
    const r = await rig()
    r.open()
    await r.tap("startTeaching", {targetSkill: "matcha"})
    await r.hear("First I sift the powder. Next step.")
    r.brainFail = new Error("boom")
    await r.tap("stopTeaching")
    expect(r.screen.teaching.status).toBe("recording")
    expect(r.screen.buildError).toContain("not built")
    same(r)
    r.brainFail = null
    await r.tap("stopTeaching")
    expect(r.screen.teaching.status).toBe("review")
    expect(r.screen.buildError).toBe("")
    same(r)
    await r.tap("publishTutorial", {tutorial: {title: "T", description: "D"}})
    same(r)
    expect(r.screen.published?.title).toBe("T")
  })

  test("a passed check: the verdict stays in the data for the step before the new one (the screen shows it as a note)", async () => {
    const r = await rig()
    r.open()
    await r.tap("startLearning", {tutorialId: MATCHA_ID})
    r.verdicts.push({result: "pass", say: "Nice work, that looks right."})
    await r.tap("checkStep")
    // The real order: stepVerdict for step 1, then learningState for step 2.
    expect(r.screen.learning?.currentStep).toBe(2)
    expect(r.screen.verdict).toMatchObject({step: 1, result: "pass", say: "Nice work, that looks right."})
    same(r)
  })

  test("a pass on the last step: the lesson ends as finished, and the praise is still there for the 'Lesson finished' note", async () => {
    const r = await rig()
    r.open()
    await r.tap("startLearning", {tutorialId: MATCHA_ID})
    for (let n = 1; n < 6; n++) await r.tap("navigateStep", {direction: "next"})
    expect(r.screen.learning?.currentStep).toBe(6)
    r.verdicts.push({result: "pass", say: "Beautiful, enjoy it."})
    await r.tap("checkStep")
    expect(r.screen.learning).toMatchObject({active: false, finished: true, currentStep: 6})
    expect(r.screen.verdict).toMatchObject({step: 6, result: "pass", say: "Beautiful, enjoy it."})
  })

  test("a check that fails at Claude after a 'fix': the old verdict is gone from the screen, and from a fresh one", async () => {
    const r = await rig()
    r.open()
    await r.tap("startLearning", {tutorialId: MATCHA_ID})
    r.verdicts.push({result: "fix", say: "The bowl is still dry."})
    await r.tap("checkStep")
    expect(r.screen.verdict?.result).toBe("fix")
    r.brainFail = new Error("Overloaded")
    await r.tap("checkStep")
    // The screen forgot it when the new check took its photo...
    expect(r.screen.verdict).toBeNull()
    // ...and a screen opened now must agree (the background forgets it at the same moment).
    expect(fresh(r).verdict).toBeNull()
    same(r)
  })

  test("a check whose photo fails after a 'fix': the old verdict is gone too", async () => {
    const r = await rig()
    r.open()
    await r.tap("startLearning", {tutorialId: MATCHA_ID})
    r.verdicts.push({result: "fix", say: "The bowl is still dry."})
    await r.tap("checkStep")
    r.photoFails = true
    await r.tap("checkStep")
    expect(r.screen.verdict).toBeNull()
    same(r)
  })

  test("the screen opens in the middle of a command (snapshot says busy), then follows the events to rest", async () => {
    const r = await rig()
    await r.tap("startLearning", {tutorialId: MATCHA_ID})
    const release = r.holdBrain()
    r.coach.command("checkStep", {})
    await tick()
    r.open()
    expect(isBusy(r.screen)).toBe(true)
    expect(r.screen.snapshotBusy).toBe(true)
    release()
    await r.coach.whenIdle()
    expect(isBusy(r.screen)).toBe(false)
    same(r)
  })

  test("the screen opens in the middle of a recording: it has the photo count, but no photo link (the viewfinder says so)", async () => {
    const r = await rig()
    await r.tap("startTeaching", {})
    await r.hear("I sift. Next step.")
    await r.hear("I pour. Next step.")
    r.open()
    expect(r.screen.teaching.frameCount).toBe(2)
    // A snapshot carries no photo. Teaching.tsx shows "The next photo will show here" for this case.
    expect(r.screen.lastPhoto).toBeNull()
    // The next photo does show.
    await r.hear("I whisk. Next step.")
    expect(r.screen.lastPhoto?.frameIndex).toBe(3)
  })

  test("End Session while the glasses talk: nothing changes until the sentence is over, then the lesson ends", async () => {
    const r = await rig()
    r.open()
    await r.tap("startLearning", {tutorialId: MATCHA_ID})
    const release = r.holdSpeech()
    r.coach.command("navigateStep", {direction: "repeat"})
    await tick()
    const before = r.events.length
    r.coach.command("endLearning", {})
    await tick()
    // This silence is why the screen shows "Ending after this sentence..." (App.tsx).
    expect(r.events.length).toBe(before)
    expect(r.screen.learning?.active).toBe(true)
    release()
    await r.coach.whenIdle()
    expect(r.screen.learning?.active).toBe(false)
    same(r)
  })
})

// ---------------------------------------------------------------- the fuzzer

/** A small fixed-seed random generator, so a failure can be run again. */
function random(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
}

const PHRASES = [
  "Start teaching.",
  "First I sift the powder.",
  "Then pour. Next step.",
  "Finish lesson.",
  "Publish lesson.",
  "Cancel lesson.",
  "Start lesson.",
  "Check.",
  "Next step.",
  "Go back.",
  "Repeat.",
  "Why",
  "Any tips",
  "What do I need",
  "Stop lesson.",
  "Tinker, how hot?",
  "Hey Tinker.",
  "What can I say",
  "blah blah blah",
]
const COMMANDS = [
  "startTeaching",
  "captureStep",
  "stopTeaching",
  "discardTeaching",
  "publishTutorial",
  "deleteTutorial",
  "startLearning",
  "endLearning",
  "navigateStep",
  "checkStep",
  "askTinker",
  "requestTutorials",
  "testAudio",
] as const

describe("fuzzer: random real inputs, and at every rest the screen equals a freshly opened one", () => {
  for (let seed = 1; seed <= 20; seed++) {
    test(`seed ${seed}`, async () => {
      const rand = random(seed)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
      const r = await rig({key: rand() > 0.15})
      r.open()
      let releases: Array<() => void> = []
      for (let i = 0; i < 120; i++) {
        const roll = rand()
        // Sometimes speech or Claude is slow, so later inputs arrive while a command runs.
        if (rand() < 0.2) releases.push(r.holdSpeech())
        if (rand() < 0.15) releases.push(r.holdBrain())
        r.brainFail = rand() < 0.15 ? new Error("Claude answered with HTTP 529.") : null
        r.photoFails = rand() < 0.1
        r.verdicts.length = 0
        r.verdicts.push(pick([{result: "pass", say: "Good."}, {result: "fix", say: "Lumpy."}, {result: "unclear", say: "Cannot see."}] as const))
        r.clock.now += pick([500, 3000, 3000, 12000, 25000])
        const lessons = r.coach.snapshot().tutorials
        if (roll < 0.35) r.coach.heard(pick(PHRASES), rand() > 0.15)
        else if (roll < 0.45) r.coach.button(pick(["short", "long"] as const))
        else if (roll < 0.55) r.coach.tick()
        else {
          const channel = pick(COMMANDS)
          const payload =
            channel === "startLearning" || channel === "deleteTutorial"
              ? {tutorialId: pick(lessons).id}
              : channel === "navigateStep"
                ? {direction: pick(["next", "previous", "repeat"] as const)}
                : channel === "askTinker"
                  ? {text: "how hot?"}
                  : channel === "publishTutorial"
                    ? {tutorial: {title: `T${i}`, description: ""}}
                    : {}
          r.coach.command(channel, payload as never)
        }
        await tick()
        // Sometimes the 2 second re-request (or a pushed snapshot) lands in the middle of a command.
        if (rand() < 0.25) r.screen = applyEvent(r.screen, {channel: "snapshot", payload: clone(r.coach.snapshot()) as Snapshot})
        // Sometimes a second input arrives while the first still runs.
        if (rand() < 0.3) {
          r.coach.command(pick(["endLearning", "discardTeaching", "checkStep", "captureStep"] as const), {})
          await tick()
        }
        // Sometimes the screen is closed and opened again here.
        if (rand() < 0.08) r.open()
        if (rand() < 0.7) {
          releases.forEach((release) => release())
          releases = []
          await r.coach.whenIdle()
          const got = core(r.screen, isBusy)
          const want = core(fresh(r), isBusy)
          if (JSON.stringify(got) !== JSON.stringify(want)) console.log(`seed ${seed}, input ${i}: the screen and a fresh snapshot differ`)
          expect(got).toEqual(want)
        }
      }
      releases.forEach((release) => release())
      await r.coach.whenIdle()
      same(r)
    })
  }
})
