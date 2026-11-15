/**
 * App.tsx: the Tinker screen on the phone.
 *
 * THE SCREEN KEEPS NO STATE OF ITS OWN
 *   The glasses, the lesson, the step number, the recording and the
 *   conversation all live in the background (src/background). The screen
 *   cannot reach the glasses, and it is thrown away every time it is closed
 *   while a lesson may still be running. So it is built like a window:
 *
 *     - it draws what the background last said (state.ts)
 *     - a button sends a command with `mentra.send`, and changes nothing here
 *     - the screen changes when the background answers with an event
 *
 *   Close the screen in the middle of a lesson, open it again, and it shows
 *   the same lesson at the same step, because it asks for a snapshot on open.
 *   Nothing on this screen pretends that something happened.
 *
 *   What the screen does keep: the text typed into a box, which tab and view
 *   are showing, and a note that an End or Discard tap is waiting for the
 *   glasses to finish a sentence. Tab and view are stored in the browser
 *   history, so the phone's back gesture steps through them before it
 *   minimises the app. The text typed on the Teaching tab is kept here, above
 *   the tabs, so switching tabs does not lose it.
 *
 * FILES
 *   state.ts      turns background events into the data drawn here
 *   Learning.tsx  the lesson library and the lesson in progress
 *   Teaching.tsx  record, wait, review, publish
 *   Settings.tsx  the Claude key box, the sound test, the spoken commands
 *   Parts.tsx     small shared pieces
 *
 * `mentra` is a global object that the Mentra App adds to this page. Its
 * types come from src/shared/channels.ts.
 */

import {useEffect, useRef, useState} from "react"
import type {JSX} from "react"
import {MiniappHeader, useHistoryState, useSafeArea} from "@mentra/miniapp/ui"
import {GraduationCapIcon, VideoIcon} from "./Icons"
import {Library, Session} from "./Learning"
import {Teaching} from "./Teaching"
import type {ReviewEdits, TeachingForms} from "./Teaching"
import {isBusy, useTinker} from "./state"

type Tab = "learning" | "teaching"
type View = "library" | "session"

/** The whole screen: header, status pills, the two tabs, and the body of the tab that is showing. */
export function App(): JSX.Element {
  // The page runs edge to edge, under the status bar and the home indicator.
  // The root is padded by these insets so nothing sits under them.
  const {insets} = useSafeArea()
  const {state, unreachable} = useTinker()
  const busy = isBusy(state)

  // useHistoryState instead of useState: every change is a history entry,
  // so the back gesture returns to the previous tab or view.
  const [tab, setTab] = useHistoryState<Tab>("tab", "learning")
  const [view, setView] = useHistoryState<View>("view", "library")

  const {learning, teaching, connection, published} = state
  const lessonActive = learning?.active === true

  // The lesson itself lives in the background. The history value only says
  // which view the person is looking at. So the session view needs both:
  // going back shows the library while the lesson keeps running, and a lesson
  // that has ended always shows the library, whatever the history says.
  const showSession = lessonActive && view === "session"

  // Follow the background ONCE, at the moment a lesson starts or ends. After
  // that the person is free to go back or switch tabs.
  const lessonKey = lessonActive ? learning.sessionId || "lesson" : ""
  const lastLessonKey = useRef("")
  useEffect(() => {
    if (lessonKey && lessonKey !== lastLessonKey.current) {
      // A lesson started (by tap, by voice, by the glasses button), or the
      // screen was reopened in the middle of one.
      setTab("learning")
      setView("session")
    } else if (!lessonKey && lastLessonKey.current) {
      // The lesson ended. On the Learning tab, setting the old value goes back
      // one history entry instead of adding one, so the next back gesture does
      // not reopen it. On the Teaching tab the tab change sits on top of that
      // entry, so the same call would ADD an entry every time a lesson ends
      // there. The view is left alone then: an ended lesson shows the library anyway.
      if (tab === "learning") setView("library")
    }
    lastLessonKey.current = lessonKey
  }, [lessonKey, tab, setTab, setView])

  // Same idea for teaching: when a recording opens (also by voice, or after
  // the screen was reopened during one), show the Teaching tab.
  const recordingOpen = teaching.status !== "idle"
  const wasRecordingOpen = useRef(false)
  useEffect(() => {
    if (recordingOpen && !wasRecordingOpen.current) setTab("teaching")
    wasRecordingOpen.current = recordingOpen
  }, [recordingOpen, setTab])

  // When the background confirms that a draft was published, show it in the library.
  const publishedId = published?.id ?? ""
  useEffect(() => {
    if (publishedId) setTab("learning")
  }, [publishedId, setTab])

  // A new body starts at its top. React swaps what is inside the page, and the
  // page keeps its scroll offset, so without this a lesson started from the
  // bottom of the library would open with its step above the screen, and the
  // "Lesson finished" note would be out of sight. main.tsx stops the browser
  // from putting an old offset back on a back step.
  const body = !state.loaded ? "connecting" : tab === "teaching" ? `teaching-${teaching.status}` : showSession ? "session" : "library"
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [body])

  // What has been typed on the Teaching tab. Kept here so a tab switch does not lose it.
  const [skill, setSkill] = useState("")
  const [edits, setEdits] = useState<ReviewEdits | null>(null)
  const forms: TeachingForms = {skill, setSkill, edits, setEdits}
  // The hint went out with the start of the recording. The next recording starts with an empty box.
  useEffect(() => {
    if (teaching.status !== "idle") setSkill("")
  }, [teaching.status])

  // End and Discard always reach the background, but while the glasses talk it
  // acts once the sentence is over. Until it confirms, the screen says so,
  // instead of looking as if the tap was ignored.
  const [ending, setEnding] = useState<"" | "lesson" | "teaching">("")
  useEffect(() => {
    if (!ending) return
    const confirmed = ending === "lesson" ? !lessonActive : teaching.status === "idle"
    // At rest again without a confirmation: the background had nothing to end.
    if (confirmed || !busy) setEnding("")
  }, [ending, lessonActive, teaching.status, busy])
  const endLesson = () => {
    mentra.send("endLearning", {})
    if (busy) setEnding("lesson")
  }
  const discardTeaching = () => {
    mentra.send("discardTeaching", {})
    if (busy) setEnding("teaching")
  }

  return (
    <div
      className="tinker-root"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      {/* The brand row stays at the top while the page scrolls. It covers the strip behind
          the status bar and the capsule menu, so no button can ever scroll under the capsule,
          where a tap would go to the Mentra App instead. The negative margin undoes the root's
          top padding for this one element, and its own padding puts the same space back inside. */}
      <div className="tinker-top" style={{marginTop: -insets.top, paddingTop: insets.top}}>
        <div className="tinker-top-inner">
          {/* MiniappHeader lines the brand up with the Mentra App's capsule menu (top right)
              and keeps it out from under it. The back arrow shows only inside a lesson. */}
          <MiniappHeader
            title={<h1 className="brand-title">TINKER</h1>}
            onBack={showSession ? () => history.back() : undefined}
            leftPadding={0}
            bottomSpacer={false}
          />
        </div>
      </div>

      <div className="tinker-container">
        {/* Hidden inside a lesson: the room goes to the step, so "Check my step" stays on the first screen. */}
        <div className="tinker-header" hidden={showSession}>
          <p className="brand-tagline">Learn by doing. Teach by showing.</p>

          {/* The pills have their own row: both do not fit beside the capsule menu on a phone. */}
          <div className="status-pills">
            {state.loaded ? (
              <>
                <div className={`status-pill ${connection.glassesConnected ? "connected" : ""}`}>
                  <span className="status-dot"></span>
                  <span>{connection.glassesConnected ? "Glasses connected" : "Glasses not connected"}</span>
                </div>
                <div className={`status-pill ${connection.claudeReady ? "connected" : ""}`}>
                  <span className="status-dot"></span>
                  <span>{connection.claudeReady ? "Claude key ready" : "Claude key missing"}</span>
                </div>
              </>
            ) : (
              // Before the first snapshot nothing is known, so nothing is claimed.
              <div className="status-pill">
                <span className="status-dot"></span>
                <span>Connecting...</span>
              </div>
            )}
          </div>
          {state.loaded && connection.message && <p className="connection-message">{connection.message}</p>}
        </div>

        <nav className="tab-navigation">
          <button
            type="button"
            className={`tab-btn ${tab === "learning" ? "active" : ""}`}
            aria-pressed={tab === "learning"}
            onClick={() => setTab("learning")}>
            <GraduationCapIcon size={18} />
            <span>Learning</span>
          </button>
          <button
            type="button"
            className={`tab-btn ${tab === "teaching" ? "active" : ""}`}
            aria-pressed={tab === "teaching"}
            onClick={() => setTab("teaching")}>
            <VideoIcon size={18} />
            <span>Teaching</span>
          </button>
        </nav>

        <main>
          {/* The buttons are locked while busy, and only a snapshot can unlock them if an event was lost. */}
          {state.loaded && busy && unreachable && (
            <p className="note-line">Tinker is not answering. Close Tinker and open it again.</p>
          )}
          {!state.loaded ? (
            <div className="card connecting-card">
              <h2>Connecting...</h2>
              <p>Waiting for Tinker to answer.</p>
              {unreachable && <p className="connecting-advice">Close Tinker and open it again.</p>}
            </div>
          ) : tab === "teaching" ? (
            <Teaching state={state} busy={busy} forms={forms} ending={ending === "teaching"} onDiscard={discardTeaching} />
          ) : showSession && learning ? (
            <Session state={state} learning={learning} busy={busy} ending={ending === "lesson"} onEnd={endLesson} />
          ) : (
            <Library
              state={state}
              busy={busy}
              onResume={() => setView("session")}
              ending={ending === "lesson"}
              onEnd={endLesson}
            />
          )}
        </main>
      </div>
    </div>
  )
}
