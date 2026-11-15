# Decisions and their reasons

Every choice in this app that was not obvious: what was chosen, why, what it was checked against, what is not checked, and when to change it. Written on 2026-11-14, during the hackathon.

"Checked" means the fact was read in a named file or source on 2026-11-14, or proved by a named test. "Not checked" means it is an assumption. Nothing in this app has been run on real glasses, so no decision here is checked on hardware.

The audit reports named below (E1 to E4) were written on 2026-11-14 by review agents before the merge. They are not in this repository. Where a finding matters, this page repeats it.

"Mentra's source" below always means the public repository `Mentra-Community/MentraOS` on GitHub, branch `dev`, at commit `f120725`. It was read on 2026-11-14, not run. The Mentra App on the team's phone and Mentra's cloud may be a different version. `docs/HOW_IT_WORKS.md` has one table with everything that was read there ("What the Mentra App does on the phone").

## History of this code

All times are 2026-11-14, from the git commits.

1. **16:16, a laptop server came first.** Commit `e7733ef` on branch `showonce-backend` added `backend/showonce-server.ts`, a Bun HTTP server with the endpoints `/plan` and `/check`. A phone app was meant to take photos, send them to the server and speak the reply. The project was called ShowOnce then.
2. **17:15, one phone app instead ("Tinker v1").** Commit `e6052d8` on the same branch replaced the server with a phone-only Mentra miniapp in `miniapp/`, on SDK 3.4.0. It had one lesson at a time, a plain screen and 11 tests. Its package id was `com.tinker.app`.
3. **17:18, the teammate's app.** Commit `14def27` on `main` ("Adding UI foundations") added `my-miniapp/`: rich screens on the old SDK 0.3.0-dev.0, with a background that called a Python server at `http://127.0.0.1:8000`. It also added `backend/`, that Python FastAPI server, with the Claude model id `claude-3-5-sonnet-20241022`.
4. **Evening, this merge.** A branch was started from `main`. Four audits looked at the teammate's screens (E1), the teammate's background (E2), the Python server and the README (E3) and the SDK upgrade (E4). Then the app in this folder was built: the teammate's screens, Tinker v1's logic grown to drive them, everything on SDK 3.4.0, no server.
5. **Later the same evening, reviews and the real API.** A review read Mentra's source to check what the app assumes about the phone and the glasses. Its findings are in D7, D10, D11, D12, D18, D20, D22, D27 and in the table "What the Mentra App does on the phone" in `docs/HOW_IT_WORKS.md`. The lead then changed four things: `LINK_FRESH_MS` from 20 to 8 minutes (D11), `safely` around every handler in `index.ts` (D27), a shorter praise sentence in the check prompt (D29), and whole sentences only for an answer that was cut off (D30). `scripts/real-claude-test.ts` ran three times against the real Claude API (D8, D9, D28).

What the audits found in commit `14def27`, and what shaped the result:

- The phone app could never reach the Python server. The address was the phone itself, and the main request used other field names than the server required (`photoUrl` against `photo_url`). The audit ran it: HTTP 422.
- "AI synthesis" always returned one fixed five-step matcha lesson marked as a success, whatever the expert showed.
- Answers to questions were fixed sentences about whisking.
- The built-in lesson existed only on the screen. The background did not know it, so the glasses stayed silent for it.
- Every finished sentence longer than 3 characters was sent as a question. In a simulation with a 900 ms speech-to-text delay, the app answered itself 9 times in 30 seconds.
- `icon.png` was a corrupt 86-byte file, and Mentra's `pack` and `release` commands only read `icon.png`.
- A hand-written `bun.d.ts` declared a global `process`, which hid mistakes that Mentra's build would catch.

To read the old code:

```bash
git show e7733ef:backend/showonce-server.ts          # the laptop server
git show e6052d8:miniapp/src/background/coach.ts     # Tinker v1
git show 14def27:backend/services/claude_service.py  # the Python server's Claude code
git show 14def27:my-miniapp/src/ui/App.tsx           # the teammate's original screen
```

An earlier version of these docs had a page named MERGING_A_FRONTEND, about how a second frontend could plug in. The frontend is merged now. `docs/SCREENS.md` replaces that page.

## D1. One phone app, no server

- **Choice:** the phone calls the Claude API directly.
- **Why:** the team did not want a laptop that has to stay on, on the same Wi-Fi, for the whole demo.
- **Checked:** the only `fetch` calls in `src/` are the one to `ENDPOINT` in `src/background/claude.ts` and the photo download in `src/background/index.ts`.
- **Cost:** the Claude key is on the phone (D13). Lessons stay on the phone that recorded them (D2).
- **Change it when:** the app goes to people outside the team, or two phones must share lessons.

## D2. TypeScript on the phone, not the team's Python server

- **Choice:** `backend/` was removed. Its useful parts were ported to TypeScript.
- **Why:** the server could not be reached from a phone and did no work that a phone cannot do (history above, audit E3). Its lesson building downloaded up to 10 photos and made one request to Claude.
- **What was ported:**
  - The question-answering prompt. Rules 1 to 4 of `CHAT_SYSTEM` in `src/background/claude.ts` are the Python prompt's rules, word for word. Two rules were added: do not make up things the expert said, and tell the learner to say "check" when they ask how their work looks, because this request carries no photo.
  - The built-in matcha lesson, text unchanged, now in `src/background/seed.ts` (D14).
  - The lesson field names (`TutorialModel` and `TutorialStepModel` in `src/shared/channels.ts`), because the screens read them.
- **What was not ported, on purpose:** the fixed fallback lesson, the keyword answers, the instruction to always write 4 to 6 steps, and the server's own sessions (D6).
- **What is honestly lost:**
  1. **One lesson library shared between phones.** `session.storage` belongs to one phone, one user and one package id. A lesson recorded on one phone does not appear on another. Teach and learn on the same phone.
  2. **The key off the phone.** The key now sits in the phone's storage. The audit also found that the Python server did not protect it: no login, listening on every network interface, open to every web origin.
  3. **Changing a prompt or a model without a rebuild.** A change to `claude.ts` needs a new build and a new install on each phone.
- **Checked:** the audit ran the Python server on a scratch copy (the 422, the fixed lesson). The storage scope is in the comment at the top of `node_modules/@mentra/miniapp/src/modules/storage.ts`. The prompt rules are compared by the test "the system prompt carries the rules of the team's Python prompt" in `test/claude.test.ts`.
- **Not checked:** whether the old model id still worked.
- **Change it when:** two phones must share lessons. That needs a small hosted store, and then the key can move behind it too.

## D3. Mentra Miniapp SDK, not the Bluetooth SDK

- **Choice:** `@mentra/miniapp`.
- **Why:** the team wanted Mentra's own speech (`session.speaker.speak`) and speech-to-text (`session.transcription`). The teammate's app uses the same SDK.
- **Checked:** the camera and speech calls exist in the SDK source (`node_modules/@mentra/miniapp/src/modules/camera.ts` and `node_modules/@mentra/miniapp/src/modules/speaker.ts`).
- **Read for Tinker v1, not re-read for the merge:** Mentra's docs say the Miniapp SDK is in beta and recommend the Bluetooth SDK for Mentra Live, and the Bluetooth SDK has no text-to-speech call.
- **Not checked:** photos and speech on real glasses.
- **Change it when:** photos or speech do not work on the real glasses and cannot be fixed. The fallback is a React Native app on Mentra's Bluetooth SDK with a separate voice. `coach.ts`, `commands.ts`, `claude.ts`, `seed.ts` and `contracts.ts` have no Mentra import and can be reused as they are. Only `index.ts` would be rewritten.

## D4. The teammate's screens and package id are kept

- **Choice:** the look stays: matcha green, cream page, rounded cards, the Learning and Teaching tabs, lesson cards, the transcript, the class names in `src/ui/styles.css`. The wiring behind it was replaced (D21). The package id stays `com.mentra.tinker`.
- **Why the screens:** the problems the audit found (E1) were in the wiring, not in the design: the screen kept its own copy of the state, showed made-up numbers, never showed a failure, and jumped to the bottom of the page on every transcript line.
- **Why the id:** it is the id already on the team's `main` branch.
- **What follows from the id (checked):** the Mentra App keeps one dev entry per package name (Mentra's template README), so on a phone this build uses the same entry as the teammate's build. Storage is scoped by package id, so nothing saved by Tinker v1 (`com.tinker.app`) is visible here. A key saved there must be pasted again.
- **Not checked:** the screens on a real phone. They were looked at in a headless browser at 380 px wide, with assumed sizes for the status bar and the home indicator.

## D5. The contracts: `Device` and `Brain`

- **Choice:** `src/background/contracts.ts` declares two interfaces. `Device` is what the Coach needs from the phone and the glasses. `Brain` is what it needs from Claude. `coach.ts` imports only these. `index.ts` builds the real `Device` from `session.*`. `claude.ts` builds the real `Brain` from `fetch`. The tests build fakes.
- **Why:** there were no glasses to test on while this was written. The split is what makes it possible to run whole lessons in `bun test`. It also let several build agents work at the same time: `channels.ts` and `contracts.ts` were frozen first, and the Coach, the Claude code and the screens were written against them.
- **Rule:** `coach.ts`, `commands.ts`, `claude.ts`, `seed.ts` and `contracts.ts` never import `@mentra/miniapp`, and the Coach never calls `fetch`.
- **Checked:** the imports of all five files, by reading. A test checks the imports of `claude.ts` and `seed.ts` ("import only the contracts and the shared types, never Mentra" in `test/claude.test.ts`).
- **Not checked by a test:** the imports of `coach.ts` and `commands.ts`. Keep the rule by hand.

## D6. No fake results

- **Choice:** when Claude fails, the app says so. No hard-coded lesson, verdict or answer ever stands in for an AI result.
- **Why:** the teammate's app returned the same matcha lesson for any skill and marked it a success, and answered every question with whisking advice. Nobody watching can tell that from a real result, and a wrong answer spoken with confidence is worse than "I could not answer that."
- **Where:** every failure in `claude.ts` is a `BrainError`. The Coach says a short sentence ("I could not build the lesson. Say finish lesson to try again.") and sends the reason to the screen. The screen shows it in red. The screen also shows no progress percentage while Claude works, no invented photo count and no invented duration.
- **Checked:** the tests "hold no stand-in answers from the Python server" (`test/claude.test.ts`), "when Claude fails to build the lesson, the recording is kept and the error is shown" and "when Claude cannot check, the step stays and the reason is on the screen" (`test/coach.test.ts`), "a failed lesson build is shown and stays through the clock ticks" (`test/ui.test.tsx`).
- **The built-in lesson is not an AI result** and is never presented as one (D14).

## D7. Plain `fetch` to Claude, no Anthropic SDK

- **Choice:** `claude.ts` builds the HTTP request by hand.
- **Why:** the background engine is not a browser and not Node. Mentra's build rejects `process`, `URL`, `Headers`, `FormData`, `Buffer` and more. `fetch` with a text body and a plain object of headers is supported.
- **Checked:** the list of rejected names in `node_modules/@mentra/miniapp-cli/src/build-helpers.ts`.
- **Checked in Mentra's source** (files `JSCPolyfillBridge.swift`, `JSCPolyfillBridge.kt` and `startup.ts`): on iPhone a background `fetch` fails after 60 seconds without data. On Android it has 30 seconds to connect, 60 seconds without data and 120 seconds for the whole call. There is no list of allowed hosts, so the Claude API can be reached. A failed `fetch` rejects with a plain `{code, message}` object, not an `Error`. `reason` in `claude.ts` and `describe` in `coach.ts` handle that.
- **Consequence:** `claude.ts` does not ask for a streamed answer, so a Claude request has to finish inside 60 seconds. A lesson build that takes Claude longer fails on iPhone. That is why the lesson request is capped at 12 photos (`MAX_PLAN_PHOTOS`) and 3500 output tokens (`PLAN_MAX_TOKENS`).
- **Not checked:** how long a real lesson request takes from a phone.
- **Change it when:** lesson builds run into the 60 seconds. Lower `MAX_PLAN_PHOTOS` or `PLAN_MAX_TOKENS` first. Asking Claude for a streamed answer would keep data flowing, but nobody has checked how the phone's `fetch` hands over a streamed body.

## D8. Two models, three kinds of request, structured output

- **Choice:** `claude-sonnet-5-5` writes the lesson (`PLAN_MODEL`). `claude-haiku-5-5` checks a step (`CHECK_MODEL`) and answers a question (`CHAT_MODEL`).
- **Why:** the lesson is written once and its quality decides everything after it. A check or an answer happens many times, and the learner is waiting for it with busy hands.
- **Structured output:** the lesson and the check pass a JSON schema in `output_config.format`, so the reply has every field. The answer to a question is plain text, because it is spoken as it is.
- **Checked:** the shape of every request, by `test/claude.test.ts`. Tinker v1's notes say the field names were compared with the type definitions of the Anthropic SDK.
- **Checked against the real API on 2026-11-14:** `scripts/real-claude-test.ts` sent all four kinds of request with a real key, three times, from a cloud machine. Claude accepted every request shape: both model ids, both thinking switches, both schemas, photos as bytes and as a link. Building a lesson took 6.1 to 7.3 seconds, a photo check 1.2 to 3.0 seconds, an answer 0.8 to 1.4 seconds. Details: `docs/TESTING.md`, section "Real Claude API test".
- **Not checked:** the same requests from the phone's background engine, and how long they take there.
- **Change it:** the three model constants at the top of `claude.ts`. Read D9 first.

## D9. Thinking is switched off in every request

- **Choice:** every request carries a `thinking` field (`thinkingOff` in `claude.ts`): `{type: "between_tools"}` for a model whose id contains `sonnet-5-5`, `{type: "disabled"}` for every other model.
- **Why:** these models think before they answer unless told not to. Thinking tokens count inside `max_tokens`, and thinking takes seconds. With 200 tokens for a check, the answer could be cut off before it starts. Tinker v1 (commit `e6052d8`) sends no `thinking` field and has this weakness. Do not copy its `claude.ts`.
- **Why two different switches:** each model refuses the other's switch with HTTP 400.
- **Checked:** the lead read this in Claude's docs on 2026-11-14 (page `build-with-claude/thinking-troubleshooting` on platform.claude.com). The docs agent fetched the same page that day through a page-summary tool. It says: both models think by default, thinking tokens count toward `max_tokens`, Sonnet 5.5 answers 400 to `disabled` and takes `between_tools`, only Sonnet 5.5 accepts `between_tools`, and Haiku 5.5 accepts `disabled`.
- **Checked against the real API on 2026-11-14:** in three runs of `scripts/real-claude-test.ts`, no request was refused. Both switches are accepted with the app's settings as they are (no effort setting is sent, so the default applies). No check was cut off by `max_tokens`.
- **Still to keep in mind:** that docs page ties both switches to an effort setting of "high" or lower. If an effort setting is ever added, run the real Claude API test again. A wrong switch shows at once as an HTTP 400 that names `thinking`.
- **Stale comment in the code:** the comment above `thinkingOff` in `claude.ts` names the page `build-with-claude/thinking` (the build notes say `thinking-troubleshooting`) and says the switch is "not yet tried against the real API". The second part is no longer true.
- **No `temperature` is sent.** The build notes say these models answer 400 to it. That was not on the page above. The source is the build notes only.
- **Change it when:** a model constant changes. Look up the new model in Claude's docs, then edit `thinkingOff`.

## D10. Photos, not video: a photo per step, plus timed photos

- **Choice:** one photo with a shutter sound when the expert says a step is finished ("next step"). In between, one silent photo when 20 seconds have passed since the last photo (`AUTO_CAPTURE_MS`).
- **Why photos:** the Claude API reads images, not video files. A photo of the finished step is also exactly what the learner's photo is compared with later.
- **Why timed photos as well:** step photos show only end states. The teammate's design took a photo every 4 seconds so Claude could see the work in progress. The idea was kept at a slower pace, and each timed photo now goes through the same one-command gate as everything else (D19). The audit found that the 4-second timer started a new photo while the last one was still running, and that nothing on the phone ever used those photos.
- **How Claude is told the difference:** each capture is labelled "step finished" or "timed photo" in the request, and the prompt tells Claude to take the step's reference photo from a "step finished" capture when it can.
- **Limits:** at most 12 photos go to Claude, every step photo first (`choosePhotos` in `coach.ts`). Timed photos stop at 40 captures (`MAX_CAPTURES`).
- **Cost:** a timed photo makes no sound, so people near the wearer get no signal. The audit raised this about the teammate's silent photos.
- **Checked:** the tests "a timed photo is taken after 20 seconds, silently, and never while a command runs", "a command given during a silent timed photo is not lost" and "Claude gets at most 12 photos: every step photo first, then timed photos spread evenly" in `test/coach.test.ts`.
- **Checked in Mentra's source:** the phone honours `size`, `compress` and `sound`. It refuses a second photo while one is in flight (`CAMERA_BUSY`), which is one more reason for the one-command gate. It also refuses photos when the glasses are not connected, when the phone is not signed in to Mentra's cloud, during a video recording, and under 15 percent glasses battery. Without Wi-Fi on the glasses a photo travels over Bluetooth, shrunk to about 640 x 640 and about 15 KB.
- **What follows:** put the glasses on Wi-Fi for the demo (a phone hotspot works), or the photo checks judge very small pictures. Keep the glasses charged: a long recording with a photo every 20 seconds uses the battery, and under 15 percent every photo is refused.
- **Not checked:** what a photo does to the microphone while it is taken, how much battery and heat a photo every 20 seconds costs, and whether a photo finishes before the next one is due.
- **Change it:** `AUTO_CAPTURE_MS` in `coach.ts`. 0 turns timed photos off.

## D11. Photo links first, bytes second

- **Choice:** a fresh photo is sent to Claude as its download link. Bytes are sent only when the link is old or Claude rejects it. "Fresh" means younger than 8 minutes (`LINK_FRESH_MS`).
- **Why:** it is faster, and nothing large passes through the bridge between the JavaScript engine and the phone.
- **Why 8 minutes:** two sources disagree on how long a link lasts. The SDK's comment on `takePhoto` says "about 30 minutes" (`node_modules/@mentra/miniapp/src/modules/camera.ts`). Mentra's cloud source signs links for 600 seconds (`PRESIGN_EXPIRES_SEC` in `cloud-v2/packages/runtime/src/services/storage/providers/s3.provider.ts`, used by `requestPhoto` in `cloud-v2/packages/runtime/src/services/camera/camera.service.ts`). The code trusts the shorter one, with a margin of 2 minutes. Until the evening of 2026-11-14 the value was 20 minutes, from the SDK comment.
- **What follows for a long recording:** a photo that is older than 8 minutes when the expert says "finish lesson" is sent as bytes, read from the copy kept on the phone. So a recording that runs longer than 8 minutes sends its early photos as bytes and its late ones as links, in the same request.
- **Why `LINK_DEAD_MS` is still 28 minutes:** between 8 and 28 minutes the phone still tries to download a link when it has no kept copy. If the link is dead, that costs one failed request and the photo is left out.
- **Checked:** both sources above, read on 2026-11-14. The fallback is tested: "when Claude cannot open photo links, the bytes are sent instead, and that is remembered" and "an old photo link is not sent: the kept copy is used, then a download, then no photo" in `test/coach.test.ts`.
- **Checked against the real API:** in `scripts/real-claude-test.ts` (check 6, three runs), Claude opened a public picture link on GitHub and judged the picture. That proves Claude fetches image links in this request shape.
- **Not checked:** how long a real Mentra link works, and whether Claude's servers can download from Mentra's photo storage. If they cannot, the first request with photos after each restart fails once and is sent again with bytes. `scripts/real-app-test.ts` exercises exactly that fallback on purpose: its simulated glasses hand out links that nobody can open.
- **Side effect on the screen:** the phone screen shows photos by their links, so it can load a picture only for about 10 minutes after it was taken.

## D12. The phone keeps its own copy of the expert's photos

- **Choice:** `session.blob.setFromUrl(key, link)` right after each photo of a recording, step photos and timed photos alike. After the draft is built, copies that no step uses are deleted. The learner's photos are never kept.
- **Why:** a lesson is used long after its links have expired, and a link lasts only about 10 minutes (D11). So for every lesson that was not recorded a moment ago, the kept copy is the only way the expert's photo reaches a check. With `setFromUrl` the phone downloads the file itself, so the bytes never pass through the JavaScript bridge.
- **Why not `session.storage`:** it holds small text. The SDK's comment asks to keep the total under about 1 MB.
- **Checked in Mentra's source:** blobs may take up to 1 GB per app. Stored data survives an app update or reinstall.
- **If saving fails:** nothing breaks. The check runs without the expert's photo and uses the written description of the finished step.
- **Known gap:** a restart in the middle of a recording or a review leaves that recording's copies on the phone. Nothing deletes them.

## D13. The Claude key is pasted into the app

- **Choice:** a password box on the phone screen. The key is tested with a 1-token request, then saved with `session.storage` on that phone. The screen is only ever told the last 4 characters.
- **Why not a `.env` file:** Mentra's build only passes `MENTRA_PUBLIC_*` variables, and it writes them into the bundle. The header of `build.ts` says secrets must not go there. This repository is also public.
- **Risk:** anyone using that phone's Tinker app spends the team's Claude credits.
- **Rule:** never write a key into any file in this repository. Tests use `sk-ant-test-...`. Delete the key in the Claude Console after the hackathon.
- **Checked:** "the key is tested before it is saved, and a rejected key is not saved" (`test/coach.test.ts`), "hold no key, and this test file holds only the fake one" (`test/claude.test.ts`).

## D14. A lesson library, and one built-in lesson

- **Choice:** recorded lessons are kept as one JSON array under the storage key `library`, newest first, at most 20 (`MAX_LIBRARY`). The built-in matcha lesson is not stored. It is added from `seed.ts` every time the library is read, it is marked `built_in`, the screen tags it "Built in", and it cannot be deleted.
- **Why a library:** the teammate's screens are built around one. Tinker v1 kept a single lesson and replaced it with each new one.
- **Why one storage value:** it is the simplest thing that works. A lesson is a few kilobytes of JSON (the built-in one is 4,344 bytes in the team's file). The cost: the whole library is written again on every change.
- **Checked in Mentra's source:** `session.storage` has no hard size limit. The SDK only advises staying under 1 MB. Stored data survives an app update or reinstall.
- **Why the built-in lesson lives in the background:** in the teammate's app it lived on the screen only, so the glasses could not speak it.
- **Why have one at all:** a new install has something to learn before anyone has recorded anything, and it can be read aloud without a Claude key.
- **Where its text comes from:** the team wrote it. It is copied unchanged from the Python server's data file, which is kept as `test/fixtures/tut_matcha_ceremonial_01.json`. A test compares every field.
- **What was added, and by whom:** each of its 6 steps got a `done_looks_like` line and a `common_mistake` line, because the photo check needs them. **An AI coding assistant wrote those lines during the merge, from each step's own text. A person on the team should read them.** No step has a `story`, because nobody told one. "Why" falls back to the step's `instruction_detailed`.
- **Not checked:** whether those `done_looks_like` lines lead to right verdicts on real photos. The built-in lesson has no expert photos, so its checks rest on these lines alone. Against the real Claude API, with a drawing instead of a photo, the check was strict (D28).
- **Not read:** Tinker v1's storage key `lesson`.
- **Change it when:** lessons grow large or numerous. Store one value per lesson and an index.

## D15. A review step between Claude and the library

- **Choice:** Claude's lesson is a draft. The expert sees every step and its "Finished looks like" line on the phone, can change the title and the description, then publishes or discards. A spoken "publish lesson" or a short press publishes the draft as it is.
- **Why:** an expert should see what Claude wrote before a beginner follows it. The teammate's screen already had this step. Tinker v1 saved the lesson at once.
- **Why only two fields come back from the screen:** the screen's copy of the lesson has travelled as JSON and must not become the truth. The steps and photos always come from the draft the background kept (`publishTutorial` in `Coach.command`).
- **Cost:** a step's text cannot be changed on the phone. A draft is not stored, so a restart during review loses it.
- **Checked:** "teach a lesson by voice, review the draft, publish it with an edited title" (`test/coach.test.ts`), "review: edit, publish the draft with the new title, then follow the background to the library" (`test/ui.test.tsx`).

## D16. A command counts only at the end of a sentence

- **Why:** an expert says things like "the next step is to whisk". Matching the words anywhere would take a photo in the middle of the explanation.
- **Extra rule:** "next", "skip", "why", "tip" and "tips" must be the whole sentence, because they come up at the end of normal sentences.
- **Cost:** "check", "done", "finished" and "repeat" work at the end of any sentence during a lesson. "I am not done" starts a check.
- **Where:** `parseCommand` in `commands.ts`.
- **Checked:** "a command counts only at the end of a sentence, and only in its own mode" and "short words are commands only when they are the whole sentence" (`test/coach.test.ts`).

## D17. Questions need the name "Tinker". Other speech is ignored

- **Choice:** during a lesson, a sentence is sent to Claude only when it starts with "Tinker", "hey Tinker", "ok Tinker" or "okay Tinker". Speech without the name that is not a command does nothing.
- **Why:** the demo happens in a loud hall. The teammate's app sent every finished sentence longer than 3 characters to the question path. The audit simulated it: an overheard "Pass me the salt please." got a spoken answer, and with a 900 ms speech-to-text delay the app answered its own answers 9 times in 30 seconds and did not stop.
- **Also:** the name followed by exactly a command runs that command ("Tinker, check."). The name alone is answered "Yes?" and the next sentence is the question, because speech-to-text often ends the sentence at that pause.
- **Checked:** "a question starts with the name Tinker, and only while a lesson is being learned", "the name alone gets a short reply, and the next sentence is the question" (`test/coach.test.ts`).
- **Checked in Mentra's source:** in a loud hall a finished sentence can arrive late or carry other people's words. That supports the choice. It also means a question can arrive with a stranger's words in front of the name, and then it is not recognised as a question.
- **Checked in Mentra's source:** the app sends speech-to-text a list of words to expect, with "Tinker" first (`BASE_VOCABULARY` in `index.ts`, sent with `session.transcription.configure({vocabulary})`). The phone ignores that list at this commit. It reads only `languageHints`. The call does no harm, and it starts to help the day Mentra reads the field.
- **Not checked:** how speech-to-text writes the name. If it hears "thinker" or "tinka", the question is not recognised. The fix would be more entries in `WAKE_WORDS` in `commands.ts`.

## D18. The app must not answer itself: quiet gap, echo filter, "Okay."

- **The problem:** the microphone and the speaker are on the same glasses, and the app's own sentences contain command words ("Say next step when it is finished").
- **Checked in Mentra's source:** the Mentra App does not pause the microphone while a miniapp speaks, and no echo cancellation was found. So the app has to protect itself. A finished sentence arrives after the speech service's end-of-speech signal (up to about 2 seconds) plus a 0.5 second wait. A loudness gate on the glasses, on by default, is described in Mentra's settings as keeping the wearer's microphone from hearing the glasses' own speech. Nobody knows how well it works, so the app does not rely on it.
- **Choice, three layers:**
  1. The microphone is ignored while the app speaks and for 700 ms after (`QUIET_AFTER_SPEECH_MS`).
  2. Heard text that matches what the app said in the last 10 seconds is dropped (`isEcho`): at least 80 percent of its words, in order, are in one of the app's last 5 sentences. This layer exists because the text of the app's own sentence can arrive after the quiet gap.
  3. Nothing the app says ends in a command or starts with its name (`defuse`). The fixed sentences are worded that way. Lesson text and Claude's replies get " Okay." added, or "So, " put in front, when they would otherwise parse as a command. If an echo slips through the first two layers, it still does nothing.
- **The exception in layer 2:** a finished sentence that is exactly one command is let through from 2.5 seconds after the app stopped speaking (`ECHO_REPLY_MS`). Without it, "publish lesson" would be ignored for 10 seconds after "Say publish lesson to save it".
- **Costs:** a person cannot interrupt the app. A person who repeats the app's words within 10 seconds is ignored. A lone command said less than 2.5 seconds after a prompt that contains it is ignored.
- **Checked:** "the app does not react to its own voice", "an echo of the app's own sentence is dropped for 10 seconds, a real sentence is not", "an echo that ends in command words cannot start a command", "a sentence from Claude that ends in a command is made harmless before it is spoken", "nothing the app said in any test above could be taken for a command" (`test/coach.test.ts`).
- **Not checked:** any of the numbers on real glasses: 700 ms, 10 seconds, 80 percent, 2.5 seconds. Nobody has measured how late the app's own speech arrives as text.
- **Watch this on the first run:** by the timing read in Mentra's source, the text of the app's own sentence can arrive up to about 2.5 seconds after the sound ends. That is later than the 700 ms quiet gap, so the echo filter (layer 2) carries the load, as designed. It is also the same size as `ECHO_REPLY_MS`. The exception only lets through a sentence that is exactly one command, and no sentence of the app is one. If speech-to-text ever cuts a piece like "publish lesson" out of the app's sentence and delivers it alone and late, it would pass. Raise `ECHO_REPLY_MS` if that happens.

## D19. One command at a time

- **Choice:** while a command runs, a new one is dropped. `stop` and `discard` are remembered and run next. So is any command given during a silent timed photo.
- **Why dropped, not queued:** two photos at once fail (in Mentra's source the phone refuses the second one with `CAMERA_BUSY`), and two sentences at once overlap. A queue would run a stale command seconds later, for example a second photo the person no longer expects.
- **Why the exceptions:** "End Session" and "Discard" must always work. And during a silent photo the person cannot know the app is busy.
- **Checked:** "End session pressed while the app is speaking still ends the lesson", "a command given during a silent timed photo is not lost", "no failure leaves the app stuck" (`test/coach.test.ts`).

## D20. What the glasses button does

- **Choice** (`Coach.button`): a short press is the main action of the current mode. A long press is the second one.

  | Mode | Short press | Long press |
  | --- | --- | --- |
  | idle | start the first lesson in the library | start teaching |
  | recording | save the step | finish the lesson |
  | processing | nothing | nothing |
  | review | publish | nothing |
  | learning | check the step | next step |

- **This differs from the team's earlier README,** which said the button advances to the next step. In the teammate's code any press moved to the next step, or stopped a recording. Here the short press in a lesson is the photo check, because that is the centre of the project, and moving on is the long press.
- **Checked:** "the button on the glasses: what a short and a long press do in every mode" (`test/coach.test.ts`). The simulated phone also sends one press (`test/phone.test.ts`).
- **Checked in Mentra's source:** presses do reach a miniapp's `onButtonPress`, with `buttonId` `"camera"` and `pressType` `"short"` or `"long"`. While any miniapp listens for presses, the Mentra App switches the glasses' own photo-on-press off. So a press should not take a stray photo while Tinker is on.
- **Not checked:** a press on real glasses. Voice and the phone screen do not depend on the button.

## D21. The screen holds no state of its own

- **Choice:** the state lives in the background. The screen draws what the background last said. A button sends a command and changes nothing on the screen. The screen changes when the background answers with an event. When the screen opens it gets a `Snapshot` with everything in it.
- **Why:** the screen is thrown away every time it closes, while a lesson may still be running on the glasses. The teammate's screen changed its own state first and told the background second. The audit listed 18 places where the two could disagree: the step number jumping back and forth after two quick taps, a lesson shown on the phone that the glasses did not know, a transcript line saying the glasses spoke when they had not.
- **Busy without a busy event:** the screen disables its buttons while `assistantState` is `thinking` or `speaking`. The Coach promises never to send `idle` or `listening` while a command runs. A snapshot also carries `busy`.
- **What the screen does keep:** text typed into a box, which tab and view are showing (in the browser history, so the back gesture works), and whether a photo link loaded.
- **Checked:** `test/ui.test.tsx` (29 tests), and "while a command runs the screen is told thinking or speaking, never idle, and idle once at the end" and "snapshot() gives the same picture as the single messages" in `test/coach.test.ts`.
- **Checked in Mentra's source:** a message to the screen that is sent before the page listens is buffered (up to 32 per channel), and a request from the screen that is sent before the background is ready is held (up to 128). So the snapshot that `index.ts` pushes when the screen opens is not lost. The screen still asks for one itself, and asks again every 2 seconds until it has one.
- **Details:** `docs/SCREENS.md`.

## D22. Own time limits on speech, photos and Claude

- **Speech:** the SDK's `speak` has no time limit and resolves when the audio has finished. If the phone never answered, the app would stay busy forever. `say` in `coach.ts` stops waiting after 6 seconds plus 110 ms per character and carries on.
- **Photo:** the SDK's default is 60 seconds. `index.ts` sets 25 seconds (`PHOTO_TIMEOUT_MS`), so a dead camera is reported while the person still remembers what they asked for.
- **Claude:** the Coach fails a request after 90 seconds (`CLAUDE_GUARD_MS`). The phone's own limit usually comes first (D7). This one is the backstop.
- **Checked:** the SDK values in `node_modules/@mentra/miniapp/src/modules/speaker.ts` (`timeoutMs: 0`) and `node_modules/@mentra/miniapp/src/session.ts` (`DEFAULT_REQUEST_TIMEOUT_MS = 60_000`). The test "speech that never ends and a Claude request that never answers do not freeze the app" (`test/coach.test.ts`).
- **Checked in Mentra's source:** `speak` resolves when playback has finished, so the quiet gap after speech starts at the right moment. The sound goes to the phone's media output. That is the glasses only when they are the phone's Bluetooth audio device.

## D23. English only

- **Choice:** `session.transcription.forLanguage("en-US", ...)`.
- **Why:** the commands are English. Automatic language detection can guess wrong on two-word commands. The teammate's app used automatic detection with English and Japanese hints.
- **Change it:** the constant `LANGUAGE` in `index.ts`. The phrase lists in `commands.ts` would need translating too.

## D24. Removed: the live stream and the chime sound

- **Choice:** the channels `startStream`, `streamReady`, `playChime` and `chimeStatus` from the teammate's app are gone.
- **Why the stream:** nothing on the screen ever started it, and nothing in the code ever stopped it. The SDK's comment says a default stream is hosted by Mentra, recorded automatically and delayed by 10 to 20 seconds, which is too late for a viewfinder. Whether the glasses can take photos while streaming is unknown.
- **Why the chime:** it played a file from a stranger's personal GitHub repository. The audit downloaded it once: a 7 MB MP3, 182 seconds long. Its owner can change or remove it at any time.
- **What does those jobs now:** the Teaching tab shows the last photo (`photoCapture`). "Test glasses audio" speaks one sentence with Mentra's own speech (`testAudio`).

## D25. The icon

- **The problem:** the teammate's `icon.png` was a corrupt 86-byte file. Mentra's old project scaffolder had read the PNG as text. The manifest pointed at a second file, `IMBIcon.png`, which works in `dev` but not in `pack` or `release`: those two read only `icon.png` (audit E4, tested with each command).
- **Choice:** the team's mascot image is now `icon.png`, and `miniapp.json` says `"icon": "icon.png"`.
- **Checked:** `icon.png` is a valid PNG, 1254 x 1254. The build notes say `mentra-miniapp pack` prints no warning.
- **Cost:** the image is 916,555 bytes, so the packed app is about 1 MB.
- **Not checked:** how the icon looks in the Mentra App.

## D26. Version pins, and the stale `latest` tags on npm

- `@mentra/miniapp` is pinned to `3.4.0` and `@mentra/miniapp-cli` to `0.1.0-beta.2`, both without `^`.
- **Trap, checked with `npm view` on 2026-11-14:** the `latest` tag of `create-mentra-miniapp` and of `@mentra/miniapp-cli` is still `0.1.0-dev.0`. A project made with `bunx create-mentra-miniapp` gets the old template, which pins the SDK to `0.3.0-dev.0`. The teammate's project came from that old template (audit E4). The `latest` tag of `@mentra/miniapp` itself is `3.4.0`.
- `sdkVersion` (`0.3.0`) and `minHostVersion` (`1.42.0`) in `miniapp.json` look old and are not. They are the values in Mentra's new template (`create-mentra-miniapp` 0.1.0-beta.2). **Checked in Mentra's source:** `sdkVersion` must be inside `>=0.3.0 <4.0.0`, and the Mentra App must be 1.42.0 or newer. Both are checked at install and at launch only. Leave them alone.
- `build.ts` and `tsconfig.json` are Mentra's new template files. `build.ts` has the check for code the background engine cannot run. The old template had no such check.
- `bun.d.ts` was deleted and must not come back. It declared `process` and `Bun` for every file, so the type checker believed they exist in the background. For the same reason, do not add `@types/node` or `bun-types`. `tsc` checks only `src/`. The tests, the scripts and `build.ts` are not type-checked.
- Keep `bun.lock`. Mentra's `pack` and `release` pick the package manager from the lock file. Without it they run `npm run build` (audit E4).

## D27. Every handler in `index.ts` is wrapped: no error may escape

- **Choice:** `safely(what, handler)` in `src/background/index.ts` runs a handler inside `try` and `catch` and writes `[tinker] <what> failed:` to the console. It wraps every screen command, the screen-open handler, the speech handler, the button handler, the glasses-connection handler and the one-second tick.
- **Why:** in Mentra's source an error that escapes a timer callback restarts the whole background. On iPhone so does an error that escapes a transcription or button handler. A restart throws away a recording in progress, a draft in review and the lesson being learned, because none of them is stored (see "What is stored on the phone" in `docs/HOW_IT_WORKS.md`). Restarts wait 2, 8 and 30 seconds, and after that the miniapp stays down.
- **This is the second line of defence.** The first is in the Coach: `run` catches everything a command throws and turns it into a transcript note "Something went wrong. ...".
- **Checked in Mentra's source:** `mobile/modules/jspolyfill/src/startup.ts` (the timer wrapper reports an escaped error to the phone), `mobile/modules/crust/ios/Source/JSCRuntime.swift` (the iPhone engine reports every uncaught exception), `MentraJSRouter.ts` (an error report is treated as a crash and the background is started again) and `mobile/modules/engine/src/services/MentraJSCrashController.ts` (`DEFAULT_BACKOFFS = [2_000, 8_000, 30_000]`).
- **Not covered by a test:** no test makes a handler throw to prove `safely` catches it.
- **Also read there:** a promise that is rejected and never caught is not reported at that commit, so it does not restart the background. The Coach starts its commands with `void this.run(...)`, and `run` catches everything anyway.
- **Not wrapped:** the two request handlers, `getSnapshot` and `setKey`. `setKey` catches its own errors and answers `{ok: false, error}`. What the SDK does with an error thrown inside a request handler was not read.
- **Change it when:** you add a handler or a timer to `index.ts`. Wrap it.

## D28. The built-in lesson's photo checks are strict: record a lesson for the demo

- **What was seen:** check 7 of `scripts/real-claude-test.ts` checks a picture against step 2 of the built-in lesson ("Sift the Matcha Powder"), which has no expert photo. The picture is a drawing of a mound of green powder in a bowl, which is what that step should look like. In all three runs on 2026-11-14 the verdict was "fix", for example "Sift the powder through the mesh so there are no clumps left in the bowl." The check itself counts as passed, because check 7 only asks that the call succeeds.
- **What was seen with the expert's picture:** check 4 uses a lesson that Claude built from three captures, so the step has the expert's picture. For a drawing of the same scene from another spot, the verdict was "pass" in all three runs.
- **Likely reason, not proven:** with only the written line ("Fine green matcha powder lies sifted in the dry bowl with no clumps") Claude looks for signs of sifting that the picture cannot show. With the expert's picture it compares the result.
- **Choice for now:** no code change. For the demo, record a lesson live, publish it, then learn it, so every step has the expert's photo. Use the built-in lesson to show steps read aloud and questions. `README.md` gives the same advice.
- **Not checked:** real photos of real matcha. The pictures were drawings.
- **Change it when:** the built-in lesson must show photo checks. Options: give its steps expert photos (it has none today), soften its `done_looks_like` lines in `seed.ts`, or add a rule to `CHECK_SYSTEM` in `claude.ts` for steps without an expert photo. Run the real Claude API test after any of these.

## D29. The praise for a correct step is at most 8 words

- **Choice:** the "pass" rule in `CHECK_SYSTEM` (`claude.ts`) reads: say: a few warm words of praise, at most 8, for example "Nice work, that looks right." Do not describe what you see.
- **Why:** on a pass, the praise and the next step are spoken as one sentence group (`check` in `coach.ts`). Long praise delays the next instruction and tells the learner nothing they need. In run 1 of `scripts/real-claude-test.ts` the praise was 14 words ("Nice work, that mound of matcha sits right in the center of the bowl."), over the test's limit of 12, although the verdict was right. The rule was then tightened by the lead.
- **Checked:** runs 2 and 3 of the same test answered "Nice work, that looks right." The test "the system prompt keeps v1's rules" in `test/claude.test.ts` checks that the prompt says "at most 8".
- **Not checked:** other steps, and real photos.
- **Change it:** `CHECK_SYSTEM` in `claude.ts`. The test program allows 12 words (check 4 in `scripts/real-claude-test.ts`), so the prompt keeps a margin.

## D30. An answer cut off by the token limit speaks only its whole sentences

- **Choice:** in `answer` in `claude.ts`, when Claude stops because it reached `CHAT_MAX_TOKENS` (200), the reply is cut back to its last full stop, question mark or exclamation mark (`wholeSentences`). When not even one sentence is whole, the call fails, and the learner hears "I could not answer that. Ask again."
- **Why:** half a sentence spoken into the ear sounds broken, and failing the whole answer would throw away sentences that are fine. The two calls that return JSON still fail on a cut-off answer, because cut-off JSON cannot be used.
- **Checked:** the tests "speaks only the whole sentences" and "fails when not even one sentence is whole" in `test/claude.test.ts`.
- **Not checked:** how often a real answer reaches 200 tokens. In the real API runs the answers had 40 to 51 words, well under the limit.

## Sources that were read

- The code in this folder, on 2026-11-14.
- The source inside the npm packages `@mentra/miniapp@3.4.0` and `@mentra/miniapp-cli@0.1.0-beta.2` (in `node_modules/`), and for the audits also `@mentra/miniapp@0.3.0-dev.0` and both `create-mentra-miniapp` templates (`0.1.0-dev.0` and `0.1.0-beta.2`).
- `Mentra-Community/MentraOS` on GitHub at commit `f120725`, read by the audits and by a review on 2026-11-14: the phone side of `fetch`, photos, speech, the transcription settings, button presses, storage and blobs, the messages to the screen, crash handling, the version gate and the launch gate. Some glasses firmware details came from an older branch of that repository and are weaker evidence. The Mentra App on the team's phone may be a different version.
- The real Claude API, through `scripts/real-claude-test.ts`, three runs on 2026-11-14 from a cloud machine (D8, D9, D28, D29).
- Mentra's docs, for Tinker v1: https://docs.mentraglass.com/llms.txt (index), and the pages for two-layer architecture, photos, text to speech, speech to text, input, quickstart, distribution and the CLI.
- Claude's docs on thinking (D9).
- The team's code at commit `14def27`, including the Python server, which the audit ran on a scratch copy.
- npm, for the tags in D26.

## Open questions

Each one needs real hardware or a real key. When you answer one, write the answer here and update the status table in `AGENTS.md`. `docs/GLASSES_TEST.md` is the walk-through for the first run on glasses.

1. **Real glasses.** Do `takePhoto` and `speak` work on a real Mentra Live through the Miniapp SDK? Does the speech come out of the glasses?
2. **The button.** Mentra's source says presses reach the app (D20). Do they on the team's glasses and Mentra App?
3. **Echo timing.** How long after the app stops speaking does its own sentence arrive as text? Are 700 ms and the echo filter enough? Does the filter ever drop a real sentence?
4. **Photo links.** Can Claude download Mentra's photo links, or does every first request fall back to bytes? Claude did open a public GitHub link in the real API test (D11).
5. **Timed photos.** Does a silent photo every 20 seconds cut words out of the narration? What does it do to battery and heat? Does a photo finish uploading before the next one is due?
6. **"Tinker" heard as "thinker".** How does speech-to-text write the name? Related: the app sends a list of words to expect (`session.transcription.configure({vocabulary})`). The audit read the Mentra App's source at commit `f120725` and found that the phone reads only the language hints of that request. The word "vocabulary" does not occur in that file. So the list appears to be ignored for now.
7. **Lessons per phone.** Is one phone enough for the demo? A lesson recorded on one phone is not on another (D2).
8. **Speed on the phone.** How long does one check take from "check" to the spoken answer? From a cloud machine the Claude part took 1.2 to 3.0 seconds per check and 6.1 to 7.3 seconds per lesson of 3 pictures (D8). The photo, the upload and the speech come on top. Does a lesson request with 12 photos finish inside the phone's 60 seconds?
9. **The built-in lesson's check lines.** Do the `done_looks_like` lines in `seed.ts` give right verdicts on real photos of matcha? With drawings, the check was strict (D28).
10. **Without internet.** Claude cannot be reached, so checks, questions and lesson building fail with a spoken sentence. Speech recognition and the voice use Mentra's cloud first. The SDK's comments (`node_modules/@mentra/miniapp/src/modules/transcription.ts` and `node_modules/@mentra/miniapp/src/modules/speaker.ts`, option `processing`, default `"preferCloud"`) describe a fallback to an on-device model. Does the built-in lesson still get read aloud, and are commands still heard, when the phone is offline?

Answered on 2026-11-14: **the thinking switch** (D9). The real Claude API accepts both switches as the app sends them.
