/**
 * Tests for the requests to Claude (src/background/claude.ts) and for the
 * built-in lesson (src/background/seed.ts).
 *   bun test test/claude.test.ts
 *
 * No request leaves the machine. `globalThis.fetch` is replaced with a fake
 * before every test and put back after it. The fake records what claude.ts
 * sent and answers with whatever the test asks for.
 *
 * The fake answer is a bare object with only `ok`, `status` and `text()`.
 * That is on purpose: Mentra's background engine is not a browser, so
 * claude.ts must not need anything more from an answer than those three.
 *
 * These tests prove the requests have the shape this file expects and that
 * every failure becomes a BrainError. They do not prove the real Claude API
 * accepts the requests. That needs scripts/real-claude-test.ts and a real key.
 */

import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {CHAT_MODEL, CHECK_MODEL, PLAN_MODEL, createBrain} from "../src/background/claude"
import {BrainError, type CaptureInput, type ImageInput} from "../src/background/contracts"
import {BUILT_IN_TUTORIALS} from "../src/background/seed"
import type {TutorialModel} from "../src/shared/channels"

const KEY = "sk-ant-test-key-1234" // not a real key
const ENDPOINT = "https://api.anthropic.com/v1/messages"
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQ"
const SRC = `${import.meta.dir}/../src/background`
// The team's original lesson file. It lives outside the miniapp folder, in the Python server's data.
// The team's original lesson file, kept as a fixture so this check keeps running after the Python server is gone.
const TEAM_JSON = `${import.meta.dir}/fixtures/tut_matcha_ceremonial_01.json`
const hasTeamJson = await Bun.file(TEAM_JSON).exists()

// ---------- fake fetch ----------

interface Call {
  url: unknown
  init: any
  /** The request body, parsed. undefined when the body was not a string. */
  body: any
}

type FakeAnswer = {ok: boolean; status: number; text: () => Promise<string>}

let calls: Call[] = []
let respond: (call: Call) => FakeAnswer = () => {
  throw new Error("This test did not say what Claude answers.")
}
const realFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  respond = () => {
    throw new Error("This test did not say what Claude answers.")
  }
  globalThis.fetch = (async (url: unknown, init: any) => {
    const call: Call = {url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined}
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  // No test may send anything but the fake key.
  for (const call of calls) expect(call.init.headers["x-api-key"]).toBe(KEY)
})

/** An HTTP answer. A string body is sent as it is, anything else as JSON. */
function http(status: number, body: unknown): FakeAnswer {
  const raw = typeof body === "string" ? body : JSON.stringify(body)
  return {ok: status >= 200 && status < 300, status, text: async () => raw}
}

/** A normal Claude answer whose text is `text`. */
function claudeSays(text: string, stopReason = "end_turn"): FakeAnswer {
  return http(200, {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{type: "text", text}],
    stop_reason: stopReason,
  })
}

function claudeSaysJson(value: unknown): FakeAnswer {
  return claudeSays(JSON.stringify(value))
}

/** Claude's own error format. */
function claudeError(status: number, type: string, message: string): FakeAnswer {
  return http(status, {type: "error", error: {type, message}})
}

/** Run a call that must fail and return its error. */
async function failure(run: () => Promise<unknown>): Promise<BrainError> {
  try {
    await run()
  } catch (err) {
    expect(err).toBeInstanceOf(BrainError)
    expect((err as BrainError).name).toBe("BrainError")
    return err as BrainError
  }
  throw new Error("Expected the call to fail, and it did not.")
}

/** What every request must look like, whatever it asks. */
function expectEnvelope(call: Call, model: string, maxTokens: number): void {
  // The background engine has no URL, Request or Headers objects:
  // the address and the body are plain text, the headers a plain object.
  expect(call.url).toBe(ENDPOINT)
  expect(typeof call.init.body).toBe("string")
  expect(Object.getPrototypeOf(call.init.headers)).toBe(Object.prototype)
  expect(Object.keys(call.init).sort()).toEqual(["body", "headers", "method"])
  expect(call.init.method).toBe("POST")
  expect(call.init.headers).toEqual({
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  })
  expect(call.body.model).toBe(model)
  expect(call.body.max_tokens).toBe(maxTokens)
  // Sonnet 5.5 and Haiku 5.5 answer HTTP 400 to these. The Python server sent temperature.
  for (const field of ["temperature", "top_p", "top_k"]) expect(field in call.body).toBe(false)
}

/**
 * The two rules of Claude's structured output: every property is listed in
 * `required`, and every object has `additionalProperties: false`.
 * Also: no keyword the feature does not support (word limits, item limits).
 */
function expectStrictSchema(schema: any, path = "schema"): void {
  const allowed = ["type", "properties", "required", "additionalProperties", "items", "enum"]
  for (const keyword of Object.keys(schema)) expect(allowed, `${path} uses "${keyword}"`).toContain(keyword)
  if (schema.type === "object") {
    expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false)
    expect([...schema.required].sort(), `${path}.required`).toEqual(Object.keys(schema.properties).sort())
    for (const [name, child] of Object.entries(schema.properties)) expectStrictSchema(child, `${path}.${name}`)
  }
  if (schema.type === "array") expectStrictSchema(schema.items, `${path}[]`)
}

// ---------- test data ----------

const brain = createBrain()

const LINK: ImageInput = {kind: "url", url: "https://photos.example/p1.jpg"}
const BYTES: ImageInput = {kind: "base64", data: JPEG_BASE64, mediaType: "image/jpeg"}
const LINK_BLOCK = {type: "image", source: {type: "url", url: "https://photos.example/p1.jpg"}}
const BYTES_BLOCK = {type: "image", source: {type: "base64", media_type: "image/jpeg", data: JPEG_BASE64}}

/** A recording with both kinds of capture, both kinds of photo, and one capture that lost its photo. */
const CAPTURES: CaptureInput[] = [
  {transcript: "  First I sift two scoops of matcha into the bowl. ", atSeconds: 12.4, kind: "step", image: LINK},
  {transcript: "", atSeconds: 31.6, kind: "auto", image: BYTES},
  {transcript: "Then I pour the water.", atSeconds: 47, kind: "step", image: null},
]

/** What the fake Claude writes for that recording. Untidy on purpose. */
const LESSON_REPLY = {
  title: " Making matcha ",
  description: "Whisk a bowl of matcha tea.",
  category: "Tea",
  estimated_duration_minutes: 5,
  tools_required: ["bowl", "whisk", "sifter"],
  ingredients_required: ["matcha powder", "hot water"],
  steps: [
    {
      title: "Sift the matcha",
      instruction_spoken: "Sift two scoops of matcha into the bowl.",
      instruction_detailed: "Sifting breaks up clumps.",
      tips: ["Tap the sifter gently.", "  ", "Use a dry bowl.", "A third tip, one more than allowed."],
      done_looks_like: "Green powder in the bowl with no lumps.",
      common_mistake: "Skipping the sifter.",
      story: "My grandmother taught me this.",
      source_capture: 1,
    },
    {
      title: "Add the water",
      instruction_spoken: "Pour in a little hot water.",
      instruction_detailed: "",
      tips: [],
      done_looks_like: "Water covers the powder.",
      common_mistake: "",
      story: "",
      source_capture: 3,
    },
  ],
}

/** A saved lesson. Step 1 is an old step with no check fields. Step 2 has every field. */
const LESSON: TutorialModel = {
  id: "tut_1",
  title: "Making matcha",
  description: "Whisk a bowl of matcha tea.",
  total_steps: 3,
  estimated_duration_minutes: 5,
  created_at: "2026-11-14T15:00:00Z",
  status: "published",
  tools_required: ["bowl", "whisk"],
  ingredients_required: ["matcha powder", "hot water"],
  steps: [
    {
      id: "s1",
      step_number: 1,
      title: "Sift the matcha",
      instruction_spoken: "Sift two scoops of matcha into the bowl.",
      instruction_detailed: "Sifting breaks up clumps.",
    },
    {
      id: "s2",
      step_number: 2,
      title: "Add the water",
      instruction_spoken: "Pour in a little hot water.",
      instruction_detailed: "Boiling water makes the tea bitter.",
      tips: ["Let the kettle rest first.", "Pour down the side."],
      done_looks_like: "A shallow pool of water covers the powder.",
      common_mistake: "Using boiling water.",
      story: "My grandmother always waited two minutes.",
    },
    {
      id: "s3",
      step_number: 3,
      title: "Whisk",
      instruction_spoken: "Whisk fast in a W shape.",
      instruction_detailed: "A W motion adds air.",
    },
  ],
}

const CHECK_INPUT = {
  tutorialTitle: LESSON.title,
  step: LESSON.steps[1]!,
  learner: BYTES,
  reference: LINK,
  heard: "I think I am done",
}

const ANSWER_INPUT = {
  tutorial: LESSON,
  stepNumber: 2,
  question: "How hot should the water be?",
  recent: [
    {speaker: "tinker" as const, text: "Step 2. Pour in a little hot water."},
    {speaker: "user" as const, text: "Tinker, how hot should the water be?"},
  ],
}

/** The four calls, for the checks that hold for every one of them. */
const ALL_CALLS: Array<[string, () => Promise<unknown>]> = [
  ["testKey", () => brain.testKey(KEY)],
  ["buildLesson", () => brain.buildLesson(KEY, {captures: CAPTURES, skillHint: ""})],
  ["checkStep", () => brain.checkStep(KEY, CHECK_INPUT)],
  ["answer", () => brain.answer(KEY, ANSWER_INPUT)],
]

/** The two calls that ask for JSON. */
const JSON_CALLS = ALL_CALLS.filter(([name]) => name === "buildLesson" || name === "checkStep")

// ---------- the models ----------

test("the models are the ones the plan names", () => {
  expect(PLAN_MODEL).toBe("claude-sonnet-5-5")
  expect(CHECK_MODEL).toBe("claude-haiku-5-5")
  expect(CHAT_MODEL).toBe("claude-haiku-5-5")
})

test("createBrain gives the four calls of the Brain contract", () => {
  expect(Object.keys(createBrain()).sort()).toEqual(["answer", "buildLesson", "checkStep", "testKey"])
})

// ---------- testKey ----------

describe("testKey", () => {
  test("sends one tiny request and accepts any HTTP 200", async () => {
    // One token always ends with "max_tokens". For this call that is success.
    respond = () => claudeSays("H", "max_tokens")
    expect(await brain.testKey(KEY)).toBeUndefined()

    expect(calls).toHaveLength(1)
    expectEnvelope(calls[0]!, CHECK_MODEL, 1)
    expect(calls[0]!.body).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 1,
      thinking: {type: "disabled"},
      messages: [{role: "user", content: "hi"}],
    })
  })

  test("a rejected key fails with status 401 and Claude's own words", async () => {
    respond = () => claudeError(401, "authentication_error", "invalid x-api-key")
    const err = await failure(() => brain.testKey(KEY))
    expect(err.status).toBe(401)
    expect(err.message).toBe("invalid x-api-key")
  })
})

// ---------- buildLesson ----------

describe("buildLesson", () => {
  test("sends one line per capture, each followed by its photo, and the schema", async () => {
    respond = () => claudeSaysJson(LESSON_REPLY)
    await brain.buildLesson(KEY, {captures: CAPTURES, skillHint: "  making matcha "})

    expect(calls).toHaveLength(1)
    const body = calls[0]!.body
    expectEnvelope(calls[0]!, PLAN_MODEL, 3500)
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system", "thinking"])

    // Line, photo, line, photo, line (no photo), then the request itself.
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe("user")
    expect(body.messages[0].content).toEqual([
      {
        type: "text",
        text: 'Capture 1 at 12 seconds (step finished). The expert said: "First I sift two scoops of matcha into the bowl."',
      },
      LINK_BLOCK,
      {type: "text", text: 'Capture 2 at 32 seconds (timed photo). The expert said: "(nothing said)"'},
      BYTES_BLOCK,
      {type: "text", text: 'Capture 3 at 47 seconds (step finished). The expert said: "Then I pour the water."'},
      {type: "text", text: 'The expert said they are teaching: "making matcha"\nWrite the lesson for this task.'},
    ])

    // Sonnet 5.5 has no "disabled". Its way to answer without thinking first is "between_tools".
    expect(body.thinking).toEqual({type: "between_tools"})
  })

  test("the schema asks for every field of a lesson and follows the structured output rules", async () => {
    respond = () => claudeSaysJson(LESSON_REPLY)
    await brain.buildLesson(KEY, {captures: CAPTURES, skillHint: ""})

    const config = calls[0]!.body.output_config
    expect(Object.keys(config)).toEqual(["format"])
    expect(Object.keys(config.format).sort()).toEqual(["schema", "type"])
    expect(config.format.type).toBe("json_schema")

    const schema = config.format.schema
    expectStrictSchema(schema)
    expect(schema.type).toBe("object")
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(LESSON_REPLY).sort())
    expect(schema.properties.estimated_duration_minutes).toEqual({type: "integer"})
    expect(schema.properties.tools_required).toEqual({type: "array", items: {type: "string"}})
    expect(schema.properties.ingredients_required).toEqual({type: "array", items: {type: "string"}})
    expect(schema.properties.steps.type).toBe("array")
    const step = schema.properties.steps.items
    expect(Object.keys(step.properties).sort()).toEqual(Object.keys(LESSON_REPLY.steps[0]!).sort())
    expect(step.properties.tips).toEqual({type: "array", items: {type: "string"}})
    expect(step.properties.source_capture).toEqual({type: "integer"})
  })

  test("the system prompt keeps v1's rules and explains the two kinds of capture", async () => {
    respond = () => claudeSaysJson(LESSON_REPLY)
    await brain.buildLesson(KEY, {captures: CAPTURES, skillHint: ""})

    const system: string = calls[0]!.body.system
    expect(system).toContain("Only include steps the expert showed or said. Do not invent steps.")
    expect(system).toContain("Merge captures that belong to the same step. Keep the expert's order.")
    expect(system).toContain('"step finished": the expert said this step was done. Its photo shows a completed step.')
    expect(system).toContain('"timed photo": taken by a timer in the middle of the work.')
    expect(system).toContain('Prefer a "step finished" capture.')
    // Every field of the answer is explained, with its limit. ("steps" is the heading "For each step:".)
    const fields = [...Object.keys(LESSON_REPLY), ...Object.keys(LESSON_REPLY.steps[0]!)].filter((f) => f !== "steps")
    for (const field of fields) expect(system).toContain(`- ${field}: `)
    expect(system).toContain("For each step:")
    for (const limit of ["at most 6 words", "at most 25 words", "at most 40 words", "at most 20 words", "at most 15 words"]) {
      expect(system).toContain(limit)
    }
    expect(system).toContain("two words at most")
  })

  test("without a skill hint the last line is only the request", async () => {
    respond = () => claudeSaysJson(LESSON_REPLY)
    await brain.buildLesson(KEY, {captures: CAPTURES, skillHint: "   "})
    const content = calls[0]!.body.messages[0].content
    expect(content.at(-1)).toEqual({type: "text", text: "Write the lesson for this task."})
    expect(JSON.stringify(content)).not.toContain("they are teaching")
  })

  test("returns Claude's lesson, tidied", async () => {
    respond = () => claudeSaysJson(LESSON_REPLY)
    const lesson = await brain.buildLesson(KEY, {captures: CAPTURES, skillHint: ""})
    expect(lesson).toEqual({
      title: "Making matcha", // trimmed
      description: "Whisk a bowl of matcha tea.",
      category: "Tea",
      estimated_duration_minutes: 5,
      tools_required: ["bowl", "whisk", "sifter"],
      ingredients_required: ["matcha powder", "hot water"],
      steps: [
        {
          title: "Sift the matcha",
          instruction_spoken: "Sift two scoops of matcha into the bowl.",
          instruction_detailed: "Sifting breaks up clumps.",
          tips: ["Tap the sifter gently.", "Use a dry bowl."], // blank tip dropped, then at most 2
          done_looks_like: "Green powder in the bowl with no lumps.",
          common_mistake: "Skipping the sifter.",
          story: "My grandmother taught me this.",
          source_capture: 1,
        },
        {
          title: "Add the water",
          instruction_spoken: "Pour in a little hot water.",
          instruction_detailed: "",
          tips: [],
          done_looks_like: "Water covers the powder.",
          common_mistake: "",
          story: "",
          source_capture: 3,
        },
      ],
    })
  })

  test("finds the JSON even when another kind of block comes first", async () => {
    respond = () =>
      http(200, {
        content: [
          {type: "thinking", thinking: "", signature: "abc"},
          {type: "text", text: JSON.stringify(LESSON_REPLY)},
        ],
        stop_reason: "end_turn",
      })
    const lesson = await brain.buildLesson(KEY, {captures: CAPTURES, skillHint: ""})
    expect(lesson.steps).toHaveLength(2)
  })

  test("a lesson with no steps is an error, not an empty lesson", async () => {
    respond = () => claudeSaysJson({...LESSON_REPLY, steps: []})
    const err = await failure(() => brain.buildLesson(KEY, {captures: CAPTURES, skillHint: ""}))
    expect(err.status).toBe(200)
    expect(err.message).toBe("Claude found no steps in the recording.")
  })

  test("steps with nothing to say aloud do not count as steps", async () => {
    respond = () => claudeSaysJson({...LESSON_REPLY, steps: [{...LESSON_REPLY.steps[0]!, instruction_spoken: "  "}]})
    const err = await failure(() => brain.buildLesson(KEY, {captures: CAPTURES, skillHint: ""}))
    expect(err.message).toBe("Claude found no steps in the recording.")
  })

  test("an answer that ran out of tokens says to record fewer steps", async () => {
    respond = () => claudeSays('{"title": "Making mat', "max_tokens")
    const err = await failure(() => brain.buildLesson(KEY, {captures: CAPTURES, skillHint: ""}))
    expect(err.status).toBe(200)
    expect(err.message).toBe("Claude's answer was cut off. Record fewer steps.")
  })
})

// ---------- checkStep ----------

describe("checkStep", () => {
  test("sends the expert's photo first and the learner's second, each named in words", async () => {
    respond = () => claudeSaysJson({result: "pass", say: "Nice work."})
    await brain.checkStep(KEY, CHECK_INPUT)

    expect(calls).toHaveLength(1)
    const body = calls[0]!.body
    expectEnvelope(calls[0]!, CHECK_MODEL, 200)
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system", "thinking"])
    expect(body.thinking).toEqual({type: "disabled"})

    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe("user")
    expect(body.messages[0].content).toEqual([
      {type: "text", text: "Photo 1, the expert's finished result for this step:"},
      LINK_BLOCK,
      {type: "text", text: "Photo 2, the learner's attempt just now:"},
      BYTES_BLOCK,
      {
        type: "text",
        text: [
          "Lesson: Making matcha",
          "Step 2: Add the water",
          "Instruction: Pour in a little hot water.",
          "Finished looks like: A shallow pool of water covers the powder.",
          "Common mistake: Using boiling water.",
          "Tips: Let the kettle rest first. Pour down the side.",
          'The learner just said: "I think I am done"',
          "Check the learner's attempt.",
        ].join("\n"),
      },
    ])
  })

  test("the schema allows exactly pass, fix or unclear, with one sentence", async () => {
    respond = () => claudeSaysJson({result: "pass", say: "Nice work."})
    await brain.checkStep(KEY, CHECK_INPUT)
    expect(calls[0]!.body.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            result: {type: "string", enum: ["pass", "fix", "unclear"]},
            say: {type: "string"},
          },
          required: ["result", "say"],
          additionalProperties: false,
        },
      },
    })
    expectStrictSchema(calls[0]!.body.output_config.format.schema)
  })

  test("the system prompt keeps v1's rules", async () => {
    respond = () => claudeSaysJson({result: "pass", say: "Nice work."})
    await brain.checkStep(KEY, CHECK_INPUT)
    const system: string = calls[0]!.body.system
    expect(system).toContain("Judge only what is visible in the learner's photo.")
    expect(system).toContain('result "pass"')
    expect(system).toContain('result "fix"')
    expect(system).toContain('result "unclear"')
    expect(system).toContain("at most 8")
    expect(system).toContain("at most 18 words")
    expect(system).toContain("at most 14 words")
    expect(system).toContain('Never mention photos, images or cameras in "say".')
  })

  test("without an expert photo, and for an old step with no check fields", async () => {
    respond = () => claudeSaysJson({result: "unclear", say: "Look at the bowl and try again."})
    await brain.checkStep(KEY, {
      tutorialTitle: LESSON.title,
      step: LESSON.steps[0]!, // no done_looks_like, no common_mistake, no tips
      learner: LINK,
      reference: null,
      heard: "",
    })
    expect(calls[0]!.body.messages[0].content).toEqual([
      {type: "text", text: "The learner's attempt just now:"},
      LINK_BLOCK,
      {
        type: "text",
        text: [
          "Lesson: Making matcha",
          "Step 1: Sift the matcha",
          "Instruction: Sift two scoops of matcha into the bowl.",
          // done_looks_like is missing, so the detail text stands in, under an honest label.
          "About this step: Sifting breaks up clumps.",
          "Check the learner's attempt.",
        ].join("\n"),
      },
    ])
  })

  test("returns each kind of verdict", async () => {
    const verdicts = [
      {result: "pass", say: "Nice work."},
      {result: "fix", say: "Sift the powder first so there are no lumps."},
      {result: "unclear", say: "Look at the bowl and try again."},
    ]
    for (const verdict of verdicts) {
      respond = () => claudeSaysJson(verdict)
      expect(await brain.checkStep(KEY, CHECK_INPUT)).toEqual(verdict as any)
    }
  })

  test("accepts a result written with a capital letter, and trims the sentence", async () => {
    respond = () => claudeSaysJson({result: "Pass", say: "  Nice work.  "})
    expect(await brain.checkStep(KEY, CHECK_INPUT)).toEqual({result: "pass", say: "Nice work."})
  })

  test("a result that is none of the three is an error", async () => {
    respond = () => claudeSaysJson({result: "maybe", say: "Hmm."})
    const err = await failure(() => brain.checkStep(KEY, CHECK_INPUT))
    expect(err.status).toBe(200)
    expect(err.message).toBe("Claude's check had no clear result.")
  })

  test("a verdict with nothing to say is an error", async () => {
    respond = () => claudeSaysJson({result: "fix", say: "   "})
    const err = await failure(() => brain.checkStep(KEY, CHECK_INPUT))
    expect(err.message).toBe("Claude's check came back without words.")
  })

  test("a photo link Claude cannot open fails with status 400, which the Coach retries with bytes", async () => {
    respond = () => claudeError(400, "invalid_request_error", "Unable to download the file.")
    const err = await failure(() => brain.checkStep(KEY, CHECK_INPUT))
    expect(err.status).toBe(400)
    expect(err.message).toBe("Unable to download the file.")
  })

  test("an answer that ran out of tokens is an error", async () => {
    respond = () => claudeSays('{"result": "fix", "say": "Sift the', "max_tokens")
    const err = await failure(() => brain.checkStep(KEY, CHECK_INPUT))
    expect(err.status).toBe(200)
    expect(err.message).toBe("Claude's answer was cut off.")
  })
})

// ---------- answer ----------

describe("answer", () => {
  test("sends the lesson, the current step, its neighbours, the conversation and the question", async () => {
    respond = () => claudeSays("About 80 degrees, so not boiling.")
    await brain.answer(KEY, ANSWER_INPUT)

    expect(calls).toHaveLength(1)
    const body = calls[0]!.body
    expectEnvelope(calls[0]!, CHAT_MODEL, 200)
    // Plain text back: no schema.
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "system", "thinking"])
    expect(body.thinking).toEqual({type: "disabled"})

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Lesson: Making matcha",
              "Tools: bowl, whisk",
              "Ingredients: matcha powder, hot water",
              'Current step: step 2 of 3, "Add the water"',
              "Spoken instruction: Pour in a little hot water.",
              "Detail: Boiling water makes the tea bitter.",
              "Tips: Let the kettle rest first. Pour down the side.",
              "Finished looks like: A shallow pool of water covers the powder.",
              "Common mistake: Using boiling water.",
              "The expert's story: My grandmother always waited two minutes.",
              "Previous step: Sift the matcha",
              "Next step: Whisk",
              "Recent conversation:",
              "Tinker: Step 2. Pour in a little hot water.",
              "Learner: Tinker, how hot should the water be?",
              'Learner asks: "How hot should the water be?"',
            ].join("\n"),
          },
        ],
      },
    ])
  })

  test("the system prompt carries the rules of the team's Python prompt", async () => {
    respond = () => claudeSays("About 80 degrees.")
    await brain.answer(KEY, ANSWER_INPUT)
    const system: string = calls[0]!.body.system
    expect(system).toContain("You are Tinker, a warm, patient, and knowledgeable skill tutor")
    expect(system).toContain("smart glasses with NO display")
    expect(system).toContain("hands-on work with their hands")
    expect(system).toContain("Respond in exactly 1 to 3 concise, natural spoken sentences.")
    expect(system).toContain("NEVER use markdown, bullet points, asterisks, numbered lists, emojis, or URLs.")
    expect(system).toContain("Direct and clear audio advice only.")
    expect(system).toContain("Answer in the context of the user's current step.")
  })

  test("leaves out what a step or a lesson does not have", async () => {
    respond = () => claudeSays("Two scoops.")
    await brain.answer(KEY, {
      tutorial: {...LESSON, tools_required: undefined, ingredients_required: []},
      stepNumber: 1, // first step: nothing before it, and none of the optional fields
      question: "How much matcha?",
      recent: [],
    })
    expect(calls[0]!.body.messages[0].content[0].text).toBe(
      [
        "Lesson: Making matcha",
        'Current step: step 1 of 3, "Sift the matcha"',
        "Spoken instruction: Sift two scoops of matcha into the bowl.",
        "Detail: Sifting breaks up clumps.",
        "Next step: Add the water",
        'Learner asks: "How much matcha?"',
      ].join("\n"),
    )

    await brain.answer(KEY, {tutorial: LESSON, stepNumber: 3, question: "Is this the end?", recent: []})
    const last: string = calls[1]!.body.messages[0].content[0].text
    expect(last).toContain("Previous step: Add the water")
    expect(last).not.toContain("Next step:")
  })

  test("cleans the reply for speech", async () => {
    respond = () => claudeSays("  **Whisk** from the wrist.\n\n# Keep it `light`,\r\n*  and   fast.  ")
    expect(await brain.answer(KEY, ANSWER_INPUT)).toBe("Whisk from the wrist. Keep it light, and fast.")
  })

  test("joins a reply that arrives in more than one piece", async () => {
    respond = () =>
      http(200, {
        content: [
          {type: "text", text: "About 80 degrees."},
          {type: "text", text: "Not boiling."},
        ],
        stop_reason: "end_turn",
      })
    expect(await brain.answer(KEY, ANSWER_INPUT)).toBe("About 80 degrees. Not boiling.")
  })

  test("a reply with nothing left to say is an error, not silence", async () => {
    respond = () => claudeSays(" ** \n # ")
    const err = await failure(() => brain.answer(KEY, ANSWER_INPUT))
    expect(err.status).toBe(200)
    expect(err.message).toContain("Claude gave an empty answer")
  })

  test("a refusal is an error", async () => {
    respond = () => claudeSays("I can't help with that.", "refusal")
    const err = await failure(() => brain.answer(KEY, ANSWER_INPUT))
    expect(err.status).toBe(200)
    expect(err.message).toBe("Claude declined to answer this question.")
  })
})

// ---------- failures every call shares ----------

describe("every call", () => {
  test.each(ALL_CALLS)("%s: no connection is status 0", async (_name, run) => {
    globalThis.fetch = (async (_url: unknown, init: any) => {
      calls.push({url: _url, init, body: undefined})
      throw new TypeError("Network request failed")
    }) as unknown as typeof fetch
    const err = await failure(run)
    expect(err.status).toBe(0)
    expect(err.message).toBe("No connection to Claude. Network request failed")
  })

  test.each(ALL_CALLS)("%s: a connection that drops while the answer arrives is status 0", async (_name, run) => {
    respond = () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("The network connection was lost.")
      },
    })
    const err = await failure(run)
    expect(err.status).toBe(0)
    expect(err.message).toBe("No connection to Claude. The network connection was lost.")
  })

  test.each(ALL_CALLS)("%s: a failure that is not an Error object still gives its reason", async (_name, run) => {
    // Mentra's fetch rejects with a plain object of this shape, not with an Error.
    globalThis.fetch = (async (_url: unknown, init: any) => {
      calls.push({url: _url, init, body: undefined})
      throw {code: "NATIVE_THROW", message: "fetch: The request timed out."}
    }) as unknown as typeof fetch
    const err = await failure(run)
    expect(err.status).toBe(0)
    expect(err.message).toBe("No connection to Claude. fetch: The request timed out.")
  })

  test.each(ALL_CALLS)("%s: an HTTP error keeps its status and Claude's message", async (_name, run) => {
    respond = () => claudeError(529, "overloaded_error", "Overloaded")
    const err = await failure(run)
    expect(err.status).toBe(529)
    expect(err.message).toBe("Overloaded")
  })

  test.each(ALL_CALLS)("%s: an HTTP error without Claude's message still keeps its status", async (_name, run) => {
    respond = () => http(502, "<html>Bad Gateway</html>")
    const err = await failure(run)
    expect(err.status).toBe(502)
    expect(err.message).toBe("Claude answered with HTTP 502.")
  })

  test.each(ALL_CALLS)("%s: HTTP 200 with a body that is not JSON is an error", async (_name, run) => {
    respond = () => http(200, "<html>Sign in to the wifi</html>")
    const err = await failure(run)
    expect(err.status).toBe(200)
    expect(err.message).toBe("Claude's answer was not JSON.")
  })

  test.each(ALL_CALLS)("%s: makes exactly one request and never retries by itself", async (_name, run) => {
    respond = () => claudeError(500, "api_error", "Internal server error")
    await failure(run)
    expect(calls).toHaveLength(1)
  })
})

describe("the two calls that ask for JSON", () => {
  test.each(JSON_CALLS)("%s: stop reason max_tokens is an error", async (_name, run) => {
    // Cut-off JSON can still parse by accident, so the stop reason decides.
    respond = () => claudeSays("{}", "max_tokens")
    const err = await failure(run)
    expect(err.status).toBe(200)
    expect(err.message).toContain("cut off")
  })

  test.each(JSON_CALLS)("%s: a reply that is not valid JSON is an error", async (_name, run) => {
    respond = () => claudeSays("Sure! Here is what I found:")
    const err = await failure(run)
    expect(err.status).toBe(200)
    expect(err.message).toBe("Claude's answer was not valid JSON.")
  })

  test.each(JSON_CALLS)("%s: a refusal is an error", async (_name, run) => {
    respond = () => claudeSays("I can't help with that.", "refusal")
    const err = await failure(run)
    expect(err.status).toBe(200)
    expect(err.message).toBe("Claude declined to answer this request.")
  })

  test.each(JSON_CALLS)("%s: a reply with no text is an error", async (_name, run) => {
    respond = () => http(200, {content: [], stop_reason: "end_turn"})
    const err = await failure(run)
    expect(err.status).toBe(200)
    expect(err.message).toBe("Claude returned no text (stop reason: end_turn).")
  })

  test.each(JSON_CALLS)("%s: valid JSON of the wrong shape is an error", async (_name, run) => {
    respond = () => claudeSaysJson("just a string")
    const err = await failure(run)
    expect(err.status).toBe(200)
  })
})

// ---------- the built-in lesson ----------

const words = (text: string) => text.trim().split(/\s+/).length

describe("the built-in lesson", () => {
  test("there is exactly one, marked built_in, with steps numbered 1 to 6", () => {
    expect(BUILT_IN_TUTORIALS).toHaveLength(1)
    const lesson = BUILT_IN_TUTORIALS[0]!
    expect(lesson.built_in).toBe(true)
    expect(lesson.status).toBe("published")
    expect(lesson.steps).toHaveLength(6)
    expect(lesson.total_steps).toBe(6)
    expect(lesson.steps.map((step) => step.step_number)).toEqual([1, 2, 3, 4, 5, 6])
    expect(new Set(lesson.steps.map((step) => step.id)).size).toBe(6)
  })

  test("every step says what finished looks like and names a common mistake, within the word limits", () => {
    for (const step of BUILT_IN_TUTORIALS[0]!.steps) {
      const done = step.done_looks_like ?? ""
      const mistake = step.common_mistake ?? ""
      expect(done.trim(), `step ${step.step_number} done_looks_like`).not.toBe("")
      expect(mistake.trim(), `step ${step.step_number} common_mistake`).not.toBe("")
      expect(words(done), `step ${step.step_number} done_looks_like`).toBeLessThanOrEqual(25)
      expect(words(mistake), `step ${step.step_number} common_mistake`).toBeLessThanOrEqual(15)
      // Nobody told a story for this lesson, so none is made up.
      expect("story" in step).toBe(false)
    }
  })

  // The file belongs to the Python server. When that folder is removed from
  // the repository this test is skipped, and the check above still runs.
  test.skipIf(!hasTeamJson)("every field of the team's JSON file is unchanged", async () => {
    const original = await Bun.file(TEAM_JSON).json()
    const lesson = BUILT_IN_TUTORIALS[0] as any

    expect(original.steps).toHaveLength(6)
    for (const [field, value] of Object.entries(original)) {
      if (field !== "steps") expect(lesson[field], field).toEqual(value)
    }
    original.steps.forEach((step: Record<string, unknown>, i: number) => {
      for (const [field, value] of Object.entries(step)) {
        expect(lesson.steps[i][field], `step ${i + 1} ${field}`).toEqual(value)
      }
    })

    // And nothing else was added besides these.
    expect(Object.keys(lesson).sort()).toEqual([...Object.keys(original), "built_in"].sort())
    lesson.steps.forEach((step: Record<string, unknown>, i: number) => {
      expect(Object.keys(step).sort()).toEqual([...Object.keys(original.steps[i]), "common_mistake", "done_looks_like"].sort())
    })
  })
})

// ---------- rules for the two source files ----------

/** The code without its comments. A "//" inside a web address is not a comment. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1")
}

describe("claude.ts and seed.ts", () => {
  test("use nothing Mentra's background engine lacks", async () => {
    const banned =
      /\b(process|Buffer|URL|URLSearchParams|Headers|Request|Response|FormData|Blob|performance|window|document|require)\b/
    for (const file of ["claude.ts", "seed.ts"]) {
      const code = withoutComments(await Bun.file(`${SRC}/${file}`).text())
      expect(code.match(banned)?.[0], file).toBeUndefined()
    }
  })

  test("import only the contracts and the shared types, never Mentra", async () => {
    const imports = (source: string) => [...source.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map((m) => m[1])
    expect(imports(await Bun.file(`${SRC}/claude.ts`).text()).sort()).toEqual([
      "../shared/channels",
      "./contracts",
      "./contracts",
    ])
    expect(imports(await Bun.file(`${SRC}/seed.ts`).text())).toEqual(["../shared/channels"])
  })

  test("hold no stand-in answers from the Python server", async () => {
    // The Python code answered with fixed matcha sentences when Claude failed. None of that may be here.
    const code = withoutComments(await Bun.file(`${SRC}/claude.ts`).text()).toLowerCase()
    for (const word of ["matcha", "whisk", "celsius", "chashaku", "heuristic", "fallback"]) {
      expect(code.includes(word), word).toBe(false)
    }
  })

  test("hold no key, and this test file holds only the fake one", async () => {
    const keys = (source: string) => source.match(/sk-ant-[A-Za-z0-9_-]+/g) ?? []
    expect(keys(await Bun.file(`${SRC}/claude.ts`).text())).toEqual([])
    expect(keys(await Bun.file(`${SRC}/seed.ts`).text())).toEqual([])
    for (const key of keys(await Bun.file(import.meta.path).text())) expect(key).toBe(KEY)
  })
})


// Added by the lead after the code review: an answer that hit max_tokens stops
// mid-sentence, and only its whole sentences may be spoken.
describe("answer cut off by max_tokens", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  const lesson = BUILT_IN_TUTORIALS[0]!

  test("speaks only the whole sentences", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{type: "text", text: "Use water at about 80 degrees. Let a boiled kettle cool for two min"}],
          stop_reason: "max_tokens",
        }),
      )) as unknown as typeof fetch
    const reply = await createBrain().answer("sk-ant-test-key-1234", {tutorial: lesson, stepNumber: 3, question: "How hot?", recent: []})
    expect(reply).toBe("Use water at about 80 degrees.")
  })

  test("fails when not even one sentence is whole", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({content: [{type: "text", text: "Use water at about"}], stop_reason: "max_tokens"})),
    ) as unknown as typeof fetch
    await expect(
      createBrain().answer("sk-ant-test-key-1234", {tutorial: lesson, stepNumber: 3, question: "How hot?", recent: []}),
    ).rejects.toMatchObject({status: 200})
  })
})
