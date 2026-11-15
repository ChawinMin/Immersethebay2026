/**
 * claude.ts: the requests to Claude. No Mentra code in here.
 *
 *   testKey      a 1-token request that proves the key works
 *   buildLesson  the expert's recording in, a lesson out            (larger model, once per lesson)
 *   checkStep    one learner photo in, pass or a correction out     (small fast model, once per check)
 *   answer       one learner question in, a short spoken reply out  (small fast model, once per question)
 *
 * The four calls are handed out together by `createBrain()` as a `Brain`
 * (contracts.ts). index.ts gives that Brain to the Coach. The Coach never
 * imports this file, so the tests can give it a fake Brain instead.
 *
 * WHY PLAIN fetch AND NOT THE ANTHROPIC SDK
 *   This code runs in Mentra's background engine, which is not a browser and
 *   not Node. Mentra's build rejects `process`, `URL`, `Headers` and other
 *   things an SDK relies on. `fetch` with a text body and a plain object of
 *   headers is supported, so that is all this file uses.
 *
 * TIME LIMIT
 *   On iPhone the Mentra App gives every request 60 seconds. On Android it
 *   also stops waiting after 60 seconds without data. Keep requests small:
 *   few photos and a low max_tokens.
 *
 * THINKING IS SWITCHED OFF
 *   Both models think before they answer unless the request says not to.
 *   Thinking is counted inside max_tokens and takes seconds. With the small
 *   limits here it would cut answers off, so every request switches it off.
 *   See `thinkingOff` below. The switch is different for each model.
 *
 * PHOTOS
 *   Claude takes photos, not video. A photo is sent as a link while the link
 *   is fresh, and as base64 bytes otherwise. coach.ts decides which.
 *
 * NO STAND-IN ANSWERS
 *   When Claude fails, the call throws a BrainError and the Coach says so.
 *   Nothing in this file makes up a lesson, a verdict or a reply.
 *
 * WHERE TO CHANGE THINGS
 *   Models: PLAN_MODEL, CHECK_MODEL and CHAT_MODEL below. Read `thinkingOff`
 *   when you change one.
 *   What Claude is told: LESSON_SYSTEM, CHECK_SYSTEM and CHAT_SYSTEM below.
 *   The fields Claude returns: LESSON_SCHEMA and CHECK_SCHEMA, together with
 *   the types `LessonDraft`, `DraftStep` and `Verdict` in contracts.ts.
 *   Change both sides together.
 */

import {BrainError} from "./contracts"
import type {Brain, CaptureInput, DraftStep, ImageInput, LessonDraft, Verdict} from "./contracts"
import type {TutorialModel, TutorialStepModel} from "../shared/channels"

// ---------- settings ----------

const ENDPOINT = "https://api.anthropic.com/v1/messages"

export const PLAN_MODEL = "claude-sonnet-5-5"
export const CHECK_MODEL = "claude-haiku-5-5"
export const CHAT_MODEL = "claude-haiku-5-5"

// The most Claude may write in one answer. Low on purpose: see TIME LIMIT above.
const PLAN_MAX_TOKENS = 3500
const CHECK_MAX_TOKENS = 200
const CHAT_MAX_TOKENS = 200

/**
 * The request field that switches thinking off for a model.
 *
 * The switch is not the same on every model, and the wrong one is answered
 * with HTTP 400:
 *   Sonnet 5.5  refuses "disabled". Its off switch is "between_tools".
 *   Haiku 5.5   refuses "between_tools". Its off switch is "disabled".
 * Source: the table of models in Claude's docs, page
 * build-with-claude/thinking, read on 2026-11-14. Not yet tried against the
 * real API. When you change a model above, look up its row in that table.
 * If Claude answers HTTP 400 and names "thinking", this function is the place.
 */
function thinkingOff(model: string): {type: string} {
  return model.indexOf("sonnet-5-5") >= 0 ? {type: "between_tools"} : {type: "disabled"}
}

// ---------- the JSON shapes Claude must return ----------

// Structured output: Claude is forced to answer with JSON of exactly this shape.
// The feature has two rules: every field must be listed in `required`, and
// `additionalProperties` must be false on every object.
// It does not support word or item limits, so those are in the prompts.
const LESSON_SCHEMA = {
  type: "object",
  properties: {
    title: {type: "string"},
    description: {type: "string"},
    category: {type: "string"},
    estimated_duration_minutes: {type: "integer"},
    tools_required: {type: "array", items: {type: "string"}},
    ingredients_required: {type: "array", items: {type: "string"}},
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {type: "string"},
          instruction_spoken: {type: "string"},
          instruction_detailed: {type: "string"},
          tips: {type: "array", items: {type: "string"}},
          done_looks_like: {type: "string"},
          common_mistake: {type: "string"},
          story: {type: "string"},
          source_capture: {type: "integer"},
        },
        required: [
          "title",
          "instruction_spoken",
          "instruction_detailed",
          "tips",
          "done_looks_like",
          "common_mistake",
          "story",
          "source_capture",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "title",
    "description",
    "category",
    "estimated_duration_minutes",
    "tools_required",
    "ingredients_required",
    "steps",
  ],
  additionalProperties: false,
}

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    result: {type: "string", enum: ["pass", "fix", "unclear"]},
    say: {type: "string"},
  },
  required: ["result", "say"],
  additionalProperties: false,
}

// ---------- prompts ----------

// Every word limit below exists because the text is read aloud to someone with
// busy hands and no screen. Long sentences are hard to follow by ear.
const LESSON_SYSTEM = `You turn one expert demonstration into a lesson for a beginner.
The beginner wears camera glasses with a speaker and no screen. Every instruction is read aloud.

You get numbered captures in the order they happened. Each capture is one line with its number, the time it was taken, its kind, and what the expert said since the capture before it. The photo of a capture comes right after its line. A capture with no photo after its line has only words.

There are two kinds of capture:
- "step finished": the expert said this step was done. Its photo shows a completed step.
- "timed photo": taken by a timer in the middle of the work. Its photo shows a step that is still going on. Use it to understand what the expert did.

Sometimes you are also told what the expert said they are teaching. Use that to understand the captures, not to add steps.

Rules:
- Only include steps the expert showed or said. Do not invent steps.
- Merge captures that belong to the same step. Keep the expert's order.
- Plain text in every field. No markdown.
- title: a short name for the task, at most 5 words.
- description: one or two sentences on what the beginner will make or do.
- category: the kind of skill, two words at most.
- estimated_duration_minutes: how long a beginner needs for the whole task, in whole minutes.
- tools_required: every tool the expert used, each in 1 to 3 words.
- ingredients_required: every ingredient or material that gets used up, each in 1 to 4 words. Use an empty list if there are none.
- When responding do not go over 25 words

For each step:
- title: a short name for the step, at most 6 words.
- instruction_spoken: one or two short spoken sentences, plain words, at most 25 words.
- instruction_detailed: why the step is done this way, at most 40 words. Use the expert's own reason when they gave one.
- tips: 0 to 2 tips, each at most 20 words. Prefer tips the expert gave. Use an empty list rather than guessing.
- done_looks_like: what a photo shows when this step is finished correctly, at most 25 words. Only things a camera can see.
- common_mistake: the most likely beginner error at this step, at most 15 words. Use "" if unknown.
- story: any history, meaning or personal reason the expert gave for this step, kept close to their own words, at most 40 words. Use "" if they gave none.
- source_capture: the number of the capture whose photo best shows this step finished. Prefer a "step finished" capture. Use a "timed photo" capture only when no "step finished" capture shows this step. It must be the number of a capture you were given.`

const CHECK_SYSTEM = `You check one step of a hands-on task for a beginner wearing camera glasses.
Your "say" text is spoken into their ear, so write it the way a calm teacher talks.

You get the learner's photo, taken just now by their glasses. Sometimes the expert's photo of the same step, finished, comes first. After the photos you get the step: its instruction, and usually a line on what finished looks like.

Rules:
- Judge only what is visible in the learner's photo.
- Judge against the "Finished looks like" line when it is there. Without it, judge against the instruction and the expert's photo.
- The expert's photo shows the expert's own tools and room. The learner's can look different. Compare the result of the step, not the surroundings.
- result "pass": the photo matches what the finished step should look like. say: a few warm words of praise, at most 8, for example "Nice work, that looks right." Do not describe what you see.
- result "fix": something visible is wrong. say: the one most important correction, at most 18 words.
- result "unclear": the photo is blurry, dark, or does not show the work. say: ask them to look at their work and try again, at most 14 words.
- Small differences in angle, lighting or background are fine. Do not fail for those.
- The common mistake, the tips and what the learner said are background. Do not fail for something you cannot see.
- Never mention photos, images or cameras in "say".
- "say" is plain spoken words. No markdown.`

// Rules 1 to 4 are the team's own, carried over from the earlier Python server
// (backend/services/claude_service.py, generate_tinker_response).
// Rules 5 and 6 are new. This request carries the lesson text but no photo, so
// Claude must not pretend to know what the expert meant or how the work looks.
const CHAT_SYSTEM = `You are Tinker, a warm, patient, and knowledgeable skill tutor speaking into the user's Mentra Live smart glasses.
The user is wearing smart glasses with NO display and is actively performing hands-on work with their hands.
CRITICAL RULES FOR SPOKEN AUDIO DELIVERY:
1. Respond in exactly 1 to 3 concise, natural spoken sentences.
2. NEVER use markdown, bullet points, asterisks, numbered lists, emojis, or URLs.
3. Direct and clear audio advice only.
4. Answer in the context of the user's current step.
5. Use the lesson details you are given. If they do not answer the question, give careful general advice or say you are not sure. Do not make up things the expert said.
6. You cannot see the user's work. If they ask whether it looks right, tell them to say "check".`

// ---------- helpers ----------

type ContentBlock =
  | {type: "text"; text: string}
  | {type: "image"; source: {type: "url"; url: string} | {type: "base64"; media_type: string; data: string}}

function textBlock(value: string): ContentBlock {
  return {type: "text", text: value}
}

function imageBlock(input: ImageInput): ContentBlock {
  if (input.kind === "url") return {type: "image", source: {type: "url", url: input.url}}
  return {type: "image", source: {type: "base64", media_type: input.mediaType, data: input.data}}
}

/** A trimmed string, or "" for anything that is not a string. Saved lessons can lack fields. */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** A list of non-empty trimmed strings, or [] for anything that is not a list. */
function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter((item) => item !== "") : []
}

/** A whole number, or 0 for anything that is not a number. */
function whole(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0
}

/**
 * Why a request failed, in words.
 * Mentra's `fetch` does not reject with an Error. It rejects with a plain
 * object {code, message}, for example when the 60 seconds are over
 * (mobile/modules/jspolyfill/src/startup.ts in Mentra-Community/MentraOS,
 * branch dev, commit f120725).
 */
function reason(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object" && typeof (err as {message?: unknown}).message === "string") {
    return (err as {message: string}).message
  }
  return String(err)
}

/**
 * Send one request to Claude and return the parsed reply.
 * Every failure becomes a BrainError: status 0 for no connection, otherwise
 * the HTTP status together with Claude's own error message.
 */
async function send(apiKey: string, body: Record<string, unknown>): Promise<any> {
  let response
  let raw: string
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Claude asks for this header on requests that carry a browser Origin.
        // The phone's background sends none, so it is only a safety net here.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    })
    // Inside the try: a connection that drops while the answer is still
    // arriving fails here, and that is also "no connection".
    raw = await response.text()
  } catch (err) {
    throw new BrainError(0, `No connection to Claude. ${reason(err)}`.trim())
  }

  let data: any = null
  try {
    data = JSON.parse(raw)
  } catch {
    // Not JSON. Handled below.
  }
  if (!response.ok) {
    const said = str(data?.error?.message)
    throw new BrainError(response.status, said || `Claude answered with HTTP ${response.status}.`)
  }
  if (!data || typeof data !== "object") throw new BrainError(response.status, "Claude's answer was not JSON.")
  return data
}

/** The text parts of a reply. Other kinds of block can come before the text, so they are picked by type. */
function replyTexts(data: any): string[] {
  const blocks: any[] = Array.isArray(data.content) ? data.content : []
  return blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text)
}

/** Call Claude and get back JSON that matches the schema. */
async function askForJson(
  apiKey: string,
  options: {
    model: string
    system: string
    content: ContentBlock[]
    schema: object
    maxTokens: number
    /** What to tell people when the answer did not fit in maxTokens. */
    cutOff: string
  },
): Promise<any> {
  const data = await send(apiKey, {
    model: options.model,
    max_tokens: options.maxTokens,
    thinking: thinkingOff(options.model),
    system: options.system,
    messages: [{role: "user", content: options.content}],
    output_config: {format: {type: "json_schema", schema: options.schema}},
  })
  // The answer reached max_tokens, so its JSON stops in the middle and would not parse.
  if (data.stop_reason === "max_tokens") throw new BrainError(200, options.cutOff)
  // A refusal comes back as HTTP 200 with ordinary words in place of the JSON.
  if (data.stop_reason === "refusal") throw new BrainError(200, "Claude declined to answer this request.")
  const texts = replyTexts(data)
  if (texts.length === 0) throw new BrainError(200, `Claude returned no text (stop reason: ${data.stop_reason}).`)
  try {
    return JSON.parse(texts[0])
  } catch {
    throw new BrainError(200, "Claude's answer was not valid JSON.")
  }
}

/** Make a reply safe to read aloud: no markdown signs, no line breaks, single spaces. */
function forSpeech(reply: string): string {
  return reply
    .replace(/[*#`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

// ---------- the calls ----------

/** A 1-token request. Throws a BrainError when the key does not work. */
async function testKey(apiKey: string): Promise<void> {
  // One token always ends with stop reason "max_tokens". That is fine here:
  // only the HTTP status matters, so this goes through `send` directly.
  await send(apiKey, {
    model: CHECK_MODEL,
    max_tokens: 1,
    thinking: thinkingOff(CHECK_MODEL),
    messages: [{role: "user", content: "hi"}],
  })
}

/** Claude's step, with every field made the type the Coach expects. */
function toDraftStep(raw: any): DraftStep {
  return {
    title: str(raw?.title),
    instruction_spoken: str(raw?.instruction_spoken),
    instruction_detailed: str(raw?.instruction_detailed),
    tips: list(raw?.tips).slice(0, 2), // the schema cannot hold Claude to 2, so this does
    done_looks_like: str(raw?.done_looks_like),
    common_mistake: str(raw?.common_mistake),
    story: str(raw?.story),
    // Left as Claude gave it. A number that names no capture means "no photo" to the Coach.
    source_capture: whole(raw?.source_capture),
  }
}

/** The expert's recording in, a lesson out. */
async function buildLesson(
  apiKey: string,
  input: {captures: CaptureInput[]; skillHint: string},
): Promise<LessonDraft> {
  const content: ContentBlock[] = []
  // For each capture: one numbered line with the expert's words, then that capture's photo.
  // The number is what Claude reports back in `source_capture`.
  input.captures.forEach((capture, i) => {
    const said = capture.transcript.trim() || "(nothing said)"
    const kind = capture.kind === "step" ? "step finished" : "timed photo"
    const seconds = Math.max(0, Math.round(capture.atSeconds))
    content.push(textBlock(`Capture ${i + 1} at ${seconds} seconds (${kind}). The expert said: "${said}"`))
    if (capture.image) content.push(imageBlock(capture.image))
  })
  // The request comes last, after everything Claude has to look at.
  const hint = input.skillHint.trim()
  content.push(
    textBlock((hint ? `The expert said they are teaching: "${hint}"\n` : "") + "Write the lesson for this task."),
  )

  const reply = await askForJson(apiKey, {
    model: PLAN_MODEL,
    system: LESSON_SYSTEM,
    content,
    schema: LESSON_SCHEMA,
    maxTokens: PLAN_MAX_TOKENS,
    cutOff: "Claude's answer was cut off. Record fewer steps.",
  })

  const rawSteps: any[] = Array.isArray(reply?.steps) ? reply.steps : []
  // A step with nothing to say aloud cannot be taught, so it does not count.
  const steps = rawSteps.map(toDraftStep).filter((step) => step.instruction_spoken !== "")
  if (steps.length === 0) throw new BrainError(200, "Claude found no steps in the recording.")

  return {
    title: str(reply.title),
    description: str(reply.description),
    category: str(reply.category),
    estimated_duration_minutes: whole(reply.estimated_duration_minutes),
    tools_required: list(reply.tools_required),
    ingredients_required: list(reply.ingredients_required),
    steps,
  }
}

/** One learner photo in, pass or a one-sentence correction out. */
async function checkStep(
  apiKey: string,
  input: {
    tutorialTitle: string
    step: TutorialStepModel
    learner: ImageInput
    reference: ImageInput | null
    heard: string
  },
): Promise<Verdict> {
  const {step, learner, reference} = input
  const content: ContentBlock[] = []
  // The order is stated in words: expert first, learner second.
  // Without the labels Claude could judge the wrong photo.
  if (reference) {
    content.push(textBlock("Photo 1, the expert's finished result for this step:"))
    content.push(imageBlock(reference))
    content.push(textBlock("Photo 2, the learner's attempt just now:"))
  } else {
    content.push(textBlock("The learner's attempt just now:"))
  }
  content.push(imageBlock(learner))

  const title = str(input.tutorialTitle)
  const done = str(step.done_looks_like)
  const detail = str(step.instruction_detailed)
  const mistake = str(step.common_mistake)
  const tips = list(step.tips)
  const heard = str(input.heard)
  // Lessons recorded before `done_looks_like` existed do not have it. They get
  // the step's detail text instead, under a label that does not claim it
  // describes the finished look.
  const target = done ? `Finished looks like: ${done}` : detail ? `About this step: ${detail}` : ""
  content.push(
    textBlock(
      [
        title ? `Lesson: ${title}` : "",
        `Step ${step.step_number}: ${str(step.title)}`,
        `Instruction: ${str(step.instruction_spoken)}`,
        target,
        mistake ? `Common mistake: ${mistake}` : "",
        tips.length > 0 ? `Tips: ${tips.join(" ")}` : "",
        heard ? `The learner just said: "${heard}"` : "",
        "Check the learner's attempt.",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    ),
  )

  const reply = await askForJson(apiKey, {
    model: CHECK_MODEL,
    system: CHECK_SYSTEM,
    content,
    schema: CHECK_SCHEMA,
    maxTokens: CHECK_MAX_TOKENS,
    cutOff: "Claude's answer was cut off.",
  })

  // Claude's docs say the capital letters of a fixed value are not guaranteed, so compare in lower case.
  const result = str(reply?.result).toLowerCase()
  const say = str(reply?.say)
  if (result !== "pass" && result !== "fix" && result !== "unclear") {
    throw new BrainError(200, "Claude's check had no clear result.")
  }
  // The learner only hears `say`. Without it there is nothing to tell them.
  if (say === "") throw new BrainError(200, "Claude's check came back without words.")
  return {result, say}
}

/** Everything Claude needs to answer a question about the step the learner is on, as one text. */
function questionText(input: {
  tutorial: TutorialModel
  stepNumber: number
  question: string
  recent: Array<{speaker: "user" | "tinker"; text: string}>
}): string {
  const {tutorial, stepNumber} = input
  const steps: TutorialStepModel[] = Array.isArray(tutorial.steps) ? tutorial.steps : []
  const step = steps[stepNumber - 1] // stepNumber counts from 1
  const previous = steps[stepNumber - 2]
  const next = steps[stepNumber]
  const tools = list(tutorial.tools_required)
  const ingredients = list(tutorial.ingredients_required)

  const lines: string[] = [`Lesson: ${str(tutorial.title)}`]
  if (tools.length > 0) lines.push(`Tools: ${tools.join(", ")}`)
  if (ingredients.length > 0) lines.push(`Ingredients: ${ingredients.join(", ")}`)
  if (step) {
    const tips = list(step.tips)
    lines.push(`Current step: step ${stepNumber} of ${steps.length}, "${str(step.title)}"`)
    lines.push(`Spoken instruction: ${str(step.instruction_spoken)}`)
    if (str(step.instruction_detailed)) lines.push(`Detail: ${str(step.instruction_detailed)}`)
    if (tips.length > 0) lines.push(`Tips: ${tips.join(" ")}`)
    if (str(step.done_looks_like)) lines.push(`Finished looks like: ${str(step.done_looks_like)}`)
    if (str(step.common_mistake)) lines.push(`Common mistake: ${str(step.common_mistake)}`)
    if (str(step.story)) lines.push(`The expert's story: ${str(step.story)}`)
  }
  if (previous) lines.push(`Previous step: ${str(previous.title)}`)
  if (next) lines.push(`Next step: ${str(next.title)}`)

  const talk = input.recent.filter((line) => str(line.text) !== "")
  if (talk.length > 0) {
    lines.push("Recent conversation:")
    talk.forEach((line) => lines.push(`${line.speaker === "tinker" ? "Tinker" : "Learner"}: ${str(line.text)}`))
  }
  lines.push(`Learner asks: "${str(input.question)}"`)
  return lines.join("\n")
}

/** One question in, one to three spoken sentences out. Plain text, no JSON. */
async function answer(
  apiKey: string,
  input: {
    tutorial: TutorialModel
    stepNumber: number
    question: string
    recent: Array<{speaker: "user" | "tinker"; text: string}>
  },
): Promise<string> {
  const data = await send(apiKey, {
    model: CHAT_MODEL,
    max_tokens: CHAT_MAX_TOKENS,
    thinking: thinkingOff(CHAT_MODEL),
    system: CHAT_SYSTEM,
    messages: [{role: "user", content: [textBlock(questionText(input))]}],
  })
  if (data.stop_reason === "refusal") throw new BrainError(200, "Claude declined to answer this question.")
  // The reply is spoken by the glasses, so markdown signs and line breaks are removed.
  let reply = forSpeech(replyTexts(data).join(" "))
  // An answer that hit the token limit stops mid-sentence. Speak only its whole sentences.
  if (data.stop_reason === "max_tokens") reply = wholeSentences(reply)
  if (reply === "") throw new BrainError(200, `Claude gave an empty answer (stop reason: ${data.stop_reason}).`)
  return reply
}

/** The text up to and including its last full stop, question mark or exclamation mark, or "" when there is none. */
function wholeSentences(text: string): string {
  const end = Math.max(text.lastIndexOf("."), text.lastIndexOf("?"), text.lastIndexOf("!"))
  return end >= 0 ? text.slice(0, end + 1).trim() : ""
}

/** The real Brain. It uses the global `fetch` at the moment of each call. */
export function createBrain(): Brain {
  return {testKey, buildLesson, checkStep, answer}
}
