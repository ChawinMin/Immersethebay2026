# Testing

## Commands

```bash
bun install        # once
bun run typecheck  # TypeScript, including the Mentra SDK's types
bun run build      # Mentra's build, with its check for code the background engine cannot run
bun test           # both test files
```

All four must pass before a commit. On 2026-11-14 the result was 11 tests passing.

## What each test file proves

### `test/coach.test.ts`

Runs the `Coach` class directly with a fake `Device` (fake glasses and fake phone storage) and a fake Claude API (a replaced `fetch`). A fake clock stands in for time, so tests do not wait.

It covers:
- a command counts only at the end of a sentence
- the key is tested before it is saved, and a rejected key is not saved
- without a key the app asks for one
- a full lesson taught by voice, then coached, with pass, fix and unclear answers
- the app does not react to its own voice
- when Claude rejects photo links, the bytes are sent and links are skipped afterwards
- a lesson survives a restart, and expired links fall back to the kept photos
- a failed photo does not break teaching or coaching
- a failed lesson request keeps the recording for a retry
- the glasses button and the phone buttons run the same commands

### `test/phone.test.ts`

Runs the **built file** `dist/background/index.js`, the same file the phone loads, inside an empty JavaScript sandbox (`node:vm`) that has only what Mentra's background engine has. A simulated phone answers the SDK.

How the simulation works, for anyone who needs to extend it:
- The SDK sends every message with `__dispatch("__bridge", "send", JSON.stringify([raw]))`. `raw` is JSON: `{payload: {type, ...}, requestId?}`.
- The phone answers by calling `__mentraDeliverBridgeRaw(raw)` with `{payload: {type: "miniapp_request_result", ok: true, data}, requestId}`.
- The first message is `miniapp_connect`. The answer is `miniapp_connect_ack`.
- Events from the glasses are `{payload: {type: "miniapp_event", streamType, data}}`. Speech uses `streamType: "transcription:en-US"`. The button uses `button_press`.
- Messages from the phone screen are events on the stream `_ui`, with `data` of `{type: "UI_OPEN"}` or `{type: "UI_MESSAGE", channel, payload, seq, requestId}`. Messages to the screen leave as `{type: "UI_SEND", channel, payload, seq, requestId?}`.
- Request types the app uses: `miniapp_photo`, `miniapp_speak`, `miniapp_storage_get`, `miniapp_storage_set`, `miniapp_storage_delete`, `miniapp_blob_set_from_url`, `miniapp_rgb_led`.

These names were read from `node_modules/@mentra/miniapp/src/protocol.ts` and `src/modules/`. They belong to SDK 3.4.0 and can change with the SDK version.

The test teaches a one-step lesson by voice, pastes a key through the screen channel, starts the lesson by voice and checks the step with a button press.

## What no test proves

- That real glasses take the photo, play the speech, or deliver button presses.
- That the real Claude API accepts these requests. The fake accepts anything with the right key.
- How long anything takes.
- Anything about the phone screen. `App.tsx` is type-checked and built, not rendered in a test.

## First run on real glasses

Do these in order. Each line says what should happen.

1. `bun run dev`, scan the QR in the Mentra App (Settings > Miniapp Developer Settings > Scan Miniapp QR Code). **Expect:** Tinker opens and shows "Ready. No lesson yet."
2. Paste the Claude key, tap Save key. **Expect:** "Key saved." This is the first real Claude request.
3. Tap "Teach a new lesson". **Expect:** the glasses say "Teaching mode..." If the phone speaker says it instead, the glasses are not the phone's audio output.
4. Say a sentence. **Expect:** it appears on the screen after "Heard for this step". If nothing appears, the microphone permission or the transcription is the problem.
5. Say "next step". **Expect:** a shutter sound, then "Step 1 saved." A wait of several seconds is normal.
6. Say "finish lesson". **Expect:** "Building the lesson.", then "Lesson saved..." within about 20 seconds, and the steps appear on the screen.
7. Say "start lesson", then "check". **Expect:** shutter sound, then a spoken answer and a green, red or orange light.

`bun run dev` prints the app's `console` output and errors in the laptop terminal. The red line on the phone screen shows the last error too.

## If something fails

| What you see | Likely cause | Where to look |
| --- | --- | --- |
| "Photo failed. ..." on the screen | Glasses not connected in the Mentra App, or camera permission missing | `takePhoto` in `index.ts`, `permissions` in `miniapp.json` |
| Nothing after "Heard for this step" | Microphone permission denied on the phone, or no internet | `session.transcription` in `index.ts` |
| Voice comes from the phone | The glasses are not the phone's Bluetooth audio output | Phone audio settings |
| "Claude rejected this key" | Wrong or deleted key | Claude Console |
| "The lesson was not built. ..." | The text after it is Claude's own error message | `buildPlan` in `claude.ts` |
| Every request runs twice | Claude cannot open Mentra's photo links, so each first try fails and bytes are sent | Expected. `withPhotos` in `coach.ts` remembers after the first time |
| The app reacts to its own voice | The quiet gap is too short | `QUIET_AFTER_SPEECH_MS` in `coach.ts` |
| The button does nothing | The Mentra App keeps button presses for its own photo feature | Use voice or the phone screen |
| Build fails naming `process`, `URL`, `Headers`... | Background code used something the engine lacks | The file and line in the message |
