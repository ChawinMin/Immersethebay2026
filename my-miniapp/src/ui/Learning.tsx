/**
 * Learning.tsx: the Learning tab. The lesson library, and the view of a lesson in progress.
 *
 * WHY THIS FILE EXISTS
 *   A learner picks a lesson here, then follows it on the glasses. The phone
 *   shows the current step, the result of the last photo check, and the
 *   conversation, for the moments when the learner looks down.
 *
 * WHAT IT MUST NOT DO
 *   It never works out the step by itself. The step, the verdict and every
 *   conversation line come from the background (see state.ts). A button here
 *   only sends a command. The screen changes when the background answers.
 */

import {useEffect, useRef, useState} from "react"
import type {FormEvent, JSX} from "react"
import type {AssistantState, LearningState, StepVerdict, TranscriptEntry, TutorialModel, TutorialStepModel} from "../shared/channels"
import {ArrowLeftIcon, ArrowRightIcon, CameraIcon, PlayIcon, RotateCcwIcon, SendIcon, TrashIcon, Volume2Icon} from "./Icons"
import {ConfirmButton, Photo, usePhotoLink} from "./Parts"
import {SettingsCard} from "./Settings"
import type {ScreenState} from "./state"

// ---------------------------------------------------------------- library

/**
 * The list of lessons, with the settings card under it.
 * `onResume` opens the session view again after the person went back from it.
 */
export function Library({state, busy, onResume}: {state: ScreenState; busy: boolean; onResume: () => void}): JSX.Element {
  const {tutorials, learning, teaching, connection, published} = state
  const lessonActive = learning?.active === true
  const titleOf = (id: string) => tutorials.find((t) => t.id === id)?.title ?? ""
  // The background refuses to start a lesson while another one, or a recording, is open.
  const canStart = !busy && !lessonActive && teaching.status === "idle"

  return (
    <div>
      <div className="catalog-header">
        <h2 className="catalog-title">Skill Tutorials</h2>
        <span className="catalog-count">{tutorials.length} Available</span>
      </div>

      {learning && lessonActive && <InProgressCard learning={learning} title={titleOf(learning.tutorialId)} onResume={onResume} />}

      {learning && !learning.active && learning.finished && (
        <p className="note-line">Lesson finished{titleOf(learning.tutorialId) ? `: ${titleOf(learning.tutorialId)}` : "."}</p>
      )}
      {published && <p className="note-line">Lesson published: {published.title}</p>}
      {teaching.status !== "idle" && (
        <p className="note-line">A recording is open on the Teaching tab. Finish or discard it before you start a lesson.</p>
      )}
      {!connection.claudeReady && (
        <p className="note-line">Photo checks and recording need the Claude key. Add it under Settings below.</p>
      )}

      <div className="tutorial-grid">
        {tutorials.map((tutorial) => (
          <LessonCard
            key={tutorial.id}
            tutorial={tutorial}
            canStart={canStart}
            // The lesson being learned right now cannot be deleted. The background refuses it too.
            canDelete={!busy && !(lessonActive && learning?.tutorialId === tutorial.id)}
          />
        ))}
      </div>
      {tutorials.length === 0 && <p className="note-line">No lessons yet. Record one on the Teaching tab.</p>}

      <SettingsCard connection={connection} busy={busy} />
    </div>
  )
}

/** One lesson in the library. Recorded lessons can be deleted. The built-in one cannot. */
function LessonCard({tutorial, canStart, canDelete}: {tutorial: TutorialModel; canStart: boolean; canDelete: boolean}): JSX.Element {
  return (
    <div className="tutorial-card">
      <div>
        <div className="tag-row">
          <span className="tutorial-tag">{tutorial.category || "Skill"}</span>
          {tutorial.built_in && <span className="tutorial-tag built-in">Built in</span>}
        </div>
        <h3 className="tutorial-title">{tutorial.title}</h3>
        <p className="tutorial-desc">{tutorial.description}</p>
      </div>
      <div>
        <div className="tutorial-meta">
          <span>
            <strong>{tutorial.steps.length}</strong> Steps
          </span>
          {/* No made-up duration: the line is left out when the lesson has none. */}
          {tutorial.estimated_duration_minutes > 0 && (
            <span>
              Est. <strong>{tutorial.estimated_duration_minutes}</strong> min
            </span>
          )}
        </div>
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary card-start"
            disabled={!canStart}
            onClick={() => mentra.send("startLearning", {tutorialId: tutorial.id})}>
            <PlayIcon size={16} />
            <span>Start Learning</span>
          </button>
          {!tutorial.built_in && (
            <ConfirmButton
              label="Delete"
              confirmLabel="Sure?"
              className="btn btn-secondary btn-small"
              disabled={!canDelete}
              icon={<TrashIcon size={14} />}
              onConfirm={() => mentra.send("deleteTutorial", {tutorialId: tutorial.id})}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Shown in the library while a lesson is still running on the glasses.
 * This happens when the person swiped back out of the session view: the back
 * gesture changes what the phone shows, it does not stop the lesson.
 */
function InProgressCard({learning, title, onResume}: {learning: LearningState; title: string; onResume: () => void}): JSX.Element {
  return (
    <div className="card in-progress-card">
      <span className="tutorial-tag">Lesson in progress</span>
      <h3 className="tutorial-title">{title || "Lesson"}</h3>
      <p className="tutorial-desc">
        Step {learning.currentStep} of {learning.totalSteps}. The glasses are still coaching.
      </p>
      <div className="button-row">
        <button type="button" className="btn btn-primary" onClick={onResume}>
          <PlayIcon size={16} />
          <span>Resume</span>
        </button>
        {/* Ending a lesson is always allowed, also while the app is busy. */}
        <button type="button" className="btn btn-secondary" onClick={() => mentra.send("endLearning", {})}>
          End
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- session

/** A lesson in progress: the current step, the photo check, the voice status and the conversation. */
export function Session({state, learning, busy}: {state: ScreenState; learning: LearningState; busy: boolean}): JSX.Element {
  const tutorial = state.tutorials.find((t) => t.id === learning.tutorialId)
  const total = learning.totalSteps
  // The bar shows the position in the lesson. A lesson with no steps gives an empty bar, not a division by zero.
  const position = total > 0 ? Math.min(100, (learning.currentStep / total) * 100) : 0
  const stepsLeft = Math.max(0, total - learning.currentStep)
  // A verdict belongs to one step. An old verdict must not sit under a new step.
  const verdict = state.verdict && state.verdict.step === learning.currentStep ? state.verdict : null
  const keyReady = state.connection.claudeReady

  return (
    <div className="session-layout">
      <div className="session-header">
        <h2 className="session-title">{tutorial?.title ?? "Lesson"}</h2>
        {/* Never disabled: the background remembers "end" even while it is busy. */}
        <button type="button" className="btn btn-secondary" onClick={() => mentra.send("endLearning", {})}>
          End Session
        </button>
      </div>

      <div>
        <div className="progress-labels">
          <span>
            Step {learning.currentStep} of {total}
          </span>
          <span>{stepsLeft === 0 ? "Last step" : `${stepsLeft} to go`}</span>
        </div>
        <div className="progress-bar-container">
          <div className="progress-bar-fill" style={{width: `${position}%`}}></div>
        </div>
      </div>

      {learning.stepData ? (
        <StepCard step={learning.stepData} />
      ) : (
        <div className="step-card">
          <p className="step-detailed">The glasses did not send this step.</p>
        </div>
      )}

      {/* The step's own buttons sit right under the step text, not at the bottom of the page. */}
      <div className="step-actions">
        <button
          type="button"
          className="btn btn-primary btn-wide"
          disabled={busy || !keyReady}
          onClick={() => mentra.send("checkStep", {})}>
          <CameraIcon size={18} />
          <span>Check my step</span>
        </button>
        {keyReady ? (
          <p className="field-hint check-hint">Or say "check" when the step is done.</p>
        ) : (
          <p className="note-line">Photo checks need the Claude key. Add it under Settings in the lesson library.</p>
        )}
        <div className="session-controls">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || learning.currentStep <= 1}
            onClick={() => mentra.send("navigateStep", {direction: "previous"})}>
            <ArrowLeftIcon size={18} />
            <span>Previous</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => mentra.send("navigateStep", {direction: "repeat"})}>
            <RotateCcwIcon size={18} />
            <span>Repeat</span>
          </button>
          {/* On the last step "next" ends the lesson as finished, so the label says so. */}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => mentra.send("navigateStep", {direction: "next"})}>
            <span>{stepsLeft === 0 ? "Finish" : "Next"}</span>
            <ArrowRightIcon size={18} />
          </button>
        </div>
      </div>

      {/* The result of a check appears right under the button that asked for it. */}
      <CheckCard referenceUrl={learning.stepData?.reference_image_url} verdict={verdict} />

      <AssistantCard assistant={state.assistant} />
      <TranscriptCard transcript={state.transcript} busy={busy} />
    </div>
  )
}

/** The current step, word for word as the background sent it. */
function StepCard({step}: {step: TutorialStepModel}): JSX.Element {
  return (
    <div className="step-card">
      <span className="step-badge">
        Step {step.step_number}: {step.title}
      </span>
      <h3 className="step-instruction">{step.instruction_spoken}</h3>
      {step.instruction_detailed && <p className="step-detailed">{step.instruction_detailed}</p>}

      {(step.tips ?? []).map((tip) => (
        <div key={tip} className="step-tips">
          <strong>Tip:</strong> {tip}
        </div>
      ))}
    </div>
  )
}

const VERDICT_LABEL: Record<StepVerdict["result"], string> = {
  pass: "Passed",
  fix: "Needs a fix",
  unclear: "Could not see it",
}

/**
 * The photo check of this step: a coloured chip, the sentence the glasses
 * said, and the two photos side by side (the expert's and the learner's).
 * A photo shows only once its link has loaded. With no verdict and no photo
 * that loads, the card shows nothing at all.
 */
function CheckCard({referenceUrl, verdict}: {referenceUrl?: string; verdict: StepVerdict | null}): JSX.Element | null {
  const expert = usePhotoLink(referenceUrl)
  const learner = usePhotoLink(verdict?.photoUrl)
  const expertGone = !expert.src || expert.status === "failed"
  const learnerGone = !learner.src || learner.status === "failed"
  if (!verdict && expertGone) return null

  return (
    // Hidden while the only thing in it is a photo that has not loaded yet.
    <div className="step-card check-card" hidden={!verdict && expert.status !== "ok"}>
      {verdict && (
        <div className="verdict">
          <span className={`tinker-pill verdict-chip ${verdict.result}`}>{VERDICT_LABEL[verdict.result]}</span>
          <p className={verdict.result === "fix" ? "error-line" : "step-tips"}>{verdict.say}</p>
        </div>
      )}
      {!(expertGone && learnerGone) && (
        <div className="photo-row">
          <Photo link={expert} alt="The expert's photo of this step" caption="The expert's photo" className="step-image-preview" />
          <Photo link={learner} alt="Your photo that was checked" caption="Your photo" className="step-image-preview" />
        </div>
      )}
    </div>
  )
}

const ASSISTANT_LABEL: Record<AssistantState, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
}

/** What the voice on the glasses is doing right now. The bars move only while it speaks. */
function AssistantCard({assistant}: {assistant: AssistantState}): JSX.Element {
  return (
    <div className="tinker-status-card">
      <div className="assistant-who">
        <Volume2Icon size={20} className="assistant-icon" />
        <div>
          <div className="assistant-name">Tinker Voice Instructor</div>
          <div className="assistant-hint">Say "Tinker," and then your question</div>
        </div>
      </div>
      <div className="assistant-state">
        <div className={`tinker-pill ${assistant}`}>
          <span className="status-dot"></span>
          <span>{ASSISTANT_LABEL[assistant]}</span>
        </div>
        <div className={`waveform ${assistant === "speaking" ? "speaking" : ""}`}>
          <div className="wave-bar"></div>
          <div className="wave-bar"></div>
          <div className="wave-bar"></div>
          <div className="wave-bar"></div>
        </div>
      </div>
    </div>
  )
}

/**
 * The conversation, and a box to type a question in a loud room.
 * Every line comes from the background. A typed question is NOT added here:
 * the background adds it and sends it back like any other line.
 */
function TranscriptCard({transcript, busy}: {transcript: TranscriptEntry[]; busy: boolean}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  // The only state here: the text in the question box.
  const [question, setQuestion] = useState("")

  // Keep the newest line in view by scrolling the list box itself.
  // `scrollIntoView` would move the whole page away from the step.
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [transcript])

  const ask = (event: FormEvent) => {
    event.preventDefault()
    const text = question.trim()
    if (!text || busy) return
    mentra.send("askTinker", {text})
    setQuestion("")
  }

  return (
    <div className="transcript-card">
      <div className="transcript-header">Live Conversation Transcript</div>
      <div className="transcript-list" ref={listRef}>
        {transcript.length === 0 && <div className="transcript-item system">Nothing said yet.</div>}
        {transcript.map((line) => (
          // An unfinished sentence is drawn lighter until its finished version replaces it.
          <div key={line.id} className={`transcript-item ${line.speaker} ${line.isFinal ? "" : "unfinished"}`}>
            <div>{line.text}</div>
            <div className="transcript-meta">{lineLabel(line)}</div>
          </div>
        ))}
      </div>

      <form className="ask-form" onSubmit={ask}>
        <input
          type="text"
          className="form-input ask-input"
          placeholder="Type a question for Tinker"
          aria-label="A question for Tinker"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn-secondary ask-send"
          aria-label="Send the question"
          disabled={busy || question.trim() === ""}>
          <SendIcon size={16} />
        </button>
      </form>
    </div>
  )
}

/** The small label under a line. The step is added only when the label does not already name it. */
function lineLabel(line: TranscriptEntry): string {
  if (!line.step || line.timestamp.includes(`Step ${line.step}`)) return line.timestamp
  return line.timestamp ? `${line.timestamp} • Step ${line.step}` : `Step ${line.step}`
}
