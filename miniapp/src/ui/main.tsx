/**
 * Phone screen entry point. The screen has no access to the glasses.
 * It shows the state the background sends and passes button taps back.
 */

import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"
import "../shared/channels"
import {App} from "./App"
import "./styles.css"

const root = document.getElementById("root")
if (!root) {
  throw new Error("Missing #root element in index.html")
}

// MentraProvider follows the phone's light or dark theme and tells the
// Mentra App when the screen is ready.
createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)
