/**
 * main.tsx: the entry point of the phone screen.
 *
 * WHERE THIS RUNS
 *   In a WebView inside the Mentra App, only while the Tinker screen is open.
 *   It has no direct access to the glasses. Everything goes through the global
 *   `mentra` object to the background (src/background), using the messages
 *   declared in src/shared/channels.ts.
 *
 * WHAT THIS FILE DOES
 *   It mounts <App /> inside <MentraProvider>. The provider does two jobs:
 *     - it copies the Mentra App's light or dark theme onto <html class="dark">,
 *       which styles.css uses to pick its colours
 *     - once the app has mounted, it calls `mentra.ready()`. That hides the
 *       Mentra App's loading screen and lets the background send its first
 *       snapshot.
 *   Do not call `mentra.ready()` by hand here. The provider calls it at the
 *   right moment: after every `mentra.on` listener in the app is attached.
 *   This file also tells the browser not to restore scroll offsets (see below).
 */

import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"
// Imported for its types only: it declares the typed global `mentra`.
import "../shared/channels"
import {App} from "./App"
import "./styles.css"

const root = document.getElementById("root")
if (!root) {
  throw new Error("Missing #root element in index.html")
}

// The tabs and the lesson view are history entries (useHistoryState), but they
// are one page. On a back step the browser would put back the scroll offset of
// the entry it returns to, which belonged to whatever view showed then.
// App.tsx starts every view at its top instead.
history.scrollRestoration = "manual"

createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)
