/**
 * channels.ts: every message between the two halves of Tinker.
 *
 *   background (src/background)  talks to the glasses and to Claude
 *   UI         (src/ui)          the screens on the phone
 *
 * Both halves import this file, so the names and shapes always match.
 * The halves share no memory. These messages are the only link, and they
 * travel as JSON text, so keep them small. Never send photo bytes.
 *
 * WHERE THE STATE LIVES
 *   In the background. The screen is thrown away every time it is closed.
 *   When it opens again it asks for a `Snapshot` and redraws itself from that.
 *   The screen must not keep its own copy of the step number, the lesson
 *   list or the transcript. It shows what the background sends.
 *
 * TWO KINDS OF CHANNEL
 *   plain     mentra.send(name, payload)      fire and forget
 *             mentra.on(name, handler)        listen
 *   Rpc<A,B>  await mentra.request(name, a)   ask and get an answer back
 *
 * TO ADD A SCREEN BUTTON THAT DOES SOMETHING
 *   1. add a command channel below and add its name to `UiCommandChannel`
 *   2. handle it in `Coach.command` in src/background/coach.ts
 *   3. send it from the screen with mentra.send
 *
 * More: docs/HOW_IT_WORKS.md
 */

import type {MentraTyped, Rpc} from "@mentra/miniapp/ui"

/**
 * The words the background sends with the "thinking" state while the glasses
 * take a photo (`takeShot` in src/background/coach.ts). During a lesson that
 * only happens at the start of a check, so the screen uses them to forget the
 * old verdict (`applyEvent` in src/ui/state.ts). Both halves use this one
 * constant, so the wording cannot drift apart.
 */
export const PHOTO_MESSAGE = "Taking a photo"

// ---------------------------------------------------------------- lessons

/** One step of a lesson. The field names use snake_case because saved lessons already use them. */
export interface TutorialStepModel {
  id: string
  /** Counts from 1. */
  step_number: number
  /** A few words, shown as the step's heading. */
  title: string
  /** What the glasses say. One or two short sentences. */
  instruction_spoken: string
  /** Extra explanation shown on the phone screen. Not spoken unless asked. */
  instruction_detailed: string
  /**
   * Link to the expert's photo of this step finished. The link comes from the
   * glasses and stops working after about 10 minutes, so the screen must cope
   * with a picture that fails to load.
   */
  reference_image_url?: string
  /** Seconds into the recording when this step's photo was taken. */
  source_timestamp_seconds?: number
  tips?: string[]
  /** What a photo shows when this step is finished correctly. The photo check is judged against this. */
  done_looks_like?: string
  /** The most likely beginner error at this step. */
  common_mistake?: string
  /** The expert's own reason or history for this step, close to their words. */
  story?: string
  /** Name of the copy of the expert's photo kept on the phone. Used once the link has expired. */
  photo_key?: string
  /** When the expert's photo was taken, in milliseconds. Tells whether the link is still fresh. */
  photo_taken_at?: number
}

export interface TutorialModel {
  id: string
  title: string
  description: string
  category?: string
  total_steps: number
  estimated_duration_minutes: number
  /** ISO date text. */
  created_at: string
  /** "draft": built by Claude, waiting for the expert to review it. "published": in the library. */
  status: "draft" | "processing" | "published"
  tools_required?: string[]
  ingredients_required?: string[]
  steps: TutorialStepModel[]
  /** True for the lesson that ships inside the app. It cannot be deleted. */
  built_in?: boolean
}

// ---------------------------------------------------------------- small shared shapes

export type AssistantState = "idle" | "listening" | "thinking" | "speaking"

/** One line of the conversation shown on the phone. */
export interface TranscriptEntry {
  id: string
  /** "user": heard by the glasses or typed. "tinker": spoken by the glasses. "system": a note or an error. */
  speaker: "user" | "tinker" | "system"
  text: string
  /** False while the person is still talking. The next entry with the same id replaces it. */
  isFinal: boolean
  /** A short label for the line, for example "Step 2" or "You". */
  timestamp: string
  step?: number
}

export interface TeachingState {
  /** "recording": the expert is demonstrating. "processing": Claude is writing the lesson. "review": a draft is waiting. */
  status: "idle" | "recording" | "processing" | "review"
  elapsedSeconds: number
  /** Photos taken so far in this recording. */
  frameCount: number
  /** Steps the expert has saved so far ("next step"). */
  stepCount: number
  /** What the expert has said since the last saved step. */
  narration: string
  sessionId?: string
  /** Set when the last recording could not be turned into a lesson. Plain words, safe to show. */
  error?: string
}

export interface LearningState {
  /** False once the lesson has ended. The screen then goes back to the library. */
  active: boolean
  /** True when the lesson ended because the last step passed its check or was finished. */
  finished: boolean
  sessionId: string
  tutorialId: string
  /** Counts from 1. */
  currentStep: number
  totalSteps: number
  stepData: TutorialStepModel | null
  assistantState: AssistantState
}

/** The result of checking the learner's work from a photo. */
export interface StepVerdict {
  step: number
  /** "pass": correct. "fix": something visible is wrong. "unclear": the photo did not show the work. */
  result: "pass" | "fix" | "unclear"
  /** The sentence the glasses said. */
  say: string
  /** Link to the learner's photo that was judged. Works for about 10 minutes. */
  photoUrl?: string
}

export interface ConnectionStatus {
  glassesConnected: boolean
  hasCamera: boolean
  hasMic: boolean
  /** True when a Claude key is saved on this phone and passed its test. */
  claudeReady: boolean
  /** Last 4 characters of the saved key, so people can tell which key it is. "" when there is none. */
  keyHint: string
  message?: string
}

/** Everything the screen needs to draw itself from nothing. Sent when the screen opens. */
export interface Snapshot {
  connection: ConnectionStatus
  /** The library, newest first. The built-in lesson is always in it. */
  tutorials: TutorialModel[]
  teaching: TeachingState
  /** The lesson Claude just built, waiting for review. null when there is none. */
  draft: TutorialModel | null
  /** null when no lesson is being learned. */
  learning: LearningState | null
  lastVerdict: StepVerdict | null
  /** The most recent conversation lines, oldest first. */
  transcript: TranscriptEntry[]
  assistant: AssistantState
  /** True while a photo, a Claude request or speech is in progress. */
  busy: boolean
}

// ---------------------------------------------------------------- the channels

export interface Channels {
  // ── screen -> background: commands ─────────────────────────────

  /** Start recording a lesson. */
  "startTeaching": {author?: string; targetSkill?: string}
  /** Photograph the finished step and save it with the words said so far. Same as saying "next step". */
  "captureStep": Record<string, never>
  /** Stop recording and let Claude write the lesson. The answer arrives as "tutorialGenerated". */
  "stopTeaching": Record<string, never>
  /** Throw away the recording or the draft. */
  "discardTeaching": Record<string, never>
  /** Save the reviewed draft into the library. Title and description may have been edited on the screen. */
  "publishTutorial": {tutorial: TutorialModel}
  /** Remove a lesson from the library. The built-in lesson cannot be removed. */
  "deleteTutorial": {tutorialId: string}

  /** Start learning a lesson. */
  "startLearning": {tutorialId: string}
  "endLearning": Record<string, never>
  /** Move between steps without a photo check. */
  "navigateStep": {direction: "next" | "previous" | "repeat"}
  /** Photograph the learner's work and let Claude check it against the current step. */
  "checkStep": Record<string, never>
  /** Ask a question about the current step. Typed on the screen, or spoken as "Tinker, ...". */
  "askTinker": {text: string}

  /** Ask for the library again. The answer arrives as "tutorialList". */
  "requestTutorials": Record<string, never>
  /** Say a short sentence through the glasses, to prove the sound works. */
  "testAudio": Record<string, never>
  "ping": {at: number}

  /** Save the Claude key after one real test request. An empty key removes the saved key. */
  "setKey": Rpc<{key: string}, {ok: boolean; error: string}>
  /** Everything the screen needs, in one answer. */
  "getSnapshot": Rpc<Record<string, never>, Snapshot>

  // ── background -> screen: events ───────────────────────────────

  "pong": {at: number; roundtripMs: number; backgroundVersion?: string}
  /** Also pushed once when the screen opens. */
  "snapshot": Snapshot
  "teachingState": TeachingState
  /** A photo was just taken while teaching. */
  "photoCapture": {
    photoUrl: string
    frameIndex: number
    timestampSeconds: number
    /** "step": the expert saved a step. "auto": a timed photo in the middle of the work. */
    kind: "step" | "auto"
  }
  /** Claude finished (or failed) writing the lesson. On "error" there is no tutorial. */
  "tutorialGenerated": {
    status: "success" | "error"
    tutorial?: TutorialModel
    error?: string
  }
  "tutorialList": {tutorials: TutorialModel[]}
  "learningState": LearningState
  "stepVerdict": StepVerdict
  "transcriptionUpdate": TranscriptEntry
  "assistantState": {state: AssistantState; message?: string}
  "connectionStatus": ConnectionStatus
}

/** Plain channels the screen sends. `Coach.command` handles exactly these. */
export type UiCommandChannel =
  | "startTeaching"
  | "captureStep"
  | "stopTeaching"
  | "discardTeaching"
  | "publishTutorial"
  | "deleteTutorial"
  | "startLearning"
  | "endLearning"
  | "navigateStep"
  | "checkStep"
  | "askTinker"
  | "requestTutorials"
  | "testAudio"
  | "ping"

/** Channels the background sends to the screen. */
export type UiEventChannel =
  | "pong"
  | "snapshot"
  | "teachingState"
  | "photoCapture"
  | "tutorialGenerated"
  | "tutorialList"
  | "learningState"
  | "stepVerdict"
  | "transcriptionUpdate"
  | "assistantState"
  | "connectionStatus"

declare global {
  // `mentra` exists only on the screen side. This gives it the types above.
  // eslint-disable-next-line no-var
  var mentra: MentraTyped<Channels>
}
