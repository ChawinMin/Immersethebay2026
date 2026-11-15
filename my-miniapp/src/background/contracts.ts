/**
 * contracts.ts: the two interfaces that keep Tinker's logic testable.
 *
 *   Device   what the Coach needs from the phone and the glasses
 *   Brain    what the Coach needs from Claude
 *
 * coach.ts imports ONLY these interfaces. It never imports the Mentra SDK and
 * never calls `fetch`. That is why whole lessons can run in `bun test` with a
 * fake Device and a fake Brain, and no glasses.
 *
 *   real Device   built in index.ts from `session.*`
 *   real Brain    built in claude.ts from `fetch`
 *   fakes         in test/
 *
 * This file must stay free of Mentra imports and of anything the background
 * engine lacks (no window, document, process, URL, Headers, Node modules).
 */

import type {Channels, TutorialModel, TutorialStepModel, UiEventChannel} from "../shared/channels"

// ---------------------------------------------------------------- Device

export type LightColor = "red" | "green" | "blue" | "orange" | "white"

export interface Hardware {
  glassesConnected: boolean
  hasCamera: boolean
  hasMic: boolean
}

export interface Device {
  /**
   * Take a photo with the glasses. Resolves with a download link that works
   * for about 10 minutes. `sound: false` takes it without the shutter sound.
   * Rejects when the photo fails or takes too long.
   */
  takePhoto(options: {sound: boolean}): Promise<{url: string; mediaType: string}>
  /** Say text through the glasses. Resolves when the speech has finished playing. */
  speak(text: string): Promise<void>
  /** Blink the light on the glasses. Never throws. */
  light(color: LightColor, times: number): void
  /** Tell speech-to-text which unusual words to expect (tool names and the like). Never throws. */
  setVocabulary(words: string[]): void
  /** What is connected right now. */
  hardware(): Hardware

  /** Download a photo link and return its bytes as base64. */
  downloadPhoto(url: string): Promise<string>
  /** Keep a copy of a photo on the phone, so it outlives its link. */
  savePhoto(key: string, url: string, mediaType: string): Promise<void>
  /** Read a kept photo back as base64, or null when there is none. */
  loadPhoto(key: string): Promise<string | null>
  deletePhoto(key: string): Promise<void>

  /** Small text storage on the phone. Values are strings. */
  storageGet(key: string): Promise<string | null>
  storageSet(key: string, value: string): Promise<void>
  storageDelete(key: string): Promise<void>

  /** Current time in milliseconds. Tests replace this with a fake clock. */
  now(): number

  /** Send one message to the phone screen. Does nothing while the screen is closed. Never throws. */
  emit<C extends UiEventChannel>(channel: C, payload: Channels[C]): void
}

// ---------------------------------------------------------------- Brain

/** A photo for Claude: its link, or its bytes. */
export type ImageInput = {kind: "url"; url: string} | {kind: "base64"; data: string; mediaType: string}

/** One moment of the expert's recording. */
export interface CaptureInput {
  /** What the expert said since the previous capture. */
  transcript: string
  /** Seconds since the recording started. */
  atSeconds: number
  /** "step": the expert said this step was finished. "auto": a timed photo in the middle of the work. */
  kind: "step" | "auto"
  image: ImageInput | null
}

/** One step as Claude writes it. The Coach adds ids, numbers and photo links afterwards. */
export interface DraftStep {
  title: string
  instruction_spoken: string
  instruction_detailed: string
  tips: string[]
  done_looks_like: string
  common_mistake: string
  story: string
  /** Number of the capture, counting from 1, whose photo best shows this step finished. */
  source_capture: number
}

/** A lesson as Claude writes it. */
export interface LessonDraft {
  title: string
  description: string
  category: string
  estimated_duration_minutes: number
  tools_required: string[]
  ingredients_required: string[]
  steps: DraftStep[]
}

export interface Verdict {
  result: "pass" | "fix" | "unclear"
  /** One short sentence to speak. */
  say: string
}

/**
 * A failed request to Claude.
 * `status` is the HTTP status. 0 means there was no connection.
 * 400 means Claude could not use something in the request, which is what
 * happens when it cannot open a photo link. The Coach then retries with bytes.
 * 401 means the key was rejected.
 */
export class BrainError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "BrainError"
    this.status = status
  }
}

export interface Brain {
  /** One tiny request that proves the key works. Rejects with a BrainError when it does not. */
  testKey(apiKey: string): Promise<void>

  /** The expert's recording in, a lesson out. `skillHint` is what the expert said they were teaching, or "". */
  buildLesson(apiKey: string, input: {captures: CaptureInput[]; skillHint: string}): Promise<LessonDraft>

  /** One learner photo in, pass or one correction out. `heard` is what the learner just said, or "". */
  checkStep(
    apiKey: string,
    input: {
      tutorialTitle: string
      step: TutorialStepModel
      learner: ImageInput
      reference: ImageInput | null
      heard: string
    },
  ): Promise<Verdict>

  /** Answer a learner's question in one to three spoken sentences. */
  answer(
    apiKey: string,
    input: {
      tutorial: TutorialModel
      /** Counts from 1. */
      stepNumber: number
      question: string
      /** The last few lines of the conversation, oldest first. */
      recent: Array<{speaker: "user" | "tinker"; text: string}>
    },
  ): Promise<string>
}
