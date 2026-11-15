# Testing

What is tested, how, and what is not. On 2026-11-14 every automated check on this page passed on a computer. Nothing has been run on real glasses.

## Commands

Run them in this folder (`my-miniapp/`).

```bash
bun install          # once
bun run typecheck    # TypeScript over src/, including the Mentra SDK's types
bun run build        # Mentra's build, with its check for code the background engine cannot run
bun test             # all six test files
```

The last three are "the three checks". All must pass before a commit.

<<<<<<< HEAD
Result on 2026-11-14: type-check 0 errors, build passes, `bun test` 244 pass in 6 files.
=======
### Windows build checker crash

Mentra CLI `0.1.0-beta.2` can crash during a build with `getSymbolOfDeclaration(location).members` or `getSymbolOfDeclaration(container).members`, pointing at a source file at line 0. Its background runtime guard compares filenames literally in a single-file TypeScript compiler host, but TypeScript normalizes Windows backslashes to forward slashes. The source is then missing from the compiler program and symbol lookup crashes. This was reproduced on Windows with Bun 1.3.10 and 1.3.13; the normal `tsc` check passes.

`build.ts` normalizes paths passed to the guard's load callback. The guard remains enabled, and dependency versions are unchanged. This is a build fix on a computer; it does not establish that the app works on glasses.

Result on 2026-11-14: type-check 0 errors, build passes, `bun test` 153 pass in 4 files.
>>>>>>> 4d5217c (Fully integrated and tested on Windows)

| File | Tests |
| --- | --- |
| `test/claude.test.ts` | 77 |
| `test/coach.test.ts` | 58 |
| `test/ui.test.tsx` | 29 |
| `test/ui-render.test.tsx` | 50 |
| `test/ui-coach.test.ts` | 29 |
| `test/phone.test.ts` | 1 |

`test/ui-dom.tsx` (the fake browser and fake Mentra App of the screen tests) and `test/ui-rig.ts` (the real Coach wired to the screen's data) are helpers, not test files. Trap: happy-dom's window is the global object, and `bun test` runs every file in one process, so a new file that needs the fake browser must use `startDom()` and `stopDom()` from `test/ui-dom.tsx` the way the two screen test files do.

One file alone: `bun test test/coach.test.ts`.

`test/phone.test.ts` runs `bun run build` first, and the build empties and rewrites `dist/`. If another build runs at the same moment (a second terminal, or `scripts/real-app-test.ts`), the test can fail because `dist/background/index.js` is missing. That is a collision, not a real failure: wait a moment and run it again.

`tsc` checks only `src/`. The test files, `scripts/` and `build.ts` are not type-checked. Bun runs them without checking types, so a wrong type in a test shows up only when the test fails.

## What each test file proves

### `test/claude.test.ts` (77 tests)

Tests the four requests in `src/background/claude.ts` and the built-in lesson in `src/background/seed.ts`. `globalThis.fetch` is replaced by a fake that records what was sent and answers what the test asks for. No request leaves the machine.

| Group | Tests | What is checked |
| --- | --- | --- |
| Models and `createBrain` | 2 | The three model ids, and that `createBrain()` gives the four calls. |
| `testKey` | 2 | One 1-token request. A rejected key fails with status 401 and Claude's own words. |
| `buildLesson` | 9 | One text line per capture followed by its photo, the schema, the prompt rules, the skill hint, the reply being tidied, JSON found after another kind of block, no steps is an error, a cut-off answer says to record fewer steps. |
| `checkStep` | 10 | Expert photo first and learner photo second, each named in words. The schema allows exactly pass, fix, unclear. The prompt rules, including "at most 8" words of praise. A step with no check fields. Each verdict. A result written with a capital letter. Bad results are errors. Status 400 is passed on. |
| `answer` | 7 | The lesson, the step, its neighbours, the conversation and the question are sent. The Python prompt's rules are in the system prompt. The reply is cleaned for speech. An empty reply and a refusal are errors. |
| Every call | 28 | Seven cases for each of the four calls: no connection is status 0, a dropped connection is status 0, a failure that is not an `Error` object still gives its reason, an HTTP error keeps its status and Claude's message, an HTTP error without a message keeps its status, HTTP 200 that is not JSON is an error, exactly one request and no retry. |
| The two JSON calls | 10 | Five cases for each: stop reason `max_tokens`, invalid JSON, a refusal, no text, JSON of the wrong shape. |
| The built-in lesson | 3 | Exactly one, marked `built_in`, 6 steps. Every step has `done_looks_like` and `common_mistake` within the word limits and no `story`. Every field of the team's original file (`test/fixtures/tut_matcha_ceremonial_01.json`) is unchanged. |
| Rules for the two source files | 4 | `claude.ts` and `seed.ts` use nothing the background engine lacks, import only the contracts and the shared types, hold no stand-in answers and hold no key. |
| An answer cut off by `max_tokens` | 2 | Only the whole sentences are spoken. With no whole sentence it is an error. |

**It does not prove** that the real Claude API accepts these requests, that the model ids exist, or that the answers are any good. That is the job of the real Claude API test below.

### `test/coach.test.ts` (58 tests)

Runs the real `Coach` with a fake `Device` (photos, speech, light, storage, kept photos, messages to the screen) and a fake `Brain` (the four Claude calls). The clock is fake too, so nothing waits for real time. After every input a test waits with `await coach.whenIdle()`.

It covers:

- **Command parsing:** the end-of-sentence rule, the whole-sentence words, the name "Tinker".
- **The key:** tested before it is saved, a rejected key is not saved, teaching without a key is refused out loud and on the screen.
- **Teaching:** a full lesson by voice ending in review, publish with an edited title, the typed skill reaching Claude, timed photos (after 20 seconds, silent, never while a command runs or the app speaks), a command given during a timed photo, the choice of at most 12 photos, the last step's photo when a timed photo took its words, a failed lesson build keeping the recording, a lesson without steps refused, finish with nothing recorded, a failed photo, discard deleting kept photos, the library limit of 20, narration keeping its last 1500 characters, words said during the app's "Step N saved." kept in the lesson.
- **Learning:** fix and unclear stay on the step, a pass moves on, a pass on the last step ends the lesson, a failed check, a new check that clears the old verdict, next, previous, repeat, why, tips and materials, a spoken and a typed question, the name alone and the echo of its reply, no key.
- **The app's own voice:** speech ignored while it talks, the echo filter and its 10 seconds, one-word echoes, an echo that closes its unfinished line, a quick spoken answer 1.2 seconds after a prompt, an echo that ends in command words, Claude's sentence made harmless ("Okay."), and a last test that runs every sentence the app said in the whole file through `parseCommand` for every mode and expects no command.
- **Photos:** link refusal falls back to bytes and is remembered, a status 400 that is not about links does not give up on links, old links fall back to the kept copy, then a download, then no photo, at most 30 photos' bytes kept in memory.
- **Restart and storage:** the key and the library survive, a damaged library does not stop the start, a damaged saved lesson is cleaned, a failed read at start never wipes the saved lessons, removing the key when the phone cannot delete it.
- **The gate and the screen:** teaching and learning never run together, "End Session" while the app speaks, "End Session" during a check or a question (no verdict, no answer), the assistant state while a command runs, no failure leaves the app stuck, `snapshot()` matches the single messages, unfinished sentences reuse one transcript id, speech or a Claude request that never ends.
- **The library:** delete, not while being learned, never the built-in lesson.
- **The glasses button** in every mode, and the small screen messages (ping, library, audio check, connection, help).

**It does not prove** that the real glasses or the real Claude API behave like the fakes. No test checks that `coach.ts` and `commands.ts` stay free of Mentra imports. That rule is kept by reading.

### `test/ui.test.tsx` (29 tests)

Renders the real `<App />` inside the real `<MentraProvider>` in a fake browser (happy-dom), with a fake `mentra` object in place of the Mentra App (both in `test/ui-dom.tsx`). The fake records every `send` and `request`, and a test pushes events the way the background would.

| Group | Tests | What is checked |
| --- | --- | --- |
| Before the first snapshot | 2 | Nothing is claimed ("Connecting..."), a snapshot is asked for, the answer is applied. |
| Library | 3 | The built-in lesson is tagged and has no Delete. A recorded lesson's Delete asks twice. Start Learning sends the command and waits for the background. |
| Learning session | 10 | The step comes from `stepData`. The Check button sends `checkStep`. A verdict shows only under its own step. Photos remove themselves when their link fails. Unfinished transcript lines are replaced. A typed question is not added by the screen. The busy rule. No key. The back gesture, Resume and the end note. |
| Teaching | 6 | Start sends what was typed and no built-in skill name. Errors and real counts show. A failed build stays visible through clock ticks. The last photo and a dead link. Review, edit, publish, then follow the background to the library. The key box when no key is saved. |
| Settings | 3 | Saving a key calls `setKey` and shows the returned error. The last four characters, and Remove. "Test glasses audio" sends `testAudio`. |
| The whole screen | 2 | It never names a Claude model version. Dark mode follows the Mentra App's theme. |
| `applyEvent` | 3 | Starts from nothing and is replaced by a snapshot. Processing counts as busy. An empty `tutorialList` empties the library. |

**It does not prove** layout, colours, or the real bridge to the Mentra App. The layout was looked at by eye in a headless browser at 380 px wide during the merge. Those pictures are not in this repository.

### `test/ui-render.test.tsx` (50 tests)

More screen tests in the same fake browser. A review broke the screen code on purpose in 33 small ways, and 25 of the broken versions still passed `test/ui.test.tsx`. These tests catch them, plus one test for each fix made after that review. Groups: the re-request of a snapshot while the screen is busy or has none, a background that does not answer ("Close Tinker and open it again."), the key box (including "No answer from Tinker. Try again." after 30 seconds), photos and dead links, the "Step N passed." note, history and scroll, buttons that respect busy, "Ending after this sentence..." for End and Discard, snapshots and events, plain words for known failures, typed text that survives a tab switch, and `main.tsx`. Timers are bun's fake timers, so a 10 second wait takes no real time.

### `test/ui-coach.test.ts` (29 tests)

The screen's data fed by the REAL Coach through `test/ui-rig.ts`, with no browser. The rule it checks: after any series of events the background really sends, the screen's data equals that of a screen that opens fresh and asks for a snapshot. 9 tests walk whole lessons (a passed check, a pass on the last step, failed checks after a "fix", a screen opened mid-command or mid-recording, End Session while the glasses talk). 20 more are a fuzzer, one per seed, that throws random speech, taps, button presses, clock ticks, slow speech, slow or failing Claude requests, failing photos and screen reopenings at it.

### `test/phone.test.ts` (1 test, about 6 seconds)

First it runs `bun run build`. Then it loads the **built file** `dist/background/index.js`, the same file the phone loads, into an empty JavaScript sandbox (`node:vm`) that has only what Mentra's background engine has. A simulated phone answers the SDK, and a fake stands in for the Claude API.

The one test walks through the whole app: start-up, the screen opening and getting a snapshot, the glasses connecting, a wrong key and a good key, teaching one step by voice, the lesson being built, publish with an edited title, learning that lesson with a button press as the check, the built-in lesson with a spoken question and "Next step.", ending from the screen, and the screen closing and opening again.

**It proves** that the real Coach, the real Claude code, the Mentra SDK inside the bundle and the wiring in `index.ts` work together. It also checks what leaves for Claude: the model, the `thinking` field for each model, the expert's words, the photo as a link.

**It does not prove** that real glasses or the real Mentra App behave like the simulation.

## How the simulated phone works

For anyone who needs to extend `test/phone.test.ts` or `scripts/real-app-test.ts`. Both use the same simulated phone.

- The SDK sends every message with `__dispatch("__bridge", "send", JSON.stringify([raw]))`. `raw` is JSON: `{payload: {type, ...}, requestId?}`.
- The phone answers a request by calling `__mentraDeliverBridgeRaw(raw)` with `{payload: {type: "miniapp_request_result", ok: true, data}, requestId}`.
- The app is started with `__mentraInitCallback("session-1")`. Its first message is `miniapp_connect`. The answer is `miniapp_connect_ack` with `userId`, `packageName`, `capabilities`, `visibility`, `colorScheme` and `permissions`.
- Events from the phone are `{payload: {type: "miniapp_event", streamType, data}}`:
  - speech: `streamType: "transcription:en-US"`, `data: {text, isFinal}`
  - the button: `streamType: "button_press"`, `data: {buttonId, pressType}`
  - the glasses: `streamType: "glasses_connection"`, `data: {connected, modelName}`
- Messages from the phone screen are events on the stream `_ui`. `data` is `{type: "UI_OPEN"}`, `{type: "UI_CLOSE"}` or `{type: "UI_MESSAGE", channel, payload, seq, requestId?}`.
- Messages to the screen leave as `{type: "UI_SEND", channel, payload, seq, requestId?}`. The answer to a request (`getSnapshot`, `setKey`) carries the `requestId`, and its payload is wrapped: `{ok: true, result}` or `{ok: false, error}`.
- Request types the simulated phone answers: `miniapp_storage_get`, `miniapp_storage_set`, `miniapp_storage_delete`, `miniapp_speak` (answer `{completed: true}`), `miniapp_photo` (answer `{requestId, photoUrl, mimeType, size}`), `miniapp_blob_set_from_url`, `miniapp_rgb_led`. In `test/phone.test.ts` every other request gets `null`, so reading a kept photo back finds nothing and the app downloads the photo link instead. `scripts/real-app-test.ts` also keeps and returns photo copies.
- `test/phone.test.ts` waits 900 ms before it "says" something, because the app ignores the microphone for 700 ms after it speaks. `scripts/real-app-test.ts` waits until the app is idle and then 3 more seconds, the way a person waits.

These names were read in `node_modules/@mentra/miniapp/src/protocol.ts`, `node_modules/@mentra/miniapp/src/modules/ui.ts` and the files under `node_modules/@mentra/miniapp/src/transport/`. They belong to SDK 3.4.0 and can change with the SDK version.

## What no test proves

- That real glasses take the photo, play the speech, blink the light or deliver button presses.
- That the app does not hear itself on real glasses. The echo rules are tested against made-up timing.
- How long anything takes on a phone.
- That the Mentra App on a real phone behaves like the simulated one.
- That the real Claude API accepts the requests, and how good its answers are. The two programs in the next section do that, from a computer.

## Real Claude API test

Two programs send real requests to the real Claude API with a real key. They are not part of `bun test`: they need a key, cost a little money and depend on the network.

| Program | What runs | What it proves |
| --- | --- | --- |
| `scripts/real-claude-test.ts` | The app's Claude code alone: `createBrain()` from `src/background/claude.ts` | That Claude accepts the four kinds of request (the model ids, the thinking switches, the JSON shapes, photos as bytes and as a link), and what the answers look like |
| `scripts/real-app-test.ts` | The built app (`dist/background/index.js`) on the simulated phone described above | That the parts work together with the real Claude: a lesson taught by voice, built, published, learned, checked from photos and finished, and a spoken question answered |

Both read the key from the environment variable `TINKER_CLAUDE_KEY` and never print it (see "The key is never printed" below). Both put the same four drawings of a matcha bowl in front of the "camera" (`scripts/test-photos.ts`, drawn by `scripts/make-test-photos.py`): an empty bowl, a mound of matcha powder, the same mound from another spot in other light, and foamy matcha. They are drawings, not photos from the glasses.

### `scripts/real-claude-test.ts`: the Claude code alone, 9 checks

**Last result: 2026-11-14, from a cloud machine with the team's real key: 9 of 9 passed on two runs in a row. Lesson build 6 to 7 s, photo checks 1.2 to 2.8 s, answers about 1 s.**

It needs Node 18 or newer. Build one file here, then run it on the machine that has the key. `scripts/README.md` has the full description.

```bash
# in my-miniapp/ (needs bun). build/ is ignored by git.
bun build scripts/real-claude-test.ts --target=node --format=esm --outfile=build/real-claude-test.mjs

read -rs TINKER_CLAUDE_KEY && export TINKER_CLAUDE_KEY   # paste the key and press Enter. It is not shown.
node build/real-claude-test.mjs
```

It takes under a minute and sends about 9 small requests. The last line is `RESULT: ALL CHECKS PASSED` or `RESULT: n OF 9 CHECKS FAILED`. Exit code 0 means nothing failed, 1 means at least one check failed, 2 means no usable key was given and nothing was sent.

| # | Check | PASS when |
| --- | --- | --- |
| 1 | Key check | Claude accepts the key. If this fails the run stops. |
| 2 | A wrong key is rejected properly | A made-up key fails with status 401. |
| 3 | Build a lesson from three captures | 2 to 4 steps, no empty fields, a valid `source_capture`, spoken instructions of at most 30 words, a title. |
| 4 | Check a correct attempt | `pass`, with at most 12 words. |
| 5 | Check a wrong attempt | `fix` or `unclear`, at most 22 words, no mention of photo, image, picture or camera. |
| 6 | A photo sent as a link | Claude opens the link and does not say `pass`. If Claude answers 400 this is a NOTE: the app then sends bytes instead. |
| 7 | Check against the built-in lesson with no expert photo | The call succeeds. |
| 8 | Answer a question | At most 3 sentences and 60 words, no markdown signs, mentions 80 or 175. |
| 9 | Answer a question the lesson cannot answer | Not empty, at most 60 words. |

Two lines of the output start with `READ THIS`. A person has to judge them: in check 3 every step must come from the expert's three sentences, and in check 9 the reply must not invent a year. A check that takes longer than 60 seconds gets a NOTE, because the Mentra App stops waiting after 60 seconds.

**Runs on 2026-11-14,** from a cloud machine, not from a phone:

- Run 1 (18:52): 8 of 9 checks passed. Check 4 failed only on length: the praise for a correct step was 14 words ("Nice work, that mound of matcha sits right in the center of the bowl."). The verdict itself was right. The lead then tightened the pass rule in `CHECK_SYSTEM` (D29 in `docs/DECISIONS.md`).
- Runs 2 and 3 (about 19:00): all 9 passed both times. Building a lesson took 6.1 and 6.9 seconds, photo checks 1.2 to 2.8 seconds, answers 0.8 to 1.1 seconds. The correct attempt got "Nice work, that looks right." The wrong attempt (an empty bowl) got "The bowl is still empty. Sift two scoops of matcha into the middle of the bowl." Claude opened the public picture link in check 6.
- In all three runs, check 7 (the built-in lesson, no expert photo) judged a correct drawing "fix". Check 7 only asks that the call succeeds, so it still counts as passed. See D28 in `docs/DECISIONS.md`: for the demo, record a lesson and learn that one.

**It does not prove** anything about Mentra's own photo links: the link in check 6 is a public picture on GitHub. The requests come from a computer, not from the phone's background engine.

**Dry run, without a key:** `TINKER_DRY_RUN=1 node build/real-claude-test.mjs`. A fake inside the program answers every request. This shows that the program works and says nothing about the real API. `TINKER_DRY_FAULT=check5` and `TINKER_DRY_FAULT=link400` make the fake misbehave on purpose, to show that a failure and a NOTE are reported.

### `scripts/real-app-test.ts`: the whole app with the real Claude, 12 checks

**Last result: 2026-11-14, about 19:37, from a cloud machine with the team's real key: 12 of 12 passed in 52.6 s. The made-up photo links got HTTP 400, so the app sent the photos again as bytes, and the lesson build took 5.3 s. Checks took 1.1 to 1.5 s. The answer took 0.9 s and ended in "Okay." from the guard (`defuse`), because Claude's answer ended in "next step".**

It builds the app with `bun run build`, loads `dist/background/index.js` into the same kind of sandbox as `test/phone.test.ts`, and plays the phone, the glasses and the person: it answers the SDK's requests, "speaks" sentences into the microphone, taps the phone screen and puts a drawing in front of the camera before each photo. Every request to Claude is real.

What the run does, in order: the key is saved on the screen (one real test request). A lesson is taught by voice in three steps, with a drawing for each ("First I set out a clean, dry tea bowl. Next step." and two more), then "Finish lesson." Claude builds the lesson, and the program prints it. "Publish lesson." "Start lesson." Then a photo check for every step by saying "Check.": once with the wrong drawing (an empty bowl on the powder step), and with the right drawing for each step. Then the built-in lesson is started from the screen, "Tinker, how hot should the water be?" is asked, and "Stop lesson." ends it.

| # | Check | PASS when |
| --- | --- | --- |
| 1 | The app refuses a wrong key and accepts the right one | Each after a real test request |
| 2 | Claude builds a lesson from the recording | 2 to 4 steps, each with a spoken instruction and a "done looks like" line |
| 3 | Published by voice and saved on the phone | The glasses say "Lesson published." and one lesson is stored |
| 4 | The lesson starts by voice | The recorded lesson is active |
| 5 | A wrong attempt is not passed | The empty bowl on the powder step is not `pass` |
| 6 | Every correct attempt is passed | Every right drawing gets `pass` |
| 7 | The lesson ends after the last step | `learningState` says `active: false, finished: true` |
| 8 | A spoken question is answered by Claude | The answer mentions 80, 175 or "eighty" |
| 9 | The lesson stops by voice | `learningState` says `active: false` |
| 10 | No error escaped inside the app | The app wrote nothing with `console.error` (that is where `safely` reports) |
| 11 | Every photo check sent Claude the right photos | The expert's photo of that step and the learner's photo |
| 12 | The app acted on every sentence and tap the first time | Nothing had to be said or tapped twice |

**Photo links:** the simulated glasses hand out links on `photos.example`, a name that exists nowhere. Claude cannot open them, so the first request with photos is refused with HTTP 400 and the app sends the photo bytes instead (`withPhotos` in `coach.ts`). The summary at the end says whether that happened and whether the bytes worked. Real Mentra links were not tried.

```bash
# in my-miniapp/ (needs bun)
read -rs TINKER_CLAUDE_KEY && export TINKER_CLAUDE_KEY   # paste the key and press Enter. It is not shown.
bun scripts/real-app-test.ts
```

It sends about 9 requests to Claude. The output ends with every request to Claude (kind, HTTP status, seconds, model, and whether each photo went as a link or as bytes), the list of checks, and one line that starts with `RESULT:` (`RESULT: ALL CHECKS PASSED` when nothing failed). Exit code 0 means all passed, 1 means a check failed or the run stopped early, 2 means no usable key was given and nothing was sent.

**Dry run, without a key:** `TINKER_DRY_RUN=1 bun scripts/real-app-test.ts`. A fake Claude answers, nothing leaves the machine, and the result says nothing about the real API.

**It does not prove** anything about real glasses: the camera, the speaker, the microphone, the button or the timing. Because it rebuilds `dist/`, do not run it at the same time as `bun test`.

### The key is never printed

Both programs read the key from `TINKER_CLAUDE_KEY`, remove spaces and quotes around it, and refuse a value that does not start with `sk-ant-` before anything is sent. They show only that the key starts with `sk-ant-`, its last 4 characters and its length. Log lines, error messages and check results go through a function (`hide`) that replaces the key with `[key hidden]`, in case the key ever comes back inside an error or a reply. The key goes to `https://api.anthropic.com/v1/messages` and nowhere else, and it is not written to any file.

## The first test on real glasses

Nobody has done it yet. The steps, with what should happen at each one, are in `docs/GLASSES_TEST.md`. Afterwards, update the status table in `AGENTS.md` and the open questions in `docs/DECISIONS.md` with what you saw.

## If something fails

Errors appear in three places on the phone: a red line on the Teaching tab, the result line under the key box, and notes in "Live Conversation Transcript" (which is only shown inside a lesson). With `bun run dev`, the phone's console output also appears in the laptop terminal. The app writes to the console only when `safely` in `index.ts` catches an error.

| What you see or hear | Likely cause | Where to look |
| --- | --- | --- |
| Tinker does not open at all | The paired glasses model must have a camera and a microphone (`hardwareRequirements` in `miniapp.json`). In Mentra's source, no paired glasses or simulated glasses block the launch. The Mentra App must be 1.42.0 or newer. | The glasses pairing in the Mentra App, `miniapp.json` |
| The screen stays on "Connecting..." | The background did not start, or does not answer `getSnapshot`. The screen asks again every 2 seconds. | The laptop terminal of `bun run dev`. `registerMiniapp` in `src/background/index.ts`. |
| A line `[tinker] ... failed:` in the terminal of `bun run dev` | An error escaped a handler. `safely` caught it and the app kept running. The words after the colon are the error. | `safely` in `src/background/index.ts`, then the handler it names |
| "Glasses not connected", "Camera not found" or "Microphone not found" | The glasses are not connected in the Mentra App | `hardware()` in `src/background/index.ts` |
| The voice comes from the phone | The glasses are not the phone's Bluetooth audio output | Phone audio settings |
| No words under "Heard for this step", no "You" lines | Microphone permission denied, or no internet, or the phone is not signed in to Mentra (speech recognition uses Mentra's cloud first) | `session.transcription.forLanguage` in `index.ts`, `permissions` in `miniapp.json` |
| "Step N saved without a photo.", "I could not take a photo. Say check to try again.", a note "Photo failed. ..." | Camera permission missing, or the photo took longer than 25 seconds. In Mentra's source a photo is also refused when the glasses are not connected, the phone is not signed in to Mentra's cloud, a video is recording, the glasses battery is under 15 percent, or another photo is still in flight. | `takePhoto` and `PHOTO_TIMEOUT_MS` in `index.ts` |
| Photo checks judge blurry, tiny pictures | The glasses are not on Wi-Fi, so photos travel over Bluetooth at about 640 x 640 pixels (Mentra's source) | The glasses' Wi-Fi in the Mentra App. A phone hotspot works. |
| "That is not a Claude key. A Claude key starts with sk-ant-." | Something else was pasted | The key box |
| "Claude rejected this key. Copy it again from the Claude Console." | Wrong or deleted key | Claude Console |
| "The test request failed. No connection to Claude. ..." | The phone has no internet | Phone network |
| "The test request failed. ..." with a message that names `thinking` or the model | Claude refuses the request shape | `thinkingOff` and the model constants in `src/background/claude.ts`. Run the real Claude API test. |
| Red line "The lesson was not built. ..." and "I could not build the lesson. Say finish lesson to try again." | The text after it is the reason: Claude's own error, "Claude's answer was cut off. Record fewer steps.", "No connection to Claude. ..." (on iPhone a request fails after 60 seconds without data), or "Claude did not answer in time." (after 90 seconds, `BUILD_GUARD_MS`) | `buildLesson` and `PLAN_MAX_TOKENS` in `claude.ts`, `MAX_PLAN_PHOTOS` in `coach.ts` |
| "I could not check that. Say check to try again." and a note "The check failed. ..." | The note holds the reason. "Claude did not answer in time." means 30 seconds passed (`CLAUDE_GUARD_MS`). | `checkStep` in `claude.ts` |
| "The lesson works now, but it could not be saved on this phone." | The phone's storage refused the write, or the library could not be read, so nothing was written over it. The reason is a note in the transcript (the phone shows it inside a lesson). The lesson is gone after a restart. | `saveLibrary` in `coach.ts` |
| A correct step of the built-in lesson gets "Needs a fix" | The built-in lesson has no expert photos, so the check rests on the written "done looks like" line. Against the real Claude API that was strict (D28 in `docs/DECISIONS.md`). | Record a lesson and learn that one. The lines are in `src/background/seed.ts`. |
| "I could not answer that. Ask again." and a note "The question failed. ..." | The note holds the reason | `answer` in `claude.ts` |
| A question gets no reaction | The name was not heard as "Tinker". Read the "You" line on the screen to see what was heard. | `WAKE_WORDS` in `src/background/commands.ts` |
| A command gets no reaction | It was said while the app was talking or within 700 ms after. Or it came less than 1.2 seconds after a prompt that contains the same words. Or another command was still running. | `QUIET_AFTER_SPEECH_MS`, `ECHO_REPLY_MS` and `run` in `src/background/coach.ts` |
| The app reacts to its own voice, or "You" lines repeat what the app said | The quiet gap or the echo filter is too weak for the real delay | `QUIET_AFTER_SPEECH_MS`, `ECHO_WINDOW_MS`, `ECHO_PERCENT` in `coach.ts` |
| A sentence ends in "Okay." or starts with "So," | Expected. The text would otherwise have ended in a command or started with the name. | `defuse` in `coach.ts` |
| The first request with photos takes twice as long | Claude cannot open Mentra's photo links. The first try fails, then bytes are sent. | Expected. `withPhotos` in `coach.ts` remembers it until the app restarts. |
| Buttons stay grey | The app is busy. "End Session", "End" and "Discard" always work. | `isBusy` in `src/ui/state.ts`, `current` in `coach.ts` |
| A photo is missing on the phone screen | Its link is older than about 10 minutes. The screen hides pictures that do not load. Checks still use the copy kept on the phone. | `Photo` in `src/ui/Parts.tsx` |
| "A draft is waiting, but it has not reached this screen." | The screen was told about a review but not given the draft | Close the screen and open it again |
| The glasses button does nothing | Mentra's source says presses reach the app, so this would be new. Write it down (open question 2 in `docs/DECISIONS.md`) and use voice or the phone screen. | `session.input.onButtonPress` in `index.ts` |
| The glasses go silent when taken off | Wear detection pauses media when the glasses are not worn (Mentra's source) | Wear the glasses, or switch wear detection off in the Mentra App |
| A lesson is missing on a second phone | Lessons are stored on the phone that recorded them | D2 in `docs/DECISIONS.md` |
| The build fails naming `process`, `URL`, `Headers` ... | Background code used something the engine lacks | The file and line in the message |
| `bun test` fails in `phone.test.ts` with "Build failed" | That test runs `bun run build` first | Run `bun run build` and read its output |
| `bun test` fails in `phone.test.ts` because `dist/background/index.js` is missing | Another build ran at the same moment | Run it again |
