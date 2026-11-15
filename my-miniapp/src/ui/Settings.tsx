/**
 * Settings.tsx: the Claude key box, the sound test and the list of spoken commands.
 *
 * WHY THIS FILE EXISTS
 *   Tinker has no server. The phone calls Claude directly, so each phone needs
 *   the team's Claude key pasted in once. The key is never written into the
 *   code, because the repository is public. The background tests the key with
 *   one tiny request and saves it on this phone.
 *
 * WHERE IT SHOWS
 *   `SettingsCard`  at the bottom of the lesson library
 *   `KeyCard`       at the top of the Teaching tab while no key is saved,
 *                   because a recording cannot start without one
 */

import {useState} from "react"
import type {JSX} from "react"
import type {ConnectionStatus} from "../shared/channels"
import {KeyIcon, Volume2Icon} from "./Icons"
import {ConfirmButton, ErrorLine} from "./Parts"

/**
 * How long the screen waits for the answer to a key save. The background's
 * test request normally takes a second or two. Without a limit, a background
 * that never answers would leave "Testing the key..." on screen with both
 * buttons off.
 */
const KEY_TIMEOUT_MS = 30000

/** What the Teaching tab needs to know about a save in progress. See `KeyCard`. */
export interface KeySaveWatch {
  /** A save has started. */
  onStart?: () => void
  /** The save has ended. `saved` is true only when a new key was accepted. */
  onDone?: (saved: boolean) => void
}

/**
 * The key field with Save and Remove.
 * The only state kept here is the text in the box and the answer to the last
 * save. Whether a key is saved comes from the background (`connection`).
 */
function KeyBox({connection, onStart, onDone}: {connection: ConnectionStatus} & KeySaveWatch): JSX.Element {
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)
  // The answer to the last save. `ok: false` is drawn in red.
  const [result, setResult] = useState<{ok: boolean; text: string} | null>(null)

  const save = async (value: string) => {
    setSaving(true)
    setResult(null)
    onStart?.()
    let saved = false
    try {
      // The background makes one real request to Claude with this key before it saves it.
      const answer = await mentra.request("setKey", {key: value}, {timeout: KEY_TIMEOUT_MS})
      if (answer.ok) {
        setResult({ok: true, text: value ? "Key saved." : "Key removed."})
        setKey("")
        saved = value !== ""
      } else {
        setResult({ok: false, text: answer.error || "The key was not saved."})
      }
    } catch (err) {
      // The SDK names its errors. `instanceof` does not work across the bridge, the name does.
      const timedOut = (err as {name?: unknown} | null)?.name === "MentraRpcTimeoutError"
      setResult({
        ok: false,
        text: timedOut ? "No answer from Tinker. Try again." : "The key was not saved. Close this screen, open it again, and retry.",
      })
    }
    setSaving(false)
    onDone?.(saved)
  }

  return (
    <div className="form-group">
      <div className="key-heading">
        <label className="form-label" htmlFor="claude-key">
          Claude key
        </label>
        <span className={`status-pill ${connection.claudeReady ? "connected" : ""}`}>
          <span className="status-dot"></span>
          <span>{connection.claudeReady ? `Key saved, ends in ${connection.keyHint}` : "No key saved"}</span>
        </span>
      </div>
      <input
        id="claude-key"
        type="password"
        className="form-input"
        value={key}
        placeholder="sk-ant-..."
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setKey(event.target.value)}
      />
      <p className="field-hint">
        Paste the team's Claude key once. It is tested with one small request and stays on this phone.
      </p>
      <div className="button-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || key.trim() === ""}
          onClick={() => save(key)}>
          <KeyIcon size={16} />
          <span>Save key</span>
        </button>
        {/* Asks twice, like Delete and Discard: it sits next to Save, and one slip would
            take the key off the phone in the middle of a demo. */}
        {connection.claudeReady && (
          <ConfirmButton
            label="Remove key"
            confirmLabel="Sure? Tap again"
            className="btn btn-secondary"
            disabled={saving}
            onConfirm={() => save("")}
          />
        )}
      </div>
      {saving && <p className="note-line">Testing the key...</p>}
      {result && (result.ok ? <p className="note-line">{result.text}</p> : <ErrorLine>{result.text}</ErrorLine>)}
    </div>
  )
}

/**
 * The key box alone, in its own card. Shown on the Teaching tab while no key
 * is saved. `onStart` and `onDone` let that tab keep the card up for a moment
 * after a save works, so "Key saved." is seen before the card goes away.
 */
export function KeyCard({connection, onStart, onDone}: {connection: ConnectionStatus} & KeySaveWatch): JSX.Element {
  return (
    <section className="card settings-card key-card">
      <KeyBox connection={connection} onStart={onStart} onDone={onDone} />
    </section>
  )
}

/** The spoken commands a person needs most. The full list is in src/background/commands.ts. */
const TEACHING_PHRASES: Array<[string, string]> = [
  ["start teaching", "record a new lesson"],
  ["next step", "save the step you just showed"],
  ["finish lesson", "stop recording and let Claude write the lesson"],
]
const LEARNING_PHRASES: Array<[string, string]> = [
  ["start lesson", "start the newest lesson"],
  ["check", "photograph your work and have it checked"],
  ["repeat", "hear the step again"],
  ["next step", "move on without a check"],
  ["Tinker, ...", "ask a question, for example \"Tinker, how long should this take?\""],
  ["stop lesson", "end the lesson"],
]

/** Two columns: the words to say, and what they do. */
function PhraseList({title, phrases}: {title: string; phrases: Array<[string, string]>}): JSX.Element {
  return (
    <div>
      <h4 className="say-title">{title}</h4>
      <dl className="say-list">
        {phrases.map(([words, meaning]) => (
          <div key={words} className="say-row">
            <dt>"{words}"</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** The settings card under the lesson library: key, sound test, spoken commands. */
export function SettingsCard({connection, busy}: {connection: ConnectionStatus; busy: boolean}): JSX.Element {
  return (
    <section className="card settings-card">
      <h3 className="settings-title">Settings</h3>

      <KeyBox connection={connection} />

      <div className="form-group">
        <span className="form-label">Sound</span>
        <div className="button-row">
          {/* The background says one sentence through the glasses, to prove the sound arrives. */}
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => mentra.send("testAudio", {})}>
            <Volume2Icon size={16} />
            <span>Test glasses audio</span>
          </button>
        </div>
        <p className="field-hint">You should hear one sentence in the glasses.</p>
      </div>

      <div className="form-group">
        <span className="form-label">What you can say</span>
        <PhraseList title="While teaching" phrases={TEACHING_PHRASES} />
        <PhraseList title="While learning" phrases={LEARNING_PHRASES} />
      </div>
    </section>
  )
}
