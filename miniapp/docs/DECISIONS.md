# Decisions and their reasons

Every choice in this app that was not obvious, why it was made, what it was based on, and when it should be changed. Written on 2026-11-14, during the hackathon.

"Checked" means the fact was read in a named source on that date. "Not checked" means it is an assumption.

## History of this code

1. **A laptop server came first.** `backend/showonce-server.ts` was a Bun HTTP server with two endpoints, `/plan` and `/check`. A phone app was meant to take photos, send them to the server, and speak the reply. It was pushed to this branch as commit `e7733ef`.
2. **The team asked for one app instead of two.** The preference was phone only, with the app itself telling the glasses to take photos and using Mentra's `speak`. The server was replaced by this miniapp. The server's prompts, JSON shapes and photo rules were carried over into `src/background/claude.ts` and `coach.ts`.
3. **The app was renamed** from ShowOnce to Tinker, the team's project name. The package id is `com.tinker.app`.
4. **The `backend/` folder was deleted** in the same commit that added this folder. To read the old server: `git show e7733ef:backend/showonce-server.ts`.

## D1. One phone app, no server

- **Choice:** the phone calls Claude directly.
- **Why:** the team did not want a laptop that has to stay on, on the same Wi-Fi, for the whole demo.
- **Cost:** the Claude key has to be on the phone. See D7.
- **Change it when:** the app goes to people outside the team. Then the key must move behind a server.

## D2. Mentra Miniapp SDK, not the Bluetooth SDK

- **Choice:** `@mentra/miniapp`.
- **Why:** the team wanted Mentra's own speech (`session.speaker.speak`) and speech-to-text (`session.transcription`). Those exist in the Miniapp SDK. The Bluetooth SDK has no text-to-speech call. The teammate building the frontend also uses the Miniapp SDK.
- **Risk, checked:** Mentra's docs say the Miniapp SDK is in beta and recommend the Bluetooth SDK for Mentra Live. Camera and speech calls exist in the Miniapp SDK source (`node_modules/@mentra/miniapp/src/modules/camera.ts`, `speaker.ts`) and its scaffolder has a "Camera glasses (Mentra Live)" option, but nobody on the team has run them on real glasses yet.
- **Change it when:** photos or speech do not work on the real glasses and cannot be fixed. The fallback is a React Native app on `@mentra/bluetooth-sdk` with a separate voice (for example ElevenLabs). `coach.ts`, `claude.ts` and `commands.ts` have no Mentra import and can be reused as they are. Only `index.ts` would be rewritten.

## D3. Plain `fetch` to Claude, no Anthropic SDK

- **Choice:** `claude.ts` builds the HTTP request by hand.
- **Why, checked:** the background engine is not a browser or Node. Mentra's build check rejects `process`, `URL`, `Headers`, `FormData`, `Buffer` and others (`node_modules/@mentra/miniapp-cli/src/build-helpers.ts`). `fetch` with a string body and plain header record is supported.
- **Checked:** on iPhone, the background `fetch` is Apple's `URLSession` with a 60 second timeout and no size limit in the code (`mobile/modules/crust/ios/Source/JSCPolyfillBridge.swift` in `Mentra-Community/MentraOS`, branch `dev`, commit `f120725`). It is a native request, so browser CORS rules do not apply.
- **Not checked:** the Android implementation.
- **Consequence:** a Claude request must finish inside 60 seconds. That is why the lesson request is capped at 12 photos and 3000 output tokens.

## D4. Photos, not video

- **Choice:** one photo per step, taken when the step is finished.
- **Why:** the Claude API reads images and does not read video files. A photo of the finished state is also exactly what the learner's photo is compared with later.
- **Change it when:** a step cannot be judged from one still image. Then take two photos per step (start and end) before considering video.

## D5. Send photo links first, bytes second

- **Choice:** a fresh photo is sent to Claude as its download link. Bytes are sent only when the link is old or Claude rejects it.
- **Why:** it is faster and nothing large passes through the bridge between the JavaScript engine and the phone.
- **Checked:** the link is a signed link that lasts about 30 minutes (comment on `takePhoto` in the SDK's `camera.ts`).
- **Not checked:** whether Claude's servers can download from Mentra's photo storage. That is why the fallback to bytes exists and is tested in `test/coach.test.ts`.

## D6. The phone keeps its own copy of each expert photo

- **Choice:** `session.blob.setFromUrl(key, link)` right after each capture.
- **Why:** a lesson is used long after its links have expired. With `setFromUrl` the phone downloads the file itself, so the bytes never pass through the JavaScript bridge.
- **Why not `session.storage`:** it holds small strings. The SDK's own comment asks to keep the total under about 1 MB.
- **If saving fails:** nothing breaks. The check runs without the expert's photo and uses the written description of the finished step.

## D7. The Claude key is pasted into the app

- **Choice:** a text box on the phone screen. The key is saved with `session.storage` on that phone and tested with a 1-token request before it is saved.
- **Why not a `.env` file:** Mentra's build only passes `MENTRA_PUBLIC_*` variables, and it writes them into the bundle. The bundle is served over Wi-Fi and zipped for release. Their own template says secrets must not go there. This repository is also public.
- **Risk:** anyone using that phone's Tinker app spends the team's Claude credits.
- **Rule:** never write a key into any file in this repository. Delete the key in the Claude Console after the hackathon.

## D8. A command counts only at the end of a sentence

- **Why:** an expert says things like "the next step is to whisk". Matching the words anywhere would take a photo in the middle of the explanation.
- **Extra rule:** the short words "why" and "skip" must be the whole sentence, because they show up at the end of normal sentences.
- **Where:** `parseCommand` in `commands.ts`, with tests in `test/coach.test.ts`.

## D9. Ignore the microphone while speaking, plus 700 ms

- **Why:** the microphone and the speaker are on the same glasses. The app's own sentences contain command words ("Say next step when it is finished").
- **Cost:** a person cannot interrupt the app while it is talking.
- **Not checked:** whether 700 ms is the right gap on the real glasses. It is the constant `QUIET_AFTER_SPEECH_MS` in `coach.ts`.

## D10. One command at a time, extra commands are dropped

- **Why:** two photos at once fail, and two sentences at once overlap. Dropping is predictable. A queue would run stale commands seconds later.

## D11. Two models, structured output

- **Choice:** `claude-sonnet-5-5` writes the lesson. `claude-haiku-5-5` checks a step.
- **Why:** the lesson is written once and its quality decides everything after it. A check happens many times and the learner is waiting for it.
- **Structured output:** both requests pass a JSON schema in `output_config.format`, so the reply always parses and always has every field.
- **Not checked:** no request has been sent to the real Claude API from this code. The field names were checked against the type definitions of `@anthropic-ai/sdk` 1.8.0.

## D12. Version pins

- `@mentra/miniapp` is pinned to `3.4.0`, the `latest` tag on npm on 2026-11-14.
- `@mentra/miniapp-cli` is pinned to `0.1.0-beta.2`.
- **Trap, checked:** `bunx create-mentra-miniapp` installs the `latest` tag of the scaffolder, which is `0.1.0-dev.0`, and that template pins `@mentra/miniapp` to `0.3.0-dev.0`. A project made that way is on a much older SDK than this one.
- `sdkVersion` (`0.3.0`) and `minHostVersion` (`1.42.0`) in `miniapp.json` are copied unchanged from Mentra's `0.1.0-beta.2` template, which pins SDK `3.4.0-beta.1237`. **Not checked:** what the Mentra App does with other values. Leave them alone unless the app refuses to install.

## D13. `coach.ts` knows nothing about Mentra

- **Choice:** the `Coach` talks to a small `Device` interface. `index.ts` implements it with the real SDK. The tests implement it with a fake.
- **Why:** there were no glasses to test on while this was written. This split is what made it possible to run complete lessons in tests.
- **Rule:** do not import `@mentra/miniapp` in `coach.ts`, `claude.ts` or `commands.ts`.

## D14. Own timeouts on speech and photos

- **Speech:** the SDK's `speak` has no timeout and resolves when the audio has finished. If the phone never answers, the app would stay busy forever. `say` in `coach.ts` gives up waiting after 6 seconds plus 110 ms per character and carries on.
- **Photo:** the SDK's default is 60 seconds. `index.ts` sets 25 seconds, so a dead camera is reported while the person still remembers what they asked for.

## D15. English only

- **Choice:** `session.transcription.forLanguage("en-US", ...)`.
- **Why:** the commands are English. Automatic language detection can guess wrong on two-word commands.
- **Change it:** the constant `LANGUAGE` in `index.ts`. The command lists in `commands.ts` would need translating too.

## D16. One lesson at a time

- **Choice:** a new lesson replaces the saved one.
- **Why:** less to build and less to explain in a demo.
- **Change it when:** the demo needs two tasks. Store lessons under `lesson-<id>` and add a way to pick one.

## Sources that were read

- Mentra docs: https://docs.mentraglass.com/llms.txt (index), and the pages for two-layer architecture, photos, text to speech, speech to text, input, quickstart, distribution and the CLI.
- The source inside the npm packages `@mentra/miniapp@3.4.0`, `@mentra/miniapp-cli@0.1.0-beta.2` and `create-mentra-miniapp@0.1.0-beta.2`.
- `Mentra-Community/MentraOS` on GitHub, for the iPhone `fetch` implementation.

## Open questions

1. Do `takePhoto` and `speak` work on a real Mentra Live through the Miniapp SDK?
2. Can Claude download Mentra's photo links, or does every request fall back to bytes?
3. Do presses of the glasses button reach a miniapp, or does the Mentra App keep them for its own photo feature?
4. Is 700 ms enough to stop the app hearing itself?
5. How long does one check take from "check" to the spoken answer on real hardware?
