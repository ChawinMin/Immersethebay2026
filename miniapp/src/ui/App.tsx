/**
 * App.tsx: the Tinker screen on the phone.
 *
 * The screen cannot reach the glasses. It does two things only:
 *   - shows the latest `AppState` that the background sends on the "state" channel
 *   - sends a button tap to the background with mentra.request("action", {name})
 *
 * It keeps no app state of its own, apart from the text typed into the key box.
 * Close the screen and open it again, and it shows the same thing, because the
 * background is the one place where the state lives.
 *
 * `mentra` is a global object that the Mentra App adds to this page. Its types
 * come from src/shared/channels.ts.
 *
 * A different frontend can replace this file. See docs/MERGING_A_FRONTEND.md.
 */

import {useEffect, useState} from "react"
import {MiniappHeader, useSafeArea} from "@mentra/miniapp/ui"
import type {ActionName, AppState} from "../shared/channels"

// Shown for the first instant, before the background has sent the real state.
const EMPTY: AppState = {
  mode: "idle",
  busy: false,
  hasKey: false,
  keyHint: "",
  lessonTitle: "",
  materials: [],
  steps: [],
  stepNumber: 0,
  narration: "",
  lastHeard: "",
  lastSaid: "",
  error: "",
}

/** The whole screen: status, the buttons for the current mode, the lesson, and the key box. */
export function App() {
  const {insets} = useSafeArea()
  const [state, setState] = useState<AppState>(EMPTY)

  useEffect(() => {
    // The background pushes a new state after every change.
    // onOpen fires once the link to the background is ready. Asking for the state
    // there covers the case where the first push was sent before this screen listened.
    const stopListening = mentra.on("state", setState)
    const stopOpen = mentra.onOpen(() => {
      mentra.request("get-state", {}).then(setState, () => {})
    })
    return () => {
      stopListening()
      stopOpen()
    }
  }, [])

  const act = (name: ActionName) => {
    mentra.request("action", {name}).catch(() => {})
  }

  return (
    <div
      className="app"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <MiniappHeader title="Tinker" />
      <main className="content">
        <Status state={state} />
        <Controls state={state} act={act} />
        {state.steps.length > 0 && <Lesson state={state} act={act} />}
        <KeyBox state={state} />
      </main>
    </div>
  )
}

/** What is happening now: the mode, what the glasses said, what was heard, and the last error. */
function Status({state}: {state: AppState}) {
  const total = state.steps.length
  const title: Record<AppState["mode"], string> = {
    idle: state.lessonTitle ? `Ready. Lesson saved: ${state.lessonTitle}` : "Ready. No lesson yet.",
    teaching: `Recording step ${state.stepNumber}`,
    building: "Building the lesson",
    coaching: `Coaching step ${state.stepNumber} of ${total}`,
  }
  return (
    <section className="card">
      <h2>{title[state.mode]}</h2>
      {state.mode === "teaching" && <p className="line">Heard for this step: {state.narration || "nothing yet"}</p>}
      {state.lastSaid && <p className="line">Glasses said: {state.lastSaid}</p>}
      {state.lastHeard && <p className="line">You said: {state.lastHeard}</p>}
      {state.busy && <p className="line">Working...</p>}
      {state.error && <p className="line error">{state.error}</p>}
    </section>
  )
}

/**
 * One button for every spoken command of the current mode. It makes the app
 * usable in a loud room and makes testing possible without speaking.
 */
function Controls({state, act}: {state: AppState; act: (name: ActionName) => void}) {
  const off = state.busy
  if (state.mode === "building") return null
  if (state.mode === "teaching") {
    return (
      <section className="card">
        <p className="hint">Say "next step" after each step. Say "finish lesson" at the end.</p>
        <button disabled={off} onClick={() => act("capture")}>Save this step</button>
        <button disabled={off} onClick={() => act("finish")}>Finish lesson</button>
        <button disabled={off} className="secondary" onClick={() => act("stop")}>Cancel</button>
      </section>
    )
  }
  if (state.mode === "coaching") {
    return (
      <section className="card">
        <p className="hint">Say "check" when a step is finished. You can also say "repeat" or "why".</p>
        <button disabled={off} onClick={() => act("check")}>Check my step</button>
        <button disabled={off} className="secondary" onClick={() => act("repeat")}>Repeat the step</button>
        <button disabled={off} className="secondary" onClick={() => act("story")}>Why this step</button>
        <button disabled={off} className="secondary" onClick={() => act("skip")}>Skip</button>
        <button disabled={off} className="secondary" onClick={() => act("stop")}>Stop lesson</button>
      </section>
    )
  }
  return (
    <section className="card">
      <p className="hint">Say "start teaching" to record a lesson. Say "start lesson" to learn one.</p>
      {state.steps.length > 0 && (
        <button disabled={off} onClick={() => act("learn")}>Start lesson</button>
      )}
      <button disabled={off} className={state.steps.length > 0 ? "secondary" : ""} onClick={() => act("teach")}>
        Teach a new lesson
      </button>
    </section>
  )
}

/** The saved lesson. While coaching, the current step is highlighted. */
function Lesson({state, act}: {state: AppState; act: (name: ActionName) => void}) {
  return (
    <section className="card">
      <h2>{state.lessonTitle}</h2>
      {state.materials.length > 0 && <p className="line">You need: {state.materials.join(", ")}</p>}
      <ol className="steps">
        {state.steps.map((step) => (
          <li key={step.number} className={state.mode === "coaching" && step.number === state.stepNumber ? "current" : ""}>
            {step.instruction}
          </li>
        ))}
      </ol>
      {state.mode === "idle" && (
        <button disabled={state.busy} className="secondary" onClick={() => act("deleteLesson")}>
          Delete this lesson
        </button>
      )}
    </section>
  )
}

/**
 * Where the Claude key is pasted once. The background tests the key with a
 * tiny request and saves it on this phone. The key is never written into the
 * code, because the repository is public.
 */
function KeyBox({state}: {state: AppState}) {
  const [key, setKey] = useState("")
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)

  const save = async (value: string) => {
    setSaving(true)
    setMessage("Testing the key...")
    try {
      const result = await mentra.request("set-key", {key: value})
      setMessage(result.ok ? (value ? "Key saved." : "Key removed.") : result.error)
      if (result.ok) setKey("")
    } catch {
      setMessage("The key was not saved. Close this screen, open it again, and retry.")
    }
    setSaving(false)
  }

  return (
    <section className="card">
      <h2>Claude key</h2>
      <p className="line">
        {state.hasKey ? `A key is saved on this phone. It ends in ${state.keyHint}.` : "No key yet. Paste the team's Claude key here once."}
      </p>
      <input
        type="password"
        value={key}
        placeholder="sk-ant-..."
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => setKey(event.target.value)}
      />
      <button disabled={saving || key.trim() === ""} onClick={() => save(key)}>Save key</button>
      {state.hasKey && (
        <button disabled={saving} className="secondary" onClick={() => save("")}>Remove key</button>
      )}
      {message && <p className="line">{message}</p>}
    </section>
  )
}
