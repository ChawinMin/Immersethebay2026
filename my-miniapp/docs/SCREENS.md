# The phone screens

How the screens in `src/ui/` get their data, what each file does, and how to add a button, a command or a field.

Read on 2026-11-14 from the code. The screens have been drawn in a test browser and looked at in a headless browser at 380 px wide. They have not been opened on a real phone.

A note on history: these screens were designed by a teammate in a separate app, and the logic behind them came from another one. The two are merged now. `docs/DECISIONS.md` (D4 and D21) says what was kept and what was replaced. This page replaces an older one that explained how to do that merge.

## The one rule: the screen keeps no state of its own

The screen is a page in a WebView inside the Mentra App. It exists only while it is open. It cannot reach the glasses. A lesson keeps running on the glasses while the screen is closed.

So the screen is built like a window onto the background:

1. It draws what the background last said.
2. A button sends a command with `mentra.send`. It changes nothing on the screen.
3. The screen changes when the background answers with an event.

Close the screen in the middle of a lesson, open it again, and it shows the same lesson at the same step.

What the screen is allowed to keep, because the background has no use for it:

- the text typed into a box (the key, the skill, the title and description of a draft, a question),
- which tab and which view are showing,
- whether a photo link loaded,
- the "tap again" state of a Discard or Delete button,
- the answer to the last "Save key".

Do not add anything else. In particular: no step counter, no lesson list, no transcript lines made on the screen, no status that changes before the background confirms it.

## How data arrives: `src/ui/state.ts`

`state.ts` is the only place where messages from the background become the data the screen draws. It exports:

| Export | What it is |
| --- | --- |
| `ScreenState` | The shape of everything the screen knows |
| `EMPTY` | The state before the background has said anything: nothing connected, nothing saved, `loaded: false` |
| `ScreenEvent` | One message from the background: `{channel, payload}` |
| `applyEvent(state, event)` | A plain function: old state plus one event gives the new state. Nothing else writes the state. |
| `isBusy(state)` | True while the background is in the middle of something |
| `useTinker()` | The React hook that listens to the background and returns the latest `ScreenState` |

`App.tsx` uses it like this:

```tsx
import {isBusy, useTinker} from "./state"

export function App(): JSX.Element {
  const state = useTinker()     // redrawn on every event from the background
  const busy = isBusy(state)    // true while a photo, a Claude request or speech is in progress
  // ... pass `state` and `busy` down to <Library>, <Session> and <Teaching>
}
```

What `useTinker` does:

1. It listens with `mentra.on` to the ten event channels: `snapshot`, `teachingState`, `photoCapture`, `tutorialGenerated`, `tutorialList`, `learningState`, `stepVerdict`, `transcriptionUpdate`, `assistantState`, `connectionStatus`. Each event goes through `applyEvent`.
2. In `mentra.onOpen` it asks for everything once: `mentra.request("getSnapshot", {}, {timeout: SNAPSHOT_TIMEOUT_MS})`. The background also pushes a `snapshot` when the screen opens. Asking covers a push that was sent before this page listened.
3. It asks again every `SNAPSHOT_RETRY_MS` (2 seconds) in two cases: no snapshot has arrived yet, or the last snapshot said `busy` and no event has since said the app is at rest.

Because `applyEvent` is a plain function, it can be tested without a browser:

```ts
import {applyEvent, EMPTY, isBusy} from "../src/ui/state"

const afterOpen = applyEvent(EMPTY, {channel: "snapshot", payload: snapshot})
const thinking = applyEvent(afterOpen, {channel: "assistantState", payload: {state: "thinking"}})
isBusy(thinking) // true
```

### `ScreenState`, field by field

| Field | Comes from | Notes |
| --- | --- | --- |
| `loaded` | the first `snapshot` | Until it is true the screen says "Connecting..." and claims nothing. |
| `connection` | `snapshot`, `connectionStatus` | Glasses, camera, microphone, key ready, last 4 characters of the key |
| `tutorials` | `snapshot`, `tutorialList` | The library, exactly as sent. The built-in lesson is in it. |
| `teaching` | `snapshot`, `teachingState` | Status, clock, counts, narration, error |
| `draft` | `snapshot`, `tutorialGenerated` | The lesson waiting for review. Cleared when the teaching status goes back to `idle` or `recording`. |
| `buildError` | a failed `tutorialGenerated` | Stays while the recording is open |
| `lastPhoto` | `photoCapture` | The newest photo of the recording. A snapshot carries no photo. |
| `published` | worked out in `applyEvent` | Set when the draft's id shows up in a `tutorialList`. Used for the note "Lesson published: TITLE" and for moving to the Learning tab. |
| `lastDraftId` | `tutorialGenerated`, `snapshot` | Only there to notice that moment |
| `learning` | `snapshot`, `learningState` | The lesson being learned. An ended lesson stays here with `active: false`, for the note "Lesson finished". |
| `verdict` | `snapshot`, `stepVerdict` | Cleared when a lesson with a new `sessionId` starts. Shown only under the step it belongs to. |
| `transcript` | `snapshot`, `transcriptionUpdate` | A line with a known `id` replaces the old one. At most `TRANSCRIPT_KEEP` (100) lines. |
| `assistant` | `snapshot`, `assistantState`, `learningState` | `idle`, `listening`, `thinking` or `speaking` |
| `snapshotBusy` | `snapshot.busy` | Cleared by an `assistantState` of `idle` or `listening` |

### The busy rule

There is no "busy" event. `isBusy` is true when the assistant is `thinking` or `speaking`, or the teaching status is `processing`, or the last snapshot said `busy`. The background promises never to say `idle` or `listening` while a command runs (`Coach.current` in `src/background/coach.ts`).

Buttons that start a command are disabled while busy. Three are never disabled, because the background remembers these commands even while it is busy: **End Session**, **End** (on the in-progress card) and **Discard**.

## The files

| File | What it draws | Sends |
| --- | --- | --- |
| `src/ui/main.tsx` | Nothing itself. Mounts `<App />` inside `<MentraProvider>`. The provider copies the Mentra App's theme onto `<html class="dark">` and calls `mentra.ready()` once the app has mounted. Do not call `mentra.ready()` by hand. | |
| `src/ui/index.html` | The mount point | |
| `src/ui/state.ts` | Nothing. See above. | `getSnapshot` |
| `src/ui/App.tsx` | The sticky "TINKER" header, the tagline, the two status pills, the Learning and Teaching tabs, and the view of the tab that is showing | |
| `src/ui/Learning.tsx` | `Library`: the lesson cards, the in-progress card, the notes, the settings card. `Session`: the current step, "Check my step", Previous, Repeat, Next, the check card with the verdict and both photos, the voice status, the transcript and the question box. | `startLearning`, `deleteTutorial`, `endLearning`, `checkStep`, `navigateStep`, `askTinker` |
| `src/ui/Teaching.tsx` | One panel per teaching status: idle (checklist, skill box, Start), recording (clock, counts, heard words, buttons, last photo), processing, review (title, description, steps, Discard, Publish) | `startTeaching`, `captureStep`, `stopTeaching`, `discardTeaching`, `publishTutorial` |
| `src/ui/Settings.tsx` | `SettingsCard` under the library: the key box, "Test glasses audio", a short list of spoken commands. `KeyCard`: the key box alone, at the top of the Teaching tab while no key is saved. | `setKey`, `testAudio` |
| `src/ui/Parts.tsx` | `usePhotoLink` and `Photo` (a picture that stays hidden until it loads and removes itself when its link is dead), `ErrorLine`, `ConfirmButton` (two taps within 4 seconds), `formatClock` | |
| `src/ui/Icons.tsx` | Inline SVG icons that take the colour of the text around them | |
| `src/ui/styles.css` | Every colour and size | |

Two channels are declared and answered by the background but not used by any screen file today: `requestTutorials` and `ping` (with its answer `pong`).

## Tabs, views and the back gesture

The phone's back gesture runs `history.back()` in the WebView. When no history is left, the Mentra App minimises the miniapp. So the tab and the view are kept with `useHistoryState` from `@mentra/miniapp/ui`, not with `useState`:

```tsx
const [tab, setTab] = useHistoryState<Tab>("tab", "learning")      // "learning" | "teaching"
const [view, setView] = useHistoryState<View>("view", "library")   // "library" | "session"
```

The lesson itself lives in the background. The history value only says what the person is looking at. `App.tsx` follows the background once, at these moments, and then leaves the person free:

- a lesson starts (by tap, by voice, by the glasses button), or the screen is reopened during one: show the Learning tab and the session view,
- the lesson ends: go back to the library,
- a recording opens: show the Teaching tab,
- the background confirms a publish: show the Learning tab.

Swiping back out of a running lesson shows the library with a "Lesson in progress" card. The lesson keeps running. **Resume** returns to it.

## Photos on the screen

The screen only gets photo links, never bytes. A link from the glasses stops working after about 10 minutes (Mentra's cloud signs it for 600 seconds; see "Photos: link or bytes" in `docs/HOW_IT_WORKS.md`). So every picture goes through `usePhotoLink` and `Photo` in `Parts.tsx`: hidden until it has loaded, removed when it fails. A dead link never leaves a broken picture. The recording screen's last photo (`Viewfinder` in `Teaching.tsx`) shows plain words instead when its link fails.

Do not send photo bytes over a channel. Messages between the two layers are JSON text, and large ones are slow.

## Mentra's screen rules, and where they are met

The rules are in the lower half of `AGENTS.md`.

| Rule | Where |
| --- | --- |
| Pad the root by `useSafeArea().insets` | `.tinker-root` in `App.tsx` |
| Keep controls out from under the capsule menu at the top right | `<MiniappHeader>` inside the sticky `.tinker-top` row in `App.tsx`. The row covers the strip behind the status bar, so no button can scroll under the capsule. |
| Back navigation through history | `useHistoryState` in `App.tsx` |
| Light and dark colours | Every colour is a variable in `:root` and `:root.dark` in `styles.css`. Do not write a fixed colour in a rule further down. |
| `<MentraProvider>` at the root | `main.tsx` |

Not checked: the real sizes of the safe areas and of the capsule menu on a phone.

## How to add things

Whatever you add, the three checks must pass before you commit: `bun run typecheck`, `bun run build`, `bun test`. And change `docs/HOW_IT_WORKS.md` in the same commit.

### A button for a command that already exists

The command table in `docs/HOW_IT_WORKS.md` lists every channel. To put, say, a second "Repeat" button somewhere:

```tsx
<button
  type="button"
  className="btn btn-secondary"
  disabled={busy}
  onClick={() => mentra.send("navigateStep", {direction: "repeat"})}>
  Repeat
</button>
```

Nothing else. Do not change any state in the click handler. The glasses will speak, and the events will redraw the screen.

For something that cannot be undone, use `ConfirmButton` from `Parts.tsx`:

```tsx
<ConfirmButton
  label="Discard"
  confirmLabel="Sure? Tap again"
  className="btn btn-secondary"
  onConfirm={() => mentra.send("discardTeaching", {})}
/>
```

### A new command

To give a new command all three ways in (voice, the glasses button, the screen), go through these places in order. A smaller change needs fewer of them. For example `materials` exists by voice only today ("what do i need"). A screen button for it needs steps 1, 2, the first part of 4, and 5.

1. **`src/shared/channels.ts`**: add the channel to `Channels` with its payload, and add its name to `UiCommandChannel`.
2. **`src/background/index.ts`**: add the name to `COMMANDS`. TypeScript reports an error here until you do.
3. **`src/background/commands.ts`**: add the name to `Command`. To make it a spoken command, add its phrases to the list of its mode (`IDLE`, `RECORDING`, `REVIEW` or `LEARNING`), in lower case with no punctuation and no apostrophes. Add it to `helpText` if the help sentence should name it.
4. **`src/background/coach.ts`**: three places.
   - `command`: a `case` for the channel that starts `this.run({command: "..."})`. Check every field of the payload before using it.
   - `perform`: a `case` that calls your method.
   - the method itself. Start it with a check of `this.mode`. Speak through `this.say(...)`.
   - optional: `button`, if a press on the glasses should do it.
5. **The screen**: the button, as above.
6. **`src/ui/Settings.tsx`**: `TEACHING_PHRASES` or `LEARNING_PHRASES`, if the phrase should be in the short list on the phone.
7. **Tests**: a test in `test/coach.test.ts` that gives the command and checks what is spoken and sent. A test in `test/ui.test.tsx` that taps the button and checks the channel.

Two warnings:

- **TypeScript only enforces step 2.** A channel with no `case` in `Coach.command`, or a command with no `case` in `perform`, does nothing and reports nothing.
- **Every sentence the app speaks must be short and must not end in a command phrase or start with "Tinker".** The glasses can hear their own speaker. If a new sentence breaks this, `defuse` adds " Okay." when it is spoken, and your test will show it.

A command that should work while the app is busy needs a decision: only `stop` and `discard` are remembered by `run`. Everything else is dropped while another command runs.

### A new field on something the screen already shows

Example: show the name of the skill while recording.

1. **`src/shared/channels.ts`**: add the field to `TeachingState`.
2. **`src/background/coach.ts`**: fill it in `teachingState()`. `snapshot()` uses the same method, so a reopened screen gets it too.
3. **`src/ui/state.ts`**: add it to `EMPTY.teaching`. For a field that is not optional, TypeScript reports an error here until you do.
4. **`src/ui/Teaching.tsx`**: draw it from `state.teaching`.
5. **Tests**: the test files are not type-checked, so update their fixtures by hand (`TEACH_IDLE` in `test/ui.test.tsx`).

The same steps work for `LearningState` (`learningState()` in the Coach), `ConnectionStatus` (`connection()`), and for a lesson field in `TutorialModel` or `TutorialStepModel`. Careful with the last two: saved lessons on phones do not have a new field, so make it optional and cope with it being absent.

### A new kind of event

1. **`src/shared/channels.ts`**: add the channel to `Channels` and its name to `UiEventChannel`.
2. **`src/background/coach.ts`**: send it with `this.send("name", payload)` at the moment it happens. If the screen needs it after being reopened, also add it to `Snapshot` (in `channels.ts`) and to `snapshot()`. An event sent while the screen is closed is lost.
3. **`src/ui/state.ts`**: four places.
   - `ScreenState` and `EMPTY`: where the data is kept.
   - `ScreenEvent`: the new `{channel, payload}` pair.
   - `applyEvent`: a `case` for it, and the `snapshot` case if you added it to the snapshot. TypeScript reports a missing `case`.
   - `useTinker`: one more `mentra.on("name", (payload) => dispatch({channel: "name", payload}))` line.
4. **A component**: draw the new field.

### A new request with an answer

`setKey` and `getSnapshot` are the two requests today. They are typed with `Rpc<Request, Answer>` in `Channels`, registered in `index.ts` with `session.ui.handle(...)` **before the first `await`**, and called from the screen like this (from `Settings.tsx`):

```tsx
const answer = await mentra.request("setKey", {key: value})   // {ok, error}
```

Use a request only when the screen needs an answer to show right away. For everything else send a plain command and let the events report what happened.

## Testing a screen change

```bash
bun test test/ui.test.tsx
```

The test renders the real `<App />` with a fake `mentra` object (`FakeMentra` in the test file). A test pushes events with `emit("learningState", {...})`, taps with `click(button("Check my step"))`, and reads what was sent with `fake.sentOn("checkStep")`. `docs/TESTING.md` says what these tests prove and what they cannot.
