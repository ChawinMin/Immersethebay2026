/**
 * coach.ts: the whole behaviour of Tinker. No Mentra code in here.
 *
 * WHAT THIS FILE IS
 *   One class, `Coach`. It decides what happens when someone speaks, presses
 *   the button on the glasses, or taps a button on the phone screen. It also
 *   holds everything the phone screen shows: the lesson library, the recording
 *   in progress, the lesson being learned and the conversation.
 *
 * WHY IT HAS NO MENTRA IMPORT
 *   The Coach only knows two small interfaces from contracts.ts: `Device`
 *   (take a photo, speak, save things, send a message to the screen) and
 *   `Brain` (the four requests to Claude). index.ts builds the real ones from
 *   the Mentra SDK and from `fetch`. The tests build fakes. That is what makes
 *   it possible to run whole lessons in `bun test` without glasses and without
 *   a network. Keep it that way: no `@mentra/miniapp` import and no `fetch` here.
 *
 * THE TWO FLOWS
 *   TEACH   "start teaching"  ->  do a step, explain it, "next step"   (photo + words saved)
 *                                 a silent photo every 20 seconds in between
 *                             ->  "finish lesson"                      (Claude writes a draft)
 *                             ->  "publish lesson"                     (the draft joins the library)
 *   LEARN   "start lesson"    ->  the step is read aloud
 *                             ->  "check"                              (photo, Claude says pass or what to fix)
 *                             ->  "Tinker, ..."                        (a question, Claude answers)
 *
 * THE FIVE MODES
 *   idle -> recording -> processing -> review -> idle      teaching a lesson
 *   idle -> learning -> idle                               learning a lesson
 *   Teaching and learning never run at the same time. A command that does not
 *   belong to the current mode does nothing.
 *
 * ONE COMMAND AT A TIME
 *   Every input ends in `run`. While one command runs, a new one is dropped.
 *   Two exceptions are remembered and run next: "stop" and "discard" always
 *   (so "End session" on the screen always works), and any command that
 *   arrives during a silent timed photo (the person cannot know one is running).
 *
 * WHAT THE SCREEN IS TOLD
 *   Every change is sent as its own small message (`teachingState`,
 *   `learningState`, `tutorialList`, `transcriptionUpdate`, `assistantState`,
 *   ...). `snapshot()` returns the same information in one object, for a
 *   screen that has just opened. The screen has no "busy" message. It disables
 *   its buttons while `assistantState` is "thinking" or "speaking", so that
 *   state never says "idle" while a command is running (see `current`).
 *
 * THE APP MUST NOT ANSWER ITSELF
 *   The microphone on the glasses can hear the speaker on the glasses. Three
 *   things stop the app from reacting to its own voice: the microphone is
 *   ignored while the app speaks and for a short gap after; a heard sentence
 *   that matches what the app said in the last 10 seconds is dropped as an
 *   echo (`isEcho`); and no sentence the app says ends in a command (`defuse`),
 *   so an echo that slips through still does nothing.
 *
 * HOW TO READ IT
 *   1. settings and data shapes
 *   2. `load`, `snapshot`, `setKey`             start-up and the screen
 *   3. `command`, `heard`, `button`, `tick`     the inputs, which all end in `run`
 *   4. `run`                                    one command at a time
 *   5. speech and the conversation, then photos
 *   6. the teaching methods, the learning methods, the library
 *
 * More: docs/HOW_IT_WORKS.md for the flow, docs/DECISIONS.md for the reasons.
 */

import type {
  AssistantState,
  Channels,
  ConnectionStatus,
  LearningState,
  Snapshot,
  StepVerdict,
  TeachingState,
  TranscriptEntry,
  TutorialModel,
  TutorialStepModel,
  UiCommandChannel,
  UiEventChannel,
} from "../shared/channels"
import {helpText, normalize, parseCommand, type Command, type Mode} from "./commands"
import {BrainError, type Brain, type CaptureInput, type Device, type ImageInput, type LessonDraft, type Verdict} from "./contracts"
import {BUILT_IN_TUTORIALS} from "./seed"

// ---------- settings you can change ----------

/** Most photos sent to Claude when it writes the lesson. More photos means a slower, costlier call. */
const MAX_PLAN_PHOTOS = 12
/** A photo link from the glasses is signed for 10 minutes (MentraOS cloud, camera.service.ts). Before this age the link itself is sent to Claude. */
const LINK_FRESH_MS = 8 * 60 * 1000
/**
 * After this age the link is treated as dead and only the copy kept on the phone is used.
 * Mentra's cloud source signs links for 10 minutes; the SDK's own comment says about 30.
 * Between the two a download is still tried. If the link is dead that costs one quick failed request.
 */
const LINK_DEAD_MS = 28 * 60 * 1000
/** After the app speaks, ignore the microphone this long, so the app does not hear itself. */
const QUIET_AFTER_SPEECH_MS = 700
/** Longest narration kept for one capture, in characters. The end is kept. */
const MAX_NARRATION = 1500
/** While recording, a silent photo is taken when this long has passed since the last photo. 0 turns timed photos off. */
const AUTO_CAPTURE_MS: number = 20000
/** Timed photos stop once a recording holds this many captures. */
const MAX_CAPTURES = 40
/** Most recorded lessons kept on the phone. One more removes the oldest and its photos. */
const MAX_LIBRARY = 20
/** Conversation lines kept for the phone screen. */
const TRANSCRIPT_KEEP = 40
/** For this long after the app spoke, a heard sentence that matches the app's own words is dropped as an echo. */
const ECHO_WINDOW_MS = 10000

// ---------- finer settings, rarely changed ----------

/** Speech normally ends by itself. Stop waiting for it after this long, plus the per-character time below. */
const SPEECH_GUARD_MS = 6000
/** Extra waiting time for every character of a spoken sentence. */
const SPEECH_GUARD_PER_CHAR_MS = 110
/** A heard sentence is an echo when at least this many percent of its words appear, in order, in something the app just said. */
const ECHO_PERCENT = 80
/**
 * An echo arrives right after the app stops speaking. A person's answer comes later.
 * From this long after the speech ended, a finished sentence that is exactly one
 * command ("publish lesson" after "Say publish lesson to save it") is the person, not an echo.
 * Set it to ECHO_WINDOW_MS to drop those too.
 */
const ECHO_REPLY_MS = 2500
/** How many of the app's last sentences are remembered for the echo check. */
const ECHO_KEEP = 5
/** A heard sentence with more words than this is never an echo: the app says nothing that long. */
const ECHO_MAX_WORDS = 120
/** Stop waiting for one Claude request after this long, so a lost connection cannot freeze the app. */
const CLAUDE_GUARD_MS = 90 * 1000
/** After someone says only "Hey Tinker", their next sentence within this time is taken as the question. */
const ASK_FOLLOW_MS = 8000
/** Conversation lines given to Claude together with a question. */
const RECENT_LINES = 6
/** Longest typed question, lesson title and lesson description accepted from the phone screen, in characters. */
const MAX_TYPED = 600
/** Most words from a lesson handed to speech-to-text as words to expect. */
const MAX_VOCABULARY = 30
/** Sent back with "pong", so the screen can show which background code is running. */
const BACKGROUND_VERSION = "tinker-2"

/** Every mode. A sentence the app says is checked against the commands of all of them. */
const MODES: Mode[] = ["idle", "recording", "processing", "review", "learning"]

// Names of the two values kept in the phone's storage. They are on phones
// already, so changing a name loses the saved key or the saved lessons.
const KEY_STORE = "claudeKey"
const LIBRARY_STORE = "library"

// ---------- data ----------

/**
 * One photo. `url` is the download link from the glasses, which works for
 * about 10 minutes. `takenAt` tells if the link is still fresh.
 */
interface Shot {
  url: string
  takenAt: number
  mediaType: string
  /** Name of the copy kept on the phone. "" for photos that are not kept. */
  key: string
}

/** One moment of a recording: what the expert said since the last capture, and a photo. */
interface Capture {
  transcript: string
  /** Seconds since the recording started. */
  atSeconds: number
  /** "step": the expert said the step was finished. "auto": a timed photo in the middle of the work. */
  kind: "step" | "auto"
  shot: Shot | null
}

/** One thing to do, with whatever came along with it. Every input is turned into a Job and given to `run`. */
interface Job {
  /** "auto" is the silent timed photo. It is started by `tick`, never by a person. */
  command: Command | "auto"
  /** check: the whole sentence that carried the command. Claude is told what the learner just said. */
  heard?: string
  /** teach: what the expert typed into "What are you teaching?". */
  skillHint?: string
  /** publish: the title and description as edited on the phone screen. */
  title?: string
  description?: string
  /** learn: which lesson. "" means the first one in the library. */
  tutorialId?: string
  /** ask: the question. */
  question?: string
  /** ask: true when the question was typed on the phone. It is then added to the conversation first. */
  typed?: boolean
  /** ask: the conversation line that already holds a spoken question. */
  lineId?: string
}

/** One sentence the app said, kept for a short time to recognise its own echo. */
interface Spoken {
  /** The words in the form `echoWords` gives. */
  words: string[]
  /** When the speech ended. */
  endedAt: number
}

/** What the screen shows about the assistant: its state and, while it works, a few words on what it is doing. */
interface Shown {
  state: AssistantState
  message: string
}

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

/** Wait for a promise, but fail with `message` after `ms`. Used for requests that must not hang forever. */
function orFail<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Keep at most `limit` items, spread evenly across the list. */
function pickEvenly(indexes: number[], limit: number): number[] {
  if (limit <= 0) return []
  if (indexes.length <= limit) return [...indexes]
  if (limit === 1) return [indexes[Math.floor(indexes.length / 2)]!]
  const kept = new Set<number>()
  for (let i = 0; i < limit; i++) {
    kept.add(indexes[Math.round((i * (indexes.length - 1)) / (limit - 1))]!)
  }
  return [...kept]
}

/**
 * Which captures send their photo to Claude. Every "step" photo comes first,
 * because it shows a step finished. Timed photos fill what is left of the
 * limit, spread over the whole recording.
 */
function choosePhotos(captures: Capture[]): Set<number> {
  const steps: number[] = []
  const autos: number[] = []
  captures.forEach((capture, i) => {
    if (capture.shot) (capture.kind === "step" ? steps : autos).push(i)
  })
  const kept = pickEvenly(steps, MAX_PLAN_PHOTOS)
  return new Set([...kept, ...pickEvenly(autos, MAX_PLAN_PHOTOS - kept.length)])
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

/** A value that should be text, as trimmed text. Anything else becomes "". */
function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** A value that should be a list of texts, without the empty ones. */
function cleanList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(clean).filter((item) => item !== "") : []
}

/** Make sure text ends like a sentence, so the next sentence does not run into it when spoken. */
function asSentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** A lesson title without closing punctuation, so "TITLE." is never spoken as "TITLE!.". */
function spokenTitle(title: string): string {
  return title.trim().replace(/[.!?\s]+$/, "")
}

// Speech-to-text writes a spoken "one" as "one" or as "1". For the echo check both are the same word.
const NUMBER_WORDS = new Map<string, string>(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    .split(" ")
    .map((word, value) => [word, String(value)]),
)

/** The words of a sentence in the form used to compare speech: lower case, no punctuation, "one" and "1" alike. */
function echoWords(text: string): string[] {
  const said = normalize(text)
  return said ? said.split(" ").map((word) => NUMBER_WORDS.get(word) ?? word) : []
}

/**
 * How many words of `heard` appear in `said` in the same order (the longest
 * common subsequence). A piece cut out of `said` scores all of its words.
 */
function wordsInOrder(heard: string[], said: string[]): number {
  let previous: number[] = new Array<number>(said.length + 1).fill(0)
  for (const word of heard) {
    const row: number[] = [0]
    for (let j = 1; j <= said.length; j++) {
      row.push(word === said[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, row[j - 1]!))
    }
    previous = row
  }
  return previous[said.length]!
}

/** True when the sentence would be taken for a command, in any mode, if the microphone heard it. */
function soundsLikeCommand(text: string): boolean {
  return MODES.some((mode) => parseCommand(mode, text) !== null)
}

/**
 * Make a sentence safe to say out loud. The glasses can hear their own
 * speaker, so nothing the app says may end in a command ("...until it is
 * done.") or start with its own name. The app's fixed sentences are written
 * that way. Text from Claude and lesson titles are not, so they are checked here.
 */
function defuse(words: string): string {
  if (!soundsLikeCommand(words)) return words
  // A closing word after the command: a command only counts at the END of a sentence.
  const tailed = `${asSentence(words)} Okay.`
  if (!soundsLikeCommand(tailed)) return tailed
  // The name at the start makes a sentence a question. A word in front undoes that.
  const headed = `So, ${words}`
  if (!soundsLikeCommand(headed)) return headed
  return `So, ${tailed}`
}

/** The expert's photo for a step, in the shape `imageFor` reads. null when the step has none. */
function referenceShot(step: TutorialStepModel): Shot | null {
  const url = step.reference_image_url ?? ""
  const key = step.photo_key ?? ""
  if (!url && !key) return null
  // No recorded time means the age is unknown. 0 makes the link count as dead, so only the kept copy is used.
  return {url, key, takenAt: step.photo_taken_at ?? 0, mediaType: "image/jpeg"}
}

/** Unusual words of a lesson (tool names and the like), so speech-to-text expects them. */
function vocabularyFor(lesson: TutorialModel): string[] {
  const source = [lesson.title, ...(lesson.tools_required ?? []), ...(lesson.ingredients_required ?? [])].join(" ")
  const seen = new Set<string>()
  const words: string[] = []
  for (const word of source.split(/[^a-zA-ZÀ-ɏ]+/)) {
    const key = word.toLowerCase()
    // Short words ("the", "and", "of") are common ones. Speech-to-text knows them already.
    if (word.length < 4 || seen.has(key)) continue
    seen.add(key)
    words.push(word)
    if (words.length >= MAX_VOCABULARY) break
  }
  return words
}

/** Read the saved library. Anything that does not look like a lesson is left out instead of crashing later. */
function readLibrary(raw: string): TutorialModel[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  const builtIn = new Set(BUILT_IN_TUTORIALS.map((lesson) => lesson.id))
  const lessons: TutorialModel[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const lesson = item as TutorialModel
    if (typeof lesson.id !== "string" || typeof lesson.title !== "string") continue
    if (!Array.isArray(lesson.steps) || lesson.steps.length === 0) continue
    if (builtIn.has(lesson.id)) continue // the built-in lesson is added from seed.ts, never stored
    lessons.push(lesson)
  }
  return lessons.slice(0, MAX_LIBRARY)
}

// ---------- the coach ----------

export class Coach {
  private mode: Mode = "idle"

  // one command at a time
  /** True while a command is running. New commands are dropped until it is false again. */
  private busy = false
  /** True while the running command is a silent timed photo. The screen is not told about that one. */
  private silent = false
  /** The one remembered command. It runs as soon as the current command ends. */
  private waiting: Job | null = null
  /** Storage work that was started and not waited for (photo copies, deletes). Counted so `whenIdle` can wait for it. */
  private loose = 0
  /** Callers of `whenIdle` that are still waiting. */
  private idleWaiters: Array<() => void> = []

  /** The Claude key. Read from the phone's storage in load(). Only its last 4 characters go to the screen. */
  private apiKey = ""
  /** Recorded lessons, newest first. The built-in lesson is not in here, it is added in `tutorials()`. */
  private recorded: TutorialModel[] = []

  // teaching
  /** Made when a recording starts. Becomes part of the lesson id, the step ids and every photo name. */
  private recordingId = ""
  private recordingStart = 0
  /** When the expert said "finish lesson". 0 while the recording runs. It freezes the clock on the screen. */
  private recordingEnd = 0
  /** What the expert typed as the skill being taught, or "". Claude gets it as a hint. */
  private skillHint = ""
  private captures: Capture[] = []
  /** What the expert has said since the last capture. */
  private narration = ""
  /** When the last photo of either kind was taken (or tried). The next timed photo is due AUTO_CAPTURE_MS later. */
  private lastCaptureAt = 0
  /** The lesson Claude just wrote, waiting to be published or discarded. */
  private draft: TutorialModel | null = null
  /** Why the last attempt to teach failed, for the screen. "" when there is nothing to report. */
  private teachError = ""

  // learning
  /** The lesson being learned. null in every other mode. */
  private lesson: TutorialModel | null = null
  /** Counts from 1. 0 when no lesson is being learned. */
  private stepNumber = 0
  private sessionId = ""
  /** Makes every sessionId different, even when two lessons start in the same millisecond of a test clock. */
  private sessionCount = 0
  private lastVerdict: StepVerdict | null = null
  /** Until this time, a sentence that is not a command is taken as a question. Set after a bare "Hey Tinker". */
  private askUntil = 0

  // the conversation and the assistant state
  /** The last TRANSCRIPT_KEEP lines, oldest first. */
  private transcript: TranscriptEntry[] = []
  /** Counter behind the line ids, so no two lines share one. */
  private lineCount = 0
  /** The sentence somebody is still speaking. Its finished version reuses this line and its id. */
  private openLine: TranscriptEntry | null = null
  /** What the screen was last told about the assistant. */
  private shown: Shown = {state: "idle", message: ""}
  /** True while the glasses are talking. The microphone is ignored during that time. */
  private speaking = false
  /** The microphone stays ignored until this time, shortly after speech ends. */
  private quietUntil = 0
  /** What the running command is waiting for: "Taking a photo", "Thinking", or "" between two phases. */
  private waitingOn = ""
  /** True while somebody is in the middle of a sentence. */
  private hearing = false
  /** The last few sentences the app said, newest last. `heard` drops their echo. */
  private spoken: Spoken[] = []

  // photos
  /** False once Claude has refused photo links. From then on photo bytes are sent. Resets when the app restarts. */
  private linksWork = true
  /** Photo name -> base64 bytes, so a kept photo is read from the phone only once. */
  private readonly photoBytes = new Map<string, string>()
  /** Photo name -> the copy that is still being made. A delete waits for it, or the copy would land after the delete. */
  private readonly saves = new Map<string, Promise<void>>()

  constructor(
    private readonly device: Device,
    private readonly brain: Brain,
  ) {}

  // ---------- start-up and the screen ----------

  /** Read the saved key and library from the phone. Called once at start. No network. */
  async load(): Promise<void> {
    try {
      this.apiKey = (await this.device.storageGet(KEY_STORE)) ?? ""
    } catch {
      this.apiKey = ""
    }
    try {
      const raw = await this.device.storageGet(LIBRARY_STORE)
      this.recorded = raw ? readLibrary(raw) : []
    } catch {
      this.recorded = []
    }
    // A screen that opened before this finished has drawn an empty library and no key. Correct it.
    this.emitConnection()
    this.emitLibrary()
  }

  /** Everything the screen needs to draw itself. */
  snapshot(): Snapshot {
    return {
      connection: this.connection(),
      tutorials: this.tutorials(),
      teaching: this.teachingState(),
      draft: this.draft,
      learning: this.mode === "learning" && this.lesson ? this.learningState(true, false) : null,
      lastVerdict: this.lastVerdict,
      transcript: this.transcript.map((line) => ({...line})),
      assistant: this.current().state,
      // A silent timed photo does not count: the screen must not lock its buttons for something nobody asked for.
      busy: this.busy && !this.silent,
    }
  }

  /** Test and save the Claude key. "" removes it. */
  async setKey(raw: string): Promise<{ok: boolean; error: string}> {
    const key = clean(raw)
    try {
      if (key === "") {
        this.apiKey = ""
        await this.device.storageDelete(KEY_STORE)
        this.emitConnection()
        return {ok: true, error: ""}
      }
      if (!key.startsWith("sk-ant-")) {
        return {ok: false, error: "That is not a Claude key. A Claude key starts with sk-ant-."}
      }
      try {
        // One real request. A key that is saved untested fails later, in the middle of a lesson.
        await this.claude(this.brain.testKey(key))
      } catch (err) {
        const status = err instanceof BrainError ? err.status : 0
        if (status === 401) return {ok: false, error: "Claude rejected this key. Copy it again from the Claude Console."}
        return {ok: false, error: `The test request failed. ${describe(err)}`}
      }
      await this.device.storageSet(KEY_STORE, key)
      this.apiKey = key
      // "Add the Claude key" is no longer true. Take it off the Teaching screen.
      if (this.teachError && this.mode === "idle") {
        this.teachError = ""
        this.emitTeaching()
      }
      this.emitConnection()
      return {ok: true, error: ""}
    } catch (err) {
      // The phone's storage failed. The screen gets a reason instead of a request that never answers.
      return {ok: false, error: `The phone could not save the key. ${describe(err)}`}
    }
  }

  /** index.ts calls this when the glasses connect or disconnect. */
  hardwareChanged(): void {
    this.emitConnection()
  }

  /** Resolves when no command is running and none is waiting. For tests. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  private isIdle(): boolean {
    return !this.busy && this.waiting === null && this.loose === 0
  }

  private wakeIdle(): void {
    if (!this.isIdle()) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** Send one message to the phone screen. */
  private send<C extends UiEventChannel>(channel: C, payload: Channels[C]): void {
    try {
      this.device.emit(channel, payload)
    } catch {
      // The screen is closed. It asks for a snapshot when it opens again.
    }
  }

  private connection(): ConnectionStatus {
    let hardware = {glassesConnected: false, hasCamera: false, hasMic: false}
    try {
      hardware = this.device.hardware()
    } catch {
      // Unknown counts as not connected.
    }
    return {
      glassesConnected: hardware.glassesConnected,
      hasCamera: hardware.hasCamera,
      hasMic: hardware.hasMic,
      claudeReady: this.apiKey !== "",
      keyHint: this.apiKey.slice(-4),
    }
  }

  private emitConnection(): void {
    this.send("connectionStatus", this.connection())
  }

  /** The library as the screen shows it: recorded lessons newest first, then the lesson that ships with the app. */
  private tutorials(): TutorialModel[] {
    return [...this.recorded, ...BUILT_IN_TUTORIALS]
  }

  private emitLibrary(): void {
    this.send("tutorialList", {tutorials: this.tutorials()})
  }

  /** Whole seconds of the recording so far. Frozen once the expert has said "finish lesson". */
  private elapsedSeconds(): number {
    if (!this.recordingStart) return 0
    const end = this.recordingEnd || this.device.now()
    return Math.max(0, Math.floor((end - this.recordingStart) / 1000))
  }

  private teachingState(): TeachingState {
    const teaching = this.mode === "recording" || this.mode === "processing" || this.mode === "review"
    const state: TeachingState = {
      status: teaching ? (this.mode as TeachingState["status"]) : "idle",
      elapsedSeconds: this.elapsedSeconds(),
      frameCount: this.captures.filter((capture) => capture.shot).length,
      stepCount: this.captures.filter((capture) => capture.kind === "step").length,
      narration: this.narration,
    }
    if (this.recordingId) state.sessionId = this.recordingId
    if (this.teachError) state.error = this.teachError
    return state
  }

  private emitTeaching(): void {
    this.send("teachingState", this.teachingState())
  }

  /** Only called while `this.lesson` is set. */
  private learningState(active: boolean, finished: boolean): LearningState {
    const lesson = this.lesson!
    return {
      active,
      finished,
      sessionId: this.sessionId,
      tutorialId: lesson.id,
      currentStep: this.stepNumber,
      totalSteps: lesson.steps.length,
      stepData: lesson.steps[this.stepNumber - 1] ?? null,
      assistantState: this.current().state,
    }
  }

  private emitLearning(): void {
    this.send("learningState", this.learningState(true, false))
  }

  // ---------- inputs ----------

  /** A plain message from the phone screen. */
  command<C extends UiCommandChannel>(channel: C, payload: Channels[C]): void {
    // The payload travelled from the screen as JSON. Every field is checked before it is used.
    const data: Record<string, unknown> = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
    const name: UiCommandChannel = channel
    // `void` starts the command and returns at once. A command can take many
    // seconds (photo, Claude, speech). The screen follows it through the events.
    switch (name) {
      case "startTeaching":
        void this.run({command: "teach", skillHint: clean(data.targetSkill).slice(0, MAX_TYPED)})
        return
      case "captureStep":
        void this.run({command: "capture"})
        return
      case "stopTeaching":
        void this.run({command: "finish"})
        return
      case "discardTeaching":
        void this.run({command: "discard"})
        return
      case "publishTutorial": {
        // Only the two fields the screen lets people edit are read. The steps
        // and photos always come from the draft kept here, never from the screen.
        const edited = data.tutorial && typeof data.tutorial === "object" ? (data.tutorial as Record<string, unknown>) : {}
        void this.run({
          command: "publish",
          title: clean(edited.title).slice(0, MAX_TYPED),
          description: clean(edited.description).slice(0, MAX_TYPED),
        })
        return
      }
      case "deleteTutorial":
        this.deleteTutorial(clean(data.tutorialId))
        return
      case "startLearning":
        void this.run({command: "learn", tutorialId: clean(data.tutorialId)})
        return
      case "endLearning":
        void this.run({command: "stop"})
        return
      case "navigateStep":
        if (data.direction === "next" || data.direction === "previous" || data.direction === "repeat") {
          void this.run({command: data.direction})
        }
        return
      case "checkStep":
        void this.run({command: "check"})
        return
      case "askTinker":
        void this.run({command: "ask", question: clean(data.text).slice(0, MAX_TYPED), typed: true})
        return
      case "requestTutorials":
        this.emitLibrary()
        return
      case "testAudio":
        void this.run({command: "audio"})
        return
      case "ping": {
        const now = this.device.now()
        const at = typeof data.at === "number" ? data.at : now
        this.send("pong", {at: now, roundtripMs: now - at, backgroundVersion: BACKGROUND_VERSION})
        return
      }
    }
  }

  /** Words from the glasses microphone. */
  heard(spoken: string, isFinal: boolean): void {
    // The text comes straight from the phone. Anything that is not text is ignored.
    const sentence = typeof spoken === "string" ? spoken.trim() : ""
    if (!sentence) return
    if (this.speaking || this.device.now() < this.quietUntil) return // the app's own voice
    // The text of the app's own sentence can arrive after the quiet gap, because
    // speech-to-text is slow. An echo leaves no line, no narration and no command.
    if (this.isEcho(sentence, isFinal)) return

    // The phone first sends half-finished guesses, then the finished sentence.
    // Both go to the screen as ONE conversation line. Only the finished one can be a command.
    const line = this.userLine(sentence, isFinal)
    if (!isFinal) {
      this.syncAssistant() // "listening", when nothing else is going on
      return
    }

    // Is there a command in this sentence? The rule is in commands.ts.
    const hit = parseCommand(this.mode, sentence)
    if (this.mode === "recording") {
      // While recording, everything the expert says belongs to the next capture.
      // If the sentence ended in a command, only the words before it are kept.
      // This runs even while another command is in progress, so no explanation is lost.
      const words = hit ? hit.before : sentence
      if (words) this.narration = `${this.narration} ${words}`.trim().slice(-MAX_NARRATION)
      this.emitTeaching()
    }

    let job: Job | null = null
    if (hit) {
      // The whole sentence goes along, because the photo check tells Claude what the learner just said.
      job = hit.command === "ask" ? {command: "ask", question: hit.question, lineId: line.id} : {command: hit.command, heard: sentence}
    } else if (this.mode === "learning" && this.device.now() < this.askUntil && echoWords(sentence).length >= 2) {
      // "Hey Tinker." ... "Yes?" ... and this is the question, in a sentence of its own.
      // One word alone is no question. It may also be the echo of "Yes?", which is too short for the echo check.
      job = {command: "ask", question: sentence, lineId: line.id}
    }
    if (job) {
      this.askUntil = 0
      // `void`: the microphone callback must not wait for a photo or for Claude.
      void this.run(job)
    }
    this.syncAssistant() // the sentence is over: "listening" ends, unless a command has just taken over
  }

  /** A press of the button on the glasses. */
  button(press: "short" | "long"): void {
    // A short press is the main action of the current mode. A long press is the second one.
    // Not confirmed on real glasses: the Mentra App may keep presses for its own photo feature.
    if (this.mode === "idle") void this.run({command: press === "long" ? "teach" : "learn", tutorialId: ""})
    else if (this.mode === "recording") void this.run({command: press === "long" ? "finish" : "capture"})
    else if (this.mode === "review" && press === "short") void this.run({command: "publish"})
    else if (this.mode === "learning") void this.run({command: press === "long" ? "next" : "check"})
    // processing: Claude is writing the lesson. The button does nothing.
  }

  /** index.ts calls this once per second. Drives the recording clock and timed photos. */
  tick(): void {
    if (this.mode !== "recording") return
    // The clock on the screen only moves when a new teachingState arrives.
    this.emitTeaching()

    if (AUTO_CAPTURE_MS <= 0) return
    // Never in the middle of a command or a spoken sentence: a timed photo must not delay either.
    if (this.busy || this.speaking) return
    if (this.captures.length >= MAX_CAPTURES) return
    if (this.device.now() - this.lastCaptureAt < AUTO_CAPTURE_MS) return
    void this.run({command: "auto"})
  }

  // ---------- one command at a time ----------

  /** Run one command. A second command that arrives while one is running is dropped, with two exceptions. */
  private async run(job: Job): Promise<void> {
    if (this.busy) {
      // Dropped, not queued. A queue would run a stale command seconds later,
      // for example a second photo the person no longer expects.
      // Exception 1: "stop" and "discard" must always work, so the newest one is remembered.
      // Exception 2: during a silent timed photo the person cannot know the app
      // is busy, so whatever they ask for then is remembered too.
      if (job.command === "stop" || job.command === "discard" || this.silent) this.waiting = job
      return
    }
    this.busy = true
    this.silent = job.command === "auto"
    try {
      // `perform` runs up to its first wait before the next line. A command
      // that speaks at once is "speaking" by then. Any other command shows as
      // "thinking", so the screen never sees "idle" while a command runs.
      const work = this.perform(job)
      this.syncAssistant()
      await work
    } catch (err) {
      // Nothing may escape from here: the callers do not wait and do not catch.
      this.note(`Something went wrong. ${describe(err)}`)
    }
    const wasSilent = this.silent
    this.busy = false
    this.silent = false
    this.waitingOn = ""

    // No `await` between `busy = false` and here, so nothing can slip in ahead of the remembered command.
    const next = this.waiting
    this.waiting = null
    if (next) return this.run(next)

    // The command is over: exactly one "idle" for the screen, which unlocks its
    // buttons on it. A sentence somebody started during the command shows as
    // "listening" again with its next piece. A silent photo changed nothing on
    // the screen, so it also must not cut off a "listening".
    if (!wasSilent) this.hearing = false
    this.syncAssistant()
    this.wakeIdle()
  }

  private async perform(job: Job): Promise<void> {
    switch (job.command) {
      case "teach":
        return this.startTeaching(job.skillHint ?? "")
      case "capture":
        return this.captureStep(true)
      case "auto":
        return this.autoCapture()
      case "finish":
        return this.finishTeaching()
      case "publish":
        return this.publish(job.title ?? "", job.description ?? "")
      case "discard":
        return this.discard()
      case "learn":
        return this.startLesson(job.tutorialId ?? "")
      case "check":
        return this.check(job.heard ?? "")
      case "next":
        return this.next()
      case "previous":
        return this.previous()
      case "repeat":
        return this.repeat()
      case "story":
        return this.story()
      case "tips":
        return this.tips()
      case "materials":
        return this.materials()
      case "ask":
        return this.ask(job)
      case "stop":
        return this.stop()
      case "help":
        return this.say(helpText(this.mode))
      case "audio":
        // It does not start with "Tinker": while a lesson runs, a sentence that starts with the name is a question.
        return this.say("This is the Tinker audio check. If you hear this in the glasses, sound works.")
    }
  }

  /**
   * Start storage work that nobody waits for (a photo copy, a delete). It
   * never fails loudly. `whenIdle` waits for it, so a test sees its result.
   */
  private quietly(work: () => Promise<unknown>): Promise<void> {
    this.loose += 1
    // The work starts inside a promise, so even an error thrown at once becomes a rejection.
    return new Promise<unknown>((resolve) => resolve(work()))
      .catch(() => {})
      .then(() => {
        this.loose -= 1
        this.wakeIdle()
      })
  }

  // ---------- the assistant state, speech and the conversation ----------

  /**
   * What the assistant is doing right now, for the screen.
   * The screen disables its buttons while this is "thinking" or "speaking".
   * So while a command runs it is always one of those two, never "idle" or
   * "listening". The silent timed photo is the exception: it shows nothing.
   */
  private current(): Shown {
    if (this.speaking) return {state: "speaking", message: ""}
    if (this.busy && !this.silent) {
      if (this.waitingOn) return {state: "thinking", message: this.waitingOn}
      // Between two phases of one command (photo done, Claude not asked yet;
      // or the last sentence spoken, the command not ended yet). Keep what the
      // screen shows now instead of flickering.
      if (this.shown.state === "thinking" || this.shown.state === "speaking") return this.shown
      return {state: "thinking", message: ""}
    }
    return {state: this.hearing ? "listening" : "idle", message: ""}
  }

  /** Tell the screen when the assistant state has changed. */
  private syncAssistant(): void {
    const next = this.current()
    if (next.state === this.shown.state && next.message === this.shown.message) return
    this.shown = next
    this.send("assistantState", next.message ? {state: next.state, message: next.message} : {state: next.state})
  }

  /** Add one line to the conversation and send it to the screen. */
  private addLine(speaker: TranscriptEntry["speaker"], text: string, isFinal = true): TranscriptEntry {
    const learning = this.mode === "learning" && this.stepNumber > 0
    let label = "Note"
    if (speaker === "user") label = "You"
    else if (speaker === "tinker") label = learning ? `Step ${this.stepNumber}` : "Tinker"
    const line: TranscriptEntry = {id: `t${++this.lineCount}`, speaker, text, isFinal, timestamp: label}
    if (learning) line.step = this.stepNumber
    this.transcript.push(line)
    if (this.transcript.length > TRANSCRIPT_KEEP) this.transcript.splice(0, this.transcript.length - TRANSCRIPT_KEEP)
    // A copy is sent, because an unfinished line is changed later.
    this.send("transcriptionUpdate", {...line})
    return line
  }

  /** A note or an error for the screen. It is not spoken. */
  private note(text: string): void {
    this.addLine("system", text)
  }

  /** What somebody said. An unfinished sentence and its finished version are one line with one id. */
  private userLine(sentence: string, isFinal: boolean): TranscriptEntry {
    let line = this.openLine
    if (line) {
      line.text = sentence
      line.isFinal = isFinal
      this.send("transcriptionUpdate", {...line})
    } else {
      line = this.addLine("user", sentence, isFinal)
    }
    this.openLine = isFinal ? null : line
    this.hearing = !isFinal
    return line
  }

  private async say(text: string): Promise<void> {
    // Every spoken sentence goes through here. The screen shows it, and the
    // microphone is ignored while it plays (see `heard`).
    if (!text.trim()) return
    const words = defuse(text.trim())
    // A sentence somebody was in the middle of: its end will arrive while the
    // app talks and be ignored. Close the line now, or it stays unfinished forever.
    if (this.openLine) {
      this.openLine.isFinal = true
      this.send("transcriptionUpdate", {...this.openLine})
      this.openLine = null
      this.hearing = false
    }
    this.addLine("tinker", words)
    this.speaking = true
    this.syncAssistant()
    try {
      // Speech normally ends on its own. The timeout only stops a stuck call from freezing the app.
      await withTimeout(this.device.speak(words), SPEECH_GUARD_MS + words.length * SPEECH_GUARD_PER_CHAR_MS)
    } catch (err) {
      this.note(`Speech failed. ${describe(err)}`)
    } finally {
      const now = this.device.now()
      this.speaking = false
      this.quietUntil = now + QUIET_AFTER_SPEECH_MS
      // Remembered with the time the speech ENDED: that is when its echo starts to arrive.
      this.spoken.push({words: echoWords(words), endedAt: now})
      if (this.spoken.length > ECHO_KEEP) this.spoken.shift()
      // Stays "speaking" on the screen until the command moves on or ends,
      // except when a Claude request is still running: then it becomes "thinking".
      this.syncAssistant()
    }
  }

  /**
   * Is this the app hearing itself? True when the sentence has at least two
   * words and most of them appear, in order, in something the app said in the
   * last ECHO_WINDOW_MS. One word is never an echo: "check" must always work.
   */
  private isEcho(sentence: string, isFinal: boolean): boolean {
    const heard = echoWords(sentence)
    if (heard.length < 2) return false
    // Longer than anything the app says. Checked first, because this runs for every piece of every sentence.
    if (heard.length > ECHO_MAX_WORDS) return false
    const now = this.device.now()
    for (const said of this.spoken) {
      const age = now - said.endedAt
      if (age >= ECHO_WINDOW_MS) continue
      // Whole numbers on both sides, so "4 of 5 words" is exactly 80 percent.
      if (wordsInOrder(heard, said.words) * 100 < heard.length * ECHO_PERCENT) continue
      // The app said "Say publish lesson to save it" and the person answers
      // "Publish lesson." a moment later. Those words are in the app's sentence,
      // but an echo of them would have arrived sooner and not as a sentence of
      // its own. So a finished sentence that is exactly one command is let through.
      const hit = isFinal && age >= ECHO_REPLY_MS ? parseCommand(this.mode, sentence) : null
      if (hit && hit.command !== "ask" && hit.before === "") continue
      return true
    }
    return false
  }

  // ---------- photos and Claude ----------

  /** Take a photo. Returns null when it fails. `sound: false` is the silent timed photo. */
  private async takeShot(key: string, sound: boolean): Promise<Shot | null> {
    this.waitingOn = "Taking a photo"
    this.syncAssistant()
    try {
      const photo = await this.device.takePhoto({sound})
      if (!photo || !photo.url) throw new Error("The glasses returned no photo.")
      return {url: photo.url, takenAt: this.device.now(), mediaType: photo.mediaType || "image/jpeg", key}
    } catch (err) {
      // A failed timed photo is not reported: nobody asked for it, and the next one comes in 20 seconds.
      if (sound) this.note(`Photo failed. ${describe(err)}`)
      return null
    } finally {
      this.waitingOn = ""
    }
  }

  /** Keep a copy of a photo on the phone, so it outlives its link. Not waited for. A failure is not fatal. */
  private keepPhoto(shot: Shot): void {
    const saving = this.quietly(() => this.device.savePhoto(shot.key, shot.url, shot.mediaType))
    this.saves.set(shot.key, saving)
    void saving.then(() => {
      if (this.saves.get(shot.key) === saving) this.saves.delete(shot.key)
    })
  }

  /** Delete a kept photo. */
  private forgetPhoto(key: string): void {
    if (!key) return
    this.photoBytes.delete(key)
    // Wait for a copy that is still being made. Otherwise the copy lands after the delete and stays forever.
    const saving = this.saves.get(key) ?? Promise.resolve()
    void this.quietly(() => saving.then(() => this.device.deletePhoto(key)))
  }

  /** Delete every kept photo of a lesson. */
  private forgetLesson(lesson: TutorialModel): void {
    const keys = new Set(lesson.steps.map((step) => step.photo_key ?? ""))
    for (const key of keys) this.forgetPhoto(key)
  }

  /** Turn a photo into something Claude can read: its link while fresh, its bytes otherwise. */
  private async imageFor(shot: Shot | null, allowLink: boolean): Promise<ImageInput | null> {
    if (!shot) return null
    const age = this.device.now() - shot.takenAt
    // 1. Fresh photo: send its link. Claude downloads it, and nothing large
    //    has to pass through the phone's JavaScript bridge.
    if (allowLink && shot.url && age < LINK_FRESH_MS) return {kind: "url", url: shot.url}

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
    if (!data && shot.url && age < LINK_DEAD_MS) {
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
      if (!(err instanceof BrainError) || err.status !== 400) throw err
      const result = await call(false) // throws again when the links were not the problem
      // Only now is it certain the links were the problem. Do not try them again.
      this.linksWork = false
      return result
    }
  }

  /** One request to Claude, with a time limit. A request that never answers would leave the app busy forever. */
  private claude<T>(request: Promise<T>): Promise<T> {
    return orFail(request, CLAUDE_GUARD_MS, "Claude did not answer in time.")
  }

  /** Show "thinking" on the screen for as long as `work` takes. */
  private async think<T>(work: () => Promise<T>): Promise<T> {
    this.waitingOn = "Thinking"
    this.syncAssistant()
    try {
      return await work()
    } finally {
      this.waitingOn = ""
      this.syncAssistant()
    }
  }

  // ---------- teaching ----------

  private async startTeaching(skillHint: string): Promise<void> {
    if (this.mode === "learning") return this.say("Stop the lesson first.")
    if (this.mode !== "idle") return // already recording, or a draft is waiting
    if (!this.apiKey) {
      // Recording without a key would end in a lesson that cannot be built.
      this.teachError = "Add the Claude key on the phone screen first."
      this.emitTeaching()
      return this.say(this.teachError)
    }
    this.mode = "recording"
    const now = this.device.now()
    this.recordingId = String(now)
    this.recordingStart = now
    this.recordingEnd = 0
    this.skillHint = skillHint
    this.captures = []
    this.narration = ""
    this.teachError = ""
    this.lastCaptureAt = now
    this.emitTeaching()
    await this.say("Recording. Do one step and explain it. Say next step when it is finished. Say finish lesson at the end.")
    // The 20 second wait starts once the instructions are over. A timed photo
    // of the expert standing still and listening would be wasted.
    this.lastCaptureAt = this.device.now()
  }

  /**
   * Add a capture: the words said up to the moment its photo was asked for, and
   * the photo when there is one. `before` is the narration as it was at that
   * moment. A photo takes a second or more, and what the expert says meanwhile
   * is the start of the next step, so it stays in `narration`.
   */
  private addCapture(kind: "step" | "auto", shot: Shot | null, before: string): void {
    const atSeconds = this.elapsedSeconds()
    // `narration` only grows at its end. If it no longer starts with `before`,
    // the length limit cut its front, and then everything goes to this capture.
    const grew = this.narration.startsWith(before)
    this.captures.push({transcript: grew ? before : this.narration, atSeconds, kind, shot})
    this.narration = grew ? this.narration.slice(before.length).trim() : ""
    if (!shot) return
    // Keep a copy on the phone. The lesson still works without it, so this is not waited for.
    this.keepPhoto(shot)
    const frameIndex = this.captures.filter((capture) => capture.shot).length
    this.send("photoCapture", {photoUrl: shot.url, frameIndex, timestampSeconds: atSeconds, kind})
  }

  /** "next step": photograph the finished step and save it with the words said so far. */
  private async captureStep(announce: boolean): Promise<void> {
    if (this.mode !== "recording") return
    const before = this.narration
    // The photo shows the step FINISHED. A learner's photo is compared with it later.
    const shot = await this.takeShot(`shot-${this.recordingId}-${this.captures.length + 1}`, true)
    this.lastCaptureAt = this.device.now()
    // Saved even when the photo failed. The expert's words alone still make a usable step.
    // The one exception is the unannounced capture at "finish lesson" that got
    // neither words nor a photo: it would tell Claude nothing.
    if (announce || shot || before) this.addCapture("step", shot, before)
    this.emitTeaching()
    if (!announce) return
    const number = this.captures.filter((capture) => capture.kind === "step").length
    await this.say(shot ? `Step ${number} saved.` : `Step ${number} saved without a photo.`)
  }

  /** The timed photo. Silent: no shutter sound, no speech, nothing on the screen but the new photo. */
  private async autoCapture(): Promise<void> {
    if (this.mode !== "recording") return
    const before = this.narration
    const shot = await this.takeShot(`shot-${this.recordingId}-${this.captures.length + 1}`, false)
    // Whether it worked or not, the next timed photo is a full wait away.
    this.lastCaptureAt = this.device.now()
    if (!shot) return // the words stay where they are, for the next capture
    this.addCapture("auto", shot, before)
    this.emitTeaching()
  }

  /** "finish lesson": Claude writes a draft lesson from the recording. */
  private async finishTeaching(): Promise<void> {
    if (this.mode !== "recording") return
    this.teachError = ""
    // The expert explained a last step but did not say "next step", or never said it at all. Save it now.
    if (this.narration || !this.captures.some((capture) => capture.kind === "step")) await this.captureStep(false)
    if (!this.captures.some((capture) => capture.transcript || capture.shot)) {
      // Not "...then say next step.": a sentence the app says must never end in a command (see `defuse`).
      return this.say("Nothing is recorded yet. Do a step and explain it, then say next step to save it.")
    }

    // "processing" lasts exactly as long as this command, so nothing else runs until Claude has answered.
    // The sentence and the Claude request run at the same time, so the wait feels shorter.
    // allSettled is used so a failed request cannot escape as an unhandled error mid-sentence.
    this.mode = "processing"
    this.recordingEnd = this.device.now()
    this.emitTeaching()
    const [, built] = await Promise.allSettled([this.say("Building the lesson."), this.think(() => this.buildDraft())])

    if (built.status === "rejected") {
      // Back to recording with every capture kept, so "finish lesson" can simply be said again.
      this.mode = "recording"
      this.recordingEnd = 0
      this.lastCaptureAt = this.device.now()
      this.teachError = `The lesson was not built. ${describe(built.reason)}`
      this.send("tutorialGenerated", {status: "error", error: this.teachError})
      this.emitTeaching()
      return this.say("I could not build the lesson. Say finish lesson to try again.")
    }

    const draft = built.value
    this.draft = draft
    this.mode = "review"
    // Kept photos that no step of the draft uses only take up space on the phone.
    const used = new Set(draft.steps.map((step) => step.photo_key ?? ""))
    for (const capture of this.captures) {
      if (capture.shot && !used.has(capture.shot.key)) this.forgetPhoto(capture.shot.key)
    }
    this.send("tutorialGenerated", {status: "success", tutorial: draft})
    this.emitTeaching()
    const count = draft.steps.length
    await this.say(
      `Lesson ready. ${spokenTitle(draft.title)}. It has ${count} ${count === 1 ? "step" : "steps"}. Say publish lesson to save it, or review it on the phone.`,
    )
  }

  /** Send the recording to Claude and turn its answer into a draft lesson. */
  private async buildDraft(): Promise<TutorialModel> {
    const captures = this.captures
    // A long recording is thinned to MAX_PLAN_PHOTOS photos.
    // Every capture keeps its words. Only some lose their photo.
    const keep = choosePhotos(captures)
    const draft = await this.withPhotos(async (allowLink) => {
      const inputs: CaptureInput[] = []
      for (let i = 0; i < captures.length; i++) {
        const capture = captures[i]!
        const image = keep.has(i) ? await this.imageFor(capture.shot, allowLink) : null
        inputs.push({transcript: capture.transcript, atSeconds: capture.atSeconds, kind: capture.kind, image})
      }
      return this.claude(this.brain.buildLesson(this.apiKey, {captures: inputs, skillHint: this.skillHint}))
    })
    return this.toTutorial(draft, captures)
  }

  /** Claude's lesson plus what only the Coach knows: ids, step numbers and the expert's photos. */
  private toTutorial(draft: LessonDraft, captures: Capture[]): TutorialModel {
    const id = this.recordingId
    const steps = (Array.isArray(draft.steps) ? draft.steps : []).map((written, i) => {
      const number = i + 1
      const spoken = clean(written.instruction_spoken)
      // A step with nothing to say cannot be taught. Failing here lets the expert try again.
      if (!spoken) throw new Error(`Claude left step ${number} without an instruction.`)
      const step: TutorialStepModel = {
        id: `step_${id}_${number}`,
        step_number: number,
        title: clean(written.title) || `Step ${number}`,
        instruction_spoken: spoken,
        instruction_detailed: clean(written.instruction_detailed),
      }
      const tips = cleanList(written.tips)
      if (tips.length) step.tips = tips
      if (clean(written.done_looks_like)) step.done_looks_like = clean(written.done_looks_like)
      if (clean(written.common_mistake)) step.common_mistake = clean(written.common_mistake)
      if (clean(written.story)) step.story = clean(written.story)
      // Claude names the capture that shows this step finished (source_capture counts from 1).
      // That capture's photo becomes the picture a learner is compared with.
      const capture = captures[Math.round(Number(written.source_capture)) - 1]
      if (capture) {
        step.source_timestamp_seconds = capture.atSeconds
        if (capture.shot) {
          step.reference_image_url = capture.shot.url
          step.photo_key = capture.shot.key
          step.photo_taken_at = capture.shot.takenAt
        }
      }
      return step
    })
    if (steps.length === 0) throw new Error("Claude returned a lesson with no steps.")

    // When Claude gives no usable number, the length of the recording itself is the honest estimate.
    const recordedMinutes = Math.ceil((this.recordingEnd - this.recordingStart) / 60000)
    const minutes = Math.round(Number(draft.estimated_duration_minutes)) || recordedMinutes || 1
    const lesson: TutorialModel = {
      id: `tut_${id}`,
      title: clean(draft.title) || this.skillHint || "Untitled lesson",
      description: clean(draft.description),
      total_steps: steps.length,
      estimated_duration_minutes: Math.min(120, Math.max(1, minutes)),
      created_at: new Date(this.device.now()).toISOString(),
      status: "draft",
      tools_required: cleanList(draft.tools_required),
      ingredients_required: cleanList(draft.ingredients_required),
      steps,
    }
    if (clean(draft.category)) lesson.category = clean(draft.category)
    return lesson
  }

  /** Forget the recording. Called when it has been published or discarded. */
  private resetRecording(): void {
    this.recordingId = ""
    this.recordingStart = 0
    this.recordingEnd = 0
    this.skillHint = ""
    this.captures = []
    this.narration = ""
    this.teachError = ""
  }

  /** "publish lesson": the reviewed draft joins the library. */
  private async publish(title: string, description: string): Promise<void> {
    if (this.mode !== "review" || !this.draft) return
    const lesson: TutorialModel = {...this.draft, status: "published"}
    // Empty means "not edited". A lesson is never published without a title.
    if (title) lesson.title = title
    if (description) lesson.description = description

    this.draft = null
    this.resetRecording()
    this.mode = "idle"
    this.recorded.unshift(lesson) // newest first
    while (this.recorded.length > MAX_LIBRARY) this.forgetLesson(this.recorded.pop()!)
    const failed = await this.saveLibrary()
    if (failed) this.note(`The lesson works now but was not saved to the phone. ${failed}`)
    this.emitLibrary()
    this.emitTeaching()
    await this.say("Lesson published.")
  }

  /** "cancel lesson": throw away the recording, or the draft that came out of it. */
  private async discard(): Promise<void> {
    if (this.mode === "recording") {
      for (const capture of this.captures) if (capture.shot) this.forgetPhoto(capture.shot.key)
      this.resetRecording()
      this.mode = "idle"
      this.emitTeaching()
      return this.say("Recording discarded.")
    }
    if (this.mode === "review") {
      // Photos the draft does not use were already deleted when it was built.
      if (this.draft) this.forgetLesson(this.draft)
      this.draft = null
      this.resetRecording()
      this.mode = "idle"
      this.emitTeaching()
      return this.say("Draft discarded.")
    }
  }

  // ---------- learning ----------

  private currentStep(): TutorialStepModel | null {
    return this.lesson?.steps[this.stepNumber - 1] ?? null
  }

  /** "start lesson": begin coaching. No key is needed: reading steps aloud works without Claude. */
  private async startLesson(tutorialId: string): Promise<void> {
    if (this.mode === "learning") return
    if (this.mode !== "idle") return this.say("Finish or cancel the recording first.")
    const library = this.tutorials()
    // By voice or by the glasses button there is no id: take the first lesson, which is the newest recording.
    const lesson = tutorialId ? library.find((candidate) => candidate.id === tutorialId) : library[0]
    const first = lesson?.steps[0]
    if (!lesson || !first) {
      this.emitLibrary() // the screen is showing a lesson that is gone
      return this.say("That lesson is not on this phone.")
    }

    this.mode = "learning"
    this.lesson = lesson
    this.stepNumber = 1
    this.sessionId = `learn_${this.device.now()}_${++this.sessionCount}`
    this.lastVerdict = null
    this.askUntil = 0
    try {
      this.device.setVocabulary(vocabularyFor(lesson))
    } catch {
      // Speech-to-text works without the extra words. Not worth stopping a lesson for.
    }
    this.emitLearning()
    this.note(`Started: ${lesson.title}`)
    // One sentence group: the title, how to ask for a check, and the first step.
    await this.say(`${spokenTitle(lesson.title)}. Say check when a step is done. Step 1. ${first.instruction_spoken}`)
  }

  /** The lesson is over. `finished` tells the screen whether the last step was reached. */
  private async endLesson(finished: boolean, sentence: string): Promise<void> {
    if (this.lesson) this.send("learningState", this.learningState(false, finished))
    this.mode = "idle"
    this.lesson = null
    this.stepNumber = 0
    this.askUntil = 0
    await this.say(sentence)
  }

  /** "check": photograph the learner's work and let Claude judge it against the current step. */
  private async check(heardText: string): Promise<void> {
    const lesson = this.lesson
    const step = this.currentStep()
    if (this.mode !== "learning" || !lesson || !step) return
    if (!this.apiKey) return this.say("Add the Claude key on the phone screen to use checks.")

    // "" as the photo name: a learner's photo is not kept on the phone.
    const shot = await this.takeShot("", true)
    if (!shot) return this.say("I could not take a photo. Say check to try again.")

    // Claude gets the expert's photo (when there is one) and the learner's photo.
    // It returns {result: "pass" | "fix" | "unclear", say: "..."}.
    let verdict: Verdict
    try {
      verdict = await this.think(() =>
        this.withPhotos(async (allowLink) => {
          const learner = await this.imageFor(shot, allowLink)
          if (!learner) throw new Error("The photo could not be read.")
          const reference = await this.imageFor(referenceShot(step), allowLink)
          return this.claude(
            this.brain.checkStep(this.apiKey, {tutorialTitle: lesson.title, step, learner, reference, heard: heardText}),
          )
        }),
      )
      const known = verdict.result === "pass" || verdict.result === "fix" || verdict.result === "unclear"
      if (!known || !clean(verdict.say)) throw new Error("Claude's answer could not be used.")
    } catch (err) {
      this.note(`The check failed. ${describe(err)}`)
      return this.say("I could not check that. Say check to try again.")
    }

    const said = clean(verdict.say)
    this.lastVerdict = {step: this.stepNumber, result: verdict.result, say: said, photoUrl: shot.url}
    this.send("stepVerdict", this.lastVerdict)
    try {
      this.device.light(verdict.result === "pass" ? "green" : verdict.result === "fix" ? "red" : "orange", 2)
    } catch {
      // The light is a bonus. The spoken verdict is what counts.
    }

    // Not a pass: say the correction and stay on this step.
    if (verdict.result !== "pass") return this.say(said)

    // Pass. The praise and the next step are one speech call, so there is no silence between them.
    const next = lesson.steps[this.stepNumber]
    if (next) {
      this.stepNumber += 1
      this.emitLearning()
      return this.say(`${asSentence(said)} Step ${this.stepNumber}. ${next.instruction_spoken}`)
    }
    await this.endLesson(true, `${asSentence(said)} That was the last step. You finished ${spokenTitle(lesson.title)}.`)
  }

  /** "next step": move on without a photo check. */
  private async next(): Promise<void> {
    const lesson = this.lesson
    if (this.mode !== "learning" || !lesson) return
    const next = lesson.steps[this.stepNumber]
    if (!next) return this.endLesson(true, `That was the last step. You finished ${spokenTitle(lesson.title)}.`)
    this.stepNumber += 1
    this.emitLearning()
    await this.say(`Step ${this.stepNumber}. ${next.instruction_spoken}`)
  }

  private async previous(): Promise<void> {
    const lesson = this.lesson
    if (this.mode !== "learning" || !lesson) return
    if (this.stepNumber <= 1) {
      return this.say(`This is the first step. Step 1. ${lesson.steps[0]!.instruction_spoken}`)
    }
    this.stepNumber -= 1
    this.emitLearning()
    await this.say(`Step ${this.stepNumber}. ${lesson.steps[this.stepNumber - 1]!.instruction_spoken}`)
  }

  private async repeat(): Promise<void> {
    const step = this.currentStep()
    if (this.mode !== "learning" || !step) return
    await this.say(`Step ${this.stepNumber}. ${step.instruction_spoken}`)
  }

  /** "why": the expert's own reason for the step. Lessons without one fall back to the written explanation. */
  private async story(): Promise<void> {
    const step = this.currentStep()
    if (this.mode !== "learning" || !step) return
    await this.say(clean(step.story) || clean(step.instruction_detailed) || "The expert gave no reason for this step.")
  }

  private async tips(): Promise<void> {
    const step = this.currentStep()
    if (this.mode !== "learning" || !step) return
    // Two at most: the learner has busy hands and cannot hold a list in mind.
    const tips = cleanList(step.tips).slice(0, 2).map(asSentence)
    await this.say(tips.length ? tips.join(" ") : "There are no tips for this step.")
  }

  private async materials(): Promise<void> {
    const lesson = this.lesson
    if (this.mode !== "learning" || !lesson) return
    const items = [...cleanList(lesson.tools_required), ...cleanList(lesson.ingredients_required)].slice(0, 8)
    await this.say(items.length ? `You need ${listAloud(items)}.` : "This lesson lists no materials.")
  }

  /** "Tinker, ...": a question about the step, answered by Claude in a few spoken sentences. */
  private async ask(job: Job): Promise<void> {
    const lesson = this.lesson
    if (this.mode !== "learning" || !lesson) {
      // Only the screen can get here, with a typed question and no lesson running.
      if (this.mode === "idle" && job.typed) return this.say("Start a lesson first.")
      return
    }
    const question = clean(job.question)
    if (job.typed && !question) return

    // A spoken question is in the conversation already (see `heard`). A typed one is added now.
    const lineId = job.typed ? this.addLine("user", question).id : (job.lineId ?? "")
    if (!this.apiKey) return this.say("Add the Claude key on the phone screen to ask questions.")
    if (!question) {
      // Only the name was said. Speech-to-text often ends the sentence at that
      // pause, so the question arrives as a sentence of its own. Invite it.
      await this.say("Yes?")
      this.askUntil = this.device.now() + ASK_FOLLOW_MS
      return
    }

    // The last few things said, oldest first, so "and how long?" makes sense to Claude.
    // The question itself is left out here: Claude gets it separately.
    const recent: Array<{speaker: "user" | "tinker"; text: string}> = []
    for (const line of this.transcript) {
      if (!line.isFinal || line.id === lineId) continue
      if (line.speaker === "user" || line.speaker === "tinker") recent.push({speaker: line.speaker, text: line.text})
    }
    let answer: string
    try {
      answer = clean(
        await this.think(() =>
          this.claude(
            this.brain.answer(this.apiKey, {
              tutorial: lesson,
              stepNumber: this.stepNumber,
              question,
              recent: recent.slice(-RECENT_LINES),
            }),
          ),
        ),
      )
      if (!answer) throw new Error("Claude gave an empty answer.")
    } catch (err) {
      this.note(`The question failed. ${describe(err)}`)
      return this.say("I could not answer that. Ask again.")
    }
    await this.say(answer)
  }

  /** "stop lesson": leave the lesson before its end. */
  private async stop(): Promise<void> {
    if (this.mode !== "learning") return
    await this.endLesson(false, "Lesson stopped.")
  }

  // ---------- the library ----------

  /** Write the recorded lessons to the phone. Returns "" when it worked, the reason when it did not. */
  private async saveLibrary(): Promise<string> {
    try {
      await this.device.storageSet(LIBRARY_STORE, JSON.stringify(this.recorded))
      return ""
    } catch (err) {
      return describe(err)
    }
  }

  /**
   * Remove a recorded lesson and its photos. Reached from the phone screen only.
   * It does not go through `run`: it changes nothing a running command relies
   * on, so the Delete button works even while the app is talking.
   */
  private deleteTutorial(tutorialId: string): void {
    const index = this.recorded.findIndex((lesson) => lesson.id === tutorialId)
    // The built-in lesson is not in `recorded`, so it is never found here.
    const beingLearned = this.mode === "learning" && this.lesson?.id === tutorialId
    if (index >= 0 && !beingLearned) {
      const [gone] = this.recorded.splice(index, 1)
      this.forgetLesson(gone!)
      void this.quietly(async () => {
        const failed = await this.saveLibrary()
        if (failed) this.note(`The lesson was removed but the phone could not save that. ${failed}`)
      })
    }
    // Sent in every case, so a screen that asked for something impossible shows the real list again.
    this.emitLibrary()
  }
}
