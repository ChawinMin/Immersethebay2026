/**
 * Parts.tsx: small pieces that more than one screen uses.
 *
 * WHY THIS FILE EXISTS
 *   The Learning tab, the Teaching tab and the settings card all need the same
 *   few things: a photo that hides itself when its link is dead, a red error
 *   sentence, and a button that asks twice before it throws something away.
 *   Keeping them here means each is written once.
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

/** One red sentence for a failure. The text comes from the background and is shown as it is. */
export function ErrorLine({children}: {children: ReactNode}): JSX.Element {
  return (
    <p className="error-line" role="alert">
      <AlertIcon size={16} />
      <span>{children}</span>
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

/** Seconds as MM:SS, for the recording clock. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(whole / 60)
  const secs = whole % 60
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}
