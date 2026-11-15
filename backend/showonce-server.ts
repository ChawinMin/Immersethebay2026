/**
 * ShowOnce backend: the expert shows a task once, Claude turns it into a
 * teaching plan, then Claude checks a learner's photo for each step.
 *
 * SETUP
 *   bun add @anthropic-ai/sdk
 *   echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env      (Bun loads .env by itself)
 *   echo '.env' >> .gitignore
 *   bun run showonce-server.ts                      (listens on port 8787)
 *
 * ENDPOINTS
 *   POST /plan    expert captures in, teaching plan out
 *   GET  /plan/ID fetch a saved plan
 *   POST /check   learner photo in, "pass" or a one-sentence fix out
 *   GET  /health  returns ok
 *
 * A photo is always { "base64": "..." } or { "url": "https://..." }.
 *
 * POST /plan body
 *   {
 *     "title": "Making matcha",
 *     "captures": [
 *       { "transcript": "First I sift two scoops of matcha into the bowl...",
 *         "photo": { "url": "https://.../step1.jpg" } },
 *       { "transcript": "Then I pour in a little hot water...",
 *         "photo": { "base64": "/9j/4AAQ..." } }
 *     ]
 *   }
 *   Returns { "planId": "ab12cd34", "plan": { title, materials, steps[] } }
 *
 * POST /check body
 *   { "planId": "ab12cd34", "stepNumber": 1,
 *     "photo": { "url": "https://.../learner.jpg" },
 *     "heard": "okay I think I'm done" }            ("heard" is optional)
 *   Returns { "result": "pass" | "fix" | "unclear", "say": "...",
 *             "nextStep": {...} | null, "finished": true | false }
 *   Speak "say" out loud. On "pass", read nextStep.instruction next.
 *
 * WHY PHOTOS AND NOT VIDEO
 *   The Claude API takes images, not video files. The cheapest good input is
 *   one photo per step plus what the expert said at that step.
 *   If all you have is a video, cut it into frames first, one every 3 seconds:
 *     ffmpeg -i demo.mp4 -vf "fps=1/3,scale=1280:-2" -q:v 4 frame_%02d.jpg
 *   then send each frame as a capture. Put the full spoken transcript in the
 *   first capture's "transcript". This server keeps at most 20 photos per plan.
 *
 * COST AND SPEED
 *   A 1080p photo costs about 1,560 input tokens. Asking the glasses for a
 *   medium-size JPEG is enough and uploads faster.
 *   /plan uses the larger model once. /check uses the small fast model.
 */

import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const PLAN_MODEL = process.env.PLAN_MODEL ?? "claude-sonnet-5-5";
const CHECK_MODEL = process.env.CHECK_MODEL ?? "claude-haiku-5-5";
const PORT = Number(process.env.PORT ?? 8787);
const PLAN_DIR = process.env.PLAN_DIR ?? "./plans";
const MAX_PHOTOS_PER_PLAN = 20;
const MAX_BASE64_CHARS = 10 * 1024 * 1024; // Claude API limit: 10 MB per image

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// ---------- types ----------

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const MEDIA_TYPES: MediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

type PhotoInput = { base64?: string; url?: string; mediaType?: string };
type Capture = { transcript?: string; photo?: PhotoInput };
type StoredPhoto = { data: string; mediaType: MediaType };

type Step = {
  number: number;
  instruction: string;
  done_looks_like: string;
  common_mistake: string;
  story: string;
  source_capture: number;
};
type Plan = { title: string; materials: string[]; steps: Step[] };
type StoredPlan = { id: string; plan: Plan; photos: (StoredPhoto | null)[] };
type CheckResult = { result: "pass" | "fix" | "unclear"; say: string };

class BadRequest extends Error {}

// ---------- JSON shapes Claude must return ----------

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    materials: { type: "array", items: { type: "string" } },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: "integer" },
          instruction: { type: "string" },
          done_looks_like: { type: "string" },
          common_mistake: { type: "string" },
          story: { type: "string" },
          source_capture: { type: "integer" },
        },
        required: [
          "number",
          "instruction",
          "done_looks_like",
          "common_mistake",
          "story",
          "source_capture",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "materials", "steps"],
  additionalProperties: false,
};

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "string", enum: ["pass", "fix", "unclear"] },
    say: { type: "string" },
  },
  required: ["result", "say"],
  additionalProperties: false,
};

// ---------- prompts ----------

const PLAN_SYSTEM = `You turn one expert demonstration into a teaching plan for a beginner.
The beginner wears camera glasses with a speaker and no screen. Every instruction is read aloud.

You get numbered captures. Each has what the expert said and usually a photo taken at that moment.

Rules:
- Only include steps the expert showed or said. Do not invent steps.
- Merge captures that belong to the same step. Keep the expert's order.
- instruction: one or two short spoken sentences, plain words, at most 25 words.
- done_looks_like: what a photo shows when this step is finished correctly. Only things a camera can see.
- common_mistake: the most likely beginner error at this step, at most 15 words. Use "" if unknown.
- story: any history, meaning or personal reason the expert gave for this step, kept close to their own words. Use "" if they gave none.
- source_capture: the number of the capture whose photo best shows this step finished.
- materials: every tool and ingredient the expert used.`;

const CHECK_SYSTEM = `You check one step of a hands-on task for a beginner wearing camera glasses.
Your "say" text is spoken into their ear, so write it the way a calm teacher talks.

Rules:
- Judge only what is visible in the learner's photo.
- result "pass": the photo matches what the finished step should look like. say: a few warm words, at most 8.
- result "fix": something visible is wrong. say: the one most important correction, at most 18 words.
- result "unclear": the photo is blurry, dark, or does not show the work. say: ask them to hold the work in view and try again, at most 14 words.
- Small differences in angle, lighting or background are fine. Do not fail for those.
- Never mention photos, images or cameras in "say".`;

// ---------- helpers ----------

function isMediaType(value: string): value is MediaType {
  return (MEDIA_TYPES as string[]).includes(value);
}

/** Read the image type from the first bytes of the base64 data. */
function sniffMediaType(base64: string): MediaType | null {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  return null;
}

/** Turn { base64 } or { url } into bytes Claude can read. */
async function loadPhoto(photo: PhotoInput): Promise<StoredPhoto> {
  let data: string;
  let mediaType = photo.mediaType ?? "";

  if (photo.base64) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(photo.base64);
    if (match) {
      mediaType = mediaType || match[1]!;
      data = match[2]!;
    } else {
      data = photo.base64;
    }
  } else if (photo.url) {
    const res = await fetch(photo.url);
    if (!res.ok) throw new BadRequest(`Could not download photo (${res.status}): ${photo.url}`);
    mediaType = mediaType || (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    data = Buffer.from(await res.arrayBuffer()).toString("base64");
  } else {
    throw new BadRequest('A photo needs "base64" or "url".');
  }

  // Trust the file's own first bytes over any label. Claude rejects a mismatch.
  mediaType = sniffMediaType(data) ?? mediaType;
  if (!isMediaType(mediaType)) mediaType = "image/jpeg";
  if (data.length > MAX_BASE64_CHARS) {
    throw new BadRequest("Photo is over 10 MB. Ask the glasses for a smaller size.");
  }
  return { data, mediaType: mediaType as MediaType };
}

function imageBlock(photo: StoredPhoto): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: photo.mediaType, data: photo.data },
  };
}

/** Call Claude and get back JSON that matches the schema. */
async function askForJson<T>(options: {
  model: string;
  system: string;
  content: Anthropic.ContentBlockParam[];
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<T> {
  const message = await claude.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    system: options.system,
    messages: [{ role: "user", content: options.content }],
    output_config: { format: { type: "json_schema", schema: options.schema } },
  });

  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude's answer was cut off. Send fewer captures or raise maxTokens.");
  }
  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error(`Claude returned no text (stop reason: ${message.stop_reason}).`);
  }
  return JSON.parse(textBlock.text) as T;
}

/** Keep at most `limit` items, spread evenly across the list. */
function pickEvenly(indexes: number[], limit: number): Set<number> {
  if (indexes.length <= limit) return new Set(indexes);
  const kept = new Set<number>();
  for (let i = 0; i < limit; i++) {
    kept.add(indexes[Math.round((i * (indexes.length - 1)) / (limit - 1))]!);
  }
  return kept;
}

// ---------- storage ----------

const plans = new Map<string, StoredPlan>();

async function savePlan(stored: StoredPlan): Promise<void> {
  plans.set(stored.id, stored);
  await mkdir(PLAN_DIR, { recursive: true });
  await writeFile(`${PLAN_DIR}/${stored.id}.json`, JSON.stringify(stored));
}

async function getPlan(id: string): Promise<StoredPlan> {
  if (!/^[a-z0-9]+$/i.test(id)) throw new BadRequest("Bad planId.");
  const cached = plans.get(id);
  if (cached) return cached;
  try {
    const stored = JSON.parse(await readFile(`${PLAN_DIR}/${id}.json`, "utf8")) as StoredPlan;
    plans.set(id, stored);
    return stored;
  } catch {
    throw new BadRequest(`No plan with id ${id}.`);
  }
}

// ---------- the two jobs ----------

/** Expert captures in, teaching plan out. */
async function buildPlan(captures: Capture[], title?: string): Promise<StoredPlan> {
  if (!Array.isArray(captures) || captures.length === 0) {
    throw new BadRequest('"captures" must be a list with at least one item.');
  }

  const withPhoto = captures.flatMap((capture, i) => (capture.photo ? [i] : []));
  const keep = pickEvenly(withPhoto, MAX_PHOTOS_PER_PLAN);
  const photos = await Promise.all(
    captures.map((capture, i) => (capture.photo && keep.has(i) ? loadPhoto(capture.photo) : null)),
  );

  const content: Anthropic.ContentBlockParam[] = [];
  captures.forEach((capture, i) => {
    const said = capture.transcript?.trim() || "(nothing said)";
    content.push({ type: "text", text: `Capture ${i + 1}. The expert said: "${said}"` });
    const photo = photos[i];
    if (photo) content.push(imageBlock(photo));
  });
  content.push({
    type: "text",
    text: `Write the teaching plan for this task${title ? `: ${title}` : ""}.`,
  });

  const plan = await askForJson<Plan>({
    model: PLAN_MODEL,
    system: PLAN_SYSTEM,
    content,
    schema: PLAN_SCHEMA,
    maxTokens: 4000,
  });
  plan.steps.forEach((step, i) => (step.number = i + 1)); // always 1, 2, 3...

  const stored: StoredPlan = { id: crypto.randomUUID().slice(0, 8), plan, photos };
  await savePlan(stored);
  return stored;
}

/** Learner photo in, pass or a one-sentence fix out. */
async function checkStep(
  planId: string,
  stepNumber: number,
  learner: PhotoInput,
  heard?: string,
): Promise<CheckResult & { nextStep: Step | null; finished: boolean }> {
  const stored = await getPlan(planId);
  const step = stored.plan.steps.find((s) => s.number === stepNumber);
  if (!step) throw new BadRequest(`Plan ${planId} has no step ${stepNumber}.`);
  if (!learner) throw new BadRequest('"photo" is required.');

  const reference = stored.photos[step.source_capture - 1] ?? null;
  const learnerPhoto = await loadPhoto(learner);

  const content: Anthropic.ContentBlockParam[] = [];
  if (reference) {
    content.push({ type: "text", text: "Photo 1, the expert's finished result for this step:" });
    content.push(imageBlock(reference));
    content.push({ type: "text", text: "Photo 2, the learner's attempt just now:" });
  } else {
    content.push({ type: "text", text: "The learner's attempt just now:" });
  }
  content.push(imageBlock(learnerPhoto));
  content.push({
    type: "text",
    text: [
      `Step ${step.number}: ${step.instruction}`,
      `Finished looks like: ${step.done_looks_like}`,
      step.common_mistake ? `Common mistake: ${step.common_mistake}` : "",
      heard ? `The learner just said: "${heard}"` : "",
      "Check the learner's attempt.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const verdict = await askForJson<CheckResult>({
    model: CHECK_MODEL,
    system: CHECK_SYSTEM,
    content,
    schema: CHECK_SCHEMA,
    maxTokens: 200,
  });

  const nextStep =
    verdict.result === "pass"
      ? (stored.plan.steps.find((s) => s.number === stepNumber + 1) ?? null)
      : null;
  return { ...verdict, nextStep, finished: verdict.result === "pass" && nextStep === null };
}

// ---------- HTTP ----------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

async function readBody(req: Request): Promise<Record<string, any>> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    throw new BadRequest("Body must be JSON.");
  }
}

async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET" && pathname === "/health") return json({ ok: true });

  if (req.method === "POST" && pathname === "/plan") {
    const body = await readBody(req);
    const stored = await buildPlan(body.captures, body.title);
    return json({ planId: stored.id, plan: stored.plan });
  }

  if (req.method === "GET" && pathname.startsWith("/plan/")) {
    const stored = await getPlan(pathname.slice("/plan/".length));
    return json({ planId: stored.id, plan: stored.plan });
  }

  if (req.method === "POST" && pathname === "/check") {
    const body = await readBody(req);
    return json(await checkStep(body.planId, Number(body.stepNumber), body.photo, body.heard));
  }

  return json({ error: "Not found." }, 404);
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120, // building a plan from many photos can take a while
  async fetch(req) {
    try {
      return await handle(req);
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      if (error instanceof Anthropic.APIError) {
        console.error("Claude API error:", error.status, error.message);
        return json({ error: `Claude API error: ${error.message}` }, 502);
      }
      console.error(error);
      return json({ error: error instanceof Error ? error.message : "Server error." }, 500);
    }
  },
});

console.log(`ShowOnce server on http://localhost:${server.port}`);
console.log(`Plan model: ${PLAN_MODEL}. Check model: ${CHECK_MODEL}.`);
