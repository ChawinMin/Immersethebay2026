/**
 * Typed channel registry — single source of truth for the names + payload
 * shapes that flow between Tinker's background JSContext and its UI
 * WebView. Both halves import this file at build time; the bundler inlines
 * the declarations so there's no runtime resolution.
 *
 * Add a key per channel. The TypeScript generic on `mentra.send` /
 * `mentra.on` / `session.ui.send` / `session.ui.on` enforces names + payload
 * shapes at compile time so the two halves cannot drift.
 */

export interface TutorialStepModel {
  id: string
  step_number: number
  title: string
  instruction_spoken: string
  instruction_detailed: string
  reference_image_url?: string
  source_timestamp_seconds?: number
  tips?: string[]
}

export interface TutorialModel {
  id: string
  title: string
  description: string
  category?: string
  total_steps: number
  estimated_duration_minutes: number
  created_at: string
  status: "draft" | "processing" | "published"
  tools_required?: string[]
  ingredients_required?: string[]
  steps: TutorialStepModel[]
}

export interface TranscriptEntry {
  id: string
  speaker: "user" | "tinker" | "system"
  text: string
  isFinal: boolean
  timestamp: string
  step?: number
}

export interface Channels {
  // ── WebView → Background Commands ─────────────────────────────
  "startTeaching": { author?: string; targetSkill?: string }
  "stopTeaching": Record<string, never>
  "publishTutorial": { tutorial: TutorialModel }
  "startLearning": { tutorialId: string }
  "endLearning": Record<string, never>
  "navigateStep": { direction: "next" | "previous" | "repeat" }
  "askTinker": { text: string }
  "requestTutorials": Record<string, never>
  "ping": { at: number }
  "playChime": Record<string, never>
  "startStream": Record<string, never>

  // ── Background → WebView Events ───────────────────────────────
  "pong": { at: number; roundtripMs: number; backgroundVersion?: string }
  "chimeStatus": { message: string }
  "streamReady": { hlsUrl: string }
  "teachingState": {
    status: "idle" | "recording" | "processing" | "review"
    elapsedSeconds: number
    frameCount: number
    sessionId?: string
    error?: string
  }
  "photoCapture": {
    photoUrl: string
    frameIndex: number
    timestampSeconds: number
  }
  "tutorialGenerated": {
    tutorial: TutorialModel
    status: "success" | "error"
    error?: string
  }
  "tutorialList": {
    tutorials: TutorialModel[]
  }
  "learningState": {
    sessionId: string
    tutorialId: string
    currentStep: number
    totalSteps: number
    stepData: TutorialStepModel | null
    assistantState: "idle" | "listening" | "thinking" | "speaking"
  }
  "transcriptionUpdate": TranscriptEntry
  "assistantState": {
    state: "idle" | "listening" | "thinking" | "speaking"
    message?: string
  }
  "connectionStatus": {
    glassesConnected: boolean
    hasCamera: boolean
    hasMic: boolean
    backendConnected: boolean
    message?: string
  }
}

declare global {
  // Augment the `mentra` global from @mentra/miniapp/ui with this miniapp's
  // typed channel registry so authors get compile-time enforcement on every
  // mentra.send / mentra.on call without re-declaring it.
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
