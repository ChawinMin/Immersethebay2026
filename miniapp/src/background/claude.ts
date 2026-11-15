/**
 * claude.ts: the requests to Claude. No Mentra code in here.
 *
 *   testKey    a 1-token request that proves the key works
 *   buildPlan  the expert's recording in, a lesson out          (larger model, once per lesson)
 *   checkStep  one learner photo in, pass or a correction out   (small fast model, once per check)
 *
 * WHY PLAIN fetch AND NOT THE ANTHROPIC SDK
 *   This code runs in Mentra's background engine, which is not a browser and
 *   not Node. Mentra's build rejects `process`, `URL`, `Headers` and other
 *   things an SDK relies on. `fetch` with a text body is supported.
 *
 * TIME LIMIT
 *   On iPhone the Mentra App gives every request 60 seconds. Keep requests
 *   small: few photos and a low max_tokens.
 *
 * PHOTOS
 *   Claude takes photos, not video. A photo is sent as a link while the link
 *   is fresh, and as base64 bytes otherwise. coach.ts decides which.
 *
 * WHERE TO CHANGE THINGS
 *   Models: PLAN_MODEL and CHECK_MODEL below.
 *   What Claude is told: PLAN_SYSTEM and CHECK_SYSTEM below.
 *   The fields Claude returns: PLAN_SCHEMA and CHECK_SCHEMA, together with the
 *   TypeScript types `Plan`, `Step` and `Verdict`. Change both sides together.
 */

const API_URL = "https://api.anthropic.com/v1/messages"
const PLAN_MODEL = "claude-sonnet-5-5"
const CHECK_MODEL = "claude-haiku-5-5"

// ---------- types ----------

export type ImageInput = {kind: "url"; url: string} | {kind: "base64"; data: string; mediaType: string}

export interface Step {
  number: number
  instruction: string
  done_looks_like: string
  common_mistake: string
  story: string
  source_capture: number
}

export interface Plan {
  title: string
  materials: string[]
  steps: Step[]
}

export interface CaptureInput {
  transcript: string
  image: ImageInput | null
}

export interface Verdict {
  result: "pass" | "fix" | "unclear"
  say: string
}

/** A failed Claude call. `status` is the HTTP status, or 0 when there was no connection. */
export class ClaudeError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ClaudeError"
    this.status = status
  }
}

// ---------- the JSON shapes Claude must return ----------

// Structured output: Claude is forced to answer with JSON of exactly this shape.
// The feature has two rules: every field must be listed in `required`, and
// `additionalProperties` must be false on every object.
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: {type: "string"},
    materials: {type: "array", items: {type: "string"}},
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: {type: "integer"},
          instruction: {type: "string"},
          done_looks_like: {type: "string"},
          common_mistake: {type: "string"},
          story: {type: "string"},
          source_capture: {type: "integer"},
        },
        required: ["number", "instruction", "done_looks_like", "common_mistake", "story", "source_capture"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "materials", "steps"],
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
const PLAN_SYSTEM = `You turn one expert demonstration into a lesson for a beginner.
The beginner wears camera glasses with a speaker and no screen. Every instruction is read aloud.

You get numbered captures. Each has what the expert said while doing one step, and usually a photo taken when that step was finished.

Rules:
- Only include steps the expert showed or said. Do not invent steps.
- Merge captures that belong to the same step. Keep the expert's order.
- title: a short name for the task, at most 5 words.
- materials: every tool and ingredient the expert used, each in 1 to 3 words.
- instruction: one or two short spoken sentences, plain words, at most 25 words.
- done_looks_like: what a photo shows when this step is finished correctly. Only things a camera can see.
- common_mistake: the most likely beginner error at this step, at most 15 words. Use "" if unknown.
- story: any history, meaning or personal reason the expert gave for this step, kept close to their own words, at most 40 words. Use "" if they gave none.
- source_capture: the number of the capture whose photo best shows this step finished.`

const CHECK_SYSTEM = `You check one step of a hands-on task for a beginner wearing camera glasses.
Your "say" text is spoken into their ear, so write it the way a calm teacher talks.

Rules:
- Judge only what is visible in the learner's photo.
- result "pass": the photo matches what the finished step should look like. say: a few warm words, at most 8.
- result "fix": something visible is wrong. say: the one most important correction, at most 18 words.
- result "unclear": the photo is blurry, dark, or does not show the work. say: ask them to look at their work and try again, at most 14 words.
- Small differences in angle, lighting or background are fine. Do not fail for those.
- Never mention photos, images or cameras in "say".`

// ---------- helpers ----------

type ContentBlock =
  | {type: "text"; text: string}
  | {type: "image"; source: {type: "url"; url: string} | {type: "base64"; media_type: string; data: string}}

function text(value: string): ContentBlock {
  return {type: "text", text: value}
}

function image(input: ImageInput): ContentBlock {
  if (input.kind === "url") return {type: "image", source: {type: "url", url: input.url}}
  return {type: "image", source: {type: "base64", media_type: input.mediaType, data: input.data}}
}

/**
 * Send one request to Claude and return the parsed reply.
 * Every failure becomes a ClaudeError: status 0 for no connection, otherwise
 * the HTTP status together with Claude's own error message.
 */
async function send(apiKey: string, body: Record<string, unknown>): Promise<any> {
  let response
  try {
    response = await fetch(API_URL, {
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
  } catch (err) {
    throw new ClaudeError(0, `No connection to Claude. ${err instanceof Error ? err.message : String(err)}`)
  }

  const raw = await response.text()
  let data: any = null
  try {
    data = JSON.parse(raw)
  } catch {
    // Not JSON. Handled below.
  }
  if (!response.ok) {
    throw new ClaudeError(response.status, data?.error?.message ?? `Claude answered with HTTP ${response.status}.`)
  }
  if (!data) throw new ClaudeError(response.status, "Claude's answer was not JSON.")
  return data
}

/** Call Claude and get back JSON that matches the schema. */
async function askForJson<T>(
  apiKey: string,
  options: {model: string; system: string; content: ContentBlock[]; schema: object; maxTokens: number},
): Promise<T> {
  const data = await send(apiKey, {
    model: options.model,
    max_tokens: options.maxTokens,
    system: options.system,
    messages: [{role: "user", content: options.content}],
    output_config: {format: {type: "json_schema", schema: options.schema}},
  })
  // The answer reached max_tokens, so its JSON stops in the middle and would not parse.
  if (data.stop_reason === "max_tokens") {
    throw new ClaudeError(200, "Claude's answer was cut off. Record fewer steps.")
  }
  const block = Array.isArray(data.content) ? data.content.find((b: any) => b?.type === "text") : null
  if (!block) throw new ClaudeError(200, `Claude returned no text (stop reason: ${data.stop_reason}).`)
  try {
    return JSON.parse(block.text) as T
  } catch {
    throw new ClaudeError(200, "Claude's answer was not valid JSON.")
  }
}

// ---------- the calls ----------

/** A 1-token request. Throws a ClaudeError when the key does not work. */
export async function testKey(apiKey: string): Promise<void> {
  await send(apiKey, {model: CHECK_MODEL, max_tokens: 1, messages: [{role: "user", content: "hi"}]})
}

/** The expert's recording in, a lesson out. */
export async function buildPlan(apiKey: string, captures: CaptureInput[]): Promise<Plan> {
  const content: ContentBlock[] = []
  // For each capture: a numbered line with the expert's words, then that capture's photo.
  // The number is what Claude reports back in `source_capture`.
  captures.forEach((capture, i) => {
    const said = capture.transcript.trim() || "(nothing said)"
    content.push(text(`Capture ${i + 1}. The expert said: "${said}"`))
    if (capture.image) content.push(image(capture.image))
  })
  content.push(text("Write the lesson for this task."))

  const plan = await askForJson<Plan>(apiKey, {
    model: PLAN_MODEL,
    system: PLAN_SYSTEM,
    content,
    schema: PLAN_SCHEMA,
    maxTokens: 3000,
  })
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new ClaudeError(200, "Claude found no steps in the recording.")
  }
  plan.steps.forEach((step, i) => (step.number = i + 1)) // always 1, 2, 3...
  return plan
}

/** One learner photo in, pass or a one-sentence correction out. */
export async function checkStep(
  apiKey: string,
  input: {step: Step; learner: ImageInput; reference: ImageInput | null; heard: string},
): Promise<Verdict> {
  const {step, learner, reference, heard} = input
  const content: ContentBlock[] = []
  // The order is stated in words: expert first, learner second.
  // Without the labels Claude could judge the wrong photo.
  if (reference) {
    content.push(text("Photo 1, the expert's finished result for this step:"))
    content.push(image(reference))
    content.push(text("Photo 2, the learner's attempt just now:"))
  } else {
    content.push(text("The learner's attempt just now:"))
  }
  content.push(image(learner))
  content.push(
    text(
      [
        `Step ${step.number}: ${step.instruction}`,
        `Finished looks like: ${step.done_looks_like}`,
        step.common_mistake ? `Common mistake: ${step.common_mistake}` : "",
        heard ? `The learner just said: "${heard}"` : "",
        "Check the learner's attempt.",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  )

  return askForJson<Verdict>(apiKey, {
    model: CHECK_MODEL,
    system: CHECK_SYSTEM,
    content,
    schema: CHECK_SCHEMA,
    maxTokens: 200,
  })
}
