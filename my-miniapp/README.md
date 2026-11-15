# Tinker

One app. It runs inside the Mentra App on the phone and controls the Mentra Live glasses. There is no server of our own.

- **Teach:** an expert wears the glasses, does a task once and explains it. The glasses take a photo of each step. Claude turns the photos and the words into a lesson, and the expert publishes it.
- **Learn:** a beginner wears the glasses and hears one step at a time. Saying "check" takes a photo, and Claude says it is right or says what to fix. Saying "Tinker, ..." asks a question.

Not run on real glasses yet. See "Not tested yet" at the end.

## Install it on a phone

A laptop is needed for this part only. The phone needs the Mentra App, version 1.42.0 or newer, with the Mentra Live glasses paired.

1. Install Bun on the laptop: https://bun.sh
2. In this folder run `bun install`.
3. Put the phone and the laptop on the same Wi-Fi.
4. Run `bun run release`. A QR code appears in the terminal.
5. On the phone open the Mentra App, go to **Settings > Miniapp Developer Settings > Scan Miniapp QR Code**, and scan it.

After step 5 the app is on the phone and the laptop can be closed.

While you are changing the code, use `bun run dev` instead of `bun run release`. It reloads the app on the phone every time you save, but the laptop has to stay on.

## Add the Claude key

Open Tinker on the phone. In the **Settings** card under the lesson list, paste the Claude key into the "Claude key" box and tap **Save key**. The app sends one test request and tells you if the key works.

The key is saved on that phone only. It is not in this code and it must never be put in this code, because this repository is public. Delete the key in the Claude Console after the hackathon.

Without a key the built-in matcha lesson can still be read aloud. Photo checks, questions and recording need the key.

## Use it

The phone needs internet and must be signed in to Mentra. Claude needs internet for every lesson, check and question. Speech recognition and the voice use Mentra's cloud first, and the photos are stored there. Mentra's SDK describes an on-device fallback for speech, which nobody on the team has tried.

A command only counts at the end of a sentence. "The next step is to whisk" is treated as explanation. "Whisk until it foams. Next step." saves the step. Wait until the glasses have stopped talking before you speak.

**Teach a lesson**

| Say | Or tap | What happens |
| --- | --- | --- |
| "Start teaching" | Start Recording | Recording starts. |
| (explain the step while you do it) | | Your words are saved for this step. |
| "Next step" | Save this step | The glasses take a photo of the finished step. |
| (keep working) | | A silent photo is taken when 20 seconds pass without one. |
| "Finish lesson" | Finish lesson | Claude writes a draft lesson. |
| "Publish lesson" | Publish to Library | The draft joins the lesson list. You can change its title and description on the phone first. |
| "Cancel lesson" | Discard | The recording or the draft is thrown away. |

**Learn a lesson**

| Say | Or tap | What happens |
| --- | --- | --- |
| "Start lesson" | Start Learning | The glasses say the title and step 1. By voice this starts the newest lesson. |
| "Check" or "I'm done" | Check my step | Photo, then a pass or one correction. A pass moves to the next step. |
| "Next step" | Next | Next step without a check. |
| "Go back" | Previous | One step back. |
| "Repeat" | Repeat | The step is read again. |
| "Why" | | The reason for this step. |
| "Any tips" | | Up to two tips for this step. |
| "What do I need" | | The tools and ingredients. |
| "Tinker, how hot should the water be?" | the question box | Claude answers a question about this step. The question must start with "Tinker". |
| "Stop lesson" | End Session | The lesson ends. |

"What can I say" lists the main commands of the moment. Every phrase that works is in `docs/HOW_IT_WORKS.md`.

**For a demo of photo checks, record a lesson first and then learn it.** A recorded lesson has the expert's photo of each step, and the check compares the learner's photo with it. The built-in lesson has no expert photos. In three tests against the real Claude API, its check called a correct drawing "fix" every time. Use the built-in lesson to show steps read aloud and questions.

**The button on the glasses**

| When | Short press | Long press |
| --- | --- | --- |
| Nothing is running | Start the newest lesson | Start teaching |
| Recording | Save the step | Finish the lesson |
| A draft is waiting | Publish it | Nothing |
| In a lesson | Check the step | Next step |

Mentra's source shows that presses reach the app, and that the Mentra App switches off the glasses' own photo-on-press while an app listens for presses. Nobody has tried it on glasses yet. Voice and the phone screen do not depend on the button.

**The light on the glasses** blinks twice after a check: green is a pass, red is a correction, orange means the photo did not show the work.

## Where things are

Changing the code? Start with `AGENTS.md`, then the `docs/` folder.

| File | What it does |
| --- | --- |
| `src/background/index.ts` | Connects the app to the glasses: photo, speech, microphone, button, light. Photo size and language are set at the top. |
| `src/background/coach.ts` | All the teach and learn logic, and everything the screen is told. |
| `src/background/commands.ts` | The spoken commands. Edit the lists to add or rename one. |
| `src/background/claude.ts` | The requests to Claude, the models and the prompts. |
| `src/background/seed.ts` | The built-in matcha lesson. |
| `src/shared/channels.ts` | The messages between the background and the screen. |
| `src/ui/` | The screens on the phone. See `docs/SCREENS.md`. |
| `miniapp.json` | App name, permissions (camera, microphone). |
| `docs/GLASSES_TEST.md` | The first test on real glasses, step by step. |

## Tests

```bash
bun run typecheck
bun run build
bun test
```

153 tests in four files. They run whole lessons against fake glasses and a fake Claude, draw the screens in a fake browser, and run the built app against a simulated phone.

Two more programs use the real Claude API with a real key: `scripts/real-claude-test.ts` (the Claude code alone) and `scripts/real-app-test.ts` (the whole app on a simulated phone). `docs/TESTING.md` explains every test and how to run both programs.

## Not tested yet

- **Real glasses.** Nobody has run this on a Mentra Live yet. `docs/GLASSES_TEST.md` has the steps for the first run.
- **The button on the glasses.** Mentra's source says presses reach the app. Not tried on glasses.
- **The app hearing itself.** The glasses' microphone can hear the glasses' speaker. The app ignores the microphone while it speaks and shortly after, and drops sentences that match what it just said. Whether the timing fits real glasses is not known.
- **The real Claude API from a phone.** `scripts/real-claude-test.ts` has run against the real API from a cloud machine, not from a phone. See `docs/TESTING.md`, section "Real Claude API test".
