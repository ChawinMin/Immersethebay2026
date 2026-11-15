from typing import Optional, List
from pydantic import BaseModel, Field

class TutorialStepModel(BaseModel):
    id: str
    step_number: int
    title: str
    instruction_spoken: str
    instruction_detailed: str
    reference_image_url: Optional[str] = None
    source_timestamp_seconds: Optional[float] = 0.0
    tips: Optional[List[str]] = Field(default_factory=list)

class TutorialModel(BaseModel):
    id: str
    title: str
    description: str
    category: Optional[str] = "Culinary Arts"
    total_steps: int = 0
    estimated_duration_minutes: int = 5
    created_at: str
    status: str = "published"
    tools_required: Optional[List[str]] = Field(default_factory=list)
    ingredients_required: Optional[List[str]] = Field(default_factory=list)
    steps: List[TutorialStepModel] = Field(default_factory=list)

class FrameData(BaseModel):
    photo_url: str
    timestamp: float
    frame_index: int

class FrameIngestRequest(BaseModel):
    photo_url: str
    timestamp: float
    frame_index: int

class SynthesizeRequest(BaseModel):
    title_hint: Optional[str] = "Physical Skill Demonstration"
    description_hint: Optional[str] = ""
    frames: Optional[List[FrameData]] = Field(default_factory=list)

class ChatQueryRequest(BaseModel):
    query: str
    step: int = 1
    tutorial_id: Optional[str] = None

class ChatQueryResponse(BaseModel):
    reply_text: str
    step: int
    source: str = "tinker-claude"
