# Tinker miniapp: read this first

This file is for AI agents and new teammates. It is the entry point to this folder.

## What this is

Tinker is one Mentra miniapp for Mentra Live glasses (camera, microphone, speaker, one button, a light, no display). An expert does a task once while explaining it. The glasses take photos, and Claude writes a lesson from the photos and the words. A beginner is then coached through the lesson by voice. Each step can be checked from a photo, and questions that start with "Tinker" are answered by Claude.

It runs on the phone inside the Mentra App. There is no server of our own. The phone calls the Claude API directly, with a key that is pasted into the app. Speech-to-text, the voice and photo storage are Mentra's services, reached through the Mentra App.

The screens were designed by one teammate and the logic came from an earlier app ("Tinker v1"). They were merged on 2026-11-14. The history is at the top of `docs/DECISIONS.md`.

## Read in this order

1. `README.md`: how to install it on a phone and how to use it.
2. `docs/HOW_IT_WORKS.md`: the two layers, every file, the modes, the full command table, the voice rules, the flow of a lesson, the Claude requests, what is stored, what the Mentra App does on the phone, every limit.
3. `docs/DECISIONS.md`: every choice that was not obvious, why it was made, what was checked and what was not, and the open questions.
4. `docs/TESTING.md`: the automated tests, the simulated phone, the two programs that test against the real Claude API, a table of failures and causes.
5. `docs/GLASSES_TEST.md`: the first test on real glasses, step by step.
6. `docs/SCREENS.md`: how the screens get their data, and how to add a button, a command or a field.

## Status on 2026-11-14

| Thing | State |
| --- | --- |
| Type-check (`bun run typecheck`) | Pass, 0 errors |
| Mentra build (`bun run build`), with its check of the background code | Pass |
| `test/claude.test.ts`: the requests to Claude against a fake `fetch`, and the built-in lesson | Pass, 77 tests |
| `test/coach.test.ts`: whole lessons against fake glasses and a fake Claude | Pass, 46 tests |
| `test/ui.test.tsx`: the screens in a fake browser | Pass, 29 tests |
| `test/phone.test.ts`: the built app on a simulated phone, a full teach and learn run | Pass, 1 test |
| Run on real Mentra Live glasses | Never run |
| Real Claude API | see docs/TESTING.md, section Real Claude API test. `scripts/real-claude-test.ts` ran three times from a cloud machine, not a phone: 8 of 9 checks, then 9 of 9 twice after the praise rule was tightened. |
| Photo checks against the built-in lesson (no expert photos) | Strict: in all three runs above, a correct drawing was called "fix". See D28 in `docs/DECISIONS.md`. |
| Glasses button reaching the app | Confirmed in Mentra's source, not yet run on glasses |

When you run something on real hardware, update this table and the "Open questions" list in `docs/DECISIONS.md`. Do not write that something works on the glasses unless it was run on the glasses.

## Rules

1. **No Claude key in any file.** This repository is public. The key is pasted into the app on the phone. Tests use the fake key `sk-ant-test-...`.
2. **Before every commit, the three checks:** `bun run typecheck`, `bun run build`, `bun test`. All must pass.
3. **Glasses calls (`session.*`) live in `src/background/index.ts` only.** Every handler and timer registered there runs inside `safely`, so one error cannot restart the miniapp. Wrap any new one the same way (D27 in `docs/DECISIONS.md`).
4. **`coach.ts`, `commands.ts`, `claude.ts`, `seed.ts` and `contracts.ts` never import `@mentra/miniapp`, and the Coach never calls `fetch`.** The Coach talks to the interfaces `Device` and `Brain` in `src/background/contracts.ts`. That is what lets the tests run whole lessons without glasses and without a network.
5. **The background is not a browser and not Node.** No `window`, `document`, `process`, `URL`, `Headers`, `FormData`, `Buffer`, `require` or Node modules in `src/background/` or `src/shared/`. The build fails with the file and line if you use one. Do not add `@types/node`, `bun-types` or a hand-written `bun.d.ts`: they hide exactly that mistake from the type checker.
6. **The screen keeps no state of its own.** The state lives in the Coach. A button sends a command and the screen changes when the background answers. See `docs/SCREENS.md`.
7. **No hard-coded stand-in for an AI result.** When Claude fails, the app says so. Never return a made-up lesson, verdict or answer.
8. **Keep saved data readable.** The storage keys `claudeKey` and `library`, and the `TutorialModel` and `TutorialStepModel` shapes in `src/shared/channels.ts`, are on phones already. Renaming a key loses the saved key or lessons. A new lesson field must be optional.
9. **Leave the versions alone** unless you have a reason: `@mentra/miniapp` 3.4.0, `@mentra/miniapp-cli` 0.1.0-beta.2, and `sdkVersion` and `minHostVersion` in `miniapp.json`. Keep `bun.lock`. See D26 in `docs/DECISIONS.md`.
10. **Every sentence the app speaks is short and must not END in a command phrase** (and must not start with "Tinker"). The learner has no screen, and the glasses can hear their own speaker. The command phrases are in `src/background/commands.ts`. The last test in `test/coach.test.ts` checks every sentence the tests made the app say.
11. **When you change behaviour, change the docs in the same commit.**

## Commands

```bash
bun install        # once
bun run dev        # develop: scan the QR once, saves reload on the phone, laptop must stay on
bun run release    # install a fixed copy on a phone, laptop not needed afterwards
bun run typecheck  # check 1
bun run build      # check 2
bun test           # check 3
```

The two programs that use the real Claude API need a key in the environment variable `TINKER_CLAUDE_KEY` and never print it. How to run them, and what they prove: `docs/TESTING.md`, section "Real Claude API test".

```bash
read -rs TINKER_CLAUDE_KEY && export TINKER_CLAUDE_KEY   # paste the key, press Enter; it is not shown
bun build scripts/real-claude-test.ts --target=node --format=esm --outfile=build/real-claude-test.mjs
node build/real-claude-test.mjs    # the Claude code alone, 9 checks
bun scripts/real-app-test.ts       # the built app on a simulated phone, with the real Claude
```

## Where to make common changes

| To change | Edit |
| --- | --- |
| What Claude is told, or the word limits | `LESSON_SYSTEM`, `CHECK_SYSTEM` and `CHAT_SYSTEM` in `src/background/claude.ts` |
| The fields Claude returns | `LESSON_SCHEMA` and `CHECK_SCHEMA` in `src/background/claude.ts`, together with `LessonDraft`, `DraftStep` and `Verdict` in `src/background/contracts.ts` |
| Which Claude models are used | `PLAN_MODEL`, `CHECK_MODEL` and `CHAT_MODEL` in `src/background/claude.ts`. Then read `thinkingOff` in the same file: each model needs its own switch. |
| How much Claude may write | `PLAN_MAX_TOKENS`, `CHECK_MAX_TOKENS`, `CHAT_MAX_TOKENS` in `src/background/claude.ts` |
| A spoken command or its wording | The lists `IDLE`, `RECORDING`, `REVIEW` and `LEARNING` in `src/background/commands.ts` |
| The name that starts a question | `WAKE_WORDS` in `src/background/commands.ts` |
| What "what can I say" answers | `helpText` in `src/background/commands.ts` |
| The short list of spoken commands on the phone screen | `TEACHING_PHRASES` and `LEARNING_PHRASES` in `src/ui/Settings.tsx` |
| What the app says | The strings in `src/background/coach.ts`. Mind rule 10. |
| What the glasses button does | `button` in `src/background/coach.ts` |
| What happens to an error inside a handler | `safely` in `src/background/index.ts`, and the `catch` in `run` in `src/background/coach.ts` |
| Timed photos | `AUTO_CAPTURE_MS` (0 turns them off) and `MAX_CAPTURES` in `src/background/coach.ts` |
| How many photos Claude gets for a lesson | `MAX_PLAN_PHOTOS` in `src/background/coach.ts` |
| The quiet gap and the echo filter | `QUIET_AFTER_SPEECH_MS`, `ECHO_WINDOW_MS`, `ECHO_PERCENT`, `ECHO_REPLY_MS` in `src/background/coach.ts` |
| When a photo link counts as old | `LINK_FRESH_MS`, `LINK_DEAD_MS` in `src/background/coach.ts` |
| How many lessons are kept | `MAX_LIBRARY` in `src/background/coach.ts` |
| Photo size, language, photo timeout, words for speech-to-text | `PHOTO_SIZE`, `LANGUAGE`, `PHOTO_TIMEOUT_MS`, `BASE_VOCABULARY` at the top of `src/background/index.ts`. The lesson's own words: `vocabularyFor` in `src/background/coach.ts`. |
| The built-in lesson | `BUILT_IN_TUTORIALS` in `src/background/seed.ts`. A test compares it with `test/fixtures/tut_matcha_ceremonial_01.json`. |
| What the screen is told | `Channels` and `Snapshot` in `src/shared/channels.ts`, and the methods of `Coach` that send them (`teachingState`, `learningState`, `connection`, `snapshot`) |
| The screens | `src/ui/`. Start with `docs/SCREENS.md`. Colours are in `src/ui/styles.css`. |
| App name, permissions, icon | `miniapp.json`, `icon.png` |

---

The rest of this file is Mentra's own rule sheet for any miniapp, copied unchanged from their project template (`create-mentra-miniapp` 0.1.0-beta.2).

# Miniapp implementation rules

## Two layers

- Put glasses subscriptions, `session.*` calls, durable state, and logic that
  must survive UI closure in `src/background/`.
- Put React, rendering, DOM access, and browser UI libraries in `src/ui/`.
- Keep `<MentraProvider>` at the root of `src/ui/main.tsx`. Once the app has
  mounted it calls `mentra.ready()`, which hides the Mentra App's loading
  screen. A UI page without the provider must call `mentra.ready()` itself, or
  the miniapp fails to open.
- The layers do not share memory. Exchange serializable data through the typed
  `mentra.*` / `session.ui.*` channels declared in `src/shared/channels.ts`.
- The background is a bare JavaScript engine, not a browser or Node. Supported
  globals are `console`, timers, `queueMicrotask`, `fetch`, `WebSocket`,
  `localStorage`, `crypto.getRandomValues`, `crypto.randomUUID`, `TextEncoder`,
  `TextDecoder`, `atob`, `btoa`, and the SDK-supported `AbortController` subset.
- Do not use `window`, `document`, DOM elements, `performance`,
  `XMLHttpRequest`, `crypto.subtle`, Node built-ins, `process`, or runtime module
  resolution in `src/background/`. Use `Date.now()` instead of
  `performance.now()`.

## UI layout

The UI WebView fills the whole phone screen. It runs under the status bar, the
home indicator, and the Mentra App's capsule menu (the floating control in the
top-right corner). `src/ui/App.tsx` shows the expected setup.

- Pad the root element by `useSafeArea().insets` on all four sides.
- Render page headers with `<MiniappHeader>` from `@mentra/miniapp/ui`. It
  lines the header up with the capsule menu and keeps content out from under
  it. Never put buttons or other controls under the capsule menu; taps there
  go to the Mentra App. For a custom header, spread `useCapsuleHeaderStyle()`
  onto it instead.
- Put the background (a color, gradient or image) on the root element you pad
  by the insets, and make that element fill the screen. It shows behind the
  status bar and the home indicator. Use padding, not margin, for the insets.
- Define both light and dark colors. The status-bar text follows the Mentra
  App's theme, and `<MentraProvider>` mirrors it as `<html class="dark">`.
  Read it in JavaScript with `useColorScheme()`. Do not hardcode a single
  scheme.

Reference: https://docs.mentraglass.com/app-devs/core-concepts/webviews/safe-areas

## Back navigation

The phone's back gesture (iOS edge swipe, Android back) runs `history.back()`
in the UI WebView. When the WebView has no history left, the Mentra App
minimizes the miniapp. Anything the user can go back from must push a history
entry.

- For pages, use a router in hash mode: react-router's `HashRouter`, or wouter
  with `useHashLocation`. Do not use `MemoryRouter`, `createMemoryRouter`, or
  wouter's `memoryLocation`.
- For tabs, dialogs, sheets, pickers, and multi-step flows, use
  `useHistoryState(key, initial)` from `@mentra/miniapp/ui` instead of
  `useState`.
- A back button in your own UI calls `history.back()`. It does not navigate
  forward to the parent route.

Reference: https://docs.mentraglass.com/app-devs/core-concepts/webviews/back-navigation

## Identity

- Replace `icon.png` with an icon designed for this miniapp: a square PNG, at
  least 512x512. The template ships a generic glasses placeholder, and
  `mentra-miniapp dev` and `release` warn while it is still in place.
- If you cannot create an image file, say so in your final message: tell the
  user that `icon.png` is still the template placeholder and needs replacing.
- Set `name` and `description` in `miniapp.json` to describe the miniapp.

## Development

- Use `bun run dev` while building and testing. Scan its QR code once. After
  that, every saved change rebuilds and reloads on the phone without a rescan.
  Several dev miniapps can coexist when they use distinct manifest package
  names.
- Use `bun run release` only for a persistent install that runs without the
  development computer. A release install is a fixed snapshot: each change
  needs another `bun run release` and another scan.
