# How Tinker works

Read this before changing any code. It describes the app as it is in this folder.

Every fact about this app was read in its code on 2026-11-14. Constant names and spoken sentences are copied from the files. Facts about what the Mentra App does on the phone come from reading Mentra's public source, and they are collected in one section near the end. Nothing on this page has been run on real glasses. `docs/TESTING.md` says what the tests prove, and `docs/DECISIONS.md` says why things are the way they are.

## The short version

Tinker is one Mentra miniapp. It runs inside the Mentra App on a phone and controls a pair of Mentra Live glasses (camera, microphone, speaker, one button, a light, no display).

1. **Teach.** An expert does a task once and explains it out loud. Saying "next step" takes a photo of the finished step. A silent photo is also taken every 20 seconds in between. On "finish lesson" Claude turns the photos and the words into a draft lesson. The expert reviews the draft on the phone and publishes it into the lesson library.
2. **Learn.** A beginner picks a lesson and hears one step at a time. Saying "check" takes a photo, and Claude answers "pass" or the one thing to fix. Saying "Tinker, ..." asks Claude a question about the current step.

There is no server. The phone calls the Claude API directly, with a key that is pasted into the app once.

One lesson ships inside the app: the team's matcha lesson. It can be read aloud without a Claude key. Photo checks, questions and recording need the key.

## Two layers

Every Mentra miniapp has two halves that share no memory.

| Layer | Folder | Runs | Can reach the glasses |
| --- | --- | --- | --- |
| Background | `src/background/` | The whole time the miniapp is on, also with the phone screen off | Yes, through `session.*` |
| Screen (UI) | `src/ui/` | Only while the Tinker screen is open on the phone | No. It sends messages to the background |

The messages between them are declared in `src/shared/channels.ts`. They travel as JSON text.

The background is a bare JavaScript engine (`build.ts` names JavaScriptCore and QuickJS). It is not a browser and not Node. Mentra's rule sheet (lower half of `AGENTS.md`) lists what it has: `console`, timers, `queueMicrotask`, `fetch`, `WebSocket`, `localStorage`, `crypto.getRandomValues`, `crypto.randomUUID`, `TextEncoder`, `TextDecoder`, `atob`, `btoa` and a subset of `AbortController`.

`bun run build` fails with a file and line number when a file that the background bundle loads uses something the engine lacks. That covers `src/background/` and any file under `src/` that it imports. The check lives in `node_modules/@mentra/miniapp-cli/src/build-helpers.ts`. It rejects, among others: `window`, `document`, `navigator`, `performance`, `XMLHttpRequest`, `FormData`, `Blob`, `URL`, `URLSearchParams`, `Request`, `Response`, `Headers`, `process`, `Buffer`, `require`, `crypto.subtle` and every import of a Node module.

## Files

| File | Job |
| --- | --- |
| `src/shared/channels.ts` | Every message between the two layers, and the lesson shapes `TutorialModel` and `TutorialStepModel`. Both layers import it. |
| `src/background/index.ts` | The entry point of the background and the only background file that imports the Mentra SDK. It builds a `Device` out of `session.*` calls, creates the `Coach`, and forwards speech, button presses, screen messages and a tick every second to it. Every handler it registers runs inside `safely`, so that no error can escape into the Mentra App. |
| `src/background/coach.ts` | All behaviour, in one class, `Coach`: modes, teaching, learning, speech, the echo filter, photos, the library, everything the screen is told. No Mentra import and no `fetch`. |
| `src/background/commands.ts` | The spoken phrases per mode, `parseCommand`, `normalize` and `helpText`. |
| `src/background/claude.ts` | The four requests to Claude (`testKey`, `buildLesson`, `checkStep`, `answer`), the prompts, the JSON shapes Claude must return, and the error mapping. `createBrain()` hands them out as a `Brain`. |
| `src/background/seed.ts` | `BUILT_IN_TUTORIALS`: the one lesson that ships inside the app. |
| `src/background/contracts.ts` | The interfaces `Device` (what the Coach needs from the phone and glasses) and `Brain` (what it needs from Claude), the data shapes that go to Claude, and `BrainError`. |
| `src/ui/main.tsx`, `src/ui/index.html` | Start of the screen. Mounts `<App />` inside `<MentraProvider>`. |
| `src/ui/state.ts` | The screen's copy of what the background last said: `applyEvent`, `isBusy`, `useTinker`. |
| `src/ui/App.tsx` | The frame: header, status pills, the two tabs, which view shows. |
| `src/ui/Learning.tsx` | The lesson library and the view of a lesson in progress. |
| `src/ui/Teaching.tsx` | Record, wait for Claude, review, publish. |
| `src/ui/Settings.tsx` | The Claude key box, the sound test, a short list of spoken commands. |
| `src/ui/Parts.tsx` | Shared pieces: a photo that hides itself when its link is dead, the error line, the two-tap button, the clock format. |
| `src/ui/Icons.tsx` | Inline SVG icons. |
| `src/ui/styles.css` | All colours and sizes, in light and dark. |
| `miniapp.json` | The manifest: name, package id `com.mentra.tinker`, permissions, hardware needs, entry files. |
| `build.ts` | Mentra's build script, unchanged from their template. Makes `dist/background/index.js` and `dist/ui/`. |
| `test/claude.test.ts`, `test/coach.test.ts`, `test/ui.test.tsx`, `test/ui-render.test.tsx`, `test/ui-coach.test.ts`, `test/phone.test.ts` | The six test files. `test/ui-dom.tsx` and `test/ui-rig.ts` are their helpers. See `docs/TESTING.md`. |
| `test/fixtures/tut_matcha_ceremonial_01.json` | The team's original matcha lesson file. A test compares `seed.ts` with it. |
| `scripts/real-claude-test.ts` | A program that runs `claude.ts` against the real Claude API. See `docs/TESTING.md` and `scripts/README.md`. |
| `scripts/real-app-test.ts` | A program that runs the built app on a simulated phone, with every Claude request going to the real Claude API. See `docs/TESTING.md`. |
| `scripts/test-photos.ts`, `scripts/make-test-photos.py` | The four test drawings of a matcha bowl, as base64 text, and the program that drew them. Both real-API programs use them. |

The screen files are described in `docs/SCREENS.md`.

## Modes

The `Coach` is always in exactly one mode (`Mode` in `commands.ts`).

| Mode | Meaning | Side |
| --- | --- | --- |
| `idle` | Nothing is running | |
| `recording` | An expert is showing a task | Teaching |
| `processing` | Claude is writing the lesson | Teaching |
| `review` | A draft lesson is waiting to be published or discarded | Teaching |
| `learning` | A beginner is being coached through a lesson | Learning |

```
idle -> recording -> processing -> review -> idle      teaching a lesson
idle -> learning -> idle                               learning a lesson
```

Teaching and learning never run at the same time. Asking to teach during a lesson is answered "Stop the lesson first." Asking to learn while a recording or a draft is open is answered "Finish or cancel the recording first."

## Commands: three ways in, one gate

Voice, the glasses button and the phone screen all end in the same private method, `Coach.run`.

| Input | Where it arrives in `index.ts` | How it becomes a command |
| --- | --- | --- |
| Voice | `session.transcription.forLanguage(LANGUAGE, ...)` calls `coach.heard(text, isFinal)` | `parseCommand(mode, text)` in `commands.ts` |
| Glasses button | `session.input.onButtonPress(...)` calls `coach.button(pressType)` | A short and a long press map to one command each, per mode |
| Phone screen | `session.ui.on(channel, ...)` calls `coach.command(channel, payload)` | One channel per command |

### One command at a time

While a command runs (`busy` is true), a new command is dropped, not queued. Two exceptions are remembered in one slot (`waiting`) and run as soon as the current command ends. The newest one wins.

1. `stop` and `discard`, always. That is why "End Session" and "Discard" on the screen are never disabled.
2. Any command that arrives during a silent timed photo. The person cannot know that one is being taken.

Some messages from the screen do not go through the gate at all, so they work even while a command runs: deleting a lesson (`deleteTutorial`), `requestTutorials`, `ping`, and the two requests `setKey` and `getSnapshot`.

### The full command table

The spoken phrases are copied from the lists in `commands.ts`. A phrase works only in its own mode.

| Command | Mode | Say | Glasses button | Screen channel and button label |
| --- | --- | --- | --- | --- |
| teach | idle | "start teaching", "teaching mode", "record a lesson" | long press | `startTeaching` ("Start Recording") |
| learn | idle | "start lesson", "start the lesson", "begin lesson", "coach me" | short press | `startLearning` with the lesson id ("Start Learning") |
| capture | recording | "next step", "save step", "save this step" | short press | `captureStep` ("Save this step") |
| finish | recording | "finish lesson", "finish the lesson", "stop recording", "end lesson", "end the lesson" | long press | `stopTeaching` ("Finish lesson") |
| discard | recording, review | "cancel lesson", "cancel the lesson", "discard lesson" | none | `discardTeaching` ("Discard", then "Sure? Tap again") |
| publish | review | "publish lesson", "save lesson", "save the lesson" | short press | `publishTutorial` ("Publish to Library") |
| check | learning | "check", "check it", "check this", "check my work", "check my step", "im done", "i am done", "how does this look", "is this right". Also "done" or "finished" when that is the whole sentence | short press | `checkStep` ("Check my step") |
| next | learning | "next step", "skip step", "skip this step". Also "next" or "skip" when that is the whole sentence | long press | `navigateStep` with `direction: "next"` ("Next", or "Finish" on the last step) |
| previous | learning | "previous step", "go back" | none | `navigateStep` with `direction: "previous"` ("Previous") |
| repeat | learning | "repeat", "repeat that", "say that again", "say it again" | none | `navigateStep` with `direction: "repeat"` ("Repeat") |
| story | learning | "why this step", "tell me why", "tell me the story". Also "why" when that is the whole sentence | none | none |
| tips | learning | "any tips", "give me a tip". Also "tip" or "tips" when that is the whole sentence | none | none |
| materials | learning | "what do i need" | none | none |
| stop | learning | "stop lesson", "stop the lesson", "end lesson" | none | `endLearning` ("End Session", and "End" on the in-progress card) |
| ask | learning | Any sentence that starts with "Tinker", "hey Tinker", "ok Tinker" or "okay Tinker". The rest is the question | none | `askTinker` (the question box under the transcript) |
| help | every mode | "what can i say" | none | none |
| audio | any | none | none | `testAudio` ("Test glasses audio") |

Notes on the table:

- **Spoken "start lesson" and the short press in `idle`** start the first lesson in the library. That is the newest recorded lesson, or the built-in lesson when nothing has been recorded. The screen starts the lesson whose card was tapped.
- **"end lesson"** finishes the recording in `recording` and stops the lesson in `learning`.
- **A long press in `review`** does nothing. **In `processing`** the button does nothing.
- **"im done"** is how `normalize` writes "I'm done". Say it the normal way.
- Three more things exist only on the screen and are not commands: delete a lesson (`deleteTutorial`, "Delete" then "Sure?"), save or remove the key (`setKey`), and the two channels `requestTutorials` and `ping`. The Coach answers those two, but no screen file sends them today.

What "help" says, from `helpText` in `commands.ts`:

| Mode | Sentence |
| --- | --- |
| idle | "Say start lesson to learn, or say start teaching to make a new one." |
| recording | "Explain a step, say next step to save it, and say finish lesson at the end." |
| review | "Say publish lesson to save it, or cancel lesson to throw it away." |
| learning | "Say check, next step, go back, repeat, why, any tips, or stop lesson, or start a question with Tinker." |
| processing | "The lesson is being built, wait a moment." In practice this is never spoken: the app is busy for the whole of `processing`, so the command is dropped. |

## The voice rules

All of this is in `Coach.heard` and `Coach.isEcho` in `coach.ts`, and `parseCommand` in `commands.ts`.

1. **English only, cloud first.** `LANGUAGE` in `index.ts` is `"en-US"`. `index.ts` passes no `processing` option to `forLanguage` or to `speak`, so the SDK's default `"preferCloud"` applies to both: Mentra's cloud does the speech recognition and the voice. The SDK's comments say the phone uses an on-device model while the cloud is unreachable. That fallback has not been tried.
2. **Pieces, then a sentence.** The phone first sends half-finished guesses (`isFinal` false), then the finished sentence. Both are shown on the screen as one transcript line with one id. Only the finished sentence can be a command.
3. **The app does not listen to itself while it talks.** Text that arrives while the app is speaking, or within `QUIET_AFTER_SPEECH_MS` (700 ms) after, is thrown away. The app has to do this itself: in Mentra's source the microphone is not paused while the app speaks, and no echo cancellation was found. **One exception, while recording:** a finished sentence that arrives in that time is kept as narration, with a "You" line, unless it matches what the app is saying or said (rule 4). The expert keeps explaining while the app says "Step 1 saved.", and those words would otherwise be lost. Such a sentence never runs a command: a command at its end is cut off (`keepWhileTalking`).
4. **The echo filter.** Speech-to-text is slow, so the app's own sentence can arrive as text after the quiet gap, and the start of a sentence can even arrive while it still plays. A piece of heard text, finished or not, is dropped when it matches one of these: the sentence the app is speaking now, or one of the last `ECHO_KEEP` (5) sentences it finished less than `ECHO_WINDOW_MS` (10 seconds) ago. It matches (`echoOf`) when:
   - it has 2 to `ECHO_MAX_WORDS` (120) words and at least `ECHO_PERCENT` (80) percent of them appear, in the same order, in that sentence, or
   - it is one word that the app said in that sentence.

   "one" and "1" count as the same word, up to twenty. A dropped piece leaves no transcript line, no narration and no command. An unfinished piece is only held back: no line and no "listening" until a later piece holds words the app did not say. When a finished sentence is dropped, a line opened by its first pieces is closed. **A finished one-word command is never an echo**, so "check" always works.
5. **The second exception to the echo filter.** The app says "Say publish lesson to save it", and the person answers "Publish lesson." Those words are inside the app's own sentence. So a finished sentence that is exactly one command of the current mode, with nothing in front of it, is let through once `ECHO_REPLY_MS` (1.2 seconds) have passed since the app stopped speaking. An echo would have arrived sooner. (The audit simulated echoes 900 ms after the speech. Until the evening of 2026-11-14 this was 2.5 seconds, which also dropped quick answers.)
6. **A command counts only at the END of a sentence.** `normalize` lower-cases the text, removes apostrophes and turns everything that is not a letter or a digit into a space. Then the sentence must equal a phrase or end with it. "The next step is to whisk" is narration. "Whisk until it foams. Next step." is narration plus the command `capture`. The longest matching phrase wins.
7. **Short words must be the whole sentence.** "next", "skip", "why", "tip", "tips", "done" and "finished" are marked `alone` in `commands.ts`. "check" and "repeat" are not: a sentence that ends in one of them is that command. "I'm done" and "I am done" are phrases of their own and work at the end of a sentence.
8. **A question starts with the name.** Only in `learning`, a sentence that starts with "Tinker", "hey Tinker", "ok Tinker" or "okay Tinker" (`WAKE_WORDS`) is a question for Claude. If the rest of the sentence is exactly a command ("Tinker, check my work."), it runs that command instead.
9. **The name alone.** "Hey Tinker." with nothing after it is answered "Yes? Ask your question." (`ASK_REPLY`). The next finished sentence within `ASK_FOLLOW_MS` (8 seconds) that is not a command, has at least two words, and is not made only of the reply's own words ("Yes, yes.") is taken as the question (`isFollowUp`). The reply has several words on purpose: the echo of a one-word "Yes?" once came back as "Yes, yes." and was sent to Claude as the question.
10. **Everything else said during a lesson does nothing.** It is shown in the transcript and that is all. This is on purpose, see D17 in `docs/DECISIONS.md`.
11. **While recording, everything is narration.** Every finished sentence is added to `narration`, without the command at its end. Only the last `MAX_NARRATION` (1500) characters are kept. This also happens while a command is running, and while the app talks (rule 3), so no explanation is lost.
12. **Nothing the app says can command it.** Every sentence passes through `defuse` before it is spoken. If the sentence would be read as a command in any mode, " Okay." is added at its end. If it starts with the name, "So, " is put in front. The app's fixed sentences are worded so that this never triggers. Lesson text and Claude's replies are not, so they are checked every time. The screen shows the sentence as it was spoken.
13. **Speech cannot be interrupted.** A "stop" given while the app talks is remembered and runs when the sentence ends. A check or a question that finds a stop or a discard waiting ends at once, after whatever it was waiting for: no verdict, no light, no step change, no answer (`stopWaiting`). If "End Session" comes during the photo, Claude is not asked at all. Then the stop runs and says "Lesson stopped."

## What `say` does

Every spoken sentence goes through `Coach.say`:

1. `defuse` (rule 12 above).
2. A transcript line with speaker `tinker` is added. Its label is "Step N" during a lesson and "Tinker" otherwise.
3. `assistantState` becomes `speaking`.
4. `device.speak(text)`, which is `session.speaker.speak(text, {stopOtherAudio: true})`. It resolves when the speech has finished playing. The sound goes to the phone's media output. That is the glasses only when they are the phone's Bluetooth audio device. Otherwise it is the phone's speaker. The Coach stops waiting after `SPEECH_GUARD_MS` (6 seconds) plus `SPEECH_GUARD_PER_CHAR_MS` (110 ms) per character. A speech error becomes a transcript note "Speech failed. ..." and the command carries on.
5. The quiet gap starts, and the sentence is remembered for the echo filter with the time it ended. While it plays it already counts for the echo filter (`saying`), because speech-to-text can deliver its start before it ends.

## Teaching, step by step

1. **teach.** Needs a saved key. Without one the app says "Add the Claude key on the phone screen first." and puts the same sentence in `teachingState.error`. With a key: mode `recording`, a new `recordingId` (the current time in milliseconds, as text), an empty list of captures, and the skill hint the expert typed into "What are you teaching?" (or ""). The app says:

   "Recording. Do one step and explain it. Say next step when it is finished. Say finish lesson at the end."

2. **The expert talks.** Sentences pile up in `narration`. The screen shows them under "Heard for this step".

3. **capture** ("next step"). `device.takePhoto({sound: true})`. The capture `{transcript, atSeconds, kind: "step", shot}` is pushed. The words said up to the moment the photo was asked for go into this capture. Words said while the photo is being taken stay in `narration` for the next one. If the photo fails the capture is still saved, with its words only. The app says "Step N saved." or "Step N saved without a photo." N counts step captures only.

4. **Timed photos.** `index.ts` calls `coach.tick()` once per second. While recording, each tick sends a `teachingState` so the clock on the screen moves. A silent photo (`sound: false`) is taken when all of this is true: `AUTO_CAPTURE_MS` (20 seconds) have passed since the last photo of either kind, no command is running, the app is not speaking, and the recording holds fewer than `MAX_CAPTURES` (40) captures. A timed photo that works becomes a capture of kind `"auto"` with the narration so far. One that fails adds nothing and is not reported. Either way the 20 seconds start again. The app says nothing, and the screen is not told that the app is busy. Setting `AUTO_CAPTURE_MS` to 0 turns timed photos off.

5. **Kept copies.** Every photo that works is also copied to the phone's own storage (`device.savePhoto`, which is `session.blob.setFromUrl`) under the name `shot-<recordingId>-<n>`. The copy is not waited for, and a failed copy is ignored.

6. **finish** ("finish lesson"). One last step capture is taken, without the "Step N saved." sentence, when there is narration left, or no step has been saved yet, or a timed photo after the last step capture took words (a timed photo shows the work half done, so the last step still needs its "finished" photo). If there is still nothing at all (no words and no photo), the app says "Nothing is recorded yet. Do a step and explain it, then say next step to save it." and stays in `recording`. Otherwise the mode becomes `processing` and the recording clock stops. The app says "Building the lesson." while the Claude request is already running.

7. **Which photos Claude gets.** At most `MAX_PLAN_PHOTOS` (12). Every `"step"` photo comes first. Timed photos fill what is left, spread evenly over the recording. A capture that loses its photo keeps its words (`choosePhotos`).

8. **Success.** `buildLesson` returns a `LessonDraft`. `Coach.toTutorial` turns it into a `TutorialModel` with `status: "draft"`:
   - lesson id `tut_<recordingId>`, step ids `step_<recordingId>_<n>`, `step_number` counted by the app,
   - each step's `source_capture` names the capture whose photo shows the step finished. That capture's link, kept-copy name, photo time and seconds become `reference_image_url`, `photo_key`, `photo_taken_at` and `source_timestamp_seconds`. A capture without a photo leaves the three photo fields out,
   - `estimated_duration_minutes` is Claude's number, or the length of the recording when Claude gives none, kept between 1 and 120,
   - `created_at` is the current time as ISO text.

   The mode becomes `review`. Kept photos that no step of the draft uses are deleted. The screen gets `tutorialGenerated` with `status: "success"`. The app says:

   "Lesson ready. TITLE. It has N steps. Say publish lesson to save it, or review it on the phone."

9. **Failure.** The mode goes back to `recording` with every capture kept. The screen gets `tutorialGenerated` with `status: "error"`, and `teachingState.error` is "The lesson was not built. " followed by the reason. The app says "I could not build the lesson. Say finish lesson to try again." Saying it again retries without retaking photos.

10. **publish** ("publish lesson", only in `review`). The stored draft is used. From the screen's message only `title` and `description` are read, when they are not empty, each cut to `MAX_TYPED` (600) characters. A spoken publish uses the draft as it is. The lesson gets `status: "published"`, goes first in the library, and the library is saved. The library holds at most `MAX_LIBRARY` (20) recorded lessons. One more removes the oldest and its kept photos. The screen gets `tutorialList` and `teachingState` (idle). The app says "Lesson published." If the phone could not save, the app says "The lesson works now, but it could not be saved on this phone." instead, and a transcript note says "The lesson works now but was not saved to the phone. ..." with the reason. Such a lesson is gone after a restart.

11. **discard** ("cancel lesson"). In `recording`: the captures are dropped and their kept photos deleted, "Recording discarded." In `review`: the draft is dropped and its photos deleted, "Draft discarded."

## Learning, step by step

1. **learn** ("start lesson"). The mode must be `idle`. A key is not needed: reading steps aloud works without Claude. An id that is not in the library is answered "That lesson is not on this phone." Otherwise: mode `learning`, step 1, a new `sessionId`, no verdict. The words of the lesson's title, tools and ingredients (words of 4 letters or more, at most 30) are handed to speech-to-text with `device.setVocabulary`. The phone ignores that list for now (see "What the Mentra App does on the phone"). The transcript gets the note "Started: TITLE". The app says, in one go:

   "TITLE. Say check when a step is done. Step 1. INSTRUCTION"

2. **check.** Without a key: "Add the Claude key on the phone screen to use checks." Otherwise the last verdict is cleared (so a screen opened during the check does not show the old one as the answer), then `device.takePhoto({sound: true})`. If the photo fails: "I could not take a photo. Say check to try again." Then `brain.checkStep` gets the lesson title, the step, the learner's photo, the expert's photo when there is one, and the sentence that carried the command. The answer is a `Verdict`: `{result, say}`.
   - The screen gets `stepVerdict` with the result, Claude's sentence and the link to the learner's photo.
   - The light blinks twice: green for `pass`, red for `fix`, orange for `unclear`.
   - `pass`, and there is a next step: the app moves on and says the praise and the next step in one speech call: "SAY Step N. INSTRUCTION".
   - `pass` on the last step: the lesson ends as finished. "SAY That was the last step. You finished TITLE."
   - `fix` or `unclear`: the app says Claude's sentence and stays on the step.
   - Claude failed: a transcript note "The check failed. ..." with the reason, and the app says "I could not check that. Say check to try again."

   The learner's photo is not kept on the phone. After every wait in a check (the photo, reading the expert's kept photo, Claude) the Coach looks for a waiting stop or discard, and if there is one the check ends there without a word (voice rule 13).

3. **next.** No photo and no Claude. "Step N. INSTRUCTION". On the last step the lesson ends as finished: "That was the last step. You finished TITLE."
4. **previous.** One step back, then "Step N. INSTRUCTION". On step 1: "This is the first step. Step 1. INSTRUCTION".
5. **repeat.** "Step N. INSTRUCTION".
6. **story** ("why"). The step's `story`. When it has none, its `instruction_detailed`. When that is empty too: "The expert gave no reason for this step."
7. **tips.** Up to two of the step's tips, or "There are no tips for this step."
8. **materials** ("what do i need"). "You need A, B and C." with the tools first, then the ingredients, at most 8 items. Or "This lesson lists no materials."
9. **ask** ("Tinker, ..."). Without a key: "Add the Claude key on the phone screen to ask questions." A typed question is first added to the transcript as a `user` line. A spoken one is there already. `brain.answer` gets the whole lesson, the step number, the question, and the last `RECENT_LINES` (6) finished transcript lines of the learner and of Tinker. The app says the answer, unless a stop or a discard is waiting (voice rule 13). On failure: a transcript note "The question failed. ..." and "I could not answer that. Ask again." A typed question while the app is `idle` is answered "Start a lesson first." In the teaching modes a typed question does nothing.
10. **stop.** The screen gets `learningState` with `active: false, finished: false`. "Lesson stopped."

When a lesson ends, either way, the screen gets one last `learningState` with `active: false`, and the mode is `idle` again.

## What is sent to the screen

The state lives in the background. The screen is thrown away every time it closes. Everything below is declared in `src/shared/channels.ts`. `docs/SCREENS.md` describes the screen's side.

### Screen to background

Plain messages (`mentra.send`). `Coach.command` handles exactly these, and `COMMANDS` in `index.ts` registers them.

| Channel | Payload | Meaning |
| --- | --- | --- |
| `startTeaching` | `{author?, targetSkill?}` | Start recording. `targetSkill` goes to Claude as a hint. `author` is not read by anything. |
| `captureStep` | `{}` | Photo and save the step. Same as "next step". |
| `stopTeaching` | `{}` | Finish the recording and build the lesson. |
| `discardTeaching` | `{}` | Throw away the recording or the draft. |
| `publishTutorial` | `{tutorial}` | Publish the draft. Only `tutorial.title` and `tutorial.description` are read. |
| `deleteTutorial` | `{tutorialId}` | Remove a recorded lesson and its photos. Refused for the lesson being learned. The built-in lesson cannot be removed. |
| `startLearning` | `{tutorialId}` | Start that lesson. |
| `endLearning` | `{}` | Stop the lesson. |
| `navigateStep` | `{direction}` | `"next"`, `"previous"` or `"repeat"`. |
| `checkStep` | `{}` | Photo check of the current step. |
| `askTinker` | `{text}` | A typed question. |
| `requestTutorials` | `{}` | Ask for the library again. Not sent by any screen file today. |
| `testAudio` | `{}` | Say "This is the Tinker audio check. If you hear this in the glasses, sound works." |
| `ping` | `{at}` | Answered with `pong`. Not sent by any screen file today. |

Requests with an answer (`mentra.request`, registered with `session.ui.handle`):

| Channel | Request | Answer |
| --- | --- | --- |
| `setKey` | `{key}` | `{ok, error}` after one real test request. An empty key removes the saved key. |
| `getSnapshot` | `{}` | A `Snapshot` |

What `setKey` can answer in `error`:

- "That is not a Claude key. A Claude key starts with sk-ant-."
- "Claude rejected this key. Copy it again from the Claude Console." (HTTP 401)
- "The test request failed. " followed by the reason
- "The phone could not save the key. " followed by the reason
- "The phone could not remove the key. " followed by the reason. An empty key is deleted on the phone first. If that fails, the app keeps using the saved key, and the screen keeps saying a key is saved.

### Background to screen

| Channel | Payload | Sent when |
| --- | --- | --- |
| `snapshot` | `Snapshot` | Pushed by `index.ts` every time the screen opens. |
| `connectionStatus` | `{glassesConnected, hasCamera, hasMic, claudeReady, keyHint, message?}` | After start-up, when the glasses connect or disconnect, after a key is saved or removed. `keyHint` is the last 4 characters of the key. `message` is never set. |
| `tutorialList` | `{tutorials}` | After start-up, publish, delete, `requestTutorials`, when a lesson that was asked for is missing, and when stored lessons are merged in before a save (see "What is stored on the phone"). Recorded lessons newest first, then the built-in lesson. |
| `teachingState` | `{status, elapsedSeconds, frameCount, stepCount, narration, sessionId?, error?}` | On every change of the recording, once per second while recording, and with every finished sentence heard while recording. `frameCount` counts captures that have a photo. `stepCount` counts step captures. |
| `photoCapture` | `{photoUrl, frameIndex, timestampSeconds, kind}` | After every photo taken while teaching. `kind` is `"step"` or `"auto"`. |
| `tutorialGenerated` | `{status, tutorial?, error?}` | When Claude has written the draft (`"success"`) or failed (`"error"`). |
| `learningState` | `{active, finished, sessionId, tutorialId, currentStep, totalSteps, stepData, assistantState}` | When a lesson starts, when the step changes, and once with `active: false` when the lesson ends. |
| `stepVerdict` | `{step, result, say, photoUrl?}` | After every photo check that Claude answered. |
| `transcriptionUpdate` | `TranscriptEntry` | For every transcript line. An unfinished sentence and its finished version share one `id`. |
| `assistantState` | `{state, message?}` | When the state changes. `message` is "Taking a photo" (the constant `PHOTO_MESSAGE` in `channels.ts`, which the screen also reads) or "Thinking". |
| `pong` | `{at, roundtripMs, backgroundVersion}` | Answer to `ping`. `backgroundVersion` is `"tinker-2"`. No screen file listens for it today. |

A `TranscriptEntry` is `{id, speaker, text, isFinal, timestamp, step?}`. `speaker` is `user`, `tinker` or `system`. `timestamp` is a label, not a time: "You", "Tinker", "Step N" or "Note". The Coach keeps the last `TRANSCRIPT_KEEP` (40) lines.

`device.emit` does nothing while the screen is closed.

### The snapshot

`Coach.snapshot()` returns everything the screen needs to draw itself from nothing:

| Field | Content |
| --- | --- |
| `connection` | The same object as `connectionStatus` |
| `tutorials` | The library |
| `teaching` | The same object as `teachingState` |
| `draft` | The draft waiting for review, or `null` |
| `learning` | The same object as `learningState` while a lesson runs, otherwise `null` |
| `lastVerdict` | The last photo check of this lesson, or `null` |
| `transcript` | The last 40 lines, oldest first |
| `assistant` | `idle`, `listening`, `thinking` or `speaking` |
| `busy` | True while a command is running. A silent timed photo does not count. |

### The busy rule

The screen has no "busy" event. It disables its buttons while `assistantState` is `thinking` or `speaking`. So the Coach keeps this promise (`Coach.current`): while a command runs, the last state it sent is `thinking` or `speaking`, never `idle` or `listening`. When the command ends and nothing is waiting, it sends `idle` once. The one exception is the silent timed photo, which sends nothing.

`listening` is sent when a half-finished sentence arrives and nothing else is going on.

## Photos: link or bytes

`session.camera.takePhoto()` uploads the photo and returns a download link. `index.ts` asks for size `PHOTO_SIZE` (`"medium"`), JPEG compression `"medium"`, and gives up after `PHOTO_TIMEOUT_MS` (25 seconds).

**How long a link lasts: about 10 minutes.** Mentra's cloud source signs photo links for 600 seconds. The SDK's own comment on `takePhoto` says "about 30 minutes". The code trusts the shorter number when it sends a link to Claude, and it still allows for the longer one before it gives a link up. Nobody has timed a real link.

For each photo sent to Claude, `Coach.imageFor` picks the first of these that works:

1. Links are allowed and the photo is younger than `LINK_FRESH_MS` (8 minutes): send the **link**. Claude downloads it, and nothing large passes through the phone's JavaScript engine.
2. The bytes are already in memory from earlier in this session: send the **bytes** as base64. Only kept photos are held in memory, at most `MAX_CACHED_PHOTOS` (30). The one used longest ago is dropped first.
3. The phone kept a copy (`session.blob`): read it and send the bytes.
4. The photo is younger than `LINK_DEAD_MS` (28 minutes): try to download the link on the phone and send the bytes. If the link is already dead, this costs one failed request.
5. Otherwise the photo is left out. A check still runs, with the text of the step.

So the expert's photo reaches a photo check as a link only in the first 8 minutes after it was taken. After that the check uses the copy kept on the phone.

The image type is read from the first bytes (`sniffMediaType`), because Claude rejects a photo with a wrong label.

`Coach.withPhotos` first sends links. If Claude answers HTTP 400, it sends the same request once more with bytes. If that works, links are not tried again until the app restarts (`linksWork`).

The built-in lesson has no expert photos. Its checks are judged against the `done_looks_like` text of the step.

The screen only ever gets photo links, never bytes. A link that has died simply does not load, and the screen hides the picture. If links last 10 minutes, as Mentra's source says, the phone screen can no longer load a picture about 10 minutes after it was taken. That includes the expert's photos of a lesson recorded earlier. The photo checks do not depend on the screen's pictures.

## The Claude requests

All in `src/background/claude.ts`.

- Endpoint (`ENDPOINT`): `POST https://api.anthropic.com/v1/messages`
- Headers: `content-type: application/json`, `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`
- No `temperature` is sent.

| Call | Model constant and value | Output limit | Output | Used |
| --- | --- | --- | --- | --- |
| `testKey` | `CHECK_MODEL`, `claude-haiku-5-5` | 1 token | Nothing is read. Only the HTTP status matters. | When a key is saved |
| `buildLesson` | `PLAN_MODEL`, `claude-sonnet-5-5` | `PLAN_MAX_TOKENS`, 3500 | JSON forced by `LESSON_SCHEMA` | Once per lesson |
| `checkStep` | `CHECK_MODEL`, `claude-haiku-5-5` | `CHECK_MAX_TOKENS`, 200 | JSON forced by `CHECK_SCHEMA` | Once per photo check |
| `answer` | `CHAT_MODEL`, `claude-haiku-5-5` | `CHAT_MAX_TOKENS`, 200 | Plain text | Once per question |

### The thinking switch

Every request carries a `thinking` field that switches thinking off (`thinkingOff`):

- a model whose id contains `sonnet-5-5` gets `{type: "between_tools"}`,
- every other model gets `{type: "disabled"}`.

Why: these models think before they answer unless told not to, and thinking tokens count inside `max_tokens`. With a limit of 200 tokens a check could be cut off before its answer. The two models need different switches, and the wrong one is answered with HTTP 400. See D9 in `docs/DECISIONS.md` for the source and for what is not checked. **When you change a model, read `thinkingOff`.**

### Structured output

`buildLesson` and `checkStep` pass a JSON schema in `output_config: {format: {type: "json_schema", schema}}`. Every field is listed in `required` and every object has `additionalProperties: false`. The schema cannot hold word or item limits, so those are in the prompts (`LESSON_SYSTEM`, `CHECK_SYSTEM`).

### What each request carries

- **`buildLesson`**: for each capture one text line, `Capture N at T seconds (step finished). The expert said: "..."` or `(timed photo)`, followed by that capture's photo when it has one. The last text block is "Write the lesson for this task.", with the expert's typed skill in front of it when there is one. Claude returns `title`, `description`, `category`, `estimated_duration_minutes`, `tools_required`, `ingredients_required` and `steps`. Each step has `title`, `instruction_spoken`, `instruction_detailed`, `tips`, `done_looks_like`, `common_mistake`, `story` and `source_capture`. Steps with an empty `instruction_spoken` are dropped. A lesson with no steps is an error. Tips are cut to 2.
- **`checkStep`**: the expert's photo first when there is one, the learner's photo second, each named in words. Then the lesson title, the step number and title, the instruction, "Finished looks like: ..." (or "About this step: ..." with the detail text when the step has no `done_looks_like`), the common mistake, the tips, and what the learner just said. Claude returns `{result, say}` with `result` one of `pass`, `fix`, `unclear`.
- **`answer`**: one text block with the lesson title, tools, ingredients, the current step (number, title, spoken instruction, detail, tips, finished look, common mistake, story), the titles of the previous and next step, the recent conversation, and the question. The system prompt `CHAT_SYSTEM` keeps the four rules of the team's earlier Python prompt word for word and adds two. The reply is cleaned for speech: `*`, `#`, backticks and line breaks are removed. When the answer was cut off by `CHAT_MAX_TOKENS` (stop reason `max_tokens`), only its whole sentences are kept (`wholeSentences`): everything up to the last full stop, question mark or exclamation mark. When not even one sentence is whole, it is an error.

### Errors

Every failure is a `BrainError` with a `status`. Nothing in `claude.ts` retries, and nothing makes up an answer.

| `status` | Meaning | Message |
| --- | --- | --- |
| 0 | No connection, or the connection dropped while the answer arrived | "No connection to Claude. " and the reason |
| The HTTP status (400, 401, 429, 500 and so on) | Claude refused the request | Claude's own error message, or "Claude answered with HTTP N." |
| 200 | Claude answered, but the answer cannot be used | "Claude's answer was cut off. Record fewer steps.", "Claude's answer was cut off.", "Claude declined to answer this request.", "Claude declined to answer this question.", "Claude returned no text (stop reason: ...).", "Claude's answer was not valid JSON.", "Claude's answer was not JSON.", "Claude found no steps in the recording.", "Claude's check had no clear result.", "Claude's check came back without words.", "Claude gave an empty answer (stop reason: ...)." |

The Coach reads the status in two places: 400 makes `withPhotos` retry with bytes, and 401 in `setKey` becomes "Claude rejected this key. ...".

The Coach also puts its own limit on every Claude request, so a lost connection cannot leave the app busy forever. A check, an answer or a key test fails after `CLAUDE_GUARD_MS` (30 seconds), a lesson build after `BUILD_GUARD_MS` (90 seconds), with "Claude did not answer in time."

## What is stored on the phone

| Where | Name | Content |
| --- | --- | --- |
| `session.storage` | `claudeKey` | The Claude key, as pasted |
| `session.storage` | `library` | A JSON array of the recorded lessons (`TutorialModel`), newest first. The built-in lesson is not stored. It is added from `seed.ts` every time the library is read. |
| `session.blob` | `shot-<recordingId>-<n>` | The kept copy of the photo of capture number n |

These names and the `TutorialModel` shape are on phones already. Changing them loses the saved key or the saved lessons.

When the app starts, `readLibrary` in `coach.ts` reads the stored lessons and cleans each one (`cleanLesson`, `cleanStep`), so a damaged value never stops the app or makes it speak "undefined":

- a value that is not JSON counts as an empty library,
- a lesson with no id, no usable step, an id seen before, or the built-in lesson's id is left out, and at most `MAX_LIBRARY` (20) lessons are kept,
- a step that is not an object is dropped, the others are numbered again from 1, a missing text becomes "", a missing step id becomes `<lessonId>_<n>`, and `total_steps` is counted again,
- a missing title becomes "Untitled lesson", the duration is kept between 1 and 120 minutes, every stored lesson counts as published and none as built in,
- fields the code does not know are kept, so a field added later survives a restart.

If the phone fails to answer when the library is read at start, the app remembers that. Before the next save it reads the library again and adds the stored lessons it did not know, matched by id. If the second read fails too, nothing is written, so the lessons on the phone are not overwritten. The new lesson then works until the app restarts, and the transcript says why.

`session.storage` belongs to one phone, one user and one package id (comment at the top of `node_modules/@mentra/miniapp/src/modules/storage.ts`). A lesson recorded on one phone does not appear on another.

Not stored: the mode, a recording in progress, a draft in review, the lesson being learned, the transcript. A restart of the background loses them. Photo copies of a recording or draft that was open at that moment stay on the phone unused.

## What the Mentra App does on the phone

These facts are not in this folder. They were read on 2026-11-14 in Mentra's public source (`Mentra-Community/MentraOS` on GitHub, branch `dev`, commit `f120725`). **Read, not run on glasses.** The Mentra App on the team's phone, and Mentra's cloud, may run a different version. `docs/DECISIONS.md` ("Sources that were read") says who read which part.

| Topic | What Mentra's source says | What it means here |
| --- | --- | --- |
| Starting the app | Tinker only launches when the phone's paired glasses model has a camera and a microphone, because `miniapp.json` marks both `REQUIRED`. With no glasses paired, or with Mentra's simulated glasses, it does not launch. | `hardware()` in `index.ts` counts both as present unless the phone says otherwise. Pair the real glasses before opening Tinker. |
| Versions | `sdkVersion` must be inside `>=0.3.0 <4.0.0`, and the Mentra App must be 1.42.0 or newer (`minHostVersion`). Checked at install and at launch only. | Leave both values in `miniapp.json` alone. |
| The button | Presses reach a miniapp's `onButtonPress`, with `buttonId` `"camera"` and `pressType` `"short"` or `"long"`. While any miniapp listens for presses, the Mentra App switches the glasses' own photo-on-press off. | `Coach.button` should get every press while Tinker is on. |
| Speech | `speak` resolves when playback has finished. The sound goes to the phone's media output: the glasses only when they are the phone's Bluetooth audio device, otherwise the phone's speaker. | The quiet gap starts at the right moment. If the voice comes from the phone, fix the phone's audio output. |
| The microphone | It is not paused while the app speaks, and no echo cancellation was found. A loudness gate on the glasses, on by default, is described as keeping the wearer's microphone from hearing the glasses' own speech; what it does in practice is not known. A finished sentence arrives after the speech service's end-of-speech signal (up to about 2 seconds) plus a 0.5 second wait. In a loud hall it can be late or carry other people's words. | The quiet gap and the echo filter are needed. So is the rule that questions start with "Tinker". |
| Words to expect | `transcription.configure({vocabulary})` is ignored by the phone at that commit. Only `languageHints` is read. The call does no harm. | `device.setVocabulary` has no effect for now. |
| Photos | `size`, `compress` and `sound` are honoured. A second photo while one is in flight is refused (`CAMERA_BUSY`). Photos are also refused when the glasses are not connected, when the phone is not signed in to Mentra's cloud, during a video recording, and under 15 percent glasses battery. | One command at a time (`run`) keeps two photos from overlapping. A refused photo becomes "Step N saved without a photo." or "I could not take a photo. Say check to try again." |
| Photo quality | Without Wi-Fi on the glasses, a photo travels over Bluetooth, shrunk to about 640 x 640 and about 15 KB. | Put the glasses on Wi-Fi for good photo checks. A phone hotspot works. |
| Photo links | Signed for 600 seconds. | `LINK_FRESH_MS` is 8 minutes. See "Photos: link or bytes". |
| Wear detection | It pauses media when the glasses are taken off. It is on by default in some Mentra App builds. | Wear the glasses during the demo, or switch it off in the Mentra App. |
| Network | A background `fetch` fails on iPhone after 60 seconds without data. On Android: 30 seconds to connect, 60 seconds without data, 120 seconds for the whole call. There is no list of allowed hosts. | The Claude API can be reached. A lesson build that takes Claude longer than 60 seconds fails on iPhone. |
| Storage | `session.storage` has no hard size limit (the SDK advises under 1 MB). Blobs: 1 GB per app. Data survives an app update or reinstall. | The key and the lessons should still be there after Tinker is installed again. |
| Messages | A message to the screen that is sent before the page listens is buffered, up to 32 per channel. A request from the screen that is sent before the background is ready is held, up to 128. | The first `snapshot` is not lost when the screen opens. |
| Errors | An error that escapes a timer callback restarts the whole background. On iPhone so does one that escapes a transcription or button handler. Restarts wait 2, 8 and 30 seconds. After that the miniapp stays down. | A restart loses a recording in progress. `safely` in `index.ts` wraps every handler and the tick, and writes `[tinker] ... failed:` to the console instead. |

## Limits and timeouts

| Thing | Constant | Value | File |
| --- | --- | --- | --- |
| Language | `LANGUAGE` | `"en-US"` | `index.ts` |
| Photo size | `PHOTO_SIZE` | `"medium"`, JPEG compression `"medium"` | `index.ts` |
| Photo time limit | `PHOTO_TIMEOUT_MS` | 25 000 ms | `index.ts` |
| Words always given to speech-to-text | `BASE_VOCABULARY` | Tinker, matcha, chawan, chasen, chashaku, whisk, sifter, froth | `index.ts` |
| Most words given to speech-to-text | `MAX_VOCABULARY` | 40 | `index.ts` |
| Tick | none (a literal) | 1000 ms | `index.ts` |
| Light blink | none (literals) | 250 ms on, 150 ms off, 2 blinks | `index.ts`, `coach.ts` |
| Photos per lesson request | `MAX_PLAN_PHOTOS` | 12 | `coach.ts` |
| Link sent as a link | `LINK_FRESH_MS` | 8 minutes | `coach.ts` |
| Link no longer even tried | `LINK_DEAD_MS` | 28 minutes | `coach.ts` |
| Quiet gap after speech | `QUIET_AFTER_SPEECH_MS` | 700 ms | `coach.ts` |
| Narration per capture | `MAX_NARRATION` | 1500 characters, the end is kept | `coach.ts` |
| Timed photo interval | `AUTO_CAPTURE_MS` | 20 000 ms, 0 turns it off | `coach.ts` |
| Captures after which timed photos stop | `MAX_CAPTURES` | 40 | `coach.ts` |
| Recorded lessons kept | `MAX_LIBRARY` | 20 | `coach.ts` |
| Transcript lines kept for snapshots | `TRANSCRIPT_KEEP` | 40 | `coach.ts` |
| Echo window | `ECHO_WINDOW_MS` | 10 000 ms | `coach.ts` |
| Echo match | `ECHO_PERCENT` | 80 percent of the heard words, in order | `coach.ts` |
| Echo exception for a lone command | `ECHO_REPLY_MS` | 1200 ms | `coach.ts` |
| Spoken sentences remembered for the echo filter | `ECHO_KEEP` | 5 | `coach.ts` |
| Longest text checked as an echo | `ECHO_MAX_WORDS` | 120 words | `coach.ts` |
| Speech guard | `SPEECH_GUARD_MS`, `SPEECH_GUARD_PER_CHAR_MS` | 6000 ms plus 110 ms per character | `coach.ts` |
| Claude guard for a check, an answer, a key test | `CLAUDE_GUARD_MS` | 30 000 ms | `coach.ts` |
| Claude guard for a lesson build | `BUILD_GUARD_MS` | 90 000 ms | `coach.ts` |
| Kept photos held in memory as bytes | `MAX_CACHED_PHOTOS` | 30 | `coach.ts` |
| Question after the bare name | `ASK_FOLLOW_MS` | 8000 ms | `coach.ts` |
| Conversation lines given to Claude | `RECENT_LINES` | 6 | `coach.ts` |
| Typed question, title, description, skill hint | `MAX_TYPED` | 600 characters | `coach.ts` |
| Lesson words given to speech-to-text | `MAX_VOCABULARY` | 30 | `coach.ts` |
| Output tokens | `PLAN_MAX_TOKENS`, `CHECK_MAX_TOKENS`, `CHAT_MAX_TOKENS` | 3500, 200, 200 | `claude.ts` |
| Transcript lines kept on the screen | `TRANSCRIPT_KEEP` | 100 | `src/ui/state.ts` |
| Screen asks again for a snapshot | `SNAPSHOT_RETRY_MS` | 2000 ms | `src/ui/state.ts` |
| Screen gives up on one snapshot request | `SNAPSHOT_TIMEOUT_MS` | 5000 ms | `src/ui/state.ts` |
| Screen says "Close Tinker and open it again." after failing requests for | `UNREACHABLE_MS` | 10 000 ms | `src/ui/state.ts` |
| Screen waits for the answer to a key save | `KEY_TIMEOUT_MS` | 30 000 ms | `src/ui/Settings.tsx` |
| Key card stays on the Teaching tab after a save | `KEY_SAVED_MS` | 2500 ms | `src/ui/Teaching.tsx` |
| Second tap on Discard or Delete | none (a literal) | within 4000 ms | `src/ui/Parts.tsx` |

`MAX_VOCABULARY` and `TRANSCRIPT_KEEP` each exist twice, in two files, with different values. That is not a mistake: they limit different things.

One limit is not in this code: the Mentra App's own limit on a background `fetch` (table above, row "Network"). On iPhone a request fails after 60 seconds without data. `claude.ts` does not ask for a streamed answer, so a lesson build that takes Claude longer than 60 seconds fails there, before the Coach's 90 seconds (`BUILD_GUARD_MS`) are up. Android has the same 60 seconds without data, so the same is likely there. Checks and answers stop earlier anyway, at the Coach's 30 seconds (`CLAUDE_GUARD_MS`). From a cloud machine a 3-picture lesson took Claude 6 to 7.5 seconds (`docs/TESTING.md`). Nobody has timed a real lesson request from a phone.
