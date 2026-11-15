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
import {ErrorLine} from "./Parts"

/**
 * The key field with Save and Remove.
 * The only state kept here is the text in the box and the answer to the last
 * save. Whether a key is saved comes from the background (`connection`).
 */
function KeyBox({connection}: {connection: ConnectionStatus}): JSX.Element {
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)
  // The answer to the last save. `ok: false` is drawn in red.
  const [result, setResult] = useState<{ok: boolean; text: string} | null>(null)

  const save = async (value: string) => {
    setSaving(true)
    setResult(null)
    try {
      // The background makes one real request to Claude with this key before it saves it.
      const answer = await mentra.request("setKey", {key: value})
      if (answer.ok) {
        setResult({ok: true, text: value ? "Key saved." : "Key removed."})
        setKey("")
      } else {
        setResult({ok: false, text: answer.error || "The key was not saved."})
      }
    } catch {
      setResult({ok: false, text: "The key was not saved. Close this screen, open it again, and retry."})
    }
    setSaving(false)
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
        {connection.claudeReady && (
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => save("")}>
            Remove key
          </button>
        )}
      </div>
      {saving && <p className="note-line">Testing the key...</p>}
      {result && (result.ok ? <p className="note-line">{result.text}</p> : <ErrorLine>{result.text}</ErrorLine>)}
    </div>
  )
}

/** The key box alone, in its own card. Shown on the Teaching tab while no key is saved. */
export function KeyCard({connection}: {connection: ConnectionStatus}): JSX.Element {
  return (
    <section className="card settings-card key-card">
      <KeyBox connection={connection} />
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
