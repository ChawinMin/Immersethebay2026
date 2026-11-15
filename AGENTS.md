# Tinker: start here

This file is for AI agents and new teammates. It covers the whole repository.

## The project

Tinker is a hackathon project for Immerse the Bay 2026 at Stanford.

- **Hardware:** Mentra Live smart glasses. They have a camera, a microphone, a speaker, one button and a light. They have no display.
- **Idea:** an expert shows a hands-on task once while wearing the glasses. The glasses then teach it to a beginner by voice and check the beginner's work from a photo, using Claude. The demo task is making matcha.
- **Track:** the ManageXR smart glasses track. Its brief: "build an experience where AI sees what you see and helps you do something real". It is judged on glasses-native design, on responsive AI, and on whether people would use it again. The team is also aiming at the AI Horizons and Virtuous Reality tracks.

What that means for the work: everything the learner needs must come through the ear, answers must come fast, and nothing shown to a judge may be faked.

## Where the code is

All of it is in `my-miniapp/`. It is one Mentra miniapp that runs on the phone inside the Mentra App. There is no server of our own. The phone calls the Claude API directly. Speech-to-text, the voice and photo storage are Mentra's services, reached through the Mentra App.

`README.md` in this folder is the project page for people.

## Repository rules

1. **Never commit a key.** This repository is public. The Claude key is pasted into the app on the phone. Tests use fake keys that look like `sk-ant-test-...`.
2. **Run the three checks before committing.** In `my-miniapp/`: `bun run typecheck`, `bun run build`, `bun test`. All must pass.
3. **Never write that something works on the glasses unless it was run on the glasses.** Keep "checked" and "not checked" apart in every doc. The status table in `my-miniapp/AGENTS.md` says what has been run where.

## Next

Read `my-miniapp/AGENTS.md`. It has the status, the rules for the code, and the order in which to read the docs.
