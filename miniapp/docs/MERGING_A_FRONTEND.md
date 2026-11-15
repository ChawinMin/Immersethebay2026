# Putting a different frontend on Tinker

A teammate is building a frontend with the same SDK (`@mentra/miniapp`). This page says how that frontend and this app become one app.

## The easy direction: bring the screens into Tinker

1. Copy the frontend's React files into `src/ui/`. Keep `src/ui/main.tsx` as the entry, or keep its `<MentraProvider>` wrapper if you replace it. Without the provider the app never finishes opening.
2. Do not change anything in `src/background/`.
3. Talk to the app only through the four channels below. The screen cannot reach the glasses by itself.

### Read what is happening

```tsx
import {useEffect, useState} from "react"
import type {AppState} from "../shared/channels"

const [state, setState] = useState<AppState | null>(null)

useEffect(() => {
  const stop = mentra.on("state", setState)                       // every change
  const stopOpen = mentra.onOpen(() => {
    mentra.request("get-state", {}).then(setState, () => {})      // once, when the screen opens
  })
  return () => { stop(); stopOpen() }
}, [])
```

`AppState` has: `mode`, `busy`, `hasKey`, `keyHint`, `lessonTitle`, `materials`, `steps`, `stepNumber`, `narration`, `lastHeard`, `lastSaid`, `error`. The comments in `src/shared/channels.ts` explain each one.

### Make something happen

```tsx
mentra.request("action", {name: "teach"})
```

| `name` | Does | Works in mode |
| --- | --- | --- |
| `teach` | Starts recording a lesson | idle |
| `capture` | Photo and save the current step | teaching |
| `finish` | Builds the lesson | teaching |
| `learn` | Starts coaching | idle |
| `check` | Photo and check the current step | coaching |
| `repeat` | Says the step again | coaching |
| `story` | Says why the expert does the step | coaching |
| `skip` | Next step without a check | coaching |
| `stop` | Cancels the recording or ends the lesson | teaching, coaching |
| `help` | Says which commands work now | any |
| `deleteLesson` | Erases the saved lesson | idle |

The reply `{ok: true}` only means the request arrived. The outcome arrives through `state`.

### Save the Claude key

```tsx
const result = await mentra.request("set-key", {key})   // {ok, error}
```

Keep a way to do this on the new screen. Without a saved key, teaching and coaching refuse to start.

## Adding a new command

Four places, in this order:

1. `src/shared/channels.ts`: add the name to `ActionName`.
2. `src/background/commands.ts`: add it to `Command`, and add its spoken phrases to the list of the mode it belongs to.
3. `src/background/coach.ts`: add a branch in `run` and write the method.
4. `test/coach.test.ts`: add a test.

## Sending new information to the screen

Add a field to `AppState` in `channels.ts`, fill it in `Coach.state()` in `coach.ts`, and add it to the `EMPTY` object in `src/ui/App.tsx`. TypeScript reports every place that is missing it. Do not send photo bytes to the screen. Messages between the two halves are JSON strings and large ones are slow.

## The other direction: move Tinker's logic into another miniapp project

1. Copy `src/background/` and `src/shared/channels.ts` into that project.
2. In its `miniapp.json`, add the `CAMERA` and `MICROPHONE` entries under `permissions`, and the `CAMERA` and `MICROPHONE` entries under `hardwareRequirements`, as they are in this folder's `miniapp.json`. Without `MICROPHONE` no speech text arrives. Without `CAMERA` every photo fails.
3. Check `@mentra/miniapp` in its `package.json`. This code is written against `3.4.0`. A project made with `bunx create-mentra-miniapp` can be on `0.3.0-dev.0`. Set it to `3.4.0` and set `@mentra/miniapp-cli` to `0.1.0-beta.2`, then run `bun install`.
4. Copy `build.ts` from this folder if the other project's `build.ts` does not import `backgroundRuntimeGuardPlugin`.
5. Run `bun run typecheck` and `bun run build`.

## Rules that keep the app working

- Glasses calls (`session.*`) go in `src/background/index.ts` only.
- `coach.ts`, `claude.ts` and `commands.ts` stay free of Mentra imports, so the tests keep running.
- No `window`, `document`, `process`, `URL`, `Headers` or Node modules in `src/background/`.
- No Claude key in any file.
