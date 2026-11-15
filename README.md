# TINKER: Learn by doing. Teach by showing.

> **AI-Powered Physical Skill Transfer for Mentra Live Smart Glasses**  
> Developed for the **Immerse the Bay Hackathon** at Stanford University.

---

## Overview

**Tinker** passes a hands-on skill from an expert to a beginner through a pair of Mentra Live smart glasses. The glasses have a camera, a microphone, a speaker, one button and a light. They have no display.

- **Teaching Mode:** An expert wears the glasses, does the task once and explains it out loud. Saying "next step" takes a photo of the finished step, and a silent photo is taken every 20 seconds in between. Claude turns the photos and the words into a lesson with numbered steps. The expert reviews the draft on the phone and publishes it.
- **Learning Mode:** A beginner wears the glasses and hears one step at a time from an assistant named **Tinker**. Saying "check" takes a photo of the work, and Claude answers with a pass or with the one thing to fix. Saying "Tinker, ..." asks a question about the current step.
- **No Display:** All guidance is spoken. The companion screen on the phone shows the lesson library, the current step, the last photo check and a transcript of the conversation.
- **Flagship Demonstration:** preparing **Ceremonial Matcha** with a bamboo *chashaku* scoop and a *chasen* whisk. That lesson ships inside the app.

---

## System Architecture

Tinker is one Mentra miniapp. It runs on the phone, inside the Mentra App. **There is no server of our own.** The phone calls the Claude API directly, with a key that is pasted into the app once.

```
[Mentra Live glasses]     camera, microphone, speaker, button, light
        ^
        |   the Mentra App connects the phone to the glasses
        v
[Phone: Mentra App]  <---------->  [Mentra's cloud]   speech-to-text, the voice, photo storage
   |
   +-- Tinker miniapp (my-miniapp/)
         |
         +-- Background  (src/background/)   runs the whole time the miniapp is on
         |      index.ts    the only file that talks to the glasses (session.*)
         |      coach.ts    all behaviour: teaching, learning, spoken commands
         |      claude.ts   the requests to Claude ------ HTTPS ------> [Claude API]
         |
         |   typed messages (src/shared/channels.ts)
         |
         +-- Screen      (src/ui/)           React page, open only while you look at it
```

The two layers of a miniapp share no memory. The background holds all the state and keeps running with the phone screen off. The screen shows what the background tells it.

Speech-to-text, the voice and the storage of photos are Mentra's own services, reached through the Mentra App. In Mentra's source they need the phone to be online and signed in to Mentra's cloud. That was read, not tried on glasses.

History: an earlier version of this README described a Python FastAPI backend. The phone app could never reach it, so it was removed on 2026-11-14 and its useful parts were moved into the miniapp. `my-miniapp/docs/DECISIONS.md` has the history. To read the old server: `git show 14def27:backend/main.py`.

---

## Project Structure

```
AGENTS.md                      Entry point for AI agents and new teammates
README.md                      This file
my-miniapp/                    The Mentra miniapp (Bun + React + TypeScript)
    AGENTS.md                  Rules, status and where to change things
    README.md                  Install, add the key, use it
    CLAUDE.md                  One line that points at AGENTS.md
    docs/
        HOW_IT_WORKS.md        Every file, command, limit and request
        DECISIONS.md           Why each choice was made, and the open questions
        TESTING.md             The automated tests, and the tests against the real Claude API
        GLASSES_TEST.md        The first test on real glasses, step by step
        SCREENS.md             How the phone screens get their data
    miniapp.json               Manifest (camera and microphone required)
    package.json, bun.lock     Dependencies, pinned to Mentra SDK 3.4.0
    tsconfig.json              TypeScript settings
    build.ts                   Mentra's build script (background bundle + screen bundle)
    icon.png                   The app icon
    src/
        shared/channels.ts     Every message between the background and the screen
        background/
            index.ts           Glasses calls: photo, speech, microphone, button, light, storage
            coach.ts           The teach and learn logic
            commands.ts        The spoken commands
            claude.ts          The requests to Claude, the models and the prompts
            seed.ts            The built-in matcha lesson
            contracts.ts       The two interfaces that let the logic run in tests
        ui/
            App.tsx            Header, status pills, the Learning and Teaching tabs
            Learning.tsx       Lesson library and the lesson in progress
            Teaching.tsx       Record, review, publish
            Settings.tsx       Claude key box, sound test
            state.ts           Turns background messages into what the screen draws
            Parts.tsx, Icons.tsx, styles.css, main.tsx, index.html
    test/                      153 automated tests in four files, and the team's original matcha lesson file
    scripts/                   Two programs that test against the real Claude API, and their test pictures
```

---

## Quickstart Guide

You need a laptop with [Bun](https://bun.sh), a phone with the Mentra App (version 1.42.0 or newer), and Mentra Live glasses paired with that app.

### 1. Put the miniapp on the phone

```bash
cd my-miniapp
bun install

bun run dev        # while changing code: reloads on the phone at every save, the laptop must stay on
# or
bun run release    # a fixed copy that keeps working after the laptop is closed
```

Both commands print a QR code. Put the phone on the same Wi-Fi as the laptop. In the Mentra App go to **Settings > Miniapp Developer Settings > Scan Miniapp QR Code** and scan it.

### 2. Add the Claude key

Open Tinker on the phone. In the **Settings** card under the lesson list, paste the Claude key and tap **Save key**. The app tests the key with one small request and saves it on that phone.

The key is never written into this repository. The repository is public.

### 3. Try it

- Tap **Start Learning** on the matcha lesson, or say "start lesson". Say "check" when a step is done.
- Open the **Teaching** tab and tap **Start Recording**, or say "start teaching", to record a lesson of your own.

For a demo of photo checks, record a lesson first and then learn it. A recorded lesson has the expert's photo for each step, and the check compares the learner's photo with it. The built-in lesson has no expert photos, and in tests against the real Claude API its checks were strict (see Status).

`my-miniapp/README.md` lists what to say and what the glasses button does.

The screen only works inside the Mentra App. It needs the `mentra` object that the Mentra App adds to the page, so the built page does not work in a desktop browser.

### For developers

```bash
cd my-miniapp
bun run typecheck
bun run build
bun test
```

All three must pass before a commit. Start reading at `AGENTS.md`.

---

## Key Hardware & AI Features

1. **A lesson from one demonstration.**  
   Claude gets the expert's words and up to 12 photos, and writes the steps. For each step it also writes what a photo of the finished step should show. Nothing is made up when Claude fails: the app says that the lesson could not be built and keeps the recording for another try.
2. **Photo checks.**  
   On "check" the glasses take a photo. Claude judges it against the step's description, and against the expert's photo of that step when there is one. It answers pass, fix or unclear. The answer is spoken, and the light on the glasses blinks green, red or orange.
3. **Questions by name.**  
   During a lesson, a sentence that starts with "Tinker" is a question for Claude. Other speech is ignored on purpose, so that a loud room does not set the app off.
4. **Not listening to itself.**  
   The glasses' microphone can hear the glasses' speaker. Tinker ignores the microphone while it speaks and for a short gap after. It also drops heard sentences that match what it just said, and none of its own sentences ends in a command. This is tested in simulation. It has not been tried on glasses.
5. **Vocabulary hints.**  
   The app sends speech recognition a list of words to expect: "Tinker", "matcha", "chawan", "chasen", "chashaku", "whisk", "sifter", "froth", and the words of the lesson being learned. In the Mentra App source that the team's review read, the phone ignores this list for now. Do not count on it.
6. **The button on the glasses.**  
   A short press is the main action of the moment and a long press is the second one. In a lesson: short checks the step, long moves to the next step. While recording: short saves the step, long finishes the lesson. With a draft waiting: short publishes it. With nothing running: short starts the newest lesson, long starts teaching. Mentra's source shows that presses reach the app, and that the Mentra App switches off the glasses' own photo-on-press while an app listens for presses. Not yet tried on glasses.
7. **A built-in lesson, and what needs the network.**  
   The app ships with a 6-step Ceremonial Matcha lesson. It can be read aloud without a Claude key. Photo checks, questions and building a lesson need the key and internet. Speech recognition and the voice use Mentra's cloud first, and photos are stored there. Plan for the phone to be online and signed in to Mentra for the whole demo.

Photos are requested from the glasses at medium size. Without Wi-Fi on the glasses, Mentra's source says a photo travels over Bluetooth at about 640 x 640 pixels, so put the glasses on Wi-Fi for the demo (a phone hotspot works). Lessons are saved on the phone that recorded them and are not shared between phones.

---

## Status

Checked on 2026-11-14, on a computer, not on glasses:

- The type-check and Mentra's build pass.
- 153 automated tests pass. They run whole lessons against fake glasses and a fake Claude, draw the screens in a fake browser, and run the built app against a simulated phone.
- The real Claude API: `my-miniapp/scripts/real-claude-test.ts` sends the app's own requests to Claude with a real key. It ran three times from a cloud machine, not from a phone. The first run passed 8 of 9 checks: the praise for a correct step was 14 words, over the test's limit of 12, while the verdict was right. The prompt was tightened, and the next two runs passed all 9. Building a lesson took 6 to 7.5 seconds, a photo check 1 to 3 seconds, an answer about 1 second. `my-miniapp/docs/TESTING.md`, section "Real Claude API test", has the details and a second program that runs the whole app against the real Claude API.

Never run on real glasses:

- photos, speech, the microphone and the light,
- the button,
- whether the app hears itself,
- how long a check takes on a phone.

`my-miniapp/docs/GLASSES_TEST.md` walks through the first test on real glasses. `my-miniapp/docs/DECISIONS.md` ends with the list of open questions.

Two things for the team:

- The built-in lesson's "what finished looks like" lines were written by an AI coding assistant from each step's text. A person should read them in `my-miniapp/src/background/seed.ts`.
- With only those lines to go on, the photo check was strict. In all three runs it called a correct drawing of sifted matcha "fix" on the built-in lesson. On a lesson that Claude had built from the expert's pictures, the same kind of drawing passed. Record a lesson for the demo.
