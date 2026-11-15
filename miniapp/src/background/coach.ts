/**
 * coach.ts: the whole behaviour of Tinker. No Mentra code in here.
 *
 * WHAT THIS FILE IS
 *   One class, `Coach`. It decides what happens when someone speaks, presses
 *   the button on the glasses, or taps a button on the phone screen.
 *
 * WHY IT HAS NO MENTRA IMPORT
 *   The Coach only knows a small `Device` interface (take a photo, speak,
 *   save things). index.ts builds that Device from the real Mentra SDK. The
 *   tests build it from fakes. That is what makes it possible to run whole
 *   lessons in `bun test` without glasses. Keep it that way.
 *
 * THE TWO FLOWS
 *   TEACH   "start teaching"  ->  do a step, explain it, "next step"  (photo + words saved)
 *                             ->  "finish lesson"                     (Claude writes the lesson)
 *   LEARN   "start lesson"    ->  the step is read aloud
 *                             ->  "check"                             (photo, Claude says pass or what to fix)
 *
 * THE FOUR MODES
 *   idle -> teaching -> building -> idle        recording a lesson
 *   idle -> coaching -> idle                    learning a lesson
 *   A command that does not belong to the current mode does nothing.
 *
 * HOW TO READ IT
 *   1. `Device`                     what the Coach needs from the outside world
 *   2. `heard`, `button`, `act`     the inputs, which all end in `run`
 *   3. `run`                        one command at a time
 *   4. the teaching methods, then the coaching methods
 *
 * More: docs/HOW_IT_WORKS.md for the flow, docs/DECISIONS.md for the reasons.
 */

import type {ActionName, AppState, Mode} from "../shared/channels"
import {buildPlan, checkStep, ClaudeError, testKey, type CaptureInput, type ImageInput, type Step} from "./claude"
import {helpText, parseCommand, type Command} from "./commands"

// ---------- settings you can change ----------

/** Most photos sent to Claude when it writes the lesson. More photos means a slower, costlier call. */
const MAX_PLAN_PHOTOS = 12
/** A photo link from the glasses works for about 30 minutes. Before this age the link itself is sent to Claude. */
const LINK_FRESH_MS = 20 * 60 * 1000
/** After this age the link is treated as dead and only the saved copy is used. */
const LINK_DEAD_MS = 28 * 60 * 1000
/** After the app speaks, ignore the microphone this long, so the app does not hear itself. */
const QUIET_AFTER_SPEECH_MS = 700
/** Longest narration kept for one step, in characters. */
const MAX_NARRATION = 1500

// ---------- the device the coach needs ----------

export type LightColor = "red" | "green" | "blue" | "orange" | "white"

/**
 * Everything the Coach needs from the phone and the glasses.
 * The real version is built in index.ts. The fake versions are in the tests.
 * To give the Coach a new ability, add a method here, then implement it in
 * index.ts and in the fakes in test/coach.test.ts.
 */
export interface Device {
  /** Take a photo with the glasses. Resolves with a download link. */
  takePhoto(): Promise<{url: string; mediaType: string}>
  /** Say text through the glasses. Resolves when the speech has finished. */
  speak(text: string): Promise<void>
  /** Blink the light on the glasses. Never throws. */
  light(color: LightColor, times: number): void
  /** Download a photo link and return its bytes as base64. */
  downloadPhoto(url: string): Promise<string>
  /** Keep a copy of a photo on the phone, so it outlives its link. */
  savePhoto(key: string, url: string, mediaType: string): Promise<void>
  /** Read a kept photo back as base64, or null when there is none. */
  loadPhoto(key: string): Promise<string | null>
  deletePhoto(key: string): Promise<void>
  /** Small text storage on the phone. */
  storageGet(key: string): Promise<string | null>
  storageSet(key: string, value: string): Promise<void>
  storageDelete(key: string): Promise<void>
  /** Current time in milliseconds. */
  now(): number
  /** Called with the new state after every change, to update the phone screen. */
  onState(state: AppState): void
}

// ---------- data ----------

/**
 * One photo. `url` is the download link from the glasses, which works for
 * about 30 minutes. `takenAt` tells if the link is still fresh.
 */
interface Shot {
  url: string
  takenAt: number
  mediaType: string
  /** Name of the copy kept on the phone. "" for photos that are not kept. */
  key: string
}

/** One recorded step while teaching: what the expert said, and the photo of the finished step. */
interface Capture {
  transcript: string
  shot: Shot | null
}

/** One step of a saved lesson: Claude's text (`Step` in claude.ts) plus the expert's photo. */
interface LessonStep extends Step {
  /** The expert's photo of this step finished. */
  shot: Shot | null
}

/**
 * A saved lesson. This exact shape is stored on the phone as JSON under the
 * storage key "lesson". Renaming or removing a field makes lessons that are
 * already saved unreadable.
 */
interface Lesson {
  id: string
  title: string
  materials: string[]
  steps: LessonStep[]
}

// Names of the two values kept in the phone's storage. They are already on
// phones, so changing a name loses the saved key or lesson.
const KEY_STORE = "claudeKey"
const LESSON_STORE = "lesson"

// ---------- small helpers ----------

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object" && "message" in err) return String((err as {message: unknown}).message)
  return String(err)
}

/** Wait for a promise, but give up after `ms`. Giving up resolves, it does not throw. */
function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms)
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Keep at most `limit` items, spread evenly across the list. */
function pickEvenly(indexes: number[], limit: number): Set<number> {
  if (indexes.length <= limit) return new Set(indexes)
  const kept = new Set<number>()
  for (let i = 0; i < limit; i++) {
    kept.add(indexes[Math.round((i * (indexes.length - 1)) / (limit - 1))]!)
  }
  return kept
}

/** Read the image type from the first bytes. Claude rejects a photo whose label is wrong. */
function sniffMediaType(base64: string, fallback: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg"
  if (base64.startsWith("iVBORw0KGgo")) return "image/png"
  if (base64.startsWith("R0lGOD")) return "image/gif"
  if (base64.startsWith("UklGR")) return "image/webp"
  return fallback || "image/jpeg"
}

function listAloud(items: string[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]!
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

// ---------- the coach ----------

export class Coach {
  private mode: Mode = "idle"
  /** True while a command is running. New commands are dropped until it is false again. */
  private busy = false
  /** The Claude key. Read from the phone's storage in load(). Only its last 4 characters go to the screen. */
  private apiKey = ""
  private lesson: Lesson | null = null

  // teaching
  /** Made when teaching starts. Becomes the lesson id and the first part of every photo name. */
  private recordingId = ""
  private captures: Capture[] = []
  private narration = ""

  // coaching
  private stepNumber = 0

  // shown on the phone screen
  private lastHeard = ""
  private lastSaid = ""
  private error = ""

  // speech and photos
  /** True while the glasses are talking. The microphone is ignored during that time. */
  private speaking = false
  /** The microphone stays ignored until this time, shortly after speech ends. */
  private quietUntil = 0
  /** False once Claude has refused photo links. From then on photo bytes are sent. Resets when the app restarts. */
  private linksWork = true
  /** Photo name -> base64 bytes, so a kept photo is read from the phone only once. */
  private readonly photoBytes = new Map<string, string>()

  constructor(private readonly device: Device) {}

  // ---------- state ----------

  state(): AppState {
    return {
      mode: this.mode,
      busy: this.busy,
      hasKey: this.apiKey !== "",
      keyHint: this.apiKey.slice(-4),
      lessonTitle: this.lesson?.title ?? "",
      materials: this.lesson?.materials ?? [],
      steps: (this.lesson?.steps ?? []).map((step) => ({number: step.number, instruction: step.instruction})),
      stepNumber: this.mode === "teaching" ? this.captures.length + 1 : this.stepNumber,
      narration: this.narration,
      lastHeard: this.lastHeard,
      lastSaid: this.lastSaid,
      error: this.error,
    }
  }

  private emit(): void {
    try {
      this.device.onState(this.state())
    } catch {
      // The screen is closed. Nothing to update.
    }
  }

  /** Read the saved key and lesson when the app starts. */
  async load(): Promise<void> {
    try {
      this.apiKey = (await this.device.storageGet(KEY_STORE)) ?? ""
    } catch {
      this.apiKey = ""
    }
    try {
      const raw = await this.device.storageGet(LESSON_STORE)
      this.lesson = raw ? (JSON.parse(raw) as Lesson) : null
    } catch {
      this.lesson = null
    }
    this.emit()
  }

  /** Save the Claude key after one test request. An empty key removes the saved key. */
  async setKey(raw: string): Promise<{ok: boolean; error: string}> {
    const key = raw.trim()
    if (key === "") {
      this.apiKey = ""
      await this.device.storageDelete(KEY_STORE)
      this.emit()
      return {ok: true, error: ""}
    }
    if (!key.startsWith("sk-ant-")) {
      return {ok: false, error: "That is not a Claude key. A Claude key starts with sk-ant-."}
    }
    try {
      await testKey(key)
    } catch (err) {
      const status = err instanceof ClaudeError ? err.status : 0
      if (status === 401) return {ok: false, error: "Claude rejected this key. Copy it again from the Claude Console."}
      return {ok: false, error: `The test request failed. ${describe(err)}`}
    }
    this.apiKey = key
    await this.device.storageSet(KEY_STORE, key)
    this.emit()
    return {ok: true, error: ""}
  }

  // ---------- inputs ----------

  /** Words from the microphone. Only finished sentences are used. */
  heard(spoken: string, isFinal: boolean): void {
    // The phone first sends half-finished guesses, then the finished sentence.
    // Only the finished one is used, or the same words would be handled twice.
    if (!isFinal) return
    const sentence = spoken.trim()
    if (!sentence) return
    if (this.speaking || this.device.now() < this.quietUntil) return // the app's own voice

    this.lastHeard = sentence
    // Is there a command at the end of this sentence? The rule is in commands.ts.
    const hit = parseCommand(this.mode, sentence)
    if (this.mode === "teaching") {
      // While teaching, everything the expert says belongs to the current step.
      // If the sentence ended in a command, only the words before it are kept.
      // This runs even while another command is in progress, so no explanation is lost.
      const words = hit ? hit.before : sentence
      if (words) this.narration = `${this.narration} ${words}`.trim().slice(-MAX_NARRATION)
    }
    this.emit()
    // `void` starts the command and returns at once. The microphone callback must
    // not wait for a photo or for Claude. The whole sentence is passed along
    // because the check prompt tells Claude what the learner just said.
    if (hit) void this.run(hit.command, sentence)
  }

  /** A press of the button on the glasses. */
  button(press: "short" | "long"): void {
    // A short press is the main action of the current mode. A long press is the second one.
    // Not confirmed on real glasses: the Mentra App may keep presses for its own photo feature.
    if (this.mode === "teaching") void this.run(press === "long" ? "finish" : "capture")
    else if (this.mode === "coaching") void this.run(press === "long" ? "repeat" : "check")
    else if (this.mode === "idle") void this.run(press === "long" || !this.lesson ? "teach" : "learn")
  }

  /** A button on the phone screen. */
  act(name: ActionName): Promise<void> {
    if (name === "deleteLesson") return this.deleteLesson()
    return this.run(name)
  }

  /** Run one command. A second command that arrives while one is running is dropped. */
  async run(command: Command, heardText = ""): Promise<void> {
    // Dropped, not queued. A queue would run a stale command seconds later,
    // for example a second photo the person no longer expects.
    if (this.busy) return
    this.busy = true
    this.error = ""
    this.emit()
    try {
      if (command === "teach") await this.startTeaching()
      else if (command === "capture") await this.captureStep()
      else if (command === "finish") await this.finishTeaching()
      else if (command === "learn") await this.startLesson()
      else if (command === "check") await this.check(heardText)
      else if (command === "repeat") await this.repeat()
      else if (command === "story") await this.story()
      else if (command === "skip") await this.skip()
      else if (command === "stop") await this.stop()
      else if (command === "help") await this.say(helpText(this.mode, this.lesson !== null))
    } catch (err) {
      this.error = describe(err)
    } finally {
      this.busy = false
      this.emit()
    }
  }

  // ---------- speech and photos ----------

  private async say(text: string): Promise<void> {
    // Every spoken sentence goes through here. The screen shows it, and the
    // microphone is ignored while it plays (see `heard`).
    this.lastSaid = text
    this.speaking = true
    this.emit()
    try {
      // Speech normally ends on its own. The timeout only stops a stuck call from freezing the app.
      await withTimeout(this.device.speak(text), 6000 + text.length * 110)
    } catch (err) {
      this.error = `Speech failed. ${describe(err)}`
    } finally {
      this.speaking = false
      this.quietUntil = this.device.now() + QUIET_AFTER_SPEECH_MS
      this.emit()
    }
  }

  /** Take a photo. Returns null and records the reason when it fails. */
  private async takeShot(key: string): Promise<Shot | null> {
    try {
      const photo = await this.device.takePhoto()
      return {url: photo.url, takenAt: this.device.now(), mediaType: photo.mediaType || "image/jpeg", key}
    } catch (err) {
      this.error = `Photo failed. ${describe(err)}`
      return null
    }
  }

  /** Turn a photo into something Claude can read: its link while fresh, its bytes otherwise. */
  private async imageFor(shot: Shot | null, allowLink: boolean): Promise<ImageInput | null> {
    if (!shot) return null
    const age = this.device.now() - shot.takenAt
    // 1. Fresh photo: send its link. Claude downloads it, and nothing large
    //    has to pass through the phone's JavaScript bridge.
    if (allowLink && age < LINK_FRESH_MS) return {kind: "url", url: shot.url}

    // 2. Bytes that were already read earlier in this session.
    const name = shot.key || shot.url
    let data = this.photoBytes.get(name) ?? null
    // 3. The copy the phone kept when the lesson was recorded.
    if (!data && shot.key) {
      try {
        data = await this.device.loadPhoto(shot.key)
      } catch {
        data = null
      }
    }
    // 4. No kept copy, but the link may still work: download it on the phone.
    if (!data && age < LINK_DEAD_MS) {
      try {
        data = await this.device.downloadPhoto(shot.url)
      } catch {
        data = null
      }
    }
    // 5. Nothing left. The caller carries on without this photo.
    if (!data) return null
    // Only kept photos are remembered. A learner's photo is used once and dropped.
    if (shot.key) this.photoBytes.set(name, data)
    return {kind: "base64", data, mediaType: sniffMediaType(data, shot.mediaType)}
  }

  /**
   * Run a Claude call that sends photos. It first sends photo links. If Claude
   * cannot use the links, it sends the photo bytes instead and remembers that.
   */
  private async withPhotos<T>(call: (allowLink: boolean) => Promise<T>): Promise<T> {
    if (!this.linksWork) return call(false)
    try {
      return await call(true)
    } catch (err) {
      // HTTP 400 is Claude's answer when it cannot use something in the request.
      // Any other failure (no connection, wrong key, overload) would fail with bytes too.
      if (!(err instanceof ClaudeError) || err.status !== 400) throw err
      const result = await call(false) // throws again when the links were not the problem
      this.linksWork = false
      return result
    }
  }

  private needKey(): string {
    return this.apiKey ? "" : "Add the Claude key on the phone screen first."
  }

  // ---------- teaching ----------

  private async startTeaching(): Promise<void> {
    if (this.mode !== "idle") return
    const missing = this.needKey()
    if (missing) return this.say(missing)
    this.mode = "teaching"
    // The old lesson stays saved until the new one is finished, so cancelling loses nothing.
    this.recordingId = String(this.device.now())
    this.captures = []
    this.narration = ""
    await this.say("Teaching mode. Do one step and explain it. Say next step when it is finished. Say finish lesson at the end.")
  }

  private async captureStep(announce = true): Promise<void> {
    if (this.mode !== "teaching") return
    const number = this.captures.length + 1
    // The photo shows the step FINISHED. A learner's photo is compared with it later.
    const key = `shot-${this.recordingId}-${number}`
    const shot = await this.takeShot(key)
    if (shot) {
      // Keep a copy on the phone. The lesson still works without it, so a failure here is not fatal.
      void this.device.savePhoto(key, shot.url, shot.mediaType).catch(() => {})
    }
    // Saved even when the photo failed. The expert's words alone still make a usable step.
    this.captures.push({transcript: this.narration, shot})
    this.narration = ""
    this.emit()
    if (!announce) return
    await this.say(shot ? `Step ${number} saved.` : `Step ${number} saved without a photo.`)
  }

  private async finishTeaching(): Promise<void> {
    if (this.mode !== "teaching") return
    // The expert explained a last step but did not say "next step". Save it now.
    if (this.narration) await this.captureStep(false)
    if (this.captures.length === 0) {
      return this.say("There are no steps yet. Do a step, explain it, then say next step.")
    }

    // "building" blocks every command until Claude has answered.
    // The sentence and the Claude request run at the same time, so the wait feels shorter.
    // allSettled is used so a failed request cannot escape as an unhandled error mid-sentence.
    this.mode = "building"
    const [, built] = await Promise.allSettled([this.say("Building the lesson."), this.makeLesson()])
    if (built.status === "rejected") {
      this.mode = "teaching"
      this.error = `The lesson was not built. ${describe(built.reason)}`
      return this.say("I could not build the lesson. Say finish lesson to try again.")
    }

    // Success. Only now is the old lesson replaced.
    const previous = this.lesson
    this.lesson = built.value
    this.mode = "idle"
    this.captures = []
    try {
      await this.device.storageSet(LESSON_STORE, JSON.stringify(this.lesson))
    } catch (err) {
      this.error = `The lesson works now but was not saved to the phone. ${describe(err)}`
    }
    if (previous) this.forgetPhotos(previous, this.lesson)
    const count = this.lesson.steps.length
    await this.say(`Lesson saved. ${this.lesson.title}. It has ${count} ${count === 1 ? "step" : "steps"}. Say start lesson to begin.`)
  }

  private async makeLesson(): Promise<Lesson> {
    const captures = this.captures
    const withPhoto = captures.flatMap((capture, i) => (capture.shot ? [i] : []))
    // A long recording is thinned to MAX_PLAN_PHOTOS photos, spread over the whole task.
    // Every capture keeps its words. Only some lose their photo.
    const keep = pickEvenly(withPhoto, MAX_PLAN_PHOTOS)

    const plan = await this.withPhotos(async (allowLink) => {
      const inputs: CaptureInput[] = []
      for (let i = 0; i < captures.length; i++) {
        const capture = captures[i]!
        const image = keep.has(i) ? await this.imageFor(capture.shot, allowLink) : null
        inputs.push({transcript: capture.transcript, image})
      }
      return buildPlan(this.apiKey, inputs)
    })

    return {
      id: this.recordingId,
      title: plan.title,
      materials: plan.materials,
      // Claude names the capture that shows each step finished (source_capture counts from 1).
      // That capture's photo becomes the picture a learner is compared with.
      steps: plan.steps.map((step) => ({...step, shot: captures[step.source_capture - 1]?.shot ?? null})),
    }
  }

  /** Delete kept photos that the new lesson does not use. */
  private forgetPhotos(old: Lesson, current: Lesson | null): void {
    const inUse = new Set((current?.steps ?? []).map((step) => step.shot?.key ?? ""))
    for (const step of old.steps) {
      const key = step.shot?.key
      if (!key || inUse.has(key)) continue
      this.photoBytes.delete(key)
      void this.device.deletePhoto(key).catch(() => {})
    }
  }

  // ---------- coaching ----------

  private currentStep(): LessonStep | null {
    return this.lesson?.steps[this.stepNumber - 1] ?? null
  }

  private async startLesson(): Promise<void> {
    if (this.mode !== "idle") return
    const first = this.lesson?.steps[0]
    if (!this.lesson || !first) return this.say("There is no lesson yet. Say start teaching to record one.")
    const missing = this.needKey()
    if (missing) return this.say(missing)

    // One sentence: the title, what to gather, how to ask for a check, and the first step.
    this.mode = "coaching"
    this.stepNumber = 1
    const materials = this.lesson.materials.length ? ` You need ${listAloud(this.lesson.materials)}.` : ""
    await this.say(`${this.lesson.title}.${materials} Say check when you finish a step. Step 1. ${first.instruction}`)
  }

  private async check(heardText: string): Promise<void> {
    const step = this.currentStep()
    if (this.mode !== "coaching" || !step || !this.lesson) return

    // "" as the photo name: a learner's photo is not kept on the phone.
    const shot = await this.takeShot("")
    if (!shot) return this.say("I could not take a photo. Say check to try again.")

    // Claude gets the expert's photo (when there is one) and the learner's photo.
    // It returns {result: "pass" | "fix" | "unclear", say: "..."}.
    let verdict
    try {
      verdict = await this.withPhotos(async (allowLink) => {
        const learner = await this.imageFor(shot, allowLink)
        if (!learner) throw new Error("The photo could not be read.")
        const reference = await this.imageFor(step.shot, allowLink)
        return checkStep(this.apiKey, {step, learner, reference, heard: heardText})
      })
    } catch (err) {
      this.error = `The check failed. ${describe(err)}`
      return this.say("I could not check that. Say check to try again.")
    }

    // Not a pass: say the correction and stay on this step.
    if (verdict.result !== "pass") {
      this.device.light(verdict.result === "fix" ? "red" : "orange", 2)
      return this.say(verdict.say)
    }

    // Pass. The praise and the next step are one sentence, so there is one speech
    // call and no silence between them.
    this.device.light("green", 2)
    const next = this.lesson.steps[this.stepNumber]
    if (next) {
      this.stepNumber += 1
      return this.say(`${verdict.say} Step ${next.number}. ${next.instruction}`)
    }
    const title = this.lesson.title
    this.mode = "idle"
    this.stepNumber = 0
    await this.say(`${verdict.say} That was the last step. You finished ${title}.`)
  }

  private async repeat(): Promise<void> {
    const step = this.currentStep()
    if (this.mode !== "coaching" || !step) return
    await this.say(`Step ${step.number}. ${step.instruction}`)
  }

  private async story(): Promise<void> {
    const step = this.currentStep()
    if (this.mode !== "coaching" || !step) return
    await this.say(step.story || "The expert gave no reason for this step.")
  }

  private async skip(): Promise<void> {
    if (this.mode !== "coaching" || !this.lesson) return
    const next = this.lesson.steps[this.stepNumber]
    if (!next) {
      this.mode = "idle"
      this.stepNumber = 0
      return this.say("That was the last step. The lesson is over.")
    }
    this.stepNumber += 1
    await this.say(`Step ${next.number}. ${next.instruction}`)
  }

  private async stop(): Promise<void> {
    if (this.mode === "teaching") {
      this.mode = "idle"
      this.captures = []
      this.narration = ""
      return this.say("Recording cancelled.")
    }
    if (this.mode === "coaching") {
      this.mode = "idle"
      this.stepNumber = 0
      return this.say("Lesson stopped.")
    }
  }

  /** Erase the saved lesson and its photos. Reached from the phone screen only, and only while idle. */
  private async deleteLesson(): Promise<void> {
    if (this.busy || this.mode !== "idle" || !this.lesson) return
    this.forgetPhotos(this.lesson, null)
    this.lesson = null
    try {
      await this.device.storageDelete(LESSON_STORE)
    } catch (err) {
      this.error = describe(err)
    }
    this.emit()
  }
}
