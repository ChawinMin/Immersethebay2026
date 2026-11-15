/**
 * real-app-test.ts: the WHOLE app against the REAL Claude API, on a simulated phone.
 *
 * WHAT THIS IS
 *   It builds the app and loads `dist/background/index.js`, the exact file the
 *   Mentra App loads on the phone. That file contains the Coach, the Brain, the
 *   wiring in index.ts and the Mentra SDK itself. It runs in an empty JavaScript
 *   sandbox with only what Mentra's background engine has.
 *
 *   Around it, this program plays the phone, the glasses and the person. It
 *   answers the SDK's requests (photos, speech, storage, kept photo copies) the
 *   way the Mentra App does, "speaks" sentences into the glasses microphone,
 *   taps buttons on the phone screen, and puts drawings in front of the camera.
 *
 *   Every request to Claude is REAL and uses the key in TINKER_CLAUDE_KEY.
 *
 * WHAT IT PROVES
 *   That the parts work together with the real Claude: a wrong key is refused
 *   and the right one accepted, a lesson is taught by voice, built by Claude
 *   from photos and words, published by voice, learned, checked from photos (a
 *   wrong attempt and right attempts), finished, and a spoken question about
 *   the built-in lesson is answered.
 *
 * WHAT IT DOES NOT PROVE
 *   Anything about real glasses: the camera, the speaker, the microphone, the
 *   button, real speech timing (speech takes no time here). The pictures are
 *   drawings, not photos.
 *
 * HOW IT WAITS
 *   Never a fixed time for the app. It waits for the app's own messages to the
 *   phone screen: teachingState, tutorialGenerated, tutorialList, learningState,
 *   stepVerdict and assistantState. Before each sentence the person waits until
 *   the screen shows the app as idle, then about 3 seconds more, the way a
 *   person answers. That gap is also what lets the app's echo filter (coach.ts)
 *   tell the person from the app's own voice, so it is never shorter than the
 *   filter's ECHO_REPLY_MS. No check depends on the exact words the app speaks.
 *
 * PHOTO LINKS
 *   The simulated glasses hand out links on `photos.example`, a name that by
 *   design exists nowhere. Claude cannot open them, so this run also exercises
 *   the app's fallback: when Claude refuses photo links (HTTP 400), the app sends
 *   the photo bytes instead. Real Mentra links are signed storage links that
 *   Claude can most likely open; scripts/real-claude-test.ts check 6 covers a
 *   real link.
 *
 * TIME LIMITS
 *   Each request to Claude gets 60 seconds, as on the phone. Every wait has its
 *   own limit, and the whole run stops by itself after 6 minutes. When a wait
 *   runs out, the run says what it was waiting for and the last things the
 *   glasses said.
 *
 * RUN IT (from my-miniapp/, needs bun)
 *   read -rs TINKER_CLAUDE_KEY && export TINKER_CLAUDE_KEY   # paste the key, press Enter
 *   bun scripts/real-app-test.ts
 *
 *   TINKER_DRY_RUN=1 bun scripts/real-app-test.ts   # fake Claude, no key, no network
 *   TINKER_DRY_RUN=1 TINKER_DRY_FAULT=check5 bun scripts/real-app-test.ts
 *   Faults (dry run only): check5 (the wrong attempt is passed), claude529
 *   (every lesson build is refused as overloaded), hang (Claude never answers).
 *
 * It never prints the key. It sends about 9 requests to Claude.
 * Exit code: 0 all passed, 1 a check failed or the run stopped early,
 * 2 no usable key (or an unknown TINKER_DRY_FAULT). With 2, nothing was sent.
 */

import {createHash} from "node:crypto"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import vm from "node:vm"
import {CHAT_MODEL, CHECK_MODEL, PLAN_MODEL} from "../src/background/claude"
import {emptyBowl, foamBowl, powderBowl, powderBowlAgain} from "./test-photos"

// ================================================================ settings

const ROOT = join(import.meta.dir, "..")
const DRY = process.env.TINKER_DRY_RUN === "1"
const ENDPOINT = "https://api.anthropic.com/v1/messages"
const BUILT_IN_ID = "tut_matcha_ceremonial_01"

/** The whole run stops by itself after this long, even if Claude never answers. */
const RUN_LIMIT_MS = 6 * 60_000
const RUN_LIMIT_TEXT = RUN_LIMIT_MS % 60_000 === 0 ? `${RUN_LIMIT_MS / 60_000} minutes` : `${RUN_LIMIT_MS / 1000} s`
/** Kept free at the end of the run limit, so the summary is printed in time. */
const SUMMARY_MS = 15_000
/**
 * The Mentra App stops a background request after 60 seconds (claude.ts, TIME
 * LIMIT, and docs/DECISIONS.md). The simulated phone does the same, so a
 * request that would fail on the phone fails here too.
 */
const PHONE_REQUEST_MS = 60_000
/** After a sentence or a tap, the app must react this soon: start thinking, start speaking, or take a photo. */
const REACTION_MS = 6_000
/** The longest one command may keep the app busy: two Claude requests (photo links refused, then bytes) and speech. */
const COMMAND_MS = 2 * PHONE_REQUEST_MS + 30_000
/** The longest a build of the app may take. */
const BUILD_MS = 120_000

/** Dry runs only. TINKER_DRY_FAULT makes the fake Claude misbehave on purpose, to show that the run notices. */
const FAULTS: Record<string, string> = {
  check5: "the fake Claude passes the wrong attempt, so check 5 must FAIL",
  claude529: "the fake Claude answers every lesson build with HTTP 529 (overloaded), so the run must stop",
  hang: "the fake Claude never answers, so every request runs into the phone's 60 second limit",
}
const FAULT = DRY ? (process.env.TINKER_DRY_FAULT ?? "").trim() : ""

// ================================================================ the key, and printing without it

/** The key of a dry run. The fake Claude accepts this one and nothing else. Not a secret. */
const DRY_RUN_KEY = "sk-ant-test-dry-run"
/** A key that is wrong on purpose. Claude refuses it with HTTP 401, which costs nothing. Not a secret. */
const WRONG_KEY = "sk-ant-api03-this-key-is-wrong-on-purpose"

/** People paste badly: spaces, line breaks and quotes around the key are removed. Nothing inside it is touched. */
function cleanKey(raw: string): string {
  return raw.replace(/^[\s"'`‘’“”]+|[\s"'`‘’“”]+$/g, "")
}

/**
 * Why a cleaned key cannot be used, or "" when it looks usable. Checked before
 * anything is sent: a value with a space or a line break cannot travel in a
 * request header, and the error about it could contain the value.
 */
function keyProblem(key: string): string {
  if (key === "") return "TINKER_CLAUDE_KEY is not set, or it is empty."
  if (!key.startsWith("sk-ant-")) return `TINKER_CLAUDE_KEY has ${key.length} characters but does not start with "sk-ant-". Claude keys do.`
  if (!/^[\x21-\x7E]+$/.test(key)) return "TINKER_CLAUDE_KEY has a space, a line break or an unusual character inside it. Copy the key again."
  if (key.length < 30) return `TINKER_CLAUDE_KEY has only ${key.length} characters. That is too short for a Claude key.`
  return ""
}

const rawKey = process.env.TINKER_CLAUDE_KEY ?? ""
const KEY = DRY ? DRY_RUN_KEY : cleanKey(rawKey)

/** Every text that must never be printed: the key as given and as cleaned up, in a dry run too. */
const secrets: string[] = []
for (const value of [rawKey, cleanKey(rawKey), DRY ? "" : KEY]) {
  // Very short values are left out: replacing a 1-letter "key" would scramble all output.
  if (value.length >= 8 && !secrets.includes(value)) secrets.push(value)
}
secrets.sort((a, b) => b.length - a.length)

/**
 * Remove the key from a text. Two nets: the exact key wherever it appears, and
 * anything else shaped like a Claude key. The two made-up keys stay readable.
 */
function hide(text: string): string {
  let out = String(text)
  for (const secret of secrets) out = out.split(secret).join("[key hidden]")
  return out.replace(/sk-ant-[A-Za-z0-9_-]{16,}/g, (found) => (found === WRONG_KEY || found === DRY_RUN_KEY ? found : "[key hidden]"))
}

/** The only way this program prints. Everything goes through `hide`. */
function print(line = ""): void {
  console.log(hide(line))
}

if (!DRY) {
  const problem = keyProblem(KEY)
  if (problem) {
    print(problem)
    print("Nothing was sent.")
    print("\nRun it like this (the key is not shown while you paste it):")
    print("  read -rs TINKER_CLAUDE_KEY && export TINKER_CLAUDE_KEY")
    print("  bun scripts/real-app-test.ts")
    print("\nOr with a fake Claude and no key:  TINKER_DRY_RUN=1 bun scripts/real-app-test.ts")
    process.exit(2)
  }
} else if (FAULT && !Object.hasOwn(FAULTS, FAULT)) {
  print(`TINKER_DRY_FAULT is "${FAULT}". It can be ${Object.keys(FAULTS).join(", ")}, or left out. Nothing was run.`)
  process.exit(2)
}

// ================================================================ timing taken from coach.ts

/** A number setting of coach.ts, read from its source text, or null when it cannot be found. */
function coachSetting(name: string): number | null {
  try {
    const source = readFileSync(join(ROOT, "src/background/coach.ts"), "utf8")
    const match = new RegExp(`const ${name}(?:\\s*:\\s*number)?\\s*=\\s*([0-9_.*+ ()]+)`).exec(source)
    if (!match) return null
    // Only digits, dots, spaces, brackets, + and * reach this line, so evaluating it is safe.
    const value = Function(`"use strict"; return (${match[1]!.replace(/_/g, "")})`)()
    return typeof value === "number" && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

const ECHO_REPLY_MS = coachSetting("ECHO_REPLY_MS")
const QUIET_AFTER_SPEECH_MS = coachSetting("QUIET_AFTER_SPEECH_MS")
/** How long the person waits after the app goes quiet before speaking: about 3 s, and always past the echo filter's limits. */
const PERSON_PAUSE_MS = Math.max(3000, (ECHO_REPLY_MS ?? 0) + 500, (QUIET_AFTER_SPEECH_MS ?? 0) + 500)

// ================================================================ the pictures in front of the camera

const PICTURES = {emptyBowl, powderBowl, powderBowlAgain, foamBowl}
type Scene = keyof typeof PICTURES
const SCENE_WORDS: Record<Scene, string> = {
  emptyBowl: "an empty tea bowl",
  powderBowl: "a bowl with a mound of green powder",
  powderBowlAgain: "a bowl with a mound of green powder, seen from another spot",
  foamBowl: "a bowl of green tea with a foamy top",
}

/** Two drawings of the same finished step. They must get the same verdict. */
function sameStep(scene: Scene | null | undefined): Scene | null {
  return scene === "powderBowlAgain" ? "powderBowl" : (scene ?? null)
}

/** What the glasses camera sees right now. The person changes it before each photo. */
let scene: Scene = "emptyBowl"
let photoCount = 0

function sceneOfUrl(url: unknown): Scene | null {
  const match = /photos\.example\/([A-Za-z]+)-\d+\.jpg$/.exec(String(url ?? ""))
  return match && Object.hasOwn(PICTURES, match[1]!) ? (match[1] as Scene) : null
}

function photoNumber(url: unknown): number | null {
  const match = /-(\d+)\.jpg$/.exec(String(url ?? ""))
  return match ? Number(match[1]) : null
}

function sceneOfBase64(data: string): Scene | null {
  for (const [name, picture] of Object.entries(PICTURES)) if (picture === data) return name as Scene
  return null
}

interface Seen {
  via: "link" | "bytes"
  scene: Scene | null
  /** The photo's number, for a link. null for bytes. */
  photo: number | null
}

/** Which drawing an image block of a Claude request holds. */
function imageScene(block: any): Seen {
  const source = block?.source ?? {}
  if (source.type === "url") return {via: "link", scene: sceneOfUrl(source.url), photo: photoNumber(source.url)}
  return {via: "bytes", scene: sceneOfBase64(String(source.data ?? "")), photo: null}
}

function seenText(seen: Seen | null | undefined): string {
  return seen ? `${seen.via}:${seen.scene ?? "?"}` : "none"
}

/** A request's status in words: still waiting, no answer, or its HTTP status. */
function statusText(status: number | null | undefined): string {
  if (status === null || status === undefined) return "no answer yet"
  return status === 0 ? "no answer" : `HTTP ${status}`
}

// ================================================================ what happened, for the report

const t0 = Date.now()
/** Every wait ends by this time, so the summary is printed before the run limit. */
const deadline = t0 + RUN_LIMIT_MS - SUMMARY_MS
const since = (at = Date.now()) => ((at - t0) / 1000).toFixed(1).padStart(6)
const spoken: string[] = []
const sent: any[] = [] // every message from the app to the phone, in order
const storage = new Map<string, string>()
const consoleErrors: string[] = []
const screenNotes: string[] = []
/** Sentences and taps the app did not react to. */
const ignored: string[] = []
/** Sentences and taps that needed a reaction from the app. */
let reactionsWanted = 0
/** Photo checks: which photos Claude got, and anything wrong with them. */
const photoLines: string[] = []
const photoProblems: string[] = []
/** Dry runs only: things the fake Claude could not answer properly. */
const fakeNotes = new Set<string>()

function log(tag: string, text: string): void {
  print(`${since()}s  ${tag.padEnd(12)} ${text}`)
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object" && "message" in err) return String((err as {message: unknown}).message)
  return String(err)
}

/** Lower case words only, for comparing texts loosely. */
function words(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** True when `phrase` appears in `text`, whatever the capitals and punctuation. */
function mentions(text: unknown, phrase: string): boolean {
  return ` ${words(text)} `.includes(` ${words(phrase)} `)
}

// ================================================================ Claude: real, or fake in a dry run

interface ClaudeCall {
  n: number
  kind: string
  model: string
  images: Seen[]
  photos: string
  startedAt: number
  /** null while still waiting for the answer. */
  ms: number | null
  /** null while waiting, 0 when no answer came. */
  status: number | null
  /** Claude's own error type and message, or why no answer came. */
  error: string
  requestId: string
  stop: string
  tokens: string
  /** The reply text of an answer with status 200. */
  text: string
  /** The request body. Kept for the checks, never printed. It holds no key: the key travels in a header. */
  body: any
}
const claudeCalls: ClaudeCall[] = []

/** What a request is, told apart by the shape claude.ts gives it. */
function kindOf(body: any, apiKey: string): string {
  const fields = body?.output_config?.format?.schema?.properties ?? {}
  if (body?.max_tokens === 1) return apiKey === WRONG_KEY ? "key test (wrong key on purpose)" : "key test"
  if (fields.steps) return "build lesson"
  if (fields.result) return "photo check"
  return "question"
}

function photosText(kind: string, images: Seen[]): string {
  if (images.length === 0) return "none"
  if (kind === "photo check") {
    return images.length > 1 ? `expert ${seenText(images[0])}, learner ${seenText(images.at(-1))}` : `learner ${seenText(images[0])}`
  }
  return images.map(seenText).join(", ")
}

/** Why a request got no answer, in words. */
function noAnswer(err: any): string {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `no answer after ${PHONE_REQUEST_MS / 1000} seconds, the phone's limit for one request`
  }
  const cause = err?.cause
  const why = cause ? [cause.code, cause.message].filter((part) => part).join(": ") : ""
  return why ? `${describe(err)} (${why})` : describe(err)
}

/** One request to Claude, made by the app through the phone's fetch. Recorded for the summary. */
async function claude(url: string, init: any): Promise<Response> {
  const headers: Record<string, string> = init?.headers ?? {}
  let body: any = null
  try {
    body = JSON.parse(String(init?.body))
  } catch {
    // Not JSON. The fake answers 400 to that, and the summary shows it.
  }
  const blocks: any[] = Array.isArray(body?.messages?.[0]?.content) ? body.messages[0].content : []
  const images = blocks.filter((block) => block?.type === "image").map(imageScene)
  const kind = kindOf(body, headers["x-api-key"] ?? "")
  const call: ClaudeCall = {
    n: claudeCalls.length + 1,
    kind,
    model: String(body?.model ?? "?"),
    images,
    photos: photosText(kind, images),
    startedAt: Date.now(),
    ms: null,
    status: null,
    error: "",
    requestId: "",
    stop: "",
    tokens: "",
    text: "",
    body,
  }
  claudeCalls.push(call)

  const signal = AbortSignal.timeout(PHONE_REQUEST_MS)
  let response: Response
  try {
    response = DRY ? await fakeClaude(body, headers, signal) : await fetch(url, {...init, signal})
  } catch (err) {
    call.ms = Date.now() - call.startedAt
    call.status = 0
    call.error = noAnswer(err)
    log("CLAUDE", `${kind} -> no answer after ${(call.ms / 1000).toFixed(1)} s (${call.model}): ${call.error}`)
    // The Mentra App's fetch rejects with a plain {code, message} object, not an Error (docs/DECISIONS.md).
    const timedOut = (err as any)?.name === "TimeoutError" || (err as any)?.name === "AbortError"
    throw {code: timedOut ? "TIMEOUT" : "NETWORK", message: call.error}
  }

  call.ms = Date.now() - call.startedAt
  call.status = response.status
  call.requestId = response.headers.get("request-id") ?? ""
  let data: any = null
  try {
    data = JSON.parse(await response.clone().text())
  } catch {
    // Not JSON, or cut off. The app finds out for itself.
  }
  if (response.ok) {
    call.stop = String(data?.stop_reason ?? "")
    const content: any[] = Array.isArray(data?.content) ? data.content : []
    call.text = content
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text))
      .join(" ")
    if (data?.usage) call.tokens = `in ${data.usage.input_tokens ?? "?"}, out ${data.usage.output_tokens ?? "?"}`
  } else {
    const type = data?.error?.type ? `${data.error.type}: ` : ""
    call.error = data?.error?.message ? `${type}${data.error.message}` : "(no readable error message)"
  }
  log(
    "CLAUDE",
    `${kind} -> HTTP ${call.status} in ${(call.ms / 1000).toFixed(1)} s (${call.model}; photos: ${call.photos})${call.error ? `: ${call.error}` : ""}`,
  )
  return response
}

/** The download of a photo link from the simulated glasses. */
function photoDownload(url: string): Response {
  const name = sceneOfUrl(url)
  if (!name) {
    log("PHONE", `the app asked for ${url}, which is no photo of these glasses`)
    return new Response("not found", {status: 404})
  }
  log("PHONE", `the app downloads photo ${photoNumber(url)} (${SCENE_WORDS[name]})`)
  return new Response(Buffer.from(PICTURES[name], "base64"), {headers: {"content-type": "image/jpeg"}})
}

/** The phone's fetch, as the app sees it. It reaches Claude and the glasses' photo links, and nothing else. */
async function sandboxFetch(input: unknown, init?: any): Promise<Response> {
  const url = String(input)
  if (url === ENDPOINT || url.startsWith("https://api.anthropic.com/")) return claude(url, init)
  if (url.startsWith("https://photos.example/")) return photoDownload(url)
  log("PHONE", `refused a request to ${url}: this simulated phone only reaches Claude and the glasses' photos`)
  throw {code: "NETWORK", message: `The simulated phone does not reach ${url}.`}
}

// ================================================================ the fake Claude (dry runs only)

let fakeCount = 0

/** Wait `ms`, or fail as soon as the phone gives up on the request. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      {once: true},
    )
  })
}

/** The image type the bytes really are, read from their first bytes. */
function mediaTypeOf(base64: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg"
  if (base64.startsWith("iVBORw0KGgo")) return "image/png"
  if (base64.startsWith("R0lGOD")) return "image/gif"
  if (base64.startsWith("UklGR")) return "image/webp"
  return "an unknown type"
}

/**
 * The two rules claude.ts names for structured output: every object lists all
 * its fields in `required`, and has `additionalProperties: false`.
 * Returns the first broken rule, or "".
 */
function schemaProblem(schema: any, path: string): string {
  if (schema?.type === "object") {
    if (schema.additionalProperties !== false) return `${path} must have additionalProperties: false`
    const required: string[] = Array.isArray(schema.required) ? schema.required : []
    for (const [name, inner] of Object.entries(schema.properties ?? {})) {
      if (!required.includes(name)) return `${path}.${name} is missing from required`
      const problem = schemaProblem(inner, `${path}.${name}`)
      if (problem) return problem
    }
  }
  if (schema?.type === "array") return schemaProblem(schema.items, `${path}[]`)
  return ""
}

/**
 * Make an answer fit the schema the app sent, the way structured output does:
 * every field of the schema is there with the right type, and nothing else.
 * Fields the fake knows nothing about are listed in `unknown`.
 */
function fitSchema(schema: any, value: any, path: string, unknown: string[]): any {
  switch (schema?.type) {
    case "object": {
      const out: Record<string, unknown> = {}
      const given = value && typeof value === "object" ? value : {}
      for (const [name, inner] of Object.entries<any>(schema.properties ?? {})) {
        if (!(name in given)) unknown.push(`${path}.${name}`)
        out[name] = fitSchema(inner, given[name], `${path}.${name}`, unknown)
      }
      return out
    }
    case "array":
      return Array.isArray(value) ? value.map((item, i) => fitSchema(schema.items, item, `${path}[${i}]`, unknown)) : []
    case "string":
      if (Array.isArray(schema.enum)) return schema.enum.includes(value) ? value : schema.enum[0]
      return typeof value === "string" ? value : ""
    case "integer":
      return Number.isInteger(value) ? value : 0
    case "number":
      return typeof value === "number" ? value : 0
    case "boolean":
      return typeof value === "boolean" ? value : false
    default:
      return value ?? null
  }
}

function textsOf(blocks: any[]): string {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text))
    .join("\n")
}

/** A lesson, written from the captures in the request: one step per "step finished" capture. */
function fakeLesson(blocks: any[]): unknown {
  const captures: Array<{number: number; step: boolean; words: string}> = []
  for (const block of blocks) {
    if (block?.type !== "text") continue
    const number = /Capture\s+(\d+)/i.exec(String(block.text))
    if (!number) continue
    const quoted = /"([\s\S]*)"/.exec(String(block.text))
    captures.push({number: Number(number[1]), step: !/timed photo/i.test(block.text), words: quoted ? quoted[1]! : String(block.text)})
  }
  const steps = captures
    .filter((capture) => capture.step)
    .map((capture) => {
      const said = capture.words.toLowerCase()
      // Like Claude, keep the expert's own story close to their words.
      const story = (/[^.!?]*\b(grandmother|grandfather|taught me)\b[^.!?]*[.!?]?/i.exec(capture.words)?.[0] ?? "").trim()
      const base = {story, source_capture: capture.number}
      if (/sift|powder|scoop/.test(said)) {
        return {
          ...base,
          title: "Sift in the matcha",
          instruction_spoken: "Sift two scoops of matcha powder into the middle of the bowl.",
          instruction_detailed: "Sifting breaks up lumps, so the tea comes out smooth.",
          tips: [],
          done_looks_like: "A small mound of green powder sits in the middle of the bowl.",
          common_mistake: "Tipping the powder in without the sifter.",
        }
      }
      if (/whisk|foam|water/.test(said)) {
        return {
          ...base,
          title: "Whisk until foamy",
          instruction_spoken: "Pour in a little hot water and whisk fast in a W shape.",
          instruction_detailed: "A fast W motion beats air into the tea and makes the foam.",
          tips: ["Keep the whisk moving from your wrist."],
          done_looks_like: "Green tea with a light foamy top fills the bowl.",
          common_mistake: "Whisking in slow circles, so no foam forms.",
        }
      }
      if (/bowl/.test(said)) {
        return {
          ...base,
          title: "Start with a clean bowl",
          instruction_spoken: "Set a clean, dry tea bowl in front of you.",
          instruction_detailed: "Powder sticks to a wet bowl and forms lumps.",
          tips: [],
          done_looks_like: "An empty, clean, dry tea bowl.",
          common_mistake: "Using a bowl that is still wet.",
        }
      }
      const first = /[^.!?]+[.!?]?/.exec(capture.words)?.[0]?.trim() ?? ""
      return {
        ...base,
        title: "Do the step",
        instruction_spoken: first || "Do the step the expert showed.",
        instruction_detailed: "",
        tips: [],
        done_looks_like: "The step looks finished.",
        common_mistake: "",
      }
    })
  return {
    title: "Making matcha",
    description: "Make a bowl of matcha with a foamy top.",
    category: "Tea",
    estimated_duration_minutes: 5,
    tools_required: ["tea bowl", "sifter", "whisk"],
    ingredients_required: ["matcha powder", "hot water"],
    steps,
  }
}

/** A verdict: the fake "sees" by comparing the learner's drawing with the expert's, or with the step's words. */
function fakeVerdict(blocks: any[]): unknown {
  const images = blocks.filter((block) => block?.type === "image").map(imageScene)
  const learner = sameStep(images.at(-1)?.scene)
  const reference = images.length > 1 ? sameStep(images[0]!.scene) : null
  const text = words(textsOf(blocks))
  const wanted: Scene | null =
    reference ?? (/powder|sift/.test(text) ? "powderBowl" : /whisk|foam/.test(text) ? "foamBowl" : /bowl/.test(text) ? "emptyBowl" : null)
  if (!learner || !wanted) return {result: "unclear", say: "I cannot see your work. Look at it and try again."}
  if (learner === wanted) return {result: "pass", say: "That looks right."}
  // TINKER_DRY_FAULT=check5: the wrong verdict on purpose, to show that check 5 catches it.
  if (FAULT === "check5") return {result: "pass", say: "Looks great, well done."}
  const fixes: Record<string, string> = {
    powderBowl: "There is no powder in the bowl yet. Sift two scoops into the middle.",
    foamBowl: "There is no foam yet. Whisk fast in a W shape.",
    emptyBowl: "Start again with an empty, clean bowl.",
  }
  return {result: "fix", say: fixes[wanted]}
}

function fakeAnswer(blocks: any[]): string {
  const text = textsOf(blocks)
  const asked = /Learner asks: "([^"]*)"/.exec(text)?.[1] ?? text
  if (/how hot|temperature/i.test(asked)) {
    return "Aim for about 80 degrees Celsius, which is 175 Fahrenheit. Let a boiled kettle cool for about two minutes."
  }
  return "I am not sure about that. Ask me again in other words."
}

/**
 * Dry runs only: a stand-in for the Claude API. It answers the way the real
 * one does where it matters for this run:
 *   a wrong key            HTTP 401
 *   a photo LINK           HTTP 400 "Unable to download the file", because it reaches no network,
 *                          just as the real Claude cannot reach photos.example
 *   photo bytes            HTTP 400 when the stated image type does not match the bytes
 *   structured output      JSON that matches the schema in the request exactly
 *   the key test           stop reason "max_tokens", as with the real 1-token request
 * It also refuses, as BUILD-NOTES says the real models do: an unknown model
 * (404), `temperature`, and the wrong thinking switch for the model.
 * Errors have the real API's shape: {type: "error", error: {type, message}}.
 */
async function fakeClaude(body: any, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  const id = `req_dry_run_${++fakeCount}`
  const answer = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), {status, headers: {"content-type": "application/json", "request-id": id}})
  const refuse = (status: number, type: string, message: string) => answer(status, {type: "error", error: {type, message}, request_id: id})
  const reply = (text: string, stopReason: string) => {
    const blocks: any[] = Array.isArray(body.messages?.[0]?.content) ? body.messages[0].content : []
    const imageCount = blocks.filter((block) => block?.type === "image").length
    const inputTokens = Math.round((String(body.system ?? "").length + textsOf(blocks).length) / 4) + imageCount * 410
    return answer(200, {
      id: `msg_dry_run_${fakeCount}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{type: "text", text}],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {input_tokens: Math.max(1, inputTokens), output_tokens: Math.max(1, Math.round(text.length / 4))},
    })
  }

  // TINKER_DRY_FAULT=hang: no answer ever. Only the phone's 60 second limit ends the request.
  if (FAULT === "hang") {
    await delay(10 * PHONE_REQUEST_MS, signal)
    return refuse(500, "api_error", "dry run: still no answer")
  }

  if (headers["x-api-key"] !== DRY_RUN_KEY) return refuse(401, "authentication_error", "invalid x-api-key")
  if (!headers["anthropic-version"]) return refuse(400, "invalid_request_error", "anthropic-version: header is required")
  if (!body || typeof body !== "object") return refuse(400, "invalid_request_error", "dry run: the request body is not JSON")
  if (![PLAN_MODEL, CHECK_MODEL, CHAT_MODEL].includes(body.model)) return refuse(404, "not_found_error", `model: ${body.model}`)
  if (typeof body.max_tokens !== "number") return refuse(400, "invalid_request_error", "max_tokens: Field required")
  if ("temperature" in body) return refuse(400, "invalid_request_error", "dry run: these models refuse temperature")
  const thinking = body.thinking?.type
  const wrongSwitch = String(body.model).includes("sonnet-5-5") ? thinking === "disabled" : thinking === "between_tools"
  if (wrongSwitch) return refuse(400, "invalid_request_error", `dry run: thinking type "${thinking}" is not accepted by ${body.model}`)

  const blocks: any[] = Array.isArray(body.messages?.[0]?.content) ? body.messages[0].content : []
  for (const image of blocks.filter((block) => block?.type === "image")) {
    if (image.source?.type === "url") {
      return refuse(400, "invalid_request_error", "Unable to download the file. Please verify the URL and try again.")
    }
    const stated = String(image.source?.media_type ?? "")
    const actual = mediaTypeOf(String(image.source?.data ?? ""))
    if (stated !== actual) return refuse(400, "invalid_request_error", `dry run: the image is ${actual}, but the request says ${stated}`)
  }

  const schema = body.output_config?.format?.schema
  const lesson = Boolean(schema?.properties?.steps)
  // TINKER_DRY_FAULT=claude529: Claude is overloaded whenever a lesson is built.
  if (FAULT === "claude529" && lesson) return refuse(529, "overloaded_error", "Overloaded")

  // A little time, so the screen goes through "thinking" as with the real Claude.
  await delay(body.max_tokens === 1 ? 150 : lesson ? 1500 : 700, signal)

  if (body.max_tokens === 1) return reply("Hi", "max_tokens")
  if (body.output_config) {
    if (body.output_config.format?.type !== "json_schema" || !schema) {
      return refuse(400, "invalid_request_error", "dry run: output_config.format must be a json_schema with a schema")
    }
    const problem = schemaProblem(schema, "schema")
    if (problem) return refuse(400, "invalid_request_error", `dry run: ${problem}`)
    const wanted = lesson ? fakeLesson(blocks) : schema.properties?.result ? fakeVerdict(blocks) : {}
    const unknown: string[] = []
    const fitted = fitSchema(schema, wanted, "answer", unknown)
    if (unknown.length) {
      fakeNotes.add(`The fake Claude did not know these fields and left them empty: ${unknown.join(", ")}. Teach fakeClaude in this script about them.`)
    }
    return reply(JSON.stringify(fitted), "end_turn")
  }
  return reply(fakeAnswer(blocks), "end_turn")
}

// ================================================================ the simulated phone

let sandbox: any

/** Phone to app. */
function deliver(payload: Record<string, unknown>, requestId?: string): void {
  sandbox.__mentraDeliverBridgeRaw(JSON.stringify(requestId ? {payload, requestId} : {payload}))
}

function event(streamType: string, data: unknown): void {
  deliver({type: "miniapp_event", streamType, data})
}

/** A failed request, answered to the app as {ok: false, error: {code, message}}. */
class PhoneError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Photo copies kept on the phone (session.blob), by name. */
const blobs = new Map<string, {scene: Scene; url: string; mimeType: string}>()
const readers = new Map<string, string>()
let readCount = 0

function blobMeta(key: string) {
  const blob = blobs.get(key)!
  return {
    key,
    mimeType: blob.mimeType,
    size: Math.round((PICTURES[blob.scene].length * 3) / 4),
    createdAt: 1,
    updatedAt: 1,
    uri: `file:///blobs/${key}`,
  }
}

/** The phone's answer to one request from the app. */
function answer(payload: any): unknown {
  switch (payload.type) {
    case "miniapp_storage_get":
      return {value: storage.get(payload.key) ?? null}
    case "miniapp_storage_set":
      storage.set(payload.key, payload.value)
      return null
    case "miniapp_storage_delete":
      storage.delete(payload.key)
      return null
    case "miniapp_speak": {
      const line = Array.isArray(payload.text) ? payload.text.join(" ") : String(payload.text)
      spoken.push(line)
      log("GLASSES SAY", `"${line}"`)
      return {completed: true}
    }
    case "miniapp_photo": {
      photoCount += 1
      const url = `https://photos.example/${scene}-${photoCount}.jpg`
      log("CAMERA", `photo ${photoCount}: ${SCENE_WORDS[scene]}${payload.sound === false ? " (silent timed photo)" : ""}`)
      return {requestId: `photo-${photoCount}`, photoUrl: url, mimeType: "image/jpeg", size: 30000}
    }
    case "miniapp_blob_set_from_url": {
      // The phone downloads the photo into its own storage. The bytes never pass through the app.
      const name = sceneOfUrl(payload.url)
      if (!name) throw new PhoneError("INTERNAL", `Download failed for ${payload.url}`)
      blobs.set(payload.key, {scene: name, url: payload.url, mimeType: payload.mimeType ?? "image/jpeg"})
      log("PHONE", `keeps a copy of photo ${photoNumber(payload.url)} (${SCENE_WORDS[name]})`)
      return blobMeta(payload.key)
    }
    case "miniapp_blob_get":
      return blobs.has(payload.key) ? blobMeta(payload.key) : null
    case "miniapp_blob_open_read": {
      const blob = blobs.get(payload.key)
      if (!blob) throw new PhoneError("INTERNAL", `No kept file named ${payload.key}`)
      const handle = `reader-${++readCount}`
      readers.set(handle, PICTURES[blob.scene])
      log("PHONE", `the app reads its copy of photo ${photoNumber(blob.url)} (${SCENE_WORDS[blob.scene]})`)
      return {handle, meta: blobMeta(payload.key)}
    }
    case "miniapp_blob_read": {
      // The drawings are small, so one read returns the whole file.
      const data = readers.get(payload.handle) ?? ""
      readers.set(payload.handle, "")
      return {base64: data, done: true}
    }
    case "miniapp_blob_close_read":
      readers.delete(payload.handle)
      return null
    case "miniapp_blob_delete": {
      const blob = blobs.get(payload.key)
      if (blob) log("PHONE", `deletes its copy of photo ${photoNumber(blob.url)}`)
      blobs.delete(payload.key)
      return null
    }
    case "miniapp_rgb_led":
      log("LIGHT", String(payload.color))
      return {type: "rgb_led_control_response", state: "success", requestId: payload.requestId}
    default:
      // Speech-to-text settings and the like: accepted, nothing to answer.
      return null
  }
}

/** Notes and errors the app shows on the phone screen are printed as they come. */
function watchScreen(message: any): void {
  if (message.type !== "UI_SEND" || message.requestId) return
  const payload = message.payload ?? {}
  if (message.channel === "transcriptionUpdate" && payload.speaker === "system") {
    screenNotes.push(String(payload.text))
    log("SCREEN NOTE", String(payload.text))
  }
  if (message.channel === "tutorialGenerated" && payload.status === "error") log("SCREEN", `lesson build failed: ${payload.error}`)
}

/** App to phone. The Mentra SDK calls this for every message. */
function dispatch(iface: string, method: string, argsJson: string): null {
  if (iface !== "__bridge" || method !== "send") return null
  const [raw] = JSON.parse(argsJson) as [string]
  const envelope = JSON.parse(raw) as {payload: any; requestId?: string}
  const payload = {...envelope.payload, requestId: envelope.requestId ?? envelope.payload?.requestId}
  sent.push(payload)
  watchScreen(payload)
  if (payload.type === "miniapp_connect") {
    queueMicrotask(() =>
      deliver({
        type: "miniapp_connect_ack",
        userId: "test-user",
        packageName: "com.mentra.tinker",
        capabilities: {hasCamera: true, hasMicrophone: true},
        visibility: "foreground",
        colorScheme: "light",
        permissions: {camera: true, microphone: true},
      }),
    )
  } else if (envelope.requestId) {
    const requestId = envelope.requestId
    queueMicrotask(() => {
      let result: Record<string, unknown>
      try {
        result = {type: "miniapp_request_result", ok: true, data: answer(payload)}
      } catch (err) {
        const code = err instanceof PhoneError ? err.code : "INTERNAL"
        result = {type: "miniapp_request_result", ok: false, error: {code, message: describe(err)}}
      }
      deliver(result, requestId)
    })
  }
  return null
}

// ================================================================ waiting, the phone screen and the person

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Ends the run early: a wait ran out, or something the rest of the run needs did not happen. */
class Stop extends Error {}

/** Wait until `check` gives something truthy. Stops the run when its own limit or the run's limit is reached. */
async function until<T>(what: string, check: () => T | null | undefined | false, seconds: number): Promise<T> {
  const ownEnd = Date.now() + seconds * 1000
  const end = Math.min(ownEnd, deadline)
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() >= end) {
      throw new Stop(
        ownEnd > deadline
          ? `The run reached its limit of ${RUN_LIMIT_TEXT} while waiting for ${what}.`
          : `Waited ${seconds} s for ${what}, and it did not happen.`,
      )
    }
    await sleep(25)
  }
}

/** Like `until`, but gives back null instead of stopping the run. */
async function waitFor<T>(check: () => T | null | undefined | false, ms: number): Promise<T | null> {
  const end = Math.min(Date.now() + ms, deadline)
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() >= end) return null
    await sleep(25)
  }
}

/** Messages the app sent to the phone screen on one channel, from message number `from` on. */
function screen(channel: string, from = 0): any[] {
  const out: any[] = []
  for (let i = from; i < sent.length; i++) {
    const message = sent[i]
    if (message.type === "UI_SEND" && message.channel === channel && !message.requestId) out.push(message.payload)
  }
  return out
}

function last(channel: string, from = 0): any {
  return screen(channel, from).at(-1)
}

/** What the glasses said from message number `from` on. */
function spokenSince(from: number): string[] {
  return sent
    .slice(from)
    .filter((message) => message.type === "miniapp_speak")
    .map((message) => (Array.isArray(message.text) ? message.text.join(" ") : String(message.text)))
}

/** True while the screen shows the app as idle: no command running, nothing being said. */
function appQuiet(): boolean {
  return (last("assistantState")?.state ?? "idle") === "idle"
}

/** Did the app react since message `mark`: start thinking or speaking, say something, or take a photo someone asked for. */
function reactedSince(mark: number): boolean {
  for (let i = mark; i < sent.length; i++) {
    const message = sent[i]
    if (message.type === "miniapp_speak") return true
    if (message.type === "miniapp_photo" && message.sound !== false) return true // a silent timed photo is nobody's answer
    if (message.type === "UI_SEND" && !message.requestId && message.channel === "assistantState") {
      if (message.payload?.state === "thinking" || message.payload?.state === "speaking") return true
    }
  }
  return false
}

/**
 * After the person asked for something at message `mark`: wait until `found`
 * gives a value, or until the app has finished without one (it reacted and is
 * quiet again). Gives back null in the second case.
 */
async function outcome<T>(what: string, mark: number, found: () => T | null | undefined | false, seconds: number): Promise<T | null> {
  let quietAt = 0
  const result = await until(
    what,
    () => {
      const value = found()
      if (value) return {value}
      if (reactedSince(mark) && appQuiet()) {
        quietAt ||= Date.now()
        if (Date.now() - quietAt >= 500) return {value: null}
      } else {
        quietAt = 0
      }
      return null
    },
    seconds,
  )
  return result.value
}

/** Wait until the app is quiet, then the person's pause. */
async function pause(ms = PERSON_PAUSE_MS): Promise<void> {
  for (;;) {
    await until("the app to finish what it is doing", appQuiet, COMMAND_MS / 1000)
    await sleep(ms)
    if (appQuiet()) return
  }
}

/** Where a sentence was said: the message number it started at, and the time. */
interface Said {
  mark: number
  at: number
}

/**
 * Say one sentence into the glasses, after the app has gone quiet and the
 * person's pause. Speech-to-text first sends a half-finished guess, then the
 * finished sentence. When the app does not react, the person says it again.
 */
async function say(sentence: string, options: {pauseMs?: number; reaction?: boolean} = {}): Promise<Said> {
  for (let attempt = 1; ; attempt++) {
    await pause(options.pauseMs)
    const mark = sent.length
    log("PERSON SAYS", `"${sentence}"${attempt > 1 ? " (says it again)" : ""}`)
    const parts = sentence.split(" ")
    if (parts.length >= 3) {
      const guess = parts.slice(0, Math.ceil(parts.length / 2)).join(" ")
      event("transcription:en-US", {text: guess, isFinal: false, language: "en-US", source: "cloud"})
      await sleep(400)
    }
    event("transcription:en-US", {text: sentence, isFinal: true, language: "en-US", source: "cloud"})
    const said = {mark, at: Date.now()}
    if (options.reaction === false) return said
    if (attempt === 1) reactionsWanted += 1
    if (await waitFor(() => reactedSince(mark), REACTION_MS)) return said
    if (Date.now() >= deadline) throw new Stop(`The run reached its limit of ${RUN_LIMIT_TEXT} right after "${sentence}".`)
    ignored.push(`"${sentence}"`)
    log("IGNORED", `the app did not react to "${sentence}" within ${REACTION_MS / 1000} s`)
    if (attempt === 3) throw new Stop(`The app ignored "${sentence}" three times.`)
  }
}

let seq = 0

/** Tap a button on the phone screen, once the app is quiet (the screen disables its buttons while the app is busy). */
async function tap(channel: string, payload: unknown): Promise<Said> {
  for (let attempt = 1; ; attempt++) {
    await until("the app to finish what it is doing", appQuiet, COMMAND_MS / 1000)
    const mark = sent.length
    log("SCREEN TAP", `${channel}${attempt > 1 ? " (again)" : ""}`)
    event("_ui", {type: "UI_MESSAGE", channel, payload, seq: ++seq})
    const said = {mark, at: Date.now()}
    if (attempt === 1) reactionsWanted += 1
    if (await waitFor(() => reactedSince(mark), REACTION_MS)) return said
    if (Date.now() >= deadline) throw new Stop(`The run reached its limit of ${RUN_LIMIT_TEXT} right after the ${channel} button.`)
    ignored.push(`the ${channel} button`)
    log("IGNORED", `the app did not react to the ${channel} button within ${REACTION_MS / 1000} s`)
    if (attempt === 2) throw new Stop(`The app ignored the ${channel} button twice.`)
  }
}

/** A request from the phone screen that expects an answer. */
async function ask(channel: string, payload: unknown, seconds: number): Promise<any> {
  const requestId = `rpc-${++seq}`
  event("_ui", {type: "UI_MESSAGE", channel, payload, seq, requestId})
  const reply = await until(
    `the app's answer to ${channel}`,
    () => sent.find((message) => message.type === "UI_SEND" && message.requestId === requestId),
    seconds,
  )
  if (!reply.payload?.ok) throw new Stop(`${channel} failed inside the app: ${reply.payload?.error?.message}`)
  return reply.payload.result
}

/** What the run was doing, for a wait that ran out. */
function whereWeAre(): string[] {
  const lines: string[] = []
  const lastSaid = spoken.slice(-4)
  lines.push(lastSaid.length ? "The last things the glasses said:" : "The glasses had not said anything yet.")
  for (const line of lastSaid) lines.push(`    "${line}"`)
  const learning = last("learningState")
  lines.push(
    `The screen showed: assistant ${last("assistantState")?.state ?? "idle"}, teaching ${last("teachingState")?.status ?? "idle"}, ` +
      `learning ${learning?.active ? `step ${learning.currentStep} of ${learning.totalSteps}` : "no lesson"}.`,
  )
  for (const call of claudeCalls.filter((c) => c.status === null)) {
    lines.push(`Still waiting for Claude: request ${call.n} (${call.kind}), sent ${((Date.now() - call.startedAt) / 1000).toFixed(0)} s ago.`)
  }
  const lastCall = claudeCalls.findLast((c) => c.status !== null)
  if (lastCall) {
    lines.push(`Last finished request to Claude: ${lastCall.kind}, ${statusText(lastCall.status)}${lastCall.error ? `: ${lastCall.error}` : ""}.`)
  }
  return lines
}

// ================================================================ checks

const CHECKS = [
  "1. The app refuses a wrong key and accepts the right one",
  "2. Claude builds a lesson from the recording",
  "3. Published by voice and saved on the phone",
  "4. The lesson starts by voice",
  "5. A wrong attempt is not passed",
  "6. Every correct attempt is passed",
  "7. The lesson ends after the last step",
  "8. A spoken question is answered by Claude",
  "9. The lesson stops by voice",
  "10. No error escaped inside the app",
  "11. Every photo check sent Claude the right photos",
  "12. The app acted on every sentence and tap the first time",
]
const results = new Map<number, {ok: boolean; detail: string}>()

function record(number: number, ok: boolean, detail: string): void {
  const before = results.get(number)
  const merged = before ? {ok: before.ok && ok, detail: `${before.detail} | ${detail}`} : {ok, detail}
  results.set(number, merged)
  log(ok ? "PASS" : "FAIL", `${CHECKS[number - 1]}: ${detail}`)
}

// ================================================================ the story the person acts out

/** The three steps the expert teaches: what the camera sees, what they say, and the words that must reach Claude. */
const TEACH: Array<{scene: Scene; words: string; alone?: boolean; reach: string[]}> = [
  {scene: "emptyBowl", words: "First I set out a clean, dry tea bowl.", reach: ["set out a clean dry tea bowl"]},
  {
    // Said as a sentence of its own, with "Next step." as the next sentence, as speech-to-text often splits it.
    scene: "powderBowl",
    words: "Then I sift two scoops of matcha powder into the middle of the bowl.",
    alone: true,
    reach: ["sift two scoops of matcha powder into the middle of the bowl"],
  },
  {
    scene: "foamBowl",
    words: "I pour in a little hot water and whisk fast in a W shape until the top is foamy. My grandmother taught me to whisk that way.",
    reach: ["whisk fast in a w shape", "my grandmother taught me to whisk that way"],
  },
]

/** For each taught step: did the expert's words reach Claude, followed by the photo the camera took then? */
function inspectBuildRequest(body: any): string[] {
  const blocks: any[] = Array.isArray(body?.messages?.[0]?.content) ? body.messages[0].content : []
  const problems: string[] = []
  TEACH.forEach((step, i) => {
    const at = blocks.findIndex((block) => block?.type === "text" && step.reach.every((phrase) => mentions(block.text, phrase)))
    if (at < 0) {
      problems.push(`step ${i + 1}: the expert's words did not reach Claude`)
      return
    }
    const photo = blocks[at + 1]?.type === "image" ? imageScene(blocks[at + 1]) : null
    if (!photo) problems.push(`step ${i + 1}: no photo came with the expert's words`)
    else if (photo.scene !== step.scene) problems.push(`step ${i + 1}: Claude got ${photo.scene ?? "an unknown picture"}, the camera saw ${step.scene}`)
  })
  return problems
}

/** What a step's finished photo should show: the expert's photo, or when there is none, a guess from the step's words. */
function expectedScene(step: any): {scene: Scene; fromPhoto: boolean} {
  const photo = sameStep(sceneOfUrl(step?.reference_image_url))
  if (photo) return {scene: photo, fromPhoto: true}
  const text = words(`${step?.title ?? ""} ${step?.instruction_spoken ?? ""} ${step?.done_looks_like ?? ""}`)
  const guess: Scene = /powder|sift|scoop/.test(text) ? "powderBowl" : /whisk|foam|froth|water/.test(text) ? "foamBowl" : "emptyBowl"
  log("NOTE", `step ${step?.step_number} has no expert photo, so the camera shows ${SCENE_WORDS[guess]}, chosen from the step's words`)
  return {scene: guess, fromPhoto: false}
}

/** After a photo check: did Claude get the photo the camera just took, and the expert's photo for this step? */
function inspectCheckPhotos(stepNumber: number, expected: {scene: Scene; fromPhoto: boolean}, callsBefore: number): void {
  const call = claudeCalls.slice(callsBefore).findLast((c) => c.kind === "photo check" && c.status === 200)
  if (!call) {
    photoProblems.push(`step ${stepNumber}: no photo check was answered with HTTP 200`)
    return
  }
  const learner = call.images.at(-1)
  const reference = call.images.length > 1 ? call.images[0] : null
  const problems: string[] = []
  if (learner?.scene !== scene) problems.push(`the learner's photo was ${learner?.scene ?? "unknown"}, the camera saw ${scene}`)
  if (learner?.via === "link" && learner.photo !== photoCount) problems.push(`the learner's link was photo ${learner.photo}, not the newest photo ${photoCount}`)
  if (expected.fromPhoto && !reference) problems.push("the expert's photo was not sent")
  if (reference && sameStep(reference.scene) !== expected.scene) problems.push(`the expert's photo was ${reference.scene ?? "unknown"}, expected ${expected.scene}`)
  photoLines.push(`step ${stepNumber}: expert ${reference?.scene ?? "none"}, learner ${learner?.scene ?? "none"}`)
  if (problems.length) photoProblems.push(`step ${stepNumber}: ${problems.join("; ")}`)
}

function printLesson(draft: any): void {
  const show = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "(none)")
  const list = (value: unknown) => (Array.isArray(value) && value.length ? value.join(", ") : "(none)")
  print()
  print("----- the lesson Claude wrote -----")
  print(`Title:        ${show(draft.title)}`)
  print(`Description:  ${show(draft.description)}`)
  print(`Category:     ${show(draft.category)}    Minutes: ${draft.estimated_duration_minutes ?? "?"}`)
  print(`Tools:        ${list(draft.tools_required)}`)
  print(`Ingredients:  ${list(draft.ingredients_required)}`)
  for (const step of Array.isArray(draft.steps) ? draft.steps : []) {
    const photo = sceneOfUrl(step.reference_image_url)
    print(`Step ${step.step_number}. ${show(step.title)}`)
    print(`  says:            ${show(step.instruction_spoken)}`)
    print(`  why:             ${show(step.instruction_detailed)}`)
    print(`  finished looks:  ${show(step.done_looks_like)}`)
    print(`  common mistake:  ${show(step.common_mistake)}`)
    print(`  story:           ${show(step.story)}`)
    print(`  tips:            ${Array.isArray(step.tips) && step.tips.length ? step.tips.join(" | ") : "(none)"}`)
    print(`  expert photo:    ${photo ? `photo ${photoNumber(step.reference_image_url)}, ${SCENE_WORDS[photo]}` : "none"}`)
  }
  print("-----------------------------------")
  print()
}

// ================================================================ building and starting the app

/** Build the app exactly as `bun run build` does for the phone, and read the background file it wrote. */
async function buildApp(): Promise<string> {
  // The key stays out of the build's environment, so no build setting can ever copy it into the bundle.
  const env: Record<string, string | undefined> = {...process.env}
  delete env.TINKER_CLAUDE_KEY
  const file = join(ROOT, "dist/background/index.js")
  let problem = ""
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      // Other programs (bun test, other agents) build into dist/ too. A build that ran at the same moment can
      // delete or half-write the file. Wait, then build again.
      log("BUILD", `${problem} Another build may have run at the same moment. Building again in 10 s.`)
      await sleep(10_000)
    }
    const build = Bun.spawnSync(["bun", "run", "build"], {cwd: ROOT, env, timeout: BUILD_MS})
    if (build.exitCode !== 0) {
      const output = `${build.stderr.toString()}\n${build.stdout.toString()}`.trim()
      problem = build.exitedDueToTimeout ? `The build took longer than ${BUILD_MS / 1000} s.` : `The build failed:\n${output}`
      // A real error in the code will not go away by building again.
      if (!build.exitedDueToTimeout && !/ENOENT|EEXIST|ENOTEMPTY|EBUSY/.test(output)) break
      continue
    }
    try {
      const code = readFileSync(file, "utf8")
      new vm.Script(code, {filename: "dist/background/index.js"}) // throws when the file is cut off
      return code
    } catch (err) {
      problem = err instanceof SyntaxError ? "dist/background/index.js is cut off." : `dist/background/index.js could not be read: ${describe(err)}.`
    }
  }
  throw new Stop(problem)
}

async function startApp(code: string): Promise<void> {
  const appConsole = {
    log: (...args: unknown[]) => log("APP LOG", args.map(String).join(" ")),
    info: (...args: unknown[]) => log("APP LOG", args.map(String).join(" ")),
    debug: () => {},
    trace: () => {},
    warn: (...args: unknown[]) => log("APP WARNING", args.map(String).join(" ")),
    error: (...args: unknown[]) => {
      const line = args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" ")
      consoleErrors.push(line)
      log("APP ERROR", line)
    },
  }
  // Only what Mentra's docs list for the background engine. No window, document, process or require.
  sandbox = vm.createContext({
    console: appConsole,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    AbortController,
    AbortSignal,
    crypto: {getRandomValues: (array: Uint8Array) => crypto.getRandomValues(array), randomUUID: () => crypto.randomUUID()},
    fetch: sandboxFetch,
    __dispatch: dispatch,
  })
  vm.runInContext(code, sandbox, {filename: "dist/background/index.js"})
  sandbox.__mentraInitCallback("session-1")
  // The app reads its saved key and lessons after it has registered all its handlers.
  await until("the app to start", () => sent.some((message) => message.type === "miniapp_storage_get"), 10)
  await sleep(200)
  event("_ui", {type: "UI_OPEN"})
  await until("the first screen snapshot", () => last("snapshot"), 10)
  event("glasses_connection", {connected: true, modelName: "Mentra Live"})
  log("PHONE", "app started, screen open, glasses connected")
}

// ================================================================ the run

async function run(): Promise<void> {
  print("Tinker: the whole app on a simulated phone, with " + (DRY ? "a FAKE Claude (dry run)" : "the REAL Claude API"))
  print(new Date().toString())
  if (DRY) {
    print("DRY RUN: no request leaves this machine. Every Claude reply below is made up by this program.")
    if (FAULT) print(`DRY RUN: the fault "${FAULT}" is switched on: ${FAULTS[FAULT]}.`)
    if (rawKey) print("DRY RUN: TINKER_CLAUDE_KEY is set, and not used.")
  } else {
    print(`Key: starts with "sk-ant-", ends in "${KEY.slice(-4)}", ${KEY.length} characters. It is never printed.`)
    if (process.env.TINKER_DRY_FAULT) print("TINKER_DRY_FAULT is ignored, because this is not a dry run.")
  }
  print(`Models: lesson ${PLAN_MODEL}, photo check ${CHECK_MODEL}, questions ${CHAT_MODEL}`)
  print(
    `About 9 requests to Claude. Each gets ${PHONE_REQUEST_MS / 1000} s, as on the phone. The whole run stops by itself after ${RUN_LIMIT_TEXT}.`,
  )
  print(
    `The person waits ${(PERSON_PAUSE_MS / 1000).toFixed(1)} s after the app goes quiet before speaking ` +
      `(coach.ts: ECHO_REPLY_MS ${ECHO_REPLY_MS ?? "not found"}, QUIET_AFTER_SPEECH_MS ${QUIET_AFTER_SPEECH_MS ?? "not found"}).`,
  )
  print("The camera pictures are drawings made for this test, not real photos.\n")

  const code = await buildApp()
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 12)
  log("BUILD", `dist/background/index.js built (${code.length} characters, sha256 ${hash})`)
  await startApp(code)

  // ---- 1. a wrong key, then the right key, pasted on the phone screen. The app tests each with one request.
  log("SCREEN", "paste a WRONG key on purpose and tap Save key")
  const wrong = await ask("setKey", {key: WRONG_KEY}, PHONE_REQUEST_MS / 1000 + 15)
  const wrongCall = claudeCalls.findLast((c) => c.kind === "key test (wrong key on purpose)")
  log("SCREEN", "paste the Claude key and tap Save key")
  const right = await ask("setKey", {key: KEY}, PHONE_REQUEST_MS / 1000 + 15)
  const wrongStatus = wrongCall ? statusText(wrongCall.status) : "no request"
  record(
    1,
    wrong?.ok === false && wrongCall?.status === 401 && right?.ok === true,
    `${wrong?.ok === false ? `wrong key refused (${wrongStatus}), the screen said "${wrong.error}"` : "the wrong key was ACCEPTED"}; ` +
      `${right?.ok ? "the right key was tested and saved on the phone" : `the right key was refused: "${right?.error}"`}`,
  )
  if (!right?.ok) throw new Stop("Claude did not accept the key, so nothing else can run.")

  // ---- 2. teach a lesson by voice
  await tap("startTeaching", {targetSkill: "making matcha"})
  await until("the recording to start", () => last("teachingState")?.status === "recording", 10)
  for (const [i, step] of TEACH.entries()) {
    scene = step.scene
    let said: Said
    if (step.alone) {
      await say(step.words, {reaction: false}) // only words: the app keeps them for the step, and says nothing
      said = await say("Next step.", {pauseMs: 1000})
    } else {
      said = await say(`${step.words} Next step.`)
    }
    const saved = await outcome(`step ${i + 1} to be saved`, said.mark, () => (last("teachingState")?.stepCount ?? 0) >= i + 1, COMMAND_MS / 1000)
    if (!saved) throw new Stop(`The app did not save step ${i + 1}. The glasses said: "${spokenSince(said.mark).join(" ")}"`)
  }

  // "Finish lesson." The app invites a second try when the build fails, so the person tries once more.
  let generated: any = null
  let buildSeconds = 0
  const buildErrors: string[] = []
  for (let attempt = 1; attempt <= 2 && !generated; attempt++) {
    const said = await say("Finish lesson.")
    const result = await outcome("Claude to build the lesson", said.mark, () => last("tutorialGenerated", said.mark), COMMAND_MS / 1000)
    buildSeconds = (Date.now() - said.at) / 1000
    if (result?.status === "success") generated = result
    else buildErrors.push(result ? String(result.error) : "the app finished without a lesson and without an error")
  }
  if (!generated) {
    record(2, false, `no lesson after ${buildErrors.length} tries. ${buildErrors.map((e, i) => `Try ${i + 1}: ${e}`).join(" ")}`)
    throw new Stop("Claude did not build the lesson, so the rest of the run cannot happen.")
  }
  const draft = generated.tutorial
  const steps: any[] = Array.isArray(draft?.steps) ? draft.steps : []
  const used = claudeCalls.findLast((c) => c.kind === "build lesson" && c.status === 200)
  const requestProblems = used ? inspectBuildRequest(used.body) : ["no lesson request was answered with HTTP 200"]
  const stepProblems: string[] = []
  if (steps.length < 2 || steps.length > 4) stepProblems.push(`${steps.length} steps, expected 2 to 4`)
  for (const step of steps) {
    if (!String(step.instruction_spoken ?? "").trim()) stepProblems.push(`step ${step.step_number} has nothing to say`)
    if (!String(step.done_looks_like ?? "").trim()) stepProblems.push(`step ${step.step_number} does not say what finished looks like`)
  }
  const problems = [...requestProblems, ...stepProblems]
  record(
    2,
    problems.length === 0,
    `"${draft?.title}", ${steps.length} steps, ${buildSeconds.toFixed(1)} s from "Finish lesson" to the draft` +
      (buildErrors.length ? ` (on try ${buildErrors.length + 1}; try 1 failed: ${buildErrors[0]})` : "") +
      `; Claude got the expert's words and photos (${used?.photos ?? "none"})` +
      (problems.length ? `; PROBLEMS: ${problems.join("; ")}` : ""),
  )
  printLesson(draft)
  const grandmother = steps.some((step) => /grandmother/i.test(`${step.story} ${step.instruction_detailed}`))
  log("NOTE", `the expert's grandmother ${grandmother ? "IS" : "is NOT"} kept in the lesson's story or reasons`)

  // ---- 3. publish by voice
  await until("the draft to wait for review", () => last("teachingState")?.status === "review", 10)
  const publishSaid = await say("Publish lesson.")
  const listed = await outcome(
    "the lesson to be published",
    publishSaid.mark,
    () => last("tutorialList", publishSaid.mark)?.tutorials?.find((t: any) => t.id === draft.id && t.status === "published"),
    COMMAND_MS / 1000,
  )
  await until("the app to finish publishing", appQuiet, 30)
  let stored: any[] = []
  try {
    stored = JSON.parse(storage.get("library") ?? "[]")
  } catch {
    stored = []
  }
  const kept = Array.isArray(stored) && stored.some((lesson) => lesson?.id === draft.id)
  record(
    3,
    Boolean(listed) && kept && last("teachingState")?.status === "idle",
    `${listed ? "in the library as published" : "NOT in the library"}, ${kept ? "saved in the phone's storage" : "NOT in the phone's storage"}; ` +
      `the glasses said "${spokenSince(publishSaid.mark).join(" ")}"`,
  )
  if (!listed) throw new Stop("The lesson was not published, so it cannot be learned.")

  // ---- 4. learn it by voice, with photo checks
  const startSaid = await say("Start lesson.")
  const begun = await outcome(
    "the lesson to start",
    startSaid.mark,
    () => {
      const state = last("learningState", startSaid.mark)
      return state?.active && state.tutorialId === draft.id && state
    },
    30,
  )
  record(4, Boolean(begun), begun ? `step 1 of ${begun.totalSteps}` : `no lesson started; the glasses said "${spokenSince(startSaid.mark).join(" ")}"`)
  if (!begun) throw new Stop("The lesson did not start.")

  let wrongTried = false
  const correct: Array<{line: string; pass: boolean}> = []
  for (let guard = 0; guard < 12; guard++) {
    const state = last("learningState")
    if (!state?.active) break
    const expected = expectedScene(state.stepData)
    // The wrong attempt: the empty bowl, at the step whose finished photo shows the powder.
    const wrongNow = !wrongTried && expected.scene === "powderBowl"
    if (wrongNow) wrongTried = true
    scene = wrongNow ? "emptyBowl" : expected.scene === "powderBowl" ? "powderBowlAgain" : expected.scene

    // "Check." The app asks for a second try when a check fails, so the person tries once more.
    let verdict: any = null
    let seconds = 0
    let why = ""
    for (let attempt = 1; attempt <= 2 && !verdict; attempt++) {
      const callsBefore = claudeCalls.length
      const said = await say("Check.")
      verdict = await outcome(`the verdict on step ${state.currentStep}`, said.mark, () => last("stepVerdict", said.mark), COMMAND_MS / 1000)
      seconds = (Date.now() - said.at) / 1000
      if (verdict) {
        inspectCheckPhotos(state.currentStep, expected, callsBefore)
        break
      }
      const failed = claudeCalls.slice(callsBefore).filter((c) => c.status !== 200)
      why = failed.length
        ? failed.map((c) => `${statusText(c.status)}${c.error ? ` (${c.error})` : ""}`).join(", ")
        : `the glasses said "${spokenSince(said.mark).join(" ")}"`
      log("NO VERDICT", `step ${state.currentStep}, try ${attempt}: ${why}`)
    }
    if (!verdict) {
      record(wrongNow ? 5 : 6, false, `step ${state.currentStep}: no verdict after 2 tries; ${why}`)
      throw new Stop("The photo check does not work, so the lesson cannot go on.")
    }

    const line = `step ${verdict.step} with ${SCENE_WORDS[scene]}: ${verdict.result}, "${verdict.say}" (${seconds.toFixed(1)} s)`
    if (wrongNow) {
      record(5, verdict.result !== "pass", line)
    } else {
      correct.push({line, pass: verdict.result === "pass"})
      log("VERDICT", line)
    }
    const moved = () => {
      const now = last("learningState")
      return now && (!now.active || now.currentStep !== state.currentStep || now.sessionId !== state.sessionId)
    }
    if (verdict.result === "pass") {
      await until("the next step or the end of the lesson", moved, 30)
    } else if (!wrongNow) {
      // A correct attempt that was not passed: move on, so the rest of the run still happens.
      const said = await say("Next step.")
      if (!(await outcome("the next step or the end of the lesson", said.mark, moved, 30))) throw new Stop("The lesson did not move on after \"Next step.\"")
    }
  }
  record(6, correct.length > 0 && correct.every((c) => c.pass), correct.map((c) => c.line).join(" | ") || "no correct attempt was checked")
  const end = last("learningState")
  record(7, end?.active === false && end?.finished === true, `active: ${end?.active}, finished: ${end?.finished}`)
  if (!wrongTried) record(5, false, "no step used the powder photo, so the wrong attempt was not tried")

  // ---- 5. a spoken question about the built-in lesson
  await tap("startLearning", {tutorialId: BUILT_IN_ID})
  await until(
    "the built-in lesson to start",
    () => {
      const state = last("learningState")
      return state?.active && state.tutorialId === BUILT_IN_ID
    },
    10,
  )
  let answered: {reply: string; seconds: number} | null = null
  const questionErrors: string[] = []
  for (let attempt = 1; attempt <= 2 && !answered; attempt++) {
    const callsBefore = claudeCalls.length
    const said = await say("Tinker, how hot should the water be?")
    await outcome("the answer", said.mark, () => false, COMMAND_MS / 1000)
    const call = claudeCalls.slice(callsBefore).findLast((c) => c.kind === "question")
    // Claude's words must reach the glasses. The first words are enough: the app may add a word to make them safe to say.
    const opening = words(call?.text).split(" ").slice(0, 8).join(" ")
    const reply = spokenSince(said.mark).find((line) => opening !== "" && words(line).includes(opening))
    if (call?.status === 200 && reply) answered = {reply, seconds: (Date.now() - said.at) / 1000}
    else if (call?.status === 200) questionErrors.push(`Claude answered "${call.text}", but the glasses did not say it`)
    else questionErrors.push(call ? `${statusText(call.status)}${call.error ? ` (${call.error})` : ""}` : "no request to Claude")
    if (!answered) log("NO ANSWER", `try ${attempt}: ${questionErrors.at(-1)}`)
  }
  record(
    8,
    Boolean(answered) && /\b(80|175|eighty)\b/i.test(answered!.reply),
    answered ? `"${answered.reply}" (${answered.seconds.toFixed(1)} s)` : `no answer after 2 tries: ${questionErrors.join("; ")}`,
  )

  const stopSaid = await say("Stop lesson.")
  const ended = await outcome(
    "the lesson to stop",
    stopSaid.mark,
    () => {
      const state = last("learningState", stopSaid.mark)
      return state && state.active === false && state
    },
    30,
  )
  record(9, Boolean(ended) && ended.finished === false, ended ? `learning ended, finished: ${ended.finished}` : "the lesson did not stop")
}

// ================================================================ checks made from the whole run, and the summary

function finalChecks(): void {
  record(10, consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join(" | ") : "no errors logged by the app")
  if (photoLines.length || photoProblems.length) {
    record(11, photoProblems.length === 0, photoProblems.length ? photoProblems.join(" | ") : photoLines.join(" | "))
  }
  if (reactionsWanted > 0) {
    record(
      12,
      ignored.length === 0,
      ignored.length ? `ignored: ${ignored.join(", ")}` : `${reactionsWanted} sentences and taps, each acted on the first time`,
    )
  }
}

/** What an error status usually means, and where to look. */
function hint(status: number, message: string): string {
  const said = message.toLowerCase()
  if (status === 0) {
    return said.includes("seconds")
      ? "Claude did not answer within the phone's 60 seconds. On the phone this request would fail the same way."
      : "No answer reached this machine. Check the internet connection, a proxy or a firewall."
  }
  if (status === 401) return "Claude rejected a key. That is expected for the wrong key on purpose. For the real key: copy it again from the Claude Console."
  if (status === 403) return "The key is known but may not do this. Check its workspace and permissions in the Claude Console."
  if (status === 404) return "Claude does not know something named in the request, most likely a model. See PLAN_MODEL, CHECK_MODEL and CHAT_MODEL in src/background/claude.ts."
  if (said.includes("credit")) return "The account has no credit left. Add credit in the Claude Console."
  if (status === 400 && said.includes("download")) return "Claude could not open the made-up photo links. That is expected: the app then sends the photo bytes."
  if (status === 400 && said.includes("thinking")) return "Claude refused the thinking setting. See thinkingOff() in src/background/claude.ts."
  if (status === 400 && /output_config|schema|format/.test(said)) return "Claude refused the JSON shape. See LESSON_SCHEMA and CHECK_SCHEMA in src/background/claude.ts."
  if (status === 400) return "Claude could not use something in the request. Its message names it."
  if (status === 429) return "Too many requests, or the account's limit is used up. Wait a minute and run it again."
  if (status === 529) return "Claude's servers are overloaded. Wait a few minutes and run it again."
  if (status >= 500) return "Claude had a problem on its side. Run it again in a minute."
  return ""
}

/** Print the summary. Returns the exit code. */
function summary(stopReason: string): number {
  print()
  print("=============== SUMMARY ===============")
  print(`Requests to Claude: ${claudeCalls.length}`)
  for (const call of claudeCalls) {
    const time = call.ms === null ? `${((Date.now() - call.startedAt) / 1000).toFixed(1)} s so far` : `${(call.ms / 1000).toFixed(1)} s`
    print(
      `  ${String(call.n).padStart(2)}. at ${since(call.startedAt)} s  ${call.kind.padEnd(31)} ${statusText(call.status).padEnd(13)} ` +
        `${time.padStart(7)}  ${call.model}  photos: ${call.photos}`,
    )
    if (call.status === 200) print(`      stop reason: ${call.stop || "?"}, tokens: ${call.tokens || "?"}`)
    else if (call.status === 0) print(`      ${call.error}`)
    else if (call.status !== null) print(`      Claude said: ${call.error || "(nothing)"}${call.requestId ? `  (request-id ${call.requestId})` : ""}`)
  }
  const hints = new Set<string>()
  for (const call of claudeCalls) {
    if (call.status === null || call.status === 200) continue
    const text = hint(call.status, call.error)
    if (text) hints.add(`${call.status === 0 ? "No answer" : `HTTP ${call.status}`}: ${text}`)
  }
  for (const text of hints) print(`  Hint. ${text}`)
  const linkRefused = claudeCalls.some((c) => c.status === 400 && c.images.some((i) => i.via === "link"))
  const bytesSent = claudeCalls.some((c) => c.images.some((i) => i.via === "bytes"))
  const bytesWorked = claudeCalls.some((c) => c.status === 200 && c.images.some((i) => i.via === "bytes"))
  if (linkRefused) {
    const then = bytesWorked
      ? "then sent the photo bytes, which worked"
      : bytesSent
        ? "then sent the photo bytes, but no request with bytes got an answer with HTTP 200"
        : "did NOT send the photo bytes afterwards"
    print(`Photo links: Claude refused the made-up links (HTTP 400), and the app ${then}.`)
  } else if (claudeCalls.some((c) => c.status === 200 && c.images.some((i) => i.via === "link"))) {
    print("Photo links: Claude opened the photo links itself.")
  }
  if (screenNotes.length) {
    print("Notes the app put on the phone screen:")
    for (const note of screenNotes) print(`  ${note}`)
  }
  for (const note of fakeNotes) print(`DRY RUN NOTE: ${note}`)

  print("\nChecks:")
  let failed = 0
  let notRun = 0
  CHECKS.forEach((name, i) => {
    const result = results.get(i + 1)
    if (!result) notRun += 1
    else if (!result.ok) failed += 1
    print(`  ${result ? (result.ok ? "PASS   " : "FAIL   ") : "NOT RUN"}  ${name}`)
  })
  if (stopReason) print(`  STOPPED EARLY: ${stopReason}`)
  print(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)} s. The glasses spoke ${spoken.length} times. ${photoCount} photos taken.`)
  if (DRY) print("DRY RUN: nothing above came from Claude.")
  if (!stopReason && failed === 0 && notRun === 0) {
    print("RESULT: ALL CHECKS PASSED")
    return 0
  }
  const parts = [`${failed} CHECK(S) FAILED`]
  if (notRun) parts.push(`${notRun} NOT RUN`)
  if (stopReason) parts.push("THE RUN STOPPED EARLY")
  print(`RESULT: ${parts.join(", ")}`)
  return 1
}

let finished = false

/** Print the summary and end the program. Runs once, whichever way the run ends. */
function finish(stopReason: string): void {
  if (finished) return
  finished = true
  finalChecks()
  process.exit(summary(stopReason))
}

/** Stop the run, say why and where it was, then print the summary. */
function stopNow(reason: string): void {
  if (finished) return
  log("STOPPED", reason)
  for (const line of whereWeAre()) print(`              ${line}`)
  finish(reason)
}

// The last net: whatever is still running when the run limit comes, the run ends and prints its summary.
setTimeout(() => stopNow(`The run reached its limit of ${RUN_LIMIT_TEXT}.`), RUN_LIMIT_MS - SUMMARY_MS + 3000)
// A thrown error that nothing catches restarts the background on the phone (index.ts, `safely`), so the run stops.
process.on("uncaughtException", (err) => {
  consoleErrors.push(`uncaught: ${describe(err)}`)
  stopNow(`An error escaped and nothing caught it: ${describe(err)}`)
})
// A promise that fails with nobody waiting for it does not restart anything. It is reported and fails check 10.
process.on("unhandledRejection", (err) => {
  consoleErrors.push(`unhandled rejection: ${describe(err)}`)
  log("APP ERROR", `a promise failed and nobody handled it (in the app or in this program): ${describe(err)}`)
})

try {
  await run()
  finish("")
} catch (err) {
  stopNow(err instanceof Stop ? err.message : `The test program failed: ${err instanceof Error ? (err.stack ?? err.message) : describe(err)}`)
}
