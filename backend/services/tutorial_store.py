import json
import os
import sys
from pathlib import Path
from typing import List, Optional

# Ensure backend root is in sys.path
backend_root = Path(__file__).resolve().parent.parent
if str(backend_root) not in sys.path:
    sys.path.insert(0, str(backend_root))

try:
    from models.schemas import TutorialModel, TutorialStepModel
except ImportError:
    from backend.models.schemas import TutorialModel, TutorialStepModel

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "tutorials"

DEFAULT_MATCHA: dict = {
    "id": "tut_matcha_ceremonial_01",
    "title": "How to Make Matcha: Traditional Ceremonial Method",
    "description": "Master the peaceful art of Japanese matcha preparation. Learn proper chashaku measuring, temperature management, and the brisk W-whisking technique for a thick jade micro-foam.",
    "category": "Culinary Arts",
    "total_steps": 6,
    "estimated_duration_minutes": 5,
    "created_at": "2026-11-14T15:00:00Z",
    "status": "published",
    "tools_required": ["Chawan (Tea Bowl)", "Chasen (100-prong Bamboo Whisk)", "Chashaku (Bamboo Scoop)", "Fine Mesh Sifter"],
    "ingredients_required": ["Ceremonial Grade Matcha (2g)", "Filtered Hot Water at 80°C / 175°F (70ml)"],
    "steps": [
        {
            "id": "step_01",
            "step_number": 1,
            "title": "Warm the Chawan & Condition Whisk",
            "instruction_spoken": "Pour hot water into your tea bowl to warm the ceramic, and briefly rest the tips of your bamboo whisk in the warm water to soften the tines.",
            "instruction_detailed": "Pre-warming the chawan prevents rapid cooling during whisking. Conditioning the chasen prevents brittle bamboo tines from snapping.",
            "source_timestamp_seconds": 10.0,
            "tips": ["Swirl the water gently, then empty the bowl and wipe it completely dry with a clean cloth before continuing."]
        },
        {
            "id": "step_02",
            "step_number": 2,
            "title": "Sift the Matcha Powder",
            "instruction_spoken": "Place your fine-mesh sifter over the dry bowl and use the bamboo chashaku scoop to measure two rounded scoops of matcha powder.",
            "instruction_detailed": "Matcha is ultra-fine stone-ground green tea and naturally clumps due to static. Sifting is essential for a smooth, lump-free beverage.",
            "source_timestamp_seconds": 28.0,
            "tips": ["Two curved scoops of the chashaku equal approximately 2 grams (1 teaspoon) of matcha."]
        },
        {
            "id": "step_03",
            "step_number": 3,
            "title": "Add 80°C (175°F) Water",
            "instruction_spoken": "Pour about 70 milliliters of hot water over the sifted matcha. Ensure the water is around 80 degrees Celsius, not boiling.",
            "instruction_detailed": "Boiling water (100°C) will scorch the delicate tea leaves and release bitter tannins, ruining the sweet umami flavor.",
            "source_timestamp_seconds": 46.0,
            "tips": ["If you boiled your kettle, let it sit with the lid open for 2 minutes to drop down to 80°C."]
        },
        {
            "id": "step_04",
            "step_number": 4,
            "title": "The Rapid W-Whisking Motion",
            "instruction_spoken": "Hold the whisk upright with your fingers relaxed. Whisk vigorously back and forth in a rapid W motion from your wrist, keeping the whisk off the bottom.",
            "instruction_detailed": "Do not stir in a circular motion. The rapid back-and-forth agitation incorporates micro air bubbles into the liquid.",
            "source_timestamp_seconds": 64.0,
            "tips": ["Keep your elbow stationary and isolate the movement entirely to your wrist for maximum speed."]
        },
        {
            "id": "step_05",
            "step_number": 5,
            "title": "Break Large Bubbles & Finish Surface",
            "instruction_spoken": "Once a rich jade foam covers the surface, slow your whisking down and gently trace across the top to pop any large remaining bubbles.",
            "instruction_detailed": "A perfect ceremonial cup features a dense, velvet-like micro-foam resembling espresso crema.",
            "source_timestamp_seconds": 82.0,
            "tips": ["Slowly lift the whisk straight out from the center of the bowl to leave a neat mound of foam."]
        },
        {
            "id": "step_06",
            "step_number": 6,
            "title": "Hold Chawan with Both Hands and Savor",
            "instruction_spoken": "Lift the chawan with both hands, placing your right hand on the side and resting the base in your left palm. Enjoy your fresh ceremonial matcha.",
            "instruction_detailed": "Traditional appreciation emphasizes gratitude, warmth in the hands, and enjoying the vibrant aroma before the first sip.",
            "source_timestamp_seconds": 96.0,
            "tips": ["Drink while warm within 3 minutes before the suspended matcha solids settle to the bottom."]
        }
    ]
}

class TutorialStore:
    def __init__(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._ensure_default_tutorial()

    def _ensure_default_tutorial(self):
        default_file = DATA_DIR / "tut_matcha_ceremonial_01.json"
        if not default_file.exists():
            with open(default_file, "w", encoding="utf-8") as f:
                json.dump(DEFAULT_MATCHA, f, indent=2)

    def get_all(self) -> List[TutorialModel]:
        tutorials = []
        for file_path in DATA_DIR.glob("*.json"):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    tutorials.append(TutorialModel(**data))
            except Exception as e:
                print(f"Error loading tutorial {file_path}: {e}")
        # Sort by creation timestamp descending
        tutorials.sort(key=lambda t: t.created_at, reverse=True)
        return tutorials

    def get_by_id(self, tutorial_id: str) -> Optional[TutorialModel]:
        file_path = DATA_DIR / f"{tutorial_id}.json"
        if not file_path.exists():
            return None
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return TutorialModel(**data)
        except Exception as e:
            print(f"Error reading tutorial {tutorial_id}: {e}")
            return None

    def save(self, tutorial: TutorialModel) -> TutorialModel:
        if not tutorial.total_steps:
            tutorial.total_steps = len(tutorial.steps)
        file_path = DATA_DIR / f"{tutorial.id}.json"
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(tutorial.model_dump(), f, indent=2)
        return tutorial

tutorial_store = TutorialStore()
