"""
Tinker Backend — FastAPI Application
Provides REST endpoints and real-time state management for:
- Teaching session recording & frame ingestion
- Multimodal AI tutorial synthesis (Claude 3.5 Sonnet)
- Learning session guidance & Tinker conversational agent
- Tutorial library persistence
"""

import os
import sys
import time
from pathlib import Path
from typing import Dict, List

# Ensure backend root is in sys.path
backend_root = Path(__file__).resolve().parent
if str(backend_root) not in sys.path:
    sys.path.insert(0, str(backend_root))

try:
    from models.schemas import (
        TutorialModel,
        TutorialStepModel,
        FrameIngestRequest,
        SynthesizeRequest,
        ChatQueryRequest,
        ChatQueryResponse
    )
    from services.tutorial_store import tutorial_store
    from services.claude_service import claude_service
except ImportError:
    from backend.models.schemas import (
        TutorialModel,
        TutorialStepModel,
        FrameIngestRequest,
        SynthesizeRequest,
        ChatQueryRequest,
        ChatQueryResponse
    )
    from backend.services.tutorial_store import tutorial_store
    from backend.services.claude_service import claude_service

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

app = FastAPI(
    title="Tinker API",
    description="AI-powered teaching and learning platform for Mentra Live smart glasses",
    version="1.0.0"
)

# Enable CORS for phone MiniApp and companion web interface
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session buffers for teaching and learning
active_teaching_sessions: Dict[str, List[dict]] = {}
active_learning_sessions: Dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Health & Status
# ---------------------------------------------------------------------------
@app.get("/")
def get_root():
    return {
        "app": "Tinker API",
        "tagline": "Learn by doing. Teach by showing.",
        "status": "online",
        "ai_engine": "Claude 3.5 Sonnet",
        "hardware": "Mentra Live Smart Glasses"
    }

# ---------------------------------------------------------------------------
# Tutorial Library Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/tutorials", response_model=List[TutorialModel])
def get_tutorials():
    return tutorial_store.get_all()

@app.get("/api/tutorials/{tutorial_id}", response_model=TutorialModel)
def get_tutorial(tutorial_id: str):
    tut = tutorial_store.get_by_id(tutorial_id)
    if not tut:
        raise HTTPException(status_code=404, detail="Tutorial not found")
    return tut

@app.post("/api/tutorials", response_model=TutorialModel, status_code=status.HTTP_201_CREATED)
def create_tutorial(tutorial: TutorialModel):
    return tutorial_store.save(tutorial)

# ---------------------------------------------------------------------------
# Teaching Mode Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/teaching/sessions/{session_id}/frames")
def ingest_frame(session_id: str, frame: FrameIngestRequest):
    if session_id not in active_teaching_sessions:
        active_teaching_sessions[session_id] = []
    
    active_teaching_sessions[session_id].append({
        "photo_url": frame.photo_url,
        "timestamp": frame.timestamp,
        "frame_index": frame.frame_index
    })

    return {
        "status": "success",
        "session_id": session_id,
        "total_frames_buffered": len(active_teaching_sessions[session_id])
    }

@app.post("/api/teaching/sessions/{session_id}/synthesize")
async def synthesize_tutorial(session_id: str, req: SynthesizeRequest):
    frames = []
    if req.frames and len(req.frames) > 0:
        frames = req.frames
    elif session_id in active_teaching_sessions:
        frames = active_teaching_sessions[session_id]

    # Synthesize structured tutorial using Claude multimodal or heuristics
    tutorial = await claude_service.synthesize_tutorial_from_frames(
        frames=frames,
        title_hint=req.title_hint or "Demonstrated Skill Tutorial"
    )

    # Persist the newly generated tutorial
    tutorial_store.save(tutorial)

    # Clear teaching session buffer
    if session_id in active_teaching_sessions:
        del active_teaching_sessions[session_id]

    return {
        "status": "success",
        "session_id": session_id,
        "tutorial": tutorial
    }

# ---------------------------------------------------------------------------
# Learning Mode & Tinker Conversational Assistant
# ---------------------------------------------------------------------------
@app.post("/api/learning/sessions/start")
def start_learning_session(payload: dict):
    tutorial_id = payload.get("tutorial_id", "")
    tut = tutorial_store.get_by_id(tutorial_id)
    if not tut:
        raise HTTPException(status_code=404, detail="Tutorial not found")

    session_id = f"learn_{int(time.time())}"
    active_learning_sessions[session_id] = {
        "tutorial_id": tutorial_id,
        "current_step": 1,
        "started_at": time.time()
    }

    step1 = tut.steps[0] if tut.steps else None
    return {
        "session_id": session_id,
        "tutorial": tut,
        "current_step": 1,
        "step_data": step1,
        "instruction_spoken": step1.instruction_spoken if step1 else ""
    }

@app.post("/api/learning/sessions/{session_id}/step")
def update_step(session_id: str, payload: dict):
    sess = active_learning_sessions.get(session_id)
    action = payload.get("action", "next")

    if not sess:
        sess = {"current_step": 1, "tutorial_id": payload.get("tutorial_id", "tut_matcha_ceremonial_01")}
        active_learning_sessions[session_id] = sess

    tut = tutorial_store.get_by_id(sess["tutorial_id"])
    if not tut or not tut.steps:
        raise HTTPException(status_code=404, detail="Tutorial not found")

    current = sess["current_step"]
    if action == "next" and current < len(tut.steps):
        current += 1
    elif action == "previous" and current > 1:
        current -= 1

    sess["current_step"] = current
    step_data = tut.steps[current - 1]

    return {
        "session_id": session_id,
        "current_step": current,
        "total_steps": len(tut.steps),
        "step_data": step_data,
        "instruction_spoken": step_data.instruction_spoken
    }

@app.post("/api/learning/sessions/{session_id}/chat", response_model=ChatQueryResponse)
def ask_tinker(session_id: str, req: ChatQueryRequest):
    tutorial = None
    if req.tutorial_id:
        tutorial = tutorial_store.get_by_id(req.tutorial_id)
    elif session_id in active_learning_sessions:
        tutorial = tutorial_store.get_by_id(active_learning_sessions[session_id]["tutorial_id"])

    # If no tutorial found, fallback to default matcha tutorial
    if not tutorial:
        tutorial = tutorial_store.get_by_id("tut_matcha_ceremonial_01")

    # Generate patient, spoken advice for smart glasses audio
    reply_text = claude_service.generate_tinker_response(
        query=req.query,
        step=req.step,
        tutorial=tutorial
    )

    return ChatQueryResponse(
        reply_text=reply_text,
        step=req.step,
        source="tinker-claude"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
