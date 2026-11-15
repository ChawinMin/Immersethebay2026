/**
 * state.ts: the screen's copy of what the background last said.
 *
 * WHY THIS FILE EXISTS
 *   The truth lives in the background (src/background/coach.ts). The screen is
 *   thrown away every time it closes, so it must be able to redraw itself from
 *   nothing. This file is the one place where messages from the background are
 *   turned into the data the screen draws. No component changes this data by
 *   itself. A button sends a command, and the screen changes only when the
 *   background answers with an event.
 *
 * HOW IT WORKS
 *   `applyEvent` is a plain function: old state + one event = new state.
 *   `useTinker` is the React hook that listens to every event from
 *   src/shared/channels.ts, feeds it to `applyEvent`, and asks for a full
 *   `Snapshot` when the screen opens.
 *
 * TO SHOW A NEW EVENT ON THE SCREEN
 *   1. add it to `ScreenEvent` and to `applyEvent`
 *   2. listen for it in `useTinker`
 *   3. draw the new field in a component
 */

import {useEffect, useReducer, useState} from "react"
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
} from "../shared/channels"

/** The screen keeps at most this many conversation lines. The background keeps 40 for snapshots. */
const TRANSCRIPT_KEEP = 100
/** How often the screen asks for a fresh snapshot while it still needs one, in milliseconds. */
const SNAPSHOT_RETRY_MS = 2000
/** Give up on one snapshot request after this long, so unanswered requests do not pile up. */
const SNAPSHOT_TIMEOUT_MS = 5000

export interface ScreenState {
  /** False until the first snapshot has arrived. The screen shows "Connecting..." until then. */
  loaded: boolean
  connection: ConnectionStatus
  /** The library, newest first, exactly as the background sent it. */
  tutorials: TutorialModel[]
  teaching: TeachingState
  /** The lesson Claude just wrote, waiting for review. */
  draft: TutorialModel | null
  /** Id of the newest draft seen. Used only to notice the moment that draft shows up in the library. */
  lastDraftId: string
  /** The reason from a failed "tutorialGenerated". Stays until the next try, a discard or a success. */
  buildError: string
  /** The newest photo of the running recording. */
  lastPhoto: Channels["photoCapture"] | null
  /** Set when the background confirmed that the reviewed draft is now in the library. */
  published: {id: string; title: string} | null
  /** The lesson being learned. An ended lesson stays here (with `active: false`) for the "finished" note. */
  learning: LearningState | null
  verdict: StepVerdict | null
  transcript: TranscriptEntry[]
  assistant: AssistantState
  /** True when the last snapshot said "busy" and nothing newer has said the app is at rest. */
  snapshotBusy: boolean
}

/** What the screen shows before the background has said anything: nothing connected, nothing saved. */
export const EMPTY: ScreenState = {
  loaded: false,
  connection: {glassesConnected: false, hasCamera: false, hasMic: false, claudeReady: false, keyHint: ""},
  tutorials: [],
  teaching: {status: "idle", elapsedSeconds: 0, frameCount: 0, stepCount: 0, narration: ""},
  draft: null,
  lastDraftId: "",
  buildError: "",
  lastPhoto: null,
  published: null,
  learning: null,
  verdict: null,
  transcript: [],
  assistant: "idle",
  snapshotBusy: false,
}

/** One message from the background: the channel name and its payload. */
export type ScreenEvent =
  | {channel: "snapshot"; payload: Snapshot}
  | {channel: "teachingState"; payload: Channels["teachingState"]}
  | {channel: "photoCapture"; payload: Channels["photoCapture"]}
  | {channel: "tutorialGenerated"; payload: Channels["tutorialGenerated"]}
  | {channel: "tutorialList"; payload: Channels["tutorialList"]}
  | {channel: "learningState"; payload: Channels["learningState"]}
  | {channel: "stepVerdict"; payload: Channels["stepVerdict"]}
  | {channel: "transcriptionUpdate"; payload: Channels["transcriptionUpdate"]}
  | {channel: "assistantState"; payload: Channels["assistantState"]}
  | {channel: "connectionStatus"; payload: Channels["connectionStatus"]}

/** Old state plus one event from the background gives the new state. Nothing else writes the state. */
export function applyEvent(state: ScreenState, event: ScreenEvent): ScreenState {
  switch (event.channel) {
    // A snapshot replaces everything. It is the whole truth at one moment.
    case "snapshot": {
      const snap = event.payload
      const stillListed = state.published !== null && snap.tutorials.some((t) => t.id === state.published?.id)
      return {
        loaded: true,
        connection: snap.connection,
        tutorials: snap.tutorials,
        teaching: snap.teaching,
        draft: snap.draft,
        lastDraftId: snap.draft ? snap.draft.id : state.lastDraftId,
        buildError: snap.teaching.status === "recording" ? state.buildError : "",
        // A snapshot carries no photo, so the photo this page already shows stays while a recording is open.
        lastPhoto: snap.teaching.status === "idle" ? null : state.lastPhoto,
        published: stillListed && snap.teaching.status === "idle" ? state.published : null,
        // "No lesson" in a snapshot does not erase a lesson this page saw end: the "finished" note stays.
        learning: snap.learning ?? (state.learning && !state.learning.active ? state.learning : null),
        verdict: snap.lastVerdict,
        transcript: snap.transcript,
        assistant: snap.assistant,
        snapshotBusy: snap.busy,
      }
    }

    case "teachingState": {
      const teaching = event.payload
      const newRecording = teaching.status === "recording" && state.teaching.status === "idle"
      return {
        ...state,
        teaching,
        // A draft exists only while Claude writes it or while it waits for review.
        draft: teaching.status === "idle" || teaching.status === "recording" ? null : state.draft,
        // A build error belongs to a recording that is still open. A new try or a discard clears it.
        buildError: teaching.status === "recording" && !newRecording ? state.buildError : "",
        lastPhoto: teaching.status === "idle" || newRecording ? null : state.lastPhoto,
        published: teaching.status === "idle" ? state.published : null,
      }
    }

    case "photoCapture":
      return {...state, lastPhoto: event.payload}

    case "tutorialGenerated": {
      const {status, tutorial, error} = event.payload
      if (status === "success" && tutorial) {
        return {...state, draft: tutorial, lastDraftId: tutorial.id, buildError: ""}
      }
      if (status === "error") {
        return {...state, buildError: error || "The lesson could not be built."}
      }
      return state
    }

    case "tutorialList": {
      const tutorials = event.payload.tutorials
      // The reviewed draft was not in the library before and is in it now: it was published.
      const wasListed = state.tutorials.some((t) => t.id === state.lastDraftId)
      const added = wasListed ? undefined : tutorials.find((t) => t.id === state.lastDraftId)
      const kept = state.published && tutorials.some((t) => t.id === state.published?.id) ? state.published : null
      return {
        ...state,
        tutorials,
        published: added ? {id: added.id, title: added.title} : kept,
        lastDraftId: added ? "" : state.lastDraftId,
      }
    }

    case "learningState": {
      const learning = event.payload
      // A new lesson starts with no verdict. The background sends no "verdict cleared" event, so do it here.
      const newLesson = learning.sessionId !== state.learning?.sessionId
      return {
        ...state,
        learning,
        verdict: newLesson ? null : state.verdict,
        assistant: learning.assistantState,
        published: learning.active ? null : state.published,
      }
    }

    case "stepVerdict":
      return {...state, verdict: event.payload}

    case "transcriptionUpdate": {
      const entry = event.payload
      // Same id: the line replaces the old one (an unfinished sentence becomes its finished version).
      const at = state.transcript.findIndex((line) => line.id === entry.id)
      const transcript =
        at >= 0
          ? state.transcript.map((line, index) => (index === at ? entry : line))
          : [...state.transcript, entry].slice(-TRANSCRIPT_KEEP)
      return {...state, transcript}
    }

    case "assistantState": {
      const assistant = event.payload.state
      const atRest = assistant === "idle" || assistant === "listening"
      return {...state, assistant, snapshotBusy: atRest ? false : state.snapshotBusy}
    }

    case "connectionStatus":
      return {...state, connection: event.payload}
  }
}

/**
 * True while the background is in the middle of something (a photo, a Claude
 * request, speech). There is no "busy" event, so this is worked out from what
 * the background did say. Buttons that start a command are disabled while it
 * is true. "End session" and "Discard" never are.
 */
export function isBusy(state: ScreenState): boolean {
  return (
    state.assistant === "thinking" ||
    state.assistant === "speaking" ||
    state.teaching.status === "processing" ||
    state.snapshotBusy
  )
}

/** Listens to the background for as long as the screen is open and returns the latest state. */
export function useTinker(): ScreenState {
  const [state, dispatch] = useReducer(applyEvent, EMPTY)
  // True once the link to the background is ready for requests.
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const stops = [
      mentra.on("snapshot", (payload) => dispatch({channel: "snapshot", payload})),
      mentra.on("teachingState", (payload) => dispatch({channel: "teachingState", payload})),
      mentra.on("photoCapture", (payload) => dispatch({channel: "photoCapture", payload})),
      mentra.on("tutorialGenerated", (payload) => dispatch({channel: "tutorialGenerated", payload})),
      mentra.on("tutorialList", (payload) => dispatch({channel: "tutorialList", payload})),
      mentra.on("learningState", (payload) => dispatch({channel: "learningState", payload})),
      mentra.on("stepVerdict", (payload) => dispatch({channel: "stepVerdict", payload})),
      mentra.on("transcriptionUpdate", (payload) => dispatch({channel: "transcriptionUpdate", payload})),
      mentra.on("assistantState", (payload) => dispatch({channel: "assistantState", payload})),
      mentra.on("connectionStatus", (payload) => dispatch({channel: "connectionStatus", payload})),
      // onOpen fires once the link to the background is ready. The background also pushes a
      // snapshot at that moment. Asking here covers a push that was sent before this page listened.
      mentra.onOpen(() => {
        setOpen(true)
        requestSnapshot(dispatch)
      }),
    ]
    return () => stops.forEach((stop) => stop())
  }, [])

  // Ask again every two seconds in two cases:
  //   - no snapshot has arrived yet, so the screen would say "Connecting..." for ever
  //   - the last snapshot said "busy". Only a snapshot carries that flag. If the command
  //     that was running ends without an "assistantState" event after it, a fresh
  //     snapshot is the only thing that can unlock the buttons again.
  const needsSnapshot = !state.loaded || state.snapshotBusy
  useEffect(() => {
    if (!open || !needsSnapshot) return
    const timer = setInterval(() => requestSnapshot(dispatch), SNAPSHOT_RETRY_MS)
    return () => clearInterval(timer)
  }, [open, needsSnapshot])

  return state
}

/** Ask the background for everything. A failed request is ignored: the pushed snapshot or the next try covers it. */
function requestSnapshot(dispatch: (event: ScreenEvent) => void): void {
  mentra.request("getSnapshot", {}, {timeout: SNAPSHOT_TIMEOUT_MS}).then(
    (payload) => dispatch({channel: "snapshot", payload}),
    () => {},
  )
}
