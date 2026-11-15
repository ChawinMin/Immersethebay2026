# Tinker

One app. It runs inside the Mentra App on the phone and controls the Mentra Live glasses. There is no laptop server.

- **Teach:** an expert wears the glasses, does a task once and explains it. The glasses take a photo of each step. Claude turns the photos and the words into a lesson.
- **Learn:** a beginner wears the glasses. The glasses read out one step at a time. When the beginner says "check", the glasses take a photo and Claude says it is right or says what to fix.

## Install it on a phone

A laptop is needed for this part only.

1. Install Bun on the laptop: https://bun.sh
2. In this folder run `bun install`.
3. Put the phone and the laptop on the same Wi-Fi. An iPhone hotspot works.
4. Run `bun run release`. A QR code appears in the terminal.
5. On the phone open the Mentra App, go to **Settings > Miniapp Developer Settings > Scan Miniapp QR Code**, and scan it.

After step 5 the app is installed on the phone and the laptop can be closed.

While you are changing the code, use `bun run dev` instead of `bun run release`. It reloads the app on the phone every time you save, but the laptop has to stay on.

## Add the Claude key

Open Tinker on the phone, paste the Claude key into the box at the bottom, and tap **Save key**. The app sends one test request and tells you if the key works.

The key is saved on that phone only. It is not in this code and it must never be put in this code, because this repository is public. Delete the key in the Claude Console after the hackathon.

## Use it

The phone needs internet the whole time.

**Teach a lesson**

| Say | What happens |
| --- | --- |
| "Start teaching" | Recording starts. |
| (explain the step while you do it) | Your words are saved for this step. |
| "Next step" | The glasses take a photo of the finished step. |
| "Finish lesson" | Claude writes the lesson. It replaces the old lesson. |
| "Cancel lesson" | The recording is thrown away. |

A command only counts at the end of a sentence. "The next step is to whisk" is treated as explanation. "Whisk until it foams. Next step." saves the step.

**Learn a lesson**

| Say | What happens |
| --- | --- |
| "Start lesson" | The glasses read the materials and step 1. |
| "Check" or "I'm done" | Photo, then "pass" or one correction. A pass moves to the next step. |
| "Repeat" | The step is read again. |
| "Why" | The glasses tell the expert's story for this step. |
| "Skip step" | Next step without a check. |
| "Stop lesson" | The lesson ends. |

"What can I say" lists the commands at any time.

**Without speaking:** every command is also a button on the Tinker screen on the phone. The button on the glasses works too: a short press saves the step (teaching) or checks the step (learning), and a long press finishes the lesson (teaching) or repeats the step (learning).

**Light on the glasses:** green is a pass, red is a correction, orange means the photo was unclear.

## Where things are

Changing the code? Start with `AGENTS.md`, then the `docs/` folder. They explain how the app works and why each choice was made.


| File | What it does |
| --- | --- |
| `src/background/index.ts` | Connects the app to the glasses: photo, speech, microphone, button, light. Photo size and language are set at the top. |
| `src/background/coach.ts` | The teach and learn logic. |
| `src/background/claude.ts` | The two Claude requests and their prompts. |
| `src/background/commands.ts` | The spoken commands. Edit the lists to add or rename one. |
| `src/ui/App.tsx` | The screen on the phone. |
| `miniapp.json` | App name, permissions (camera, microphone). |

## Tests

```bash
bun test
```

- `test/coach.test.ts` runs whole lessons against fake glasses and a fake Claude.
- `test/phone.test.ts` runs the built app against a simulated phone.

## Not tested yet

- Real glasses. Nobody has run this on a Mentra Live yet.
- The real Claude API. The tests use a fake one. The first real check is the "Save key" button.
- The button on the glasses. The Mentra App may keep button presses for its own photo feature. Voice and the phone screen do not depend on it.
