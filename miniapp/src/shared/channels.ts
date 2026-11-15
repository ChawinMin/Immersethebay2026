/**
 * Messages between the two halves of the miniapp.
 *
 *   background (src/background)  talks to the glasses and to Claude
 *   UI         (src/ui)          the screen on the phone
 *
 * Both halves import this file, so the names and shapes always match.
 *
 * The two halves do not share memory. These messages are the only link, and
 * they travel as JSON text, so keep them small. Never send photo bytes.
 *
 * TO ADD A COMMAND
 *   1. add its name to `ActionName` below
 *   2. add it to `Command` and to a phrase list in src/background/commands.ts
 *   3. add a branch in `Coach.run` in src/background/coach.ts
 *
 * TO SHOW SOMETHING NEW ON THE SCREEN
 *   1. add a field to `AppState` below
 *   2. fill it in `Coach.state()` in src/background/coach.ts
 *   3. add it to `EMPTY` in src/ui/App.tsx
 *
 * More: docs/MERGING_A_FRONTEND.md
 */

import type {MentraTyped, Rpc} from "@mentra/miniapp/ui"

/** What the app is doing right now. */
export type Mode =
  | "idle" // waiting for "start teaching" or "start lesson"
  | "teaching" // the expert is recording a lesson
  | "building" // Claude is writing the lesson from the recording
  | "coaching" // a learner is being walked through the lesson

/** Everything the phone screen can ask the background to do. */
export type ActionName =
  | "teach" // start recording a lesson
  | "capture" // save the step the expert just did
  | "finish" // end the recording and build the lesson
  | "learn" // start coaching a learner
  | "check" // photograph the learner's work and check it
  | "repeat" // say the current step again
  | "story" // say why the expert does this step
  | "skip" // go to the next step without checking
  | "stop" // leave teaching or coaching
  | "help" // say which commands work right now
  | "deleteLesson" // erase the saved lesson

export interface StepView {
  number: number
  instruction: string
}

/** One snapshot of the app, sent to the phone screen after every change. */
export interface AppState {
  mode: Mode
  /** True while a photo, a Claude call or speech is in progress. */
  busy: boolean
  hasKey: boolean
  /** Last 4 characters of the saved Claude key, so you can tell which key it is. */
  keyHint: string
  /** "" when no lesson is saved. */
  lessonTitle: string
  materials: string[]
  steps: StepView[]
  /** Coaching: the step the learner is on. Teaching: the step being recorded. */
  stepNumber: number
  /** Teaching: what the expert has said for the current step so far. */
  narration: string
  lastHeard: string
  lastSaid: string
  error: string
}

export interface Channels {
  /** background to UI: the latest state. */
  "state": AppState
  /** UI to background: give me the state now. */
  "get-state": Rpc<Record<string, never>, AppState>
  /** UI to background: a button was tapped. */
  "action": Rpc<{name: ActionName}, {ok: boolean}>
  /** UI to background: save the Claude key. An empty key removes it. */
  "set-key": Rpc<{key: string}, {ok: boolean; error: string}>
}

declare global {
  // The `mentra` object exists only in the UI. This gives it the types above.
  // eslint-disable-next-line no-var
  var mentra: MentraTyped<Channels>
}
