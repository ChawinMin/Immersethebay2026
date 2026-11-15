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
 *   What the screen does keep: the text typed into a box, and which tab and
 *   view are showing. Tab and view are stored in the browser history, so the
 *   phone's back gesture steps through them before it minimises the app.
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

import {useEffect, useRef} from "react"
import type {JSX} from "react"
import {MiniappHeader, useHistoryState, useSafeArea} from "@mentra/miniapp/ui"
import {GraduationCapIcon, VideoIcon} from "./Icons"
import {Library, Session} from "./Learning"
import {Teaching} from "./Teaching"
import {isBusy, useTinker} from "./state"

type Tab = "learning" | "teaching"
type View = "library" | "session"

/** The whole screen: header, status pills, the two tabs, and the body of the tab that is showing. */
export function App(): JSX.Element {
  // The page runs edge to edge, under the status bar and the home indicator.
  // The root is padded by these insets so nothing sits under them.
  const {insets} = useSafeArea()
  const state = useTinker()
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
      // The lesson ended. Setting the old value goes back one history entry
      // instead of adding one, so the next back gesture does not reopen it.
      setView("library")
    }
    lastLessonKey.current = lessonKey
  }, [lessonKey, setTab, setView])

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
        <div className="tinker-header">
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
          {!state.loaded ? (
            <div className="card connecting-card">
              <h2>Connecting...</h2>
              <p>Waiting for Tinker to answer.</p>
            </div>
          ) : tab === "teaching" ? (
            <Teaching state={state} busy={busy} />
          ) : showSession && learning ? (
            <Session state={state} learning={learning} busy={busy} />
          ) : (
            <Library state={state} busy={busy} onResume={() => setView("session")} />
          )}
        </main>
      </div>
    </div>
  )
}
