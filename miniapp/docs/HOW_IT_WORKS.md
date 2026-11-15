# How Tinker works

Read this before changing any code. It describes the app as it is in this folder.

## The short version

Tinker is one Mentra miniapp. It runs inside the Mentra App on a phone and controls a pair of Mentra Live glasses (camera, microphone, speaker, button, light, no screen).

1. **Teach.** An expert does a task once and explains it out loud. At the end of each step the glasses take one photo. Claude turns the photos and the words into a lesson: a title, a materials list and numbered steps.
2. **Learn.** A beginner hears one step at a time. When they say "check", the glasses take a photo. Claude compares it with the expert's photo and answers "pass" or one correction, which is spoken into the beginner's ear.

There is no server. The phone calls the Claude API directly.

## Two layers

Every Mentra miniapp has two halves that do not share memory.

| Layer | Folder | Runs | Can reach the glasses |
| --- | --- | --- | --- |
| Background | `src/background/` | The whole time the miniapp is on, also with the phone screen off | Yes, through `session` |
| UI | `src/ui/` | Only while the Tinker screen is open on the phone | No. It sends messages to the background |

The background is a bare JavaScript engine (JavaScriptCore on iPhone, QuickJS on Android). It is not a browser and not Node. It has `console`, timers, `fetch`, `localStorage`, `atob`, `btoa`, `TextEncoder`, `TextDecoder`, and a small `crypto`. It has no `window`, `document`, `process`, `URL`, `Headers`, `FormData`, `Buffer` or `require`. `bun run build` fails with a file and line number when background code uses one of those.

## Files

| File | Job |
| --- | --- |
| `src/background/index.ts` | The only file that touches the Mentra SDK on the background side. It builds a `Device` object out of `session.*` calls and hands it to the `Coach`. |
| `src/background/coach.ts` | All behaviour: modes, teaching, coaching, speech, photo handling, saving. It has no Mentra import, so the tests can run it with a fake `Device`. |
| `src/background/claude.ts` | The Claude HTTP requests, the prompts and the JSON shapes Claude must return. |
| `src/background/commands.ts` | The spoken commands and the rule for spotting one in a sentence. |
| `src/shared/channels.ts` | The message types between UI and background. Both halves import it. |
| `src/ui/App.tsx` | The phone screen. Shows the state, has a button for every command, and has the box for the Claude key. |
| `src/ui/main.tsx`, `index.html`, `styles.css` | UI boot and looks. |
| `miniapp.json` | The manifest: name, package id, permissions, hardware needs, entry files. |
| `build.ts` | Mentra's build script, unchanged from their template. Makes `dist/background/index.js` and `dist/ui/`. |
| `test/coach.test.ts` | Whole lessons against a fake `Device` and a fake Claude. |
| `test/phone.test.ts` | The built bundle against a simulated phone. |

## Modes

The `Coach` is always in exactly one mode.

| Mode | Meaning | Commands that work |
| --- | --- | --- |
| `idle` | Waiting | teach, learn, help |
| `teaching` | The expert is recording | capture, finish, stop, help |
| `building` | Claude is writing the lesson | none |
| `coaching` | A learner is doing the lesson | check, repeat, story, skip, stop, help |

A command that does not belong to the current mode does nothing.

## Three ways in, one way through

Voice, the glasses button and the phone screen all end in the same function, `Coach.run(command)`.

| Input | Where it arrives | How it becomes a command |
| --- | --- | --- |
| Voice | `session.transcription.forLanguage("en-US", ...)` in `index.ts` calls `coach.heard(text, isFinal)` | `parseCommand(mode, text)` in `commands.ts` |
| Glasses button | `session.input.onButtonPress(...)` calls `coach.button(pressType)` | Short and long press map to a command per mode |
| Phone screen | `mentra.request("action", {name})` reaches `session.ui.handle("action", ...)` which calls `coach.act(name)` | The name is the command |

`run` accepts one command at a time. While one is running (`busy` is true), new commands are dropped, not queued.

### The voice rules

- Only finished sentences are used (`isFinal`). Half-heard text is ignored.
- A command counts only at the end of a sentence. "The next step is to whisk" is narration. "Whisk until it foams. Next step." is narration plus the command `capture`.
- While the app is speaking, and for 700 ms after, the microphone is ignored. The glasses' microphone hears the glasses' speaker, and without this gap the app would react to its own voice.
- In teaching mode every finished sentence that is not a command is added to the narration of the current step, up to 1500 characters.

## Teach, step by step

1. `teach`: mode becomes `teaching`. A recording id is made from the current time. It becomes the lesson id and the prefix of the photo names.
2. The expert talks. Sentences pile up in `narration`.
3. `capture` ("next step"): `device.takePhoto()`. The result is a download link. The capture `{transcript, shot}` is pushed to `captures` and `narration` is cleared. In the background the phone keeps its own copy of the photo (`device.savePhoto`, which is `session.blob.setFromUrl`). If the photo fails, the step is still saved with its words.
4. `finish` ("finish lesson"): if the expert explained a last step without saying "next step", that step is captured now. Mode becomes `building`. The app says "Building the lesson." while the Claude request is already running.
5. `buildPlan` in `claude.ts` sends every capture: its number, the expert's words, and its photo. Claude returns `{title, materials, steps[]}`. Each step has `instruction`, `done_looks_like`, `common_mistake`, `story` and `source_capture` (which capture's photo shows the step finished).
6. The lesson is saved to the phone under the storage key `lesson`. The previous lesson and its photos are replaced. Mode returns to `idle`.

If Claude fails, the mode goes back to `teaching` and the captures are kept, so saying "finish lesson" again retries without retaking photos.

## Learn, step by step

1. `learn` ("start lesson"): mode becomes `coaching`, step 1. The app says the title, the materials and step 1.
2. `check`: `device.takePhoto()`, then `checkStep` in `claude.ts`. Claude gets the expert's photo first (when there is one), the learner's photo second, the step's instruction, what "finished" looks like, the common mistake, and what the learner just said.
3. Claude returns `{result, say}`.
   - `pass`: green light. The app says the praise and the next step in one sentence. After the last step the mode returns to `idle`.
   - `fix`: red light. The app says the one correction. The step does not change.
   - `unclear`: orange light. The app asks the learner to look at their work and try again.
4. `repeat` says the step again. `story` says the expert's reason for the step. `skip` moves on without a check. `stop` ends the lesson.

## Photos: link or bytes

`session.camera.takePhoto()` uploads the photo to Mentra's storage and returns a signed download link that works for about 30 minutes.

For each photo sent to Claude, `Coach.imageFor` picks one of these, in order:

1. The photo is younger than 20 minutes and links are allowed: send the **link**. Claude downloads it. Nothing large crosses the phone's JavaScript bridge.
2. The bytes are already in memory: send the **bytes** as base64.
3. The phone kept a copy (`session.blob`): read it and send the bytes.
4. The photo is younger than 28 minutes: download the link on the phone and send the bytes.
5. Otherwise the photo is left out. A check still runs with the text description of the finished step.

If Claude answers HTTP 400 to a request that used links, `Coach.withPhotos` repeats the request once with bytes. If that works, links are not tried again until the app restarts.

## The Claude requests

- Endpoint: `POST https://api.anthropic.com/v1/messages`
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`, `anthropic-dangerous-direct-browser-access: true`
- Lesson model: `claude-sonnet-5-5`, at most 3000 output tokens, once per lesson.
- Check model: `claude-haiku-5-5`, at most 200 output tokens, once per check.
- Both use structured output (`output_config.format` with a JSON schema), so the reply always parses.
- The key test is a 1-token request to the check model.
- Errors become a `ClaudeError` with the HTTP status. Status 0 means no connection.

## What is stored on the phone

| Where | Key | Content |
| --- | --- | --- |
| `session.storage` | `claudeKey` | The Claude API key, as pasted |
| `session.storage` | `lesson` | The lesson as JSON, including each step's photo link, time and photo name |
| `session.blob` | `shot-<recordingId>-<n>` | The expert's photo for capture number n |

The shape of the `lesson` JSON is the `Lesson` interface in `coach.ts`. Changing that interface breaks lessons that are already saved on a phone.

## Messages between the phone screen and the background

Defined in `src/shared/channels.ts`.

| Channel | Direction | Payload | Reply |
| --- | --- | --- | --- |
| `state` | background to UI | `AppState` | none |
| `get-state` | UI to background | `{}` | `AppState` |
| `action` | UI to background | `{name: ActionName}` | `{ok: true}` right away. The result shows up in later `state` messages |
| `set-key` | UI to background | `{key: string}` | `{ok, error}` after the 1-token test. An empty key deletes the saved key |

The background sends `state` after every change. The UI keeps no state of its own except the text in the key box.

## Limits and timeouts

| Thing | Value | Where |
| --- | --- | --- |
| Photo size | `medium`, JPEG quality `medium` | `index.ts` |
| Photo timeout | 25 s | `index.ts` |
| Speech guard | 6 s plus 110 ms per character | `coach.ts`, `say` |
| Quiet gap after speech | 700 ms | `coach.ts` |
| Photos per lesson request | 12, spread evenly | `coach.ts` |
| Link treated as fresh | 20 min | `coach.ts` |
| Link treated as dead | 28 min | `coach.ts` |
| Network timeout on iPhone | 60 s, set by the Mentra App, not by this code | Mentra's native fetch |
