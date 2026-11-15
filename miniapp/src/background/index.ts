/**
 * index.ts: the background entry point, and the ONLY background file that
 * touches the Mentra SDK.
 *
 * WHERE THIS RUNS
 *   On the phone, inside the Mentra App, for as long as the miniapp is on.
 *   It keeps running with the phone screen off. It is a bare JavaScript engine:
 *   no window, document, process, URL, Headers or Node modules. `bun run build`
 *   fails with a file and line number if this folder uses one of those.
 *
 * WHAT THIS FILE DOES
 *   It builds a `Device` out of real Mentra calls and hands it to the `Coach`
 *   (coach.ts), which holds all the behaviour.
 *
 *     photos   session.camera.takePhoto()
 *     speech   session.speaker.speak()         plays through the glasses
 *     hearing  session.transcription           the glasses microphone, as text
 *     button   session.input.onButtonPress()
 *     light    session.led
 *     saving   session.storage (small text) and session.blob (photos)
 *
 * WHY THE SPLIT
 *   The Coach never imports Mentra, so the tests can run it with fake glasses.
 *   If the team ever moves to Mentra's Bluetooth SDK, this is the one file to
 *   rewrite. Reasons for every choice here: docs/DECISIONS.md.
 */

import {bytesToBase64, registerMiniapp} from "@mentra/miniapp/background"
import type {Channels} from "../shared/channels"
import {Coach} from "./coach"

// ---------- settings you can change ----------

/** Language of the spoken commands and the narration. The commands in commands.ts are English. */
const LANGUAGE = "en-US"
/** Photo size: "low", "medium", "high" or "max". Medium is enough for Claude and uploads faster. */
const PHOTO_SIZE = "medium"
/** Give up on a photo after this long, in milliseconds. The SDK's own default is 60 seconds. */
const PHOTO_TIMEOUT_MS = 25000

// The Mentra App runs this function once when the miniapp starts.
// It keeps its loading screen up until the promise this function returns has settled.
registerMiniapp<Channels>(async (session) => {
  const coach = new Coach({
    // The glasses take the photo and upload it. The answer is a download link
    // that works for about 30 minutes. The shutter sound is left on, so the
    // wearer hears that a photo was taken.
    async takePhoto() {
      const photo = await session.camera.takePhoto({
        size: PHOTO_SIZE,
        compress: "medium", // JPEG quality. Smaller file, still clear enough for Claude.
        timeoutMs: PHOTO_TIMEOUT_MS,
      })
      return {url: photo.photoUrl, mediaType: photo.mimeType}
    },

    // Mentra's own text to speech. The sound goes to the phone's current audio
    // output, which is the glasses when they are connected as Bluetooth audio.
    // The promise resolves when the speech has finished playing.
    async speak(text) {
      await session.speaker.speak(text, {stopOtherAudio: true})
    },

    // The light is a bonus. A failure here must never stop a lesson, so errors are swallowed.
    light(color, times) {
      void session.led.blink(color, 250, 150, times).catch(() => {})
    },

    // Used only when a photo's bytes are needed and the phone kept no copy.
    async downloadPhoto(url) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Photo download failed with HTTP ${response.status}.`)
      return bytesToBase64(await response.arrayBuffer())
    },

    async savePhoto(key, url, mediaType) {
      // The phone downloads the photo straight to its own storage.
      // The bytes never pass through this JavaScript engine.
      await session.blob.setFromUrl(key, url, {mimeType: mediaType})
    },

    async loadPhoto(key) {
      const bytes = await session.blob.bytes(key)
      return bytes ? bytesToBase64(bytes) : null
    },

    deletePhoto: (key) => session.blob.delete(key),
    storageGet: (key) => session.storage.get(key),
    storageSet: (key, value) => session.storage.set(key, value),
    storageDelete: (key) => session.storage.delete(key),
    now: () => Date.now(),
    // Does nothing while the Tinker screen is closed. The screen asks for the state when it opens.
    onState: (state) => session.ui.send("state", state),
  })

  // Phone screen. These handlers are registered BEFORE the first `await`,
  // as Mentra's docs require. A request from the screen that arrives before
  // its handler exists fails with "no handler registered".
  session.ui.handle("get-state", () => coach.state())
  session.ui.handle("set-key", ({key}) => coach.setKey(key))
  session.ui.handle("action", ({name}) => {
    // Not awaited: a command can take many seconds (photo, Claude, speech).
    // The screen gets the reply at once and follows progress through "state".
    void coach.act(name)
    return {ok: true}
  })
  session.ui.onOpen(() => session.ui.send("state", coach.state()))

  // Glasses. `forLanguage` is used instead of automatic language detection,
  // because detection can guess wrong on two-word commands.
  session.transcription.forLanguage(LANGUAGE, (data) => coach.heard(data.text, data.isFinal))
  session.input.onButtonPress((press) => coach.button(press.pressType))

  // Read the saved Claude key and lesson from the phone. This is local storage, not the network.
  await coach.load()
})
