/**
 * ui-dom.tsx: the fake browser and the fake Mentra App that the screen tests share.
 *
 * WHY THIS FILE EXISTS
 *   test/ui.test.tsx and test/ui-render.test.tsx both render the real <App />
 *   inside the real <MentraProvider> in a fake browser (happy-dom), with a fake
 *   `mentra` object in place of the Mentra App. This file holds that set-up
 *   once. It is not a test file itself.
 *
 * HOW A TEST FILE USES IT
 *     const {act, App, applyEvent} = await startDom()   // at the top, before anything renders
 *     beforeEach(async () => { fake = await resetPage() })
 *     afterEach(unmountPage)
 *     afterAll(stopDom)
 *
 * WHY startDom() AND NOT A SET-UP AT IMPORT TIME
 *   `bun test` runs every test file in ONE process and loads each module once.
 *   The fake browser must exist before React DOM is first loaded (React DOM
 *   checks for a browser when it loads), and it must be taken away again at
 *   the end of each file, so the background tests see a plain engine with no
 *   `window`. So each file calls startDom() and stopDom() itself.
 */

import {GlobalRegistrator} from "@happy-dom/global-registrator"
import type {
  Channels,
  ConnectionStatus,
  LearningState,
  Snapshot,
  TeachingState,
  TutorialModel,
  TutorialStepModel,
} from "../src/shared/channels"
import {BUILT_IN_TUTORIALS} from "../src/background/seed"

// ---------------------------------------------------------------- a history that can go back

/**
 * happy-dom's `history.go()` does nothing, but the screen's tabs and views use
 * the browser history (useHistoryState). This stand-in keeps a real stack and
 * fires `popstate` a moment later, like a browser does.
 */
const historyStack = {stack: [null] as unknown[], index: 0}

function installHistory(): void {
  const clone = (value: unknown) => (value === null || value === undefined ? null : JSON.parse(JSON.stringify(value)))
  const h = window.history
  Object.defineProperty(h, "state", {configurable: true, get: () => historyStack.stack[historyStack.index]})
  h.pushState = (state: unknown) => {
    historyStack.stack = [...historyStack.stack.slice(0, historyStack.index + 1), clone(state)]
    historyStack.index++
  }
  h.replaceState = (state: unknown) => {
    historyStack.stack[historyStack.index] = clone(state)
  }
  h.go = (delta = 0) => {
    const next = historyStack.index + delta
    if (next < 0 || next >= historyStack.stack.length) return
    setTimeout(() => {
      historyStack.index = next
      window.dispatchEvent(new window.PopStateEvent("popstate", {state: historyStack.stack[historyStack.index]}))
    }, 0)
  }
  h.back = () => h.go(-1)
}

/** How many history entries exist, and which one is showing. */
export function historyDepth(): {length: number; index: number} {
  return {length: historyStack.stack.length, index: historyStack.index}
}

/**
 * The SDK's history hook (useHistoryState) adds ONE "popstate" listener per
 * window, and it only adds a new one when `window` changes. happy-dom's window
 * IS the global object, so when a second test file creates a new fake browser
 * in the same process, the hook sees the same `window`, keeps its listener, and
 * that listener went away with the old browser. Every back step would then wait
 * for ever. So each "popstate" listener is remembered here and added again to
 * every new fake browser. Found the hard way: tests passed alone and failed
 * when run after test/ui.test.tsx.
 */
const popstateListeners: EventListenerOrEventListenerObject[] = []
function carryPopstateListeners(): void {
  const add = window.addEventListener.bind(window)
  for (const listener of popstateListeners) add("popstate", listener)
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    if (type === "popstate" && listener && !popstateListeners.includes(listener)) popstateListeners.push(listener)
    if (listener) add(type, listener, options)
  }) as typeof window.addEventListener
}

// ---------------------------------------------------------------- the fake Mentra App

type Handler = (payload: unknown) => void

/** Stands in for the `mentra` object the Mentra App adds to the page. */
export class FakeMentra {
  sent: Array<{channel: string; payload: unknown}> = []
  requests: Array<{channel: string; payload: unknown; options?: {timeout?: number}}> = []
  readyCalls = 0
  /** What `request` answers, per channel. With no entry the request never settles. */
  answers: Record<string, (payload: unknown) => Promise<unknown>> = {}
  private handlers = new Map<string, Set<Handler>>()
  private openCallbacks: Array<() => void> = []

  send = (channel: string, payload: unknown) => {
    this.sent.push({channel, payload})
  }
  on = (channel: string, cb: Handler) => {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set())
    this.handlers.get(channel)?.add(cb)
    return () => {
      this.handlers.get(channel)?.delete(cb)
    }
  }
  request = (channel: string, payload: unknown, options?: {timeout?: number}) => {
    this.requests.push({channel, payload, options})
    const answer = this.answers[channel]
    return answer ? answer(payload) : new Promise(() => {})
  }
  // Like the real bridge: onOpen callbacks run once `ready()` has been called.
  onOpen = (cb: () => void) => {
    if (this.readyCalls > 0) cb()
    else this.openCallbacks.push(cb)
    return () => {}
  }
  onClose = () => () => {}
  ready = () => {
    this.readyCalls++
    if (this.readyCalls === 1) this.openCallbacks.forEach((cb) => cb())
  }

  /** Deliver one event from the "background" to the screen. */
  emit<C extends keyof Channels>(channel: C, payload: Channels[C]) {
    for (const cb of this.handlers.get(channel) ?? []) cb(payload)
  }
  /** How many listeners the screen has on a channel. */
  listeners(channel: string): number {
    return this.handlers.get(channel)?.size ?? 0
  }
  sentOn(channel: string): unknown[] {
    return this.sent.filter((message) => message.channel === channel).map((message) => message.payload)
  }
  requestsOn(channel: string): Array<{channel: string; payload: unknown; options?: {timeout?: number}}> {
    return this.requests.filter((request) => request.channel === channel)
  }
}

/** The error the real SDK rejects with when a request's `timeout` runs out (modules/ui.ts). */
export function timeoutError(): Error {
  const err = new Error("timed out")
  err.name = "MentraRpcTimeoutError"
  return err
}

// ---------------------------------------------------------------- the page

type Modules = {
  act: typeof import("react").act
  createRoot: typeof import("react-dom/client").createRoot
  MentraProvider: typeof import("@mentra/miniapp/ui").MentraProvider
  App: typeof import("../src/ui/App").App
  applyEvent: typeof import("../src/ui/state").applyEvent
  EMPTY: typeof import("../src/ui/state").EMPTY
  isBusy: typeof import("../src/ui/state").isBusy
}
let modules: Modules | null = null
let fake: FakeMentra | null = null
let root: ReturnType<Modules["createRoot"]> | null = null

/** Create the fake browser, then load React and the screen. Call once at the top of a test file. */
export async function startDom(): Promise<Modules> {
  if (typeof document === "undefined") GlobalRegistrator.register()
  // Tells React that `act` is in use, so it does not print a warning on every update.
  ;(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true
  carryPopstateListeners()
  installHistory()
  const {act} = await import("react")
  const {createRoot} = await import("react-dom/client")
  const {MentraProvider} = await import("@mentra/miniapp/ui")
  const {App} = await import("../src/ui/App")
  const {applyEvent, EMPTY, isBusy} = await import("../src/ui/state")
  modules = {act, createRoot, MentraProvider, App, applyEvent, EMPTY, isBusy}
  return modules
}

function need(): Modules {
  if (!modules) throw new Error("call startDom() first")
  return modules
}

/** Before each test: an empty page, a fresh history and a fresh fake Mentra App. */
export async function resetPage(): Promise<FakeMentra> {
  // A back step the last test started may still be on its way (or was stopped by fake
  // timers). Until its "popstate" lands, the SDK's history hook holds every change back.
  // Land one now, let the hook settle, and only then wipe the history.
  window.dispatchEvent(new window.PopStateEvent("popstate", {state: historyStack.stack[historyStack.index]}))
  await new Promise((resolve) => setTimeout(resolve, 1))
  historyStack.stack = [null]
  historyStack.index = 0
  document.body.innerHTML = ""
  document.documentElement.className = ""
  window.scrollTo(0, 0)
  fake = new FakeMentra()
  ;(globalThis as unknown as {mentra: unknown}).mentra = fake
  return fake
}

/** After each test: unmount so timers (the snapshot retry) stop, and let a pending popstate land. */
export async function unmountPage(): Promise<void> {
  const {act} = need()
  await act(async () => {
    root?.unmount()
  })
  root = null
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** At the end of a test file: take the fake browser away again. */
export async function stopDom(): Promise<void> {
  delete (globalThis as unknown as {mentra?: unknown}).mentra
  delete (globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT
  if (typeof document !== "undefined") await GlobalRegistrator.unregister()
}

/** Mount the whole screen exactly as main.tsx does. */
export async function mount(): Promise<void> {
  const {act, createRoot, MentraProvider, App} = need()
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <MentraProvider>
        <App />
      </MentraProvider>,
    )
  })
}

/** Remove the screen, as the Mentra App does when the screen is closed. */
export async function unmount(): Promise<void> {
  const {act} = need()
  await act(async () => {
    root?.unmount()
  })
  root = null
}

/** Push one background event and let React redraw. */
export async function emit<C extends keyof Channels>(channel: C, payload: Channels[C]): Promise<void> {
  const {act} = need()
  await act(async () => {
    fake?.emit(channel, payload)
  })
  await settle()
}

/** Let timers that are due (the fake history's popstate) and promises finish. Real timers only. */
export async function settle(): Promise<void> {
  const {act} = need()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

export async function click(element: Element | undefined | null): Promise<void> {
  if (!element) throw new Error("click: the element is not on the screen")
  const {act} = need()
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

/** Type into a React input: set the value the way a browser would, then fire `input`. */
export async function type(element: Element | null, value: string): Promise<void> {
  if (!element) throw new Error("type: the input is not on the screen")
  const {act} = need()
  const proto = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new window.Event("input", {bubbles: true}))
  })
}

export const screenText = () => (document.body.textContent ?? "").replace(/\s+/g, " ")
export const all = (selector: string) => Array.from(document.querySelectorAll(selector))
/** The button whose visible text (or aria-label) is exactly `label`. */
export const button = (label: string) =>
  all("button").find((b) => (b.textContent ?? "").trim() === label || b.getAttribute("aria-label") === label) as
    | HTMLButtonElement
    | undefined
/** The text of every visible note line, in order. A note inside a hidden part does not count. */
export const notes = () => all(".note-line").filter((n) => !n.closest("[hidden]")).map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())

// ---------------------------------------------------------------- test data

export const step = (n: number, extra: Partial<TutorialStepModel> = {}): TutorialStepModel => ({
  id: `step_0${n}`,
  step_number: n,
  title: `Title of step ${n}`,
  instruction_spoken: `Library text of step ${n}.`,
  instruction_detailed: `Detail of step ${n}.`,
  ...extra,
})

export const BUILT_IN: TutorialModel = {
  id: "tut_matcha_ceremonial_01",
  title: "How to Make Matcha",
  description: "The built-in lesson.",
  category: "Culinary Arts",
  total_steps: 3,
  estimated_duration_minutes: 5,
  created_at: "2026-11-14T15:00:00Z",
  status: "published",
  steps: [step(1), step(2), step(3)],
  built_in: true,
}

export const RECORDED: TutorialModel = {
  id: "tut_1763140000000",
  title: "Tie a Bowline Knot",
  description: "A loop that does not slip.",
  total_steps: 2,
  estimated_duration_minutes: 2,
  created_at: "2026-11-14T17:00:00Z",
  status: "published",
  steps: [step(1), step(2)],
}

/** The real built-in lesson, word for word as the app ships it (src/background/seed.ts). */
export const SEED: TutorialModel = BUILT_IN_TUTORIALS[0]!

export const READY: ConnectionStatus = {glassesConnected: true, hasCamera: true, hasMic: true, claudeReady: true, keyHint: "9xQz"}
export const NOTHING: ConnectionStatus = {glassesConnected: false, hasCamera: false, hasMic: false, claudeReady: false, keyHint: ""}
export const TEACH_IDLE: TeachingState = {status: "idle", elapsedSeconds: 0, frameCount: 0, stepCount: 0, narration: ""}

export const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  connection: READY,
  tutorials: [RECORDED, BUILT_IN],
  teaching: TEACH_IDLE,
  draft: null,
  learning: null,
  lastVerdict: null,
  transcript: [],
  assistant: "idle",
  busy: false,
  ...over,
})

export const lesson = (over: Partial<LearningState> = {}): LearningState => ({
  active: true,
  finished: false,
  sessionId: "session-1",
  tutorialId: BUILT_IN.id,
  currentStep: 2,
  totalSteps: 3,
  // Deliberately NOT the text in the library: the screen must show `stepData`.
  stepData: step(2, {instruction_spoken: "Sift two scoops into the dry bowl."}),
  assistantState: "idle",
  ...over,
})
