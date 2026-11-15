/**
 * Teaching.tsx: the Teaching tab. Record a lesson, wait for Claude, review, publish.
 *
 * WHY THIS FILE EXISTS
 *   An expert shows a task once while wearing the glasses. This tab shows the
 *   expert what the glasses have captured so far and lets them review the
 *   lesson Claude wrote before it goes into the library.
 *
 * THE FOUR STATES
 *   idle        nothing is being recorded
 *   recording   the expert is demonstrating
 *   processing  Claude is writing the lesson
 *   review      a draft is waiting
 *
 *   The state is `teachingState.status` from the background. This file never
 *   sets it. Tapping "Finish lesson" sends a command, and the tab changes only
 *   when the background reports the new status. That is why a failed start or
 *   a failed lesson build can never leave the screen showing something untrue.
 *
 * WHAT IS TYPED HERE IS KEPT BY App.tsx
 *   The "What are you teaching?" box and the review boxes are held one level
 *   up (`TeachingForms`). Switching to the Learning tab removes this tab from
 *   the page, and the typed text would otherwise go with it.
 */

import {useEffect, useState} from "react"
import type {JSX, ReactNode} from "react"
import type {Channels, TutorialModel} from "../shared/channels"
import {AlertIcon, CameraIcon, CheckCircleIcon, SparklesIcon, SquareIcon, VideoIcon} from "./Icons"
import {ConfirmButton, ErrorLine, formatClock, stepCount} from "./Parts"
import {KeyCard} from "./Settings"
import type {ScreenState} from "./state"

/** How long the key card stays on this tab after a key was saved, so "Key saved." can be read. */
const KEY_SAVED_MS = 2500

/** The edited title and description of one draft. */
export interface ReviewEdits {
  draftId: string
  title: string
  description: string
}

/** What has been typed on this tab. App.tsx keeps it, so a tab switch does not lose it. */
export interface TeachingForms {
  /** The "What are you teaching?" box. */
  skill: string
  setSkill: (text: string) => void
  /** The review boxes. They count only for the draft with the same id. null until the first edit. */
  edits: ReviewEdits | null
  setEdits: (edits: ReviewEdits) => void
}

/** Picks the panel for the status the background reported. */
export function Teaching({state, busy, forms, ending, onDiscard}: {
  state: ScreenState
  busy: boolean
  forms: TeachingForms
  /** True after Discard was tapped while the glasses were talking, until the background confirms. */
  ending: boolean
  /** Sends `discardTeaching`. */
  onDiscard: () => void
}): JSX.Element {
  const {teaching, draft, buildError} = state

  // Two places can carry a failure: `teachingState.error` and a failed "tutorialGenerated".
  // Both are shown. When they say the same thing it is shown once.
  const messages = [teaching.error ?? "", buildError].filter((text, index, all) => text && all.indexOf(text) === index)
  const errors = messages.map((text) => <ErrorLine key={text}>{text}</ErrorLine>)
  // The background takes a discard at any time, but while the glasses talk it acts once the sentence is over.
  const waiting = ending ? <p className="note-line">Ending after this sentence...</p> : null

  if (teaching.status === "recording") {
    return <Recording state={state} busy={busy} errors={errors} waiting={waiting} onDiscard={onDiscard} />
  }
  if (teaching.status === "processing") return <Processing errors={errors} />
  if (teaching.status === "review") {
    return draft ? (
      <Review key={draft.id} draft={draft} busy={busy} errors={errors} forms={forms} waiting={waiting} onDiscard={onDiscard} />
    ) : (
      <ReviewWithoutDraft errors={errors} waiting={waiting} onDiscard={onDiscard} />
    )
  }
  return <TeachIdle state={state} busy={busy} errors={errors} forms={forms} />
}

/** One chip of the hardware checklist. The words change with the flag, not only the colour. */
function CheckItem({ok, yes, no}: {ok: boolean; yes: string; no: string}): JSX.Element {
  return (
    <div className={`checklist-item ${ok ? "ready" : ""}`}>
      {ok ? <CheckCircleIcon size={16} /> : <AlertIcon size={16} />}
      <span>{ok ? yes : no}</span>
    </div>
  )
}

/** Nothing is being recorded: the introduction, the checklist and the Start button. */
function TeachIdle({state, busy, errors, forms}: {state: ScreenState; busy: boolean; errors: ReactNode; forms: TeachingForms}): JSX.Element {
  const {connection, learning} = state
  const lessonActive = learning?.active === true

  // The background reports the new key (claudeReady) just BEFORE it answers the save,
  // so the key card would vanish before "Key saved." could appear in it. The card
  // therefore stays up while a save runs, and for a moment after one works.
  const [keyCard, setKeyCard] = useState<"" | "saving" | "saved">("")
  useEffect(() => {
    if (keyCard !== "saved") return
    const timer = setTimeout(() => setKeyCard(""), KEY_SAVED_MS)
    return () => clearTimeout(timer)
  }, [keyCard])

  const start = () => {
    // The text is sent to Claude as a hint, never invented.
    const targetSkill = forms.skill.trim()
    mentra.send("startTeaching", targetSkill ? {targetSkill} : {})
  }

  return (
    <div>
      {/* A recording cannot start without a key, so the key box comes first while none is saved. */}
      {(!connection.claudeReady || keyCard !== "") && (
        <KeyCard
          connection={connection}
          onStart={() => setKeyCard("saving")}
          onDone={(saved) => setKeyCard(saved ? "saved" : "")}
        />
      )}

      <div className="card teaching-hero">
        <h2>Teach a Skill</h2>
        <p className="hero-text">
          Put on your Mentra Live glasses and show a hands-on skill once. Tinker photographs each step you save,
          listens to what you say, and Claude writes the lesson.
        </p>

        <div className="hardware-checklist">
          <CheckItem ok={connection.hasCamera} yes="Camera ready" no="Camera not found" />
          <CheckItem ok={connection.hasMic} yes="Microphone ready" no="Microphone not found" />
          <CheckItem ok={connection.claudeReady} yes="Claude key ready" no="Claude key missing" />
        </div>

        <div className="form-group hero-field">
          <label className="form-label" htmlFor="teach-skill">
            What are you teaching? <span className="optional">(optional)</span>
          </label>
          <input
            id="teach-skill"
            type="text"
            className="form-input"
            value={forms.skill}
            maxLength={80}
            placeholder="For example: tying a bowline knot"
            onChange={(event) => forms.setSkill(event.target.value)}
          />
        </div>

        {errors}
        {lessonActive && <p className="note-line">A lesson is running. End it before you record.</p>}

        <button type="button" className="btn btn-primary btn-hero" disabled={busy || lessonActive} onClick={start}>
          <VideoIcon size={20} />
          <span>Start Recording</span>
        </button>
        <p className="field-hint">Or say "start teaching".</p>
      </div>
    </div>
  )
}

/**
 * The expert is demonstrating. Every number here is the background's own count.
 * The buttons come before the photo so that none of them falls below the edge
 * of a small phone, also when an error and a long sentence are showing.
 */
function Recording({state, busy, errors, waiting, onDiscard}: {
  state: ScreenState
  busy: boolean
  errors: ReactNode
  waiting: ReactNode
  onDiscard: () => void
}): JSX.Element {
  const {teaching, lastPhoto} = state
  return (
    <div className="card recording-panel">
      <div className="record-indicator">
        <span className="pulse-dot"></span>
        <span>Recording on the glasses</span>
      </div>

      <div className="timer-display">{formatClock(teaching.elapsedSeconds)}</div>
      <div className="frame-count-badge">
        Steps saved: <strong>{teaching.stepCount}</strong> · Photos: <strong>{teaching.frameCount}</strong>
      </div>

      {errors}

      <div className="heard-box">
        <div className="heard-label">Heard for this step</div>
        {/* Long narration is clipped at the top, so the newest words stay visible. */}
        <div className="heard-text">
          <span>{teaching.narration || "nothing yet"}</span>
        </div>
      </div>

      <div className="session-controls recording-controls">
        <button type="button" className="btn btn-primary btn-wide" disabled={busy} onClick={() => mentra.send("captureStep", {})}>
          <CameraIcon size={18} />
          <span>Save this step</span>
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => mentra.send("stopTeaching", {})}>
          <SquareIcon size={16} />
          <span>Finish lesson</span>
        </button>
        {/* Never disabled: the background remembers a discard even while it is busy. */}
        <ConfirmButton label="Discard" confirmLabel="Sure? Tap again" className="btn btn-secondary" onConfirm={onDiscard} />
      </div>
      {waiting}

      <Viewfinder photo={lastPhoto} taken={teaching.frameCount} />
      <p className="field-hint">Say "next step" after each step. Say "finish lesson" at the end.</p>
    </div>
  )
}

/**
 * The newest photo of this recording. A dead link or no photo shows plain words instead.
 * `taken` is the background's photo count. A screen opened in the middle of a
 * recording has a count but no photo yet: a snapshot carries no photo links.
 */
function Viewfinder({photo, taken}: {photo: Channels["photoCapture"] | null; taken: number}): JSX.Element {
  // Remember WHICH link failed, so the next photo gets a fresh try.
  const [failed, setFailed] = useState("")
  const src = photo?.photoUrl ?? ""
  const visible = photo !== null && src !== "" && failed !== src
  return (
    <div className="viewfinder-preview">
      {visible ? (
        <>
          <img src={src} alt="The last photo from the glasses" onError={() => setFailed(src)} />
          <span className="viewfinder-tag">{photo.kind === "step" ? "Saved step" : "Timed photo"}</span>
        </>
      ) : (
        <div className="viewfinder-placeholder">
          <CameraIcon size={32} />
          <span>{src ? "The last photo could not be shown" : taken > 0 ? "The next photo will show here" : "No photo yet"}</span>
        </div>
      )}
    </div>
  )
}

/** Claude is writing the lesson. There is no way to know how far along it is, so no percentage is shown. */
function Processing({errors}: {errors: ReactNode}): JSX.Element {
  return (
    <div className="card processing-card">
      <SparklesIcon size={48} className="processing-icon" />
      <h3>Building the lesson...</h3>
      <p>
        Claude is writing the steps from your photos and your words. The glasses say "Lesson ready" when it is done.
      </p>
      {/* A bar that slides for ever: "working", with no claim about how much is left. */}
      <div className="progress-bar-container processing-bar">
        <div className="progress-bar-indeterminate"></div>
      </div>
      {errors}
    </div>
  )
}

/**
 * The draft Claude wrote. The expert can change the title and the description,
 * then publish or discard. The text in the boxes is kept by App.tsx.
 */
function Review({draft, busy, errors, forms, waiting, onDiscard}: {
  draft: TutorialModel
  busy: boolean
  errors: ReactNode
  forms: TeachingForms
  waiting: ReactNode
  onDiscard: () => void
}): JSX.Element {
  // The boxes start with Claude's text. Edits made for an earlier draft do not count.
  const edits: ReviewEdits =
    forms.edits && forms.edits.draftId === draft.id
      ? forms.edits
      : {draftId: draft.id, title: draft.title, description: draft.description}
  const {title, description} = edits

  const publish = () => {
    // The background keeps its own copy of the draft and takes only the title and
    // the description from this message. An emptied box falls back to Claude's text.
    const tutorial: TutorialModel = {
      ...draft,
      title: title.trim() || draft.title,
      description: description.trim() || draft.description,
    }
    mentra.send("publishTutorial", {tutorial})
  }

  return (
    <div className="card review-form">
      <div className="review-heading">
        <h3>Review & Publish</h3>
        <span className="tutorial-tag">{stepCount(draft.steps.length)}</span>
      </div>

      {errors}

      <div className="form-group">
        <label className="form-label" htmlFor="tut-title">
          Tutorial Title
        </label>
        <input
          id="tut-title"
          type="text"
          className="form-input"
          value={title}
          onChange={(event) => forms.setEdits({...edits, title: event.target.value})}
        />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="tut-desc">
          Description
        </label>
        <textarea
          id="tut-desc"
          className="form-textarea"
          rows={3}
          value={description}
          onChange={(event) => forms.setEdits({...edits, description: event.target.value})}
        />
      </div>

      <div>
        <h4 className="review-steps-title">Generated Steps</h4>
        <div className="review-steps">
          {draft.steps.map((step) => (
            <div key={step.id} className="review-step">
              <div className="review-step-head">
                <span>
                  Step {step.step_number}: {step.title}
                </span>
                {/* The time is shown only when the lesson has one. Nothing is made up. */}
                {typeof step.source_timestamp_seconds === "number" && (
                  <span className="review-step-time">at {formatClock(step.source_timestamp_seconds)}</span>
                )}
              </div>
              <p>{step.instruction_spoken}</p>
              {step.done_looks_like && (
                <p className="review-step-done">
                  <strong>Finished looks like:</strong> {step.done_looks_like}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {waiting}
      <div className="review-actions">
        <ConfirmButton label="Discard" confirmLabel="Sure? Tap again" className="btn btn-secondary" onConfirm={onDiscard} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={publish}>
          <CheckCircleIcon size={18} />
          <span>Publish to Library</span>
        </button>
      </div>
    </div>
  )
}

/** The background says a draft is waiting but has not sent it. Say so, and offer the way out. */
function ReviewWithoutDraft({errors, waiting, onDiscard}: {errors: ReactNode; waiting: ReactNode; onDiscard: () => void}): JSX.Element {
  return (
    <div className="card review-form">
      <div className="review-heading">
        <h3>Review & Publish</h3>
      </div>
      {errors}
      <p className="note-line">A draft is waiting, but it has not reached this screen. Close the screen and open it again.</p>
      {waiting}
      <div className="review-actions">
        <ConfirmButton label="Discard" confirmLabel="Sure? Tap again" className="btn btn-secondary" onConfirm={onDiscard} />
      </div>
    </div>
  )
}
