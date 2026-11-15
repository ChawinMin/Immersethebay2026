/**
 * Parts.tsx: small pieces that more than one screen uses.
 *
 * WHY THIS FILE EXISTS
 *   The Learning tab, the Teaching tab and the settings card all need the same
 *   few things: a photo that hides itself when its link is dead, a red error
 *   sentence that puts known failures in plain words, and a button that asks
 *   twice before it throws something away. Keeping them here means each is
 *   written once.
 */

import {useEffect, useState} from "react"
import type {JSX, ReactNode} from "react"
import {AlertIcon} from "./Icons"

/** Whether a photo link works: not known yet, yes, or no. */
export interface PhotoLink {
  src: string
  status: "loading" | "ok" | "failed"
  onLoad: () => void
  onError: () => void
}

/**
 * Follows one photo link from the glasses. The links stop working after about
 * 10 minutes, so the screen must find out whether the picture really loads.
 * The answer is remembered together with the link it belongs to, so a new link
 * starts again at "loading".
 */
export function usePhotoLink(src?: string): PhotoLink {
  const [result, setResult] = useState<{src: string; status: "ok" | "failed"} | null>(null)
  const link = src ?? ""
  return {
    src: link,
    status: link && result?.src === link ? result.status : "loading",
    onLoad: () => setResult({src: link, status: "ok"}),
    onError: () => setResult({src: link, status: "failed"}),
  }
}

/**
 * A photo with a caption. It stays hidden until the picture has loaded, and a
 * picture that fails to load is removed together with its caption. A dead link
 * therefore never leaves a broken picture on the screen.
 */
export function Photo({link, alt, caption, className}: {
  link: PhotoLink
  alt: string
  caption?: string
  className?: string
}): JSX.Element | null {
  if (!link.src || link.status === "failed") return null
  return (
    // `hidden` keeps the <img> in the page so the browser loads it, without showing an empty box.
    <figure className="photo-figure" hidden={link.status !== "ok"}>
      <img src={link.src} alt={alt} className={className} onLoad={link.onLoad} onError={link.onError} />
      {caption && <figcaption className="photo-caption">{caption}</figcaption>}
    </figure>
  )
}

/**
 * Failures the person can do something about, in plain words. The background
 * reports Claude's own error text (for example "Overloaded" or
 * "invalid x-api-key"), which means little to someone holding a tea bowl.
 * The patterns match that text: the screen never sees the status number itself
 * unless Claude sent no message (then claude.ts writes "Claude answered with HTTP 529.").
 */
const PLAIN_WORDS: Array<[RegExp, string]> = [
  // HTTP 529. Claude's own message for it is "Overloaded".
  [/\b529\b|overloaded/i, "Claude is busy right now. Try again in a moment."],
  // HTTP 401: a wrong or revoked key. Claude's own message for it is "invalid x-api-key".
  [/\b401\b|invalid x-api-key|authentication/i, "Claude rejected the key."],
  // The phone could not reach Claude at all (claude.ts: "No connection to Claude.").
  [/no connection/i, "No internet connection to Claude."],
]

/** The plain sentence for a known failure, or "" when the text is not one of them. */
export function plainWords(text: string): string {
  for (const [pattern, plain] of PLAIN_WORDS) if (pattern.test(text)) return plain
  return ""
}

/**
 * A sentence from the background. A known failure gets its plain sentence
 * first, with the background's own words after it in smaller type, so nothing
 * is hidden from the person who has to fix it.
 */
export function Explained({text}: {text: string}): JSX.Element {
  const plain = plainWords(text)
  if (!plain) return <span>{text}</span>
  return (
    <span>
      {plain} <small className="error-detail">{text}</small>
    </span>
  )
}

/** One red sentence for a failure. The text comes from the background. Known failures are explained first. */
export function ErrorLine({children}: {children: string}): JSX.Element {
  return (
    <p className="error-line" role="alert">
      <AlertIcon size={16} />
      <Explained text={children} />
    </p>
  )
}

/**
 * A button for an action that cannot be undone (discard a recording, delete a
 * lesson). The first tap only changes the label. A second tap within four
 * seconds does the action. This guards against a slip of the thumb.
 */
export function ConfirmButton({label, confirmLabel, onConfirm, className, disabled, icon}: {
  label: string
  confirmLabel: string
  onConfirm: () => void
  className: string
  disabled?: boolean
  icon?: ReactNode
}): JSX.Element {
  const [armed, setArmed] = useState(false)

  // Forget the first tap after four seconds.
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])

  const tap = () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    onConfirm()
  }

  return (
    <button type="button" className={className} disabled={disabled} onClick={tap}>
      {icon}
      <span>{armed ? confirmLabel : label}</span>
    </button>
  )
}

/** "1 Step", "6 Steps": the size of a lesson. */
export function stepCount(count: number): string {
  return `${count} ${count === 1 ? "Step" : "Steps"}`
}

/** Seconds as MM:SS, for the recording clock. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(whole / 60)
  const secs = whole % 60
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}
