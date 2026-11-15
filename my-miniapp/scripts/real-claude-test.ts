/**
 * real-claude-test.ts: runs the app's own Claude code against the REAL Claude API.
 *
 * WHY THIS EXISTS
 *   Everything in src/background/claude.ts has only ever talked to fakes
 *   (test/claude.test.ts). Fakes prove the requests have the shape we meant.
 *   They cannot prove that Claude accepts that shape, that the model names
 *   exist, or that the answers are any good. This program is that proof. It
 *   calls the same `createBrain()` the phone uses, with a real key, and prints
 *   what came back.
 *
 * WHAT IT DOES
 *   Nine checks, in order, about nine small requests in total:
 *     1  the key works
 *     2  a wrong key is refused with status 401
 *     3  a lesson is built from three captures (words plus a picture each)
 *     4  a correct attempt passes the photo check
 *     5  a wrong attempt does not pass
 *     6  a picture sent as a link
 *     7  a check with no expert picture, against the built-in lesson
 *     8  a question the lesson can answer
 *     9  a question the lesson cannot answer
 *   Each check prints what is sent, PASS or FAIL (or NOTE), the seconds it
 *   took and Claude's actual reply. Then a summary table and one RESULT line.
 *   Exit code: 0 nothing failed, 1 something failed, 2 no usable key was given.
 *
 * THE KEY
 *   Read from the environment variable TINKER_CLAUDE_KEY. It is never printed.
 *   Only this is shown: that it starts with "sk-ant-", its last 4 characters
 *   and its length. Every line this program prints goes through `hide()`,
 *   which replaces the key with "[key hidden]" should it ever turn up in an
 *   error message or a reply.
 *
 * THE PICTURES
 *   Four small drawings of a matcha bowl (scripts/test-photos.ts, made by
 *   scripts/make-test-photos.py). They are drawings, not real photos, and the
 *   output says so.
 *
 * DRY RUN
 *   TINKER_DRY_RUN=1 replaces `fetch` with a fake that answers the way Claude
 *   would, so the program itself can be tried with no key and no network.
 *   Nothing in a dry run says anything about the real API.
 *   TINKER_DRY_FAULT=check5 makes the fake wrongly pass the empty bowl, to show
 *   that a failure is reported. TINKER_DRY_FAULT=link400 makes the fake refuse
 *   the link in check 6, to show the NOTE. Both only work in a dry run.
 *
 * HOW IT IS RUN
 *   This file lives in scripts/, outside src/, so Node things like `process`
 *   are allowed here (they are not allowed in src/background). It is bundled
 *   into one file and run with Node 18 or newer. See scripts/README.md.
 *
 * It has no dependencies besides this project's own source files.
 */

import {CHAT_MODEL, CHECK_MODEL, PLAN_MODEL, createBrain} from "../src/background/claude"
import {BrainError} from "../src/background/contracts"
import type {CaptureInput, DraftStep, ImageInput, LessonDraft, Verdict} from "../src/background/contracts"
import {BUILT_IN_TUTORIALS} from "../src/background/seed"
import type {TutorialStepModel} from "../src/shared/channels"
import {emptyBowl, foamBowl, powderBowl, powderBowlAgain} from "./test-photos"

// The project has no Node type package, so the few parts of `process` used
// here are described by hand.
declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
  version: string
}

// ---------- settings ----------

/** The nine checks, in the order they run. Check number N is NAMES[N - 1]. */
const NAMES = [
  "Key check",
  "A wrong key is rejected properly",
  "Build a lesson from three captures (photo bytes)",
  "Check a correct attempt",
  "Check a wrong attempt",
  "A photo sent as a link",
  "Check against the built-in lesson with no expert photo",
  "Answer a question",
  "Answer a question the lesson cannot answer",
]
const TOTAL_CHECKS = NAMES.length

/** A key that is wrong on purpose, for check 2. It is not a secret and may be printed. */
const WRONG_KEY = "sk-ant-api03-this-key-is-wrong-on-purpose"

/** The key used in a dry run. The fake accepts this one and nothing else. */
const DRY_RUN_KEY = "sk-ant-test-dry-run"

/** A public picture of the team's cartoon mascot, for check 6. It shows no bowl and no matcha. */
const MASCOT_LINK =
  "https://raw.githubusercontent.com/ChawinMin/Immersethebay2026/14def270d17092074d7e84f27fb358582a3d6843/my-miniapp/IMBIcon.png"

/** Give up on one request after this long, so a dead connection cannot hang the run. */
const TIME_LIMIT_MS = 120_000

/** The Mentra App on the phone stops waiting for a request after this long (see claude.ts, TIME LIMIT). */
const PHONE_LIMIT_SECONDS = 60

const ENDPOINT = "https://api.anthropic.com/v1/messages"

// ---------- printing, with the key always hidden ----------

/** Every text that must never appear in the output: the key as given and the key as cleaned up. */
const secrets: string[] = []

function addSecret(value: string | undefined): void {
  // Very short values are left out: replacing a 1-letter "key" would scramble all output.
  if (value && value.length >= 8 && secrets.indexOf(value) < 0) {
    secrets.push(value)
    secrets.sort((a, b) => b.length - a.length) // longest first, so a part never hides before the whole
  }
}

/**
 * Remove the key from a text. Two nets:
 *   1. the exact key, wherever it appears;
 *   2. anything else shaped like a Claude key, in case the key came back in
 *      a slightly different form. The two made-up keys of this program are
 *      not secrets and stay readable.
 */
function hide(text: string): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join("[key hidden]")
  return out.replace(/sk-ant-[A-Za-z0-9_-]{16,}/g, (found) =>
    found === WRONG_KEY || found === DRY_RUN_KEY ? found : "[key hidden]",
  )
}

/** The only way this program prints. Everything goes through `hide`. */
function print(line = ""): void {
  console.log(hide(line))
}

function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((line) => by + line)
    .join("\n")
}

// ---------- small measuring helpers ----------

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((word) => word !== "").length
}

/** Sentences are counted by their end marks: a full stop, "!" or "?" followed by a space or the end. */
function countSentences(text: string): number {
  return text.split(/[.!?]+(?=\s|$)/).filter((part) => part.trim() !== "").length
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/** A drawing from test-photos.ts in the form claude.ts expects for photo bytes. */
function bytes(data: string): ImageInput {
  return {kind: "base64", data, mediaType: "image/jpeg"}
}

// ---------- the key ----------

/** People paste badly: spaces, line breaks and quotes around the key are removed. Nothing inside it is touched. */
function cleanKey(raw: string): string {
  return raw.replace(/^[\s"'`‘’“”]+|[\s"'`‘’“”]+$/g, "")
}

const HOW_TO_RUN = [
  "This program needs your Claude key in the environment variable TINKER_CLAUDE_KEY.",
  "It never prints the key.",
  "",
  "How to run it (the first line asks for the key without showing it on screen):",
  "  read -rs TINKER_CLAUDE_KEY && export TINKER_CLAUDE_KEY",
  "  node real-claude-test.mjs",
  "",
  "Or in one line (this leaves the key in your shell history):",
  '  TINKER_CLAUDE_KEY="sk-ant-..." node real-claude-test.mjs',
  "",
  "To try the program with no key and no network:",
  "  TINKER_DRY_RUN=1 node real-claude-test.mjs",
]

/**
 * Why a cleaned key cannot be used, or "" when it looks usable.
 * These are checked BEFORE anything is sent, for two reasons. The app itself
 * only accepts keys that start with "sk-ant-". And a value with a space or a
 * line break inside it cannot travel in a request header: Node refuses it
 * with an error text that can contain the value, which must not reach the screen.
 */
function keyProblem(key: string): string {
  if (key === "") return "TINKER_CLAUDE_KEY is not set, or it is empty."
  if (key.indexOf("sk-ant-") !== 0) {
    return `TINKER_CLAUDE_KEY has ${key.length} characters but does not start with "sk-ant-". Claude keys do.`
  }
  if (!/^[\x21-\x7E]+$/.test(key)) {
    return "TINKER_CLAUDE_KEY has a space, a line break or an unusual character inside it. Copy the key again."
  }
  if (key.length < 30) return `TINKER_CLAUDE_KEY has only ${key.length} characters. That is too short for a Claude key.`
  return ""
}

// ---------- fetch: a time limit for real runs, a fake for dry runs ----------

/**
 * Real runs only. Wraps `fetch` so that
 *   - a request with no answer after TIME_LIMIT_MS is stopped, and
 *   - a failed connection says why. Node's own message is only "fetch failed";
 *     the real reason (no internet, a blocked address, a certificate problem)
 *     is in the error's `cause`.
 * claude.ts is not changed by this. It still calls the global `fetch`, turns
 * the error into a BrainError with status 0, and keeps the message.
 */
function installTimeLimit(): void {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    try {
      return await realFetch(input, {...init, signal: AbortSignal.timeout(TIME_LIMIT_MS)})
    } catch (err) {
      const name = (err as {name?: string} | null)?.name
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`No answer after ${TIME_LIMIT_MS / 1000} seconds.`)
      }
      const message = err instanceof Error ? err.message : String(err)
      const cause = (err as {cause?: {code?: string; message?: string}} | null)?.cause
      const why = cause ? [cause.code, cause.message].filter((part) => part).join(": ") : ""
      throw new Error(why ? `${message} (${why})` : message)
    }
  }) as unknown as typeof fetch
}

/** The lesson the fake "writes" in a dry run. Shaped like a real answer to check 3. */
const DRY_RUN_LESSON = {
  title: "Whisking a Bowl of Matcha",
  description: "You will make a bowl of matcha tea with a foamy top, starting from a clean, dry bowl.",
  category: "Tea making",
  estimated_duration_minutes: 5,
  tools_required: ["tea bowl", "sifter", "scoop", "whisk"],
  ingredients_required: ["matcha powder", "hot water"],
  steps: [
    {
      title: "Start with a clean, dry bowl",
      instruction_spoken: "Set a clean, dry tea bowl in front of you.",
      instruction_detailed: "The expert starts with a clean, dry bowl before any powder goes in.",
      tips: [],
      done_looks_like: "An empty, clean, dry tea bowl sits on the table.",
      common_mistake: "Using a bowl that is still wet.",
      story: "",
      source_capture: 1,
    },
    {
      title: "Sift in two scoops of matcha",
      instruction_spoken: "Sift two scoops of matcha powder into the middle of the bowl.",
      instruction_detailed: "The expert sifts two scoops so the powder lands in the middle of the bowl.",
      tips: [],
      done_looks_like: "A small mound of bright green powder sits in the middle of the bowl.",
      common_mistake: "Putting the powder in without sifting it.",
      story: "",
      source_capture: 2,
    },
    {
      title: "Add water and whisk to foam",
      instruction_spoken: "Pour in a little hot water. Whisk fast in a W shape until the top is foamy.",
      instruction_detailed: "Fast whisking in a W shape is what makes the top foamy.",
      tips: ["Whisk in a W shape."],
      done_looks_like: "The bowl holds green tea with a light foamy top and small bubbles.",
      common_mistake: "Whisking too slowly, so no foam forms.",
      story: "My grandmother taught me to whisk in a W shape.",
      source_capture: 3,
    },
  ],
}

/**
 * Dry runs only. Replaces `fetch` with a fake Claude, so no request leaves
 * this machine. The fake tells the four kinds of request apart by the same
 * things claude.ts puts into them:
 *   lesson     output_config carries a schema with a "steps" field
 *   check      output_config carries a schema with a "result" field
 *   key test   max_tokens is 1
 *   question   a system prompt and no output_config
 * Any key other than DRY_RUN_KEY is answered with 401, as the real API does.
 * Errors have the real API's shape: {type: "error", error: {type, message}}.
 */
function installFakeClaude(fault: string): void {
  globalThis.fetch = (async (input: unknown, init?: {method?: string; headers?: Record<string, string>; body?: unknown}) => {
    const answer = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}})
    const refuse = (status: number, type: string, message: string) =>
      answer(status, {type: "error", error: {type, message}, request_id: "req_dry_run"})

    if (String(input) !== ENDPOINT || init?.method !== "POST") return refuse(404, "not_found_error", "Not found")
    const headers = init.headers ?? {}
    if (headers["x-api-key"] !== DRY_RUN_KEY) return refuse(401, "authentication_error", "invalid x-api-key")
    if (!headers["anthropic-version"]) {
      return refuse(400, "invalid_request_error", "anthropic-version: header is required")
    }

    let body: any
    try {
      body = JSON.parse(String(init.body))
    } catch {
      return refuse(400, "invalid_request_error", "The request body is not valid JSON")
    }
    const say = (text: string, stopReason = "end_turn") =>
      answer(200, {
        id: "msg_dry_run",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{type: "text", text}],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {input_tokens: 0, output_tokens: 0},
      })

    const first = body.messages?.[0]?.content
    const blocks: any[] = Array.isArray(first) ? first : []
    const images = blocks.filter((block) => block?.type === "image")
    const texts: string[] = blocks.filter((block) => block?.type === "text").map((block) => String(block.text))
    const schemaFields = body.output_config?.format?.schema?.properties

    // A lesson request. The fake also looks at what this program sent: three
    // numbered captures, each followed by its picture as bytes.
    if (schemaFields?.steps) {
      const captures = texts.filter((text) => /^Capture \d+ at \d+ seconds/.test(text)).length
      const asBytes = images.filter((image) => image.source?.type === "base64").length
      if (captures !== 3 || asBytes !== 3) {
        return refuse(400, "invalid_request_error", `dry run: expected 3 captures with 3 pictures as bytes, got ${captures} and ${asBytes}`)
      }
      return say(JSON.stringify(DRY_RUN_LESSON))
    }

    // A check request. The learner's picture is always the last one (claude.ts
    // puts the expert's first). The fake "sees" by comparing the bytes with
    // the known drawings.
    if (schemaFields?.result) {
      const learner = images[images.length - 1]?.source
      if (!learner) return refuse(400, "invalid_request_error", "dry run: the check request has no picture")
      if (learner.type === "url") {
        if (fault === "link400") {
          return refuse(400, "invalid_request_error", "Unable to download the file. Please verify the URL and try again.")
        }
        return say(JSON.stringify({result: "unclear", say: "I can't see your bowl. Look at your work and try again."}))
      }
      if (learner.data === emptyBowl) {
        // TINKER_DRY_FAULT=check5: the wrong verdict on purpose, to show that check 5 catches it.
        if (fault === "check5") return say(JSON.stringify({result: "pass", say: "Looks great, well done."}))
        return say(
          JSON.stringify({result: "fix", say: "The bowl is still empty. Sift two scoops of matcha into the middle."}),
        )
      }
      if (learner.data === powderBowl || learner.data === powderBowlAgain) {
        return say(JSON.stringify({result: "pass", say: "Nicely done, that looks right."}))
      }
      return say(JSON.stringify({result: "unclear", say: "I can't tell from here. Look at your work and try again."}))
    }

    // The key test: one token, so the real API also stops with "max_tokens".
    if (body.max_tokens === 1) return say("Hi", "max_tokens")

    // A question.
    if (typeof body.system === "string") {
      const question = texts.join("\n")
      if (question.indexOf("How hot") >= 0) {
        return say(
          "Aim for about 80 degrees Celsius, which is 175 Fahrenheit. If your kettle just boiled, leave the lid open for two minutes first.",
        )
      }
      if (question.indexOf("What year") >= 0) {
        return say(
          "I'm not sure when your whisk was made, the lesson does not say. For this step, hold it upright and whisk fast in a W from your wrist.",
        )
      }
      return say("I'm not sure about that one. Ask me again in other words.")
    }

    return refuse(400, "invalid_request_error", "dry run: the fake does not know this kind of request")
  }) as unknown as typeof fetch
}

// ---------- running one check ----------

type Outcome = "PASS" | "FAIL" | "NOTE" | "NOT RUN"

/** One rule of a check: whether it held, and the rule in words with the measured value. */
type Rule = [held: boolean, text: string]

interface Judged {
  outcome: "PASS" | "FAIL" | "NOTE"
  /** Lines shown under the result: every rule with "ok" or "BAD", or the error. */
  details: string[]
  /** Claude's reply as text. "" when there is none to show. */
  reply: string
  /** Lines shown last: things a person has to read and judge. */
  after: string[]
}

interface Row {
  number: number
  name: string
  outcome: Outcome
  ms: number
}

/** PASS when every rule held, FAIL otherwise. Every rule is listed either way. */
function byRules(rules: Rule[], reply: string, after: string[] = []): Judged {
  return {
    outcome: rules.every(([held]) => held) ? "PASS" : "FAIL",
    details: rules.map(([held, text]) => `${held ? "ok " : "BAD"}  ${text}`),
    reply,
    after,
  }
}

/** What an error status usually means, and where to look. "" when there is nothing useful to add. */
function hint(status: number, message: string): string {
  const said = message.toLowerCase()
  if (status === 0) return "No answer reached this machine. Check the internet connection, or a proxy or firewall in between."
  if (status === 401) return "Claude rejected the key. Copy it again from the Claude Console."
  if (status === 403) return "The key is known but may not do this. Check its workspace and permissions in the Claude Console."
  if (status === 404) {
    return "Claude does not know something named in the request, most likely a model. See PLAN_MODEL, CHECK_MODEL and CHAT_MODEL in src/background/claude.ts."
  }
  if (said.indexOf("credit") >= 0) return "The account has no credit left. Add credit in the Claude Console."
  if (status === 400 && said.indexOf("thinking") >= 0) {
    return "Claude refused the thinking setting. See thinkingOff() in src/background/claude.ts."
  }
  if (status === 400 && /output_config|schema|format/.test(said)) {
    return "Claude refused the JSON shape. See LESSON_SCHEMA and CHECK_SCHEMA in src/background/claude.ts."
  }
  if (status === 400) return "Claude could not use something in the request. The message above names it."
  if (status === 429) return "Too many requests, or the account's limit is used up. Wait a minute and run it again."
  if (status >= 500) return "Claude had a problem on its side. Run it again in a minute."
  if (status === 200) return "Claude answered, but the app's code could not use the answer. The message above says why."
  return ""
}

/** An error as lines for the output: its status, its message, and a hint. */
function describeError(err: unknown): string[] {
  if (err instanceof BrainError) {
    const lines = [`Error status: ${err.status}`, `Error message: ${err.message}`]
    const tip = hint(err.status, err.message)
    if (tip) lines.push(`Hint: ${tip}`)
    return lines
  }
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return ["Error status: none (this is not an error from the Claude code, it is a fault in the test program)", `Error message: ${message}`]
}

// ---------- the program ----------

async function main(): Promise<number> {
  const startedAt = Date.now()
  const dryRun = process.env.TINKER_DRY_RUN === "1"
  const fault = dryRun ? (process.env.TINKER_DRY_FAULT ?? "").trim() : ""

  // Whatever is in the variable must never be printed, in a dry run too.
  const rawKey = process.env.TINKER_CLAUDE_KEY ?? ""
  addSecret(rawKey)
  const key = dryRun ? DRY_RUN_KEY : cleanKey(rawKey)
  if (!dryRun) addSecret(key)

  print("Tinker: test of the app's Claude code against the real Claude API")
  print(`${new Date().toString()}  (Node ${process.version})`)

  if (!dryRun) {
    const problem = keyProblem(key)
    if (problem) {
      print()
      print(problem)
      print()
      HOW_TO_RUN.forEach((line) => print(line))
      return 2
    }
  } else if (fault !== "" && fault !== "check5" && fault !== "link400") {
    print()
    print(`TINKER_DRY_FAULT is "${fault}". It can be "check5" or "link400", or left out.`)
    return 2
  }

  if (dryRun) {
    print("DRY RUN: no request leaves this machine")
    print("DRY RUN: every reply below is made up by this program. It says nothing about the real Claude API.")
    if (fault) print(`DRY RUN: the fault "${fault}" is switched on (TINKER_DRY_FAULT).`)
    installFakeClaude(fault)
  } else {
    installTimeLimit()
    if (process.env.TINKER_DRY_FAULT) print("TINKER_DRY_FAULT is ignored, because this is not a dry run.")
  }
  if (dryRun) print("A real run sends about 9 small requests to the real Claude API using your key. This dry run sends none.")
  else print("This sends about 9 small requests to the real Claude API using your key")
  print("The test pictures are drawings made for this test, not real photos.")
  if (dryRun) print(`Key: the dry-run key "${DRY_RUN_KEY}" (made up, not a real key)`)
  else print(`Key: starts with "sk-ant-", ends in "${key.slice(-4)}", ${key.length} characters`)
  print(`Models: lesson ${PLAN_MODEL}, photo check ${CHECK_MODEL}, questions ${CHAT_MODEL}`)

  const brain = createBrain()
  const builtIn = BUILT_IN_TUTORIALS[0]
  const rows: Row[] = []
  const replyLabel = dryRun ? "Made-up reply (dry run):" : "Claude's reply:"

  /**
   * Run one check and print it.
   *   call        the request to Claude. Only this part is timed.
   *   judge       turns the answer into PASS or FAIL.
   *   judgeError  for checks where an error is expected or tolerated. It
   *               returns a verdict for that error, or null for "this error
   *               is a failure like any other".
   * Returns the answer, or undefined when the call threw.
   */
  async function check<T>(spec: {
    number: number
    sending: string[]
    call: () => Promise<T>
    judge: (value: T) => Judged
    judgeError?: (err: unknown) => Judged | null
  }): Promise<T | undefined> {
    print()
    print("-".repeat(72))
    const name = NAMES[spec.number - 1]
    print(`CHECK ${spec.number} of ${TOTAL_CHECKS}: ${name}`)
    spec.sending.forEach((line) => print(line))

    let value: T | undefined
    let answered = false
    let judged: Judged
    const start = Date.now()
    let ms = 0
    try {
      value = await spec.call()
      ms = Date.now() - start
      answered = true
      judged = spec.judge(value)
    } catch (err) {
      if (!answered) ms = Date.now() - start
      // `judgeError` is only for errors from Claude. An error thrown by `judge`
      // itself also lands here, and is reported as a fault of the test program.
      const expected = !answered && spec.judgeError ? spec.judgeError(err) : null
      judged = expected ?? {outcome: "FAIL", details: describeError(err), reply: "", after: []}
    }

    print(`${judged.outcome}  (${seconds(ms)} seconds)`)
    judged.details.forEach((line) => print(indent(line)))
    if (judged.reply !== "") {
      print(replyLabel)
      print(indent(judged.reply))
    }
    judged.after.forEach((line) => print(line))
    if (ms > PHONE_LIMIT_SECONDS * 1000) {
      print(
        `NOTE: this took longer than ${PHONE_LIMIT_SECONDS} seconds. The Mentra App stops waiting after ${PHONE_LIMIT_SECONDS} seconds, so on the phone this request would have failed.`,
      )
    }
    rows.push({number: spec.number, name, outcome: judged.outcome, ms})
    return value
  }

  // ---- 1. Key check
  // Proves the key is accepted, the address and headers are right, and the
  // small model's name and its "thinking off" switch are accepted. Everything
  // else needs this, so the run stops here when it fails.
  await check({
    number: 1,
    sending: [`Sending: a 1-token "hi" to ${CHECK_MODEL} with your key`],
    call: () => brain.testKey(key),
    // The reply is a single token that claude.ts throws away, so there is none to print.
    judge: () => byRules([[true, "Claude accepted the key and the request"]], ""),
  })

  if (rows[0].outcome !== "PASS") {
    print()
    print("Check 1 failed, so nothing else can run. Checks 2 to 9 were not run.")
  } else {
    // ---- 2. A wrong key is rejected properly
    // The app shows "Claude rejected this key" when saving a key fails with
    // status 401 (coach.ts, setKey). This proves that a bad key really arrives
    // as a BrainError with status 401, and not as some other failure.
    await check({
      number: 2,
      sending: [`Sending: the same 1-token request with the made-up key "${WRONG_KEY}"`],
      call: () => brain.testKey(WRONG_KEY),
      judge: () => byRules([[false, "Claude accepted a key that is wrong. It must be refused."]], ""),
      judgeError: (err) =>
        err instanceof BrainError && err.status === 401
          ? byRules(
              [[true, "the call threw a BrainError with status 401"]],
              `status ${err.status}: ${err.message}`,
            )
          : null,
    })

    // ---- 3. Build a lesson from three captures (photo bytes)
    // The heart of teaching mode: the expert's words and photos in, a lesson
    // out. Proves the large model's name, its "thinking off" switch, the JSON
    // shape and photos sent as bytes are all accepted, and shows what Claude
    // makes of a small recording.
    const expertSaid: Array<[atSeconds: number, words: string, picture: string, pictureName: string]> = [
      [10, "I start with a clean, dry tea bowl.", emptyBowl, "emptyBowl"],
      [25, "Then I sift two scoops of matcha powder into the middle of the bowl.", powderBowl, "powderBowl"],
      [
        45,
        "I pour in a little hot water and whisk fast until the top is foamy. My grandmother taught me to whisk in a W shape.",
        foamBowl,
        "foamBowl",
      ],
    ]
    const captures: CaptureInput[] = expertSaid.map(([atSeconds, transcript, picture]) => ({
      transcript,
      atSeconds,
      kind: "step",
      image: bytes(picture),
    }))
    const lesson: LessonDraft | undefined = await check({
      number: 3,
      sending: [
        `Sending: 3 "step" captures (the expert's words and one drawing each, as bytes) and the hint "making matcha" to ${PLAN_MODEL}`,
        ...expertSaid.map(
          ([atSeconds, words, , pictureName], i) => `  ${i + 1}. at ${atSeconds} seconds, picture ${pictureName}: "${words}"`,
        ),
      ],
      call: () => brain.buildLesson(key, {skillHint: "making matcha", captures}),
      judge: (draft) => {
        const steps = draft.steps
        const empty = steps.filter((s) => s.title === "" || s.instruction_spoken === "" || s.done_looks_like === "")
        const badSource = steps.filter((s) => [1, 2, 3].indexOf(s.source_capture) < 0)
        const spoken = steps.map((s) => countWords(s.instruction_spoken))
        const grandmother = steps
          .map((s, i) => (/grandmother|grandma/i.test(s.story) ? i + 1 : 0))
          .filter((n) => n > 0)
        return byRules(
          [
            [steps.length >= 2 && steps.length <= 4, `steps in the lesson: ${steps.length} (2 to 4 wanted)`],
            [
              empty.length === 0,
              `steps that lack a title, a spoken instruction or a "done looks like" line: ${empty.length} (0 wanted)`,
            ],
            [
              badSource.length === 0,
              `source_capture of each step: ${steps.map((s) => s.source_capture).join(", ")} (each must be 1, 2 or 3)`,
            ],
            [
              spoken.every((n) => n <= 30),
              `words in each spoken instruction: ${spoken.join(", ")} (at most 30 each; the prompt asks for 25)`,
            ],
            [draft.title !== "", `the lesson's title is "${draft.title}" (it must not be empty)`],
          ],
          JSON.stringify(draft, null, 2),
          [
            "READ THIS: every step should come from the three sentences above",
            grandmother.length > 0
              ? `NOTE: the grandmother is mentioned in the story of step ${grandmother.join(" and ")}. The expert's personal reason was kept.`
              : "NOTE: no step's story mentions the grandmother. The expert's personal reason was not kept.",
          ],
        )
      },
    })

    // Checks 4 and 5 use a step of the lesson Claude just wrote: the step that
    // points at capture 2 (the powder), or else the second step. `DraftStep`
    // is what Claude writes; `TutorialStepModel` is what the app stores and
    // hands to the check. The Coach makes the same conversion (PLAN 4.6).
    function toStepModel(draft: DraftStep, index: number): TutorialStepModel {
      return {
        id: `step_realtest_${index + 1}`,
        step_number: index + 1,
        title: draft.title,
        instruction_spoken: draft.instruction_spoken,
        instruction_detailed: draft.instruction_detailed,
        tips: draft.tips,
        done_looks_like: draft.done_looks_like,
        common_mistake: draft.common_mistake,
        story: draft.story,
      }
    }
    let powderStep: TutorialStepModel
    let powderTitle: string
    let powderFrom: string
    if (lesson && lesson.steps.length > 0) {
      let index = lesson.steps.findIndex((s) => s.source_capture === 2)
      if (index < 0) index = lesson.steps.length > 1 ? 1 : 0
      powderStep = toStepModel(lesson.steps[index], index)
      powderTitle = lesson.title
      powderFrom = `step ${index + 1} "${powderStep.title}" of the lesson from check 3`
    } else {
      // Check 3 gave no lesson. The two checks still run, on the built-in
      // lesson's powder step, so one failure does not hide two more answers.
      powderStep = builtIn.steps[1]
      powderTitle = builtIn.title
      powderFrom = `step 2 "${powderStep.title}" of the BUILT-IN lesson (check 3 gave no lesson to take a step from)`
    }
    const heard = "okay I think I'm done"

    // ---- 4. Check a correct attempt
    // The heart of learning mode. Two pictures of the same result, taken from
    // a different place in different light, as an expert and a learner would.
    // Proves the check passes good work and keeps its praise short.
    await check<Verdict>({
      number: 4,
      sending: [
        `Sending: ${powderFrom}, expert picture powderBowl, learner picture powderBowlAgain (both as bytes), heard "${heard}", to ${CHECK_MODEL}`,
      ],
      call: () =>
        brain.checkStep(key, {
          tutorialTitle: powderTitle,
          step: powderStep,
          reference: bytes(powderBowl),
          learner: bytes(powderBowlAgain),
          heard,
        }),
      judge: (verdict) =>
        byRules(
          [
            [verdict.result === "pass", `result is "${verdict.result}" ("pass" wanted)`],
            [countWords(verdict.say) <= 12, `words in "say": ${countWords(verdict.say)} (at most 12; the prompt asks for 8)`],
          ],
          JSON.stringify(verdict),
        ),
    })

    // ---- 5. Check a wrong attempt
    // The learner says "I'm done" over an empty bowl. A check that passes
    // everything is worthless, so this must NOT pass. The sentence is spoken
    // into the learner's ear: it must be short and must not talk about photos.
    await check<Verdict>({
      number: 5,
      sending: [
        `Sending: the same step and expert picture, learner picture emptyBowl (as bytes), heard "${heard}", to ${CHECK_MODEL}`,
      ],
      call: () =>
        brain.checkStep(key, {
          tutorialTitle: powderTitle,
          step: powderStep,
          reference: bytes(powderBowl),
          learner: bytes(emptyBowl),
          heard,
        }),
      judge: (verdict) => {
        const banned = verdict.say.match(/\b(photos?|photographs?|images?|pictures?|cameras?)\b/gi) ?? []
        return byRules(
          [
            [
              verdict.result === "fix" || verdict.result === "unclear",
              `result is "${verdict.result}" ("fix" or "unclear" wanted, never "pass")`,
            ],
            [countWords(verdict.say) <= 22, `words in "say": ${countWords(verdict.say)} (at most 22; the prompt asks for 18)`],
            [
              banned.length === 0,
              banned.length === 0
                ? `"say" does not mention photo, image, picture or camera`
                : `"say" mentions ${banned.join(", ")} (it must not)`,
            ],
          ],
          JSON.stringify(verdict),
        )
      },
    })

    // ---- 6. A photo sent as a link
    // The app sends a fresh glasses photo as a link and only falls back to
    // bytes when Claude answers 400 (coach.ts, withPhotos). This shows which
    // of the two happens with a real public link. The picture is a cartoon
    // mascot, so a working link must not lead to "pass". A 400 is not a
    // failure of the app: it is the case the fallback exists for.
    await check<Verdict>({
      number: 6,
      sending: [
        `Sending: built-in lesson step 2 "${builtIn.steps[1].title}", no expert picture, learner picture as a LINK to a cartoon mascot (not matcha in a bowl), to ${CHECK_MODEL}`,
        `  Link: ${MASCOT_LINK}`,
      ],
      call: () =>
        brain.checkStep(key, {
          tutorialTitle: builtIn.title,
          step: builtIn.steps[1],
          reference: null,
          learner: {kind: "url", url: MASCOT_LINK},
          heard: "",
        }),
      judge: (verdict) =>
        byRules(
          [
            [true, "Claude opened the link"],
            [verdict.result !== "pass", `result is "${verdict.result}" (anything but "pass" wanted: the picture shows no matcha)`],
          ],
          JSON.stringify(verdict),
        ),
      judgeError: (err) => {
        if (!(err instanceof BrainError) || err.status !== 400) return null
        // Status 400 is also what Claude answers to other faults in a request.
        // The app cannot tell them apart either: it retries with bytes on any 400.
        const aboutLink = /url|link|download|fetch|retriev|access|file/i.test(err.message)
        return {
          outcome: "NOTE",
          details: [
            "Claude could not open this link. The app handles this by sending photo bytes instead.",
            `Error status: ${err.status}`,
            `Error message: ${err.message}`,
            ...(aboutLink
              ? []
              : ["This message does not name the link. If checks 4, 5 and 7 failed with the same message, the cause is something else."]),
          ],
          reply: "",
          after: [],
        }
      },
    })

    // ---- 7. Check against the built-in lesson with no expert photo
    // The built-in lesson has no expert photos, so its checks have only the
    // written "Finished looks like" line to go by. This shows what such a
    // check looks like. Any verdict counts: the point is that the call works.
    await check<Verdict>({
      number: 7,
      sending: [
        `Sending: built-in lesson step 2 "${builtIn.steps[1].title}", no expert picture, learner picture powderBowl (as bytes), to ${CHECK_MODEL}`,
      ],
      call: () =>
        brain.checkStep(key, {
          tutorialTitle: builtIn.title,
          step: builtIn.steps[1],
          reference: null,
          learner: bytes(powderBowl),
          heard: "",
        }),
      judge: (verdict) =>
        byRules(
          [[true, `the call succeeded. The result is "${verdict.result}", words in "say": ${countWords(verdict.say)}`]],
          JSON.stringify(verdict),
        ),
    })

    // ---- 8. Answer a question
    // "Tinker, how hot should the water be?" on the step that says 80 degrees
    // Celsius (175 Fahrenheit). Proves the answer uses the lesson's own facts
    // and is fit to be spoken: short, and free of markdown signs.
    await check<string>({
      number: 8,
      sending: [
        `Sending: the built-in lesson, step 3 "${builtIn.steps[2].title}", and the question "How hot should the water be?" to ${CHAT_MODEL}`,
      ],
      call: () => brain.answer(key, {tutorial: builtIn, stepNumber: 3, question: "How hot should the water be?", recent: []}),
      judge: (reply) => {
        const signs = reply.match(/[*#`\n\r]/g) ?? []
        // A spoken answer may spell the number out. That counts as mentioning it.
        const mentions = /(^|\D)(80|175)(\D|$)/.test(reply) || /\beighty\b|\bone hundred (and )?seventy[- ]five\b/i.test(reply)
        return byRules(
          [
            [reply !== "", "the reply is not empty"],
            [countSentences(reply) <= 3, `sentences in the reply: ${countSentences(reply)} (at most 3)`],
            [countWords(reply) <= 60, `words in the reply: ${countWords(reply)} (at most 60)`],
            [signs.length === 0, `markdown signs (* # backtick) and line breaks in the reply: ${signs.length} (0 wanted)`],
            [mentions, mentions ? "the reply mentions 80 or 175" : "the reply mentions neither 80 nor 175"],
          ],
          reply,
        )
      },
    })

    // ---- 9. Answer a question the lesson cannot answer
    // Nothing in the lesson says when the whisk was made. The prompt tells
    // Claude to say it is not sure instead of making things up. A program
    // cannot judge that, so a person reads the reply.
    await check<string>({
      number: 9,
      sending: [
        `Sending: the built-in lesson, step 4 "${builtIn.steps[3].title}", and the question "What year was this whisk made?" to ${CHAT_MODEL}`,
      ],
      call: () => brain.answer(key, {tutorial: builtIn, stepNumber: 4, question: "What year was this whisk made?", recent: []}),
      judge: (reply) =>
        byRules(
          [
            [reply !== "", "the reply is not empty"],
            [countWords(reply) <= 60, `words in the reply: ${countWords(reply)} (at most 60)`],
          ],
          reply,
          ["READ THIS: it should not invent a year."],
        ),
    })
  }

  // ---------- summary ----------

  const table: Row[] = NAMES.map(
    (name, i) => rows.find((row) => row.number === i + 1) ?? {number: i + 1, name, outcome: "NOT RUN", ms: 0},
  )
  const widest = Math.max(...NAMES.map((name) => name.length))

  print()
  print("=".repeat(72))
  print("SUMMARY")
  print(`  #  ${"Check".padEnd(widest)}  ${"Result".padEnd(7)}  Seconds`)
  for (const row of table) {
    const time = row.outcome === "NOT RUN" ? "-" : seconds(row.ms)
    print(`  ${row.number}  ${row.name.padEnd(widest)}  ${row.outcome.padEnd(7)}  ${time.padStart(7)}`)
  }
  print()
  print(`Total time: ${seconds(Date.now() - startedAt)} seconds`)
  print(`Models in use: lesson ${PLAN_MODEL}, photo check ${CHECK_MODEL}, questions ${CHAT_MODEL}`)

  const failed = table.filter((row) => row.outcome === "FAIL").length
  const notes = table.filter((row) => row.outcome === "NOTE").length
  const notRun = table.filter((row) => row.outcome === "NOT RUN").length
  if (notes > 0) print(`Checks that ended with a NOTE: ${notes}. A NOTE is not a failure. Read it above.`)
  if (notRun > 0) print(`Checks that were not run: ${notRun}.`)
  if (dryRun) print("DRY RUN: nothing above came from Claude. This only shows that the test program itself works.")
  print(failed === 0 ? "RESULT: ALL CHECKS PASSED" : `RESULT: ${failed} OF ${TOTAL_CHECKS} CHECKS FAILED`)
  return failed === 0 ? 0 : 1
}

// `process.exitCode` is set and the program is left to end by itself. That
// way everything printed is written out first, also when the output goes into
// a file or another program.
main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    print(`The test program itself broke: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`)
    print(`RESULT: 1 OF ${TOTAL_CHECKS} CHECKS FAILED`)
    process.exitCode = 1
  },
)
