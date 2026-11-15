# Tinker miniapp: read this first

This file is for AI agents and new teammates. It is the entry point to this folder.

## What this is

Tinker is one Mentra miniapp for Mentra Live glasses. An expert does a task once while explaining it. The glasses take a photo of each step, and Claude writes a lesson from the photos and the words. A beginner is then coached through the lesson by voice, and each step is checked from a photo.

It runs on the phone inside the Mentra App. There is no server. The phone calls the Claude API directly.

## Read in this order

1. `README.md`: how to install it on a phone and how to use it.
2. `docs/HOW_IT_WORKS.md`: the two layers, the modes, the flow of a lesson, the Claude requests, what is stored.
3. `docs/DECISIONS.md`: every choice that was not obvious, why it was made, what was checked and what was not.
4. `docs/TESTING.md`: the tests, the simulated phone, the first run on real glasses, a table of failures and causes.
5. `docs/MERGING_A_FRONTEND.md`: how another frontend plugs in, and how to add a command.

## Status on 2026-11-14

| Thing | State |
| --- | --- |
| Type-check, Mentra build, 11 tests | Pass |
| Full teach and learn run on a simulated phone | Pass (`test/phone.test.ts`) |
| Run on real Mentra Live glasses | Never done |
| A request to the real Claude API | Never done |
| Glasses button reaching the app | Unknown |

When you run something on real hardware, update this table and the "Open questions" list in `docs/DECISIONS.md`. Do not write that something works on the glasses unless it was run on the glasses.

## Rules

1. **No Claude key in any file.** This repository is public. The key is pasted into the app on the phone. Tests use the fake key `sk-ant-test-...`.
2. **Before every commit:** `bun run typecheck`, `bun run build`, `bun test`. All must pass.
3. **Glasses calls (`session.*`) live in `src/background/index.ts` only.** `coach.ts`, `claude.ts` and `commands.ts` must not import `@mentra/miniapp`. That is what lets the tests run without glasses.
4. **The background is not a browser and not Node.** No `window`, `document`, `process`, `URL`, `Headers`, `FormData`, `Buffer`, `require` or Node modules in `src/background/` or `src/shared/`. The build fails with the file and line if you use one.
5. **Keep saved data readable.** The storage keys `claudeKey` and `lesson`, and the `Lesson` shape in `coach.ts`, are already on phones. Changing them loses the saved key or lesson.
6. **Leave the versions alone** unless you have a reason: `@mentra/miniapp` 3.4.0, `@mentra/miniapp-cli` 0.1.0-beta.2, and `sdkVersion` and `minHostVersion` in `miniapp.json`. See D12 in `docs/DECISIONS.md`.
7. **Every sentence the app speaks is short.** The learner has no screen. Word limits are in the prompts in `claude.ts`.
8. **When you change behaviour, change the docs in the same commit.**

## Commands

```bash
bun install        # once
bun run dev        # develop: scan the QR once, saves reload on the phone, laptop must stay on
bun run release    # install a fixed copy on a phone, laptop not needed afterwards
bun run typecheck
bun run build
bun test
```

## Where to make common changes

| To change | Edit |
| --- | --- |
| What Claude is told, or the word limits | The prompts in `src/background/claude.ts` |
| Which Claude models are used | `PLAN_MODEL` and `CHECK_MODEL` in `src/background/claude.ts` |
| A spoken command or its wording | The lists in `src/background/commands.ts` |
| What the app says | The strings in `src/background/coach.ts` |
| Photo size, language, photo timeout | The constants at the top of `src/background/index.ts` |
| The quiet gap, photo limits, link ages | The constants at the top of `src/background/coach.ts` |
| The phone screen | `src/ui/App.tsx` and `src/ui/styles.css` |
| What the screen is told | `AppState` in `src/shared/channels.ts` and `Coach.state()` |
| App name, permissions | `miniapp.json` |

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
