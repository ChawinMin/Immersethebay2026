# TINKER — Learn by doing. Teach by showing.

> **AI-Powered Physical Skill Transfer for Mentra Live Smart Glasses**  
> Developed for the **Immerse the Bay Hackathon** at Stanford University.

---

## Overview

**Tinker** is an AI-powered platform that enables bilateral transfer of physical craftsmanship:
- **Teaching Mode:** A master practitioner records a point-of-view (POV) demonstration of a hands-on skill using Mentra Live smart glasses. Tinker's multimodal AI pipeline analyzes the visual and temporal flow, segments it into atomic procedural steps, and compiles a structured tutorial.
- **Learning Mode:** A beginner puts on the Mentra Live smart glasses and receives hands-free, step-by-step **audio guidance** from an AI assistant named **Tinker**.
- **Displayless Constraint:** Because Mentra Live glasses feature no heads-up display, visual overload is eliminated. Guidance is delivered purely through spatial audio, while the companion web app displays POV keyframes, progress, and a live conversation transcript.
- **Flagship Demonstration:** The traditional art of preparing **Ceremonial Matcha** using a bamboo *chashaku* scoop and *chasen* whisk.

---

## System Architecture

```
[Mentra Live Smart Glasses]
       │ (BLE Audio & 12MP Camera)
       ▼
[MentraOS Mobile Host]
       ├── Background Runtime (src/background/index.ts)  ─── session.camera, session.speaker, session.transcription
       │         │
       │         └── Typed Message Bus (src/shared/channels.ts)
       │                 │
       └── WebView Interface (src/ui/App.tsx)  ────────────── React 19, Matcha Design System (#FAF9F6, #668B5B)
                 │
                 ▼ (HTTP REST / WebSockets)
[Python FastAPI Backend] (backend/main.py)
       ├── Frame Ingestion & Session State
       ├── Tutorial Store (backend/data/tutorials)
       └── Claude 3.5 Sonnet Engine (Anthropic API)
                 ├── Multimodal Keyframe Analysis & Step Synthesis
                 └── Tinker Wearable Conversational Agent (Voice Q&A)
```

---

## Project Structure

```
├── my-miniapp/                   # Mentra MiniApp (Bun + React + TypeScript)
│   ├── miniapp.json              # Manifest (CAMERA & MICROPHONE permissions)
│   ├── build.ts                  # Bun dual-target bundler (Background IIFE + UI WebView)
│   └── src/
│       ├── background/index.ts   # Edge controller (Hardware bridge, camera loop, echo gating)
│       ├── shared/channels.ts    # Typed message bus between background and WebView
│       └── ui/
│           ├── App.tsx           # Companion interface (Learning & Teaching tabs)
│           ├── styles.css        # Minimalist matcha design system
│           └── Icons.tsx         # Lightweight inline SVG icon library
├── backend/                      # Python FastAPI Application
│   ├── main.py                   # REST endpoints & CORS configuration
│   ├── models/schemas.py         # Pydantic data models (Tutorial, Step, Chat)
│   ├── services/
│   │   ├── tutorial_store.py     # File-based JSON persistence engine
│   │   └── claude_service.py     # Anthropic Claude 3.5 Sonnet multimodal & chat prompts
│   └── data/tutorials/           # Stored tutorial JSON files (Ceremonial Matcha pre-seeded)
└── README.md
```

---

## Quickstart Guide

### 1. Start the FastAPI Backend

```bash
# From workspace root
python backend/main.py
```
*Backend runs on `http://127.0.0.1:8000` with interactive API docs at `http://127.0.0.1:8000/docs`.*

### 2. Build / Run the Mentra MiniApp

```bash
# Build the production bundles (dist/background and dist/ui)
bun my-miniapp/build.ts

# Launch the Mentra local dev server with QR sideload for Mentra Live glasses
cd my-miniapp
bun run dev
```

### 3. Open the Companion UI in Browser

The UI can be opened inside the Mentra phone app WebView or directly in any desktop/mobile browser:
- Open `my-miniapp/dist/ui/index.html` in your browser.

---

## Key Hardware & AI Features

1. **Deterministic Echo Suppression:**  
   Smart glasses microphones naturally pick up audio from open-ear temple speakers. Tinker's background controller tracks `isSpeaking` and `session.speaker.isPlaying` with a 500ms post-audio acoustic cooldown, completely eliminating self-transcription loops.
2. **Vocabulary Boosting:**  
   `session.transcription.configure({ vocabulary: ["matcha", "chawan", "chasen", "chashaku", "whisk", "sifter"] })` ensures Japanese culinary terminology is recognized with high fidelity.
3. **Hands-Free Temple Button:**  
   Pressing the capacitive temple button on the Mentra Live glasses immediately advances to the next instruction step without touching a phone.
4. **Offline Resilience:**  
   Pre-seeded with a comprehensive 6-step Ceremonial Matcha tutorial and context-aware fallback intelligence for guaranteed demonstration performance under poor venue Wi-Fi.
