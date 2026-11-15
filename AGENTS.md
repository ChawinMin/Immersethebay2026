# Tinker: guide for AI agents and new teammates

This repository is the team's entry for **Immerse the Bay 2026**, the Stanford XR hackathon.

## The project in four lines

- **Hardware:** Mentra Live smart glasses (camera, microphone, speaker, button, light, no screen).
- **Idea:** an expert shows a task once, and the glasses then teach it to a beginner. Experts teach the AI, and the AI teaches other people when the expert is not there. The demo task is making matcha. The wider aim is keeping crafts, culture and history from being lost.
- **Track:** ManageXR smart glasses track. Its brief: build an experience where AI sees what you see and helps you do something real. It is judged on glasses-native design, responsive AI, and whether people would use it again.
- **Also aiming at:** AI Horizons (technical depth) and Virtuous Reality (social impact).

## Where the code is

Everything is in **`miniapp/`**. It is one Mentra miniapp that runs on the phone. Start with `miniapp/AGENTS.md`.

There is no server. An earlier laptop server (`backend/showonce-server.ts`) was removed when the app became phone only. To read it: `git show e7733ef:backend/showonce-server.ts`. The reasons are in `miniapp/docs/DECISIONS.md`.

## Rules for the whole repository

1. **Never commit a Claude key or any other secret.** This repository is public. The `.gitignore` at the root comes from a Unity template and does not ignore `.env`. `miniapp/.gitignore` does.
2. Before committing a change in `miniapp/`, run `bun run typecheck`, `bun run build` and `bun test` there.
3. Do not write that something works on the glasses unless it was run on the glasses. `miniapp/AGENTS.md` has a status table. Keep it true.
