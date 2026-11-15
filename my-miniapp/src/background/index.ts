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
 *   It builds a `Device` (contracts.ts) out of real Mentra calls and hands it,
 *   together with the real `Brain` (claude.ts), to the `Coach` (coach.ts).
 *   The Coach holds all the behaviour.
 *
 *     photos   session.camera.takePhoto()
 *     speech   session.speaker.speak()         plays through the glasses
 *     hearing  session.transcription           the glasses microphone, as text
 *     button   session.input.onButtonPress()
 *     light    session.led
 *     saving   session.storage (small text) and session.blob (photos)
 *     screen   session.ui                      messages from channels.ts
 *
 * WHY THE SPLIT
 *   The Coach never imports Mentra, so the tests run it with fake glasses.
 *   If the team ever moves to Mentra's Bluetooth SDK, this is the one file to
 *   rewrite. Reasons for every choice here: docs/DECISIONS.md.
 */

import {bytesToBase64, registerMiniapp} from "@mentra/miniapp/background"
import type {Channels, UiCommandChannel} from "../shared/channels"
import {createBrain} from "./claude"
import {Coach} from "./coach"
import type {Device, Hardware} from "./contracts"

// ---------- settings you can change ----------

/** Language of the spoken commands and the narration. The commands in commands.ts are English. */
const LANGUAGE = "en-US"
/** Photo size: "low", "medium", "high" or "max". Medium is enough for Claude and uploads faster. */
const PHOTO_SIZE = "medium"
/** Give up on a photo after this long, in milliseconds. The SDK's own default is 60 seconds. */
const PHOTO_TIMEOUT_MS = 25000
/**
 * Unusual words the speech-to-text should expect in every session.
 * "Tinker" matters most: a question to the app starts with that word.
 * The Coach adds the tools and ingredients of the lesson being learned.
 */
const BASE_VOCABULARY = ["Tinker", "matcha", "chawan", "chasen", "chashaku", "whisk", "sifter", "froth"]
/** Speech-to-text gets at most this many boosted words. */
const MAX_VOCABULARY = 40

/**
 * Every plain message the screen can send. Written as an object so that
 * TypeScript reports an error here when a command is added to
 * `UiCommandChannel` in channels.ts and forgotten in this list.
 */
const COMMANDS: Record<UiCommandChannel, true> = {
  startTeaching: true,
  captureStep: true,
  stopTeaching: true,
  discardTeaching: true,
  publishTutorial: true,
  deleteTutorial: true,
  startLearning: true,
  endLearning: true,
  navigateStep: true,
  checkStep: true,
  askTinker: true,
  requestTutorials: true,
  testAudio: true,
  ping: true,
}

/**
 * Run a handler and keep any error inside it.
 *
 * Mentra's source (MentraOS, branch dev, commit f120725) restarts the whole
 * background when an error escapes a timer callback, and on iPhone also when
 * one escapes a transcription or button handler. A restart throws away a
 * recording in progress. The Coach already catches its own errors; this is the
 * second line of defence, so one bad event can never cost the demo.
 */
function safely(what: string, handler: () => void): void {
  try {
    handler()
  } catch (err) {
    console.error(`[tinker] ${what} failed:`, err)
  }
}

// The Mentra App runs this function once when the miniapp starts.
// It keeps its loading screen up until the promise this function returns has settled.
registerMiniapp<Channels>(async (session) => {
  // The SDK types each channel separately. These two loosely typed views let
  // one loop register every command and one function send every event. The
  // channel names and payloads are still checked: by `COMMANDS` above and by
  // `Device.emit` in contracts.ts.
  const sendToScreen = session.ui.send as unknown as (channel: string, payload: unknown) => void
  const onScreenMessage = session.ui.on as unknown as (channel: string, handler: (payload: unknown) => void) => void

  /** What the phone last told us about the glasses. null until it has said anything. */
  let glassesConnected: boolean | null = null

  const device: Device = {
    // The glasses take the photo and upload it. The answer is a download link
    // that works for about 10 minutes.
    async takePhoto({sound}) {
      const photo = await session.camera.takePhoto({
        size: PHOTO_SIZE,
        compress: "medium", // JPEG quality. Smaller file, still clear enough for Claude.
        sound, // the shutter sound tells the wearer a photo was taken; timed photos are silent
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

    // `configure` returns a promise that rejects when the phone cannot apply it.
    // A missing vocabulary boost is not worth stopping for.
    setVocabulary(words) {
      const seen = new Set<string>()
      const list: string[] = []
      for (const word of [...BASE_VOCABULARY, ...words]) {
        const clean = word.trim()
        const key = clean.toLowerCase()
        if (!clean || seen.has(key)) continue
        seen.add(key)
        list.push(clean)
        if (list.length >= MAX_VOCABULARY) break
      }
      void session.transcription.configure({vocabulary: list}).catch(() => {})
    },

    hardware(): Hardware {
      // `session.capabilities` is null until the phone has described the glasses.
      const capabilities = session.capabilities
      const connected = glassesConnected ?? capabilities !== null
      // The manifest marks camera and microphone as REQUIRED, so the Mentra App
      // only runs Tinker on glasses that have both. They count as present
      // unless the phone says otherwise.
      return {
        glassesConnected: connected,
        hasCamera: connected && capabilities?.hasCamera !== false,
        hasMic: connected && capabilities?.hasMicrophone !== false,
      }
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

    // Does nothing while the Tinker screen is closed. The screen asks for a snapshot when it opens.
    emit(channel, payload) {
      try {
        sendToScreen(channel, payload)
      } catch {
        // The screen went away between the check and the send. Nothing to do.
      }
    },
  }

  const coach = new Coach(device, createBrain())

  // Phone screen. Everything here is registered BEFORE the first `await`, as
  // Mentra's docs require. A request from the screen that arrives before its
  // handler exists fails with "no handler registered".
  session.ui.handle("getSnapshot", () => coach.snapshot())
  session.ui.handle("setKey", ({key}) => coach.setKey(key))
  for (const name of Object.keys(COMMANDS) as UiCommandChannel[]) {
    // Not awaited: a command can take many seconds (photo, Claude, speech).
    // The screen follows progress through the events the Coach emits.
    onScreenMessage(name, (payload) => safely(name, () => coach.command(name, payload as never)))
  }
  // The screen is thrown away when it closes. Every time it opens it gets the full picture.
  session.ui.onOpen(() => safely("onOpen", () => device.emit("snapshot", coach.snapshot())))

  // Glasses. `forLanguage` is used instead of automatic language detection,
  // because detection can guess wrong on two-word commands.
  session.transcription.forLanguage(LANGUAGE, (data) => safely("heard", () => coach.heard(data.text, data.isFinal)))
  session.input.onButtonPress((press) => safely("button", () => coach.button(press.pressType)))
  session.glasses.onConnection((data) => {
    glassesConnected = data.connected
    safely("hardwareChanged", () => coach.hardwareChanged())
  })

  // The recording clock and the timed photos. The Coach decides what a tick does.
  setInterval(() => safely("tick", () => coach.tick()), 1000)

  // Read the saved Claude key and lessons from the phone. This is local storage, not the network.
  await coach.load()

  // Fire and forget, after everything is registered.
  device.setVocabulary([])
})
