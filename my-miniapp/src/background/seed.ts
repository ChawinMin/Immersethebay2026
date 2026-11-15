/**
 * seed.ts: the lesson that ships inside the app.
 *
 * WHY IT EXISTS
 *   A new install has an empty library. This ready-made matcha lesson means
 *   the Learning tab works the first time the app is opened, before anyone
 *   has recorded anything. It also needs no Claude key to be read aloud.
 *
 * WHERE IT CAME FROM
 *   The text was written by the team for the earlier Python server
 *   (backend/data/tutorials/tut_matcha_ceremonial_01.json on the main branch
 *   at commit 14def27). It is copied here unchanged.
 *
 * WHAT WAS ADDED TO IT
 *   Two fields on every step, because the photo check needs them:
 *     done_looks_like   what the glasses camera sees when the step is finished
 *     common_mistake    the most likely beginner error
 *   Both were written for this file during the merge, by an AI coding
 *   assistant, from that step's own text. The app does not generate them, and
 *   a person on the team should read them once. No step has a `story`: nobody
 *   told one. test/claude.test.ts checks that every field of the team's JSON
 *   file is still the same here.
 *
 * IT IS NOT AN AI RESULT
 *   Nothing in the app presents this lesson as something Claude built from a
 *   recording. It is marked `built_in`, the library shows it as built in, and
 *   it cannot be deleted.
 */

import type {TutorialModel} from "../shared/channels"

export const BUILT_IN_TUTORIALS: TutorialModel[] = [
  {
    "id": "tut_matcha_ceremonial_01",
    "title": "How to Make Matcha: Traditional Ceremonial Method",
    "description": "Master the peaceful art of Japanese matcha preparation. Learn proper chashaku measuring, temperature management, and the brisk W-whisking technique for a thick jade micro-foam.",
    "category": "Culinary Arts",
    "total_steps": 6,
    "estimated_duration_minutes": 5,
    "created_at": "2026-11-14T15:00:00Z",
    "status": "published",
    "tools_required": [
      "Chawan (Tea Bowl)",
      "Chasen (100-prong Bamboo Whisk)",
      "Chashaku (Bamboo Scoop)",
      "Fine Mesh Sifter"
    ],
    "ingredients_required": [
      "Ceremonial Grade Matcha (4g)",
      "Filtered Hot Water at 80°C / 175°F (70ml)"
    ],
    "steps": [
      {
        "id": "step_01",
        "step_number": 1,
        "title": "Warm the Chawan & Condition Whisk",
        "instruction_spoken": "Pour hot water into your tea bowl to warm the ceramic, and briefly rest the tips of your bamboo whisk in the warm water to soften the tines.",
        "instruction_detailed": "Pre-warming the chawan prevents rapid cooling during whisking. Conditioning the chasen prevents brittle bamboo tines from snapping.",
        "source_timestamp_seconds": 10.0,
        "tips": [
          "Swirl the water gently, then empty the bowl and wipe it completely dry with a clean cloth before continuing."
        ],
        "done_looks_like": "The tea bowl holds water with the bamboo whisk tips resting in it, or the bowl is already emptied and wiped dry.",
        "common_mistake": "Skipping the whisk soak, so the brittle bamboo tines can snap."
      },
      {
        "id": "step_02",
        "step_number": 2,
        "title": "Sift the Matcha Powder",
        "instruction_spoken": "Place your fine-mesh sifter over the dry bowl and use the bamboo chashaku scoop to measure two rounded scoops of matcha powder.",
        "instruction_detailed": "Matcha is ultra-fine stone-ground green tea and naturally clumps due to static. Sifting is essential for a smooth, lump-free beverage.",
        "source_timestamp_seconds": 28.0,
        "tips": [
          "Two curved scoops of the chashaku equal approximately 2 grams (1 teaspoon) of matcha."
        ],
        "done_looks_like": "Fine green matcha powder lies sifted in the dry bowl with no clumps. The sifter may still sit over the bowl.",
        "common_mistake": "Scooping the powder straight into the bowl without sifting, which leaves clumps."
      },
      {
        "id": "step_03",
        "step_number": 3,
        "title": "Add 80°C (175°F) Water",
        "instruction_spoken": "Pour about 70 milliliters of hot water over the sifted matcha. Ensure the water is around 80 degrees Celsius, not boiling.",
        "instruction_detailed": "Boiling water (100°C) will scorch the delicate tea leaves and release bitter tannins, ruining the sweet umami flavor.",
        "source_timestamp_seconds": 46.0,
        "tips": [
          "If you boiled your kettle, let it sit with the lid open for 2 minutes to drop down to 80°C."
        ],
        "done_looks_like": "A shallow pool of water covers the matcha powder in the bowl. The bowl is far from full.",
        "common_mistake": "Pouring boiling water, which scorches the tea and makes it bitter."
      },
      {
        "id": "step_04",
        "step_number": 4,
        "title": "The Rapid W-Whisking Motion",
        "instruction_spoken": "Hold the whisk upright with your fingers relaxed. Whisk vigorously back and forth in a rapid W motion from your wrist, keeping the whisk off the bottom.",
        "instruction_detailed": "Do not stir in a circular motion. The rapid back-and-forth agitation incorporates micro air bubbles into the liquid.",
        "source_timestamp_seconds": 64.0,
        "tips": [
          "Keep your elbow stationary and isolate the movement entirely to your wrist for maximum speed."
        ],
        "done_looks_like": "The green liquid in the bowl is frothy, with small bubbles across the surface. The whisk, if in view, is held upright.",
        "common_mistake": "Stirring in circles instead of whisking back and forth in a W."
      },
      {
        "id": "step_05",
        "step_number": 5,
        "title": "Break Large Bubbles & Finish Surface",
        "instruction_spoken": "Once a rich jade foam covers the surface, slow your whisking down and gently trace across the top to pop any large remaining bubbles.",
        "instruction_detailed": "A perfect ceremonial cup features a dense, velvet-like micro-foam resembling espresso crema.",
        "source_timestamp_seconds": 82.0,
        "tips": [
          "Slowly lift the whisk straight out from the center of the bowl to leave a neat mound of foam."
        ],
        "done_looks_like": "Dense jade-green foam covers the whole surface of the tea, with only tiny bubbles and no large ones.",
        "common_mistake": "Leaving large bubbles on top instead of gently popping them with the whisk."
      },
      {
        "id": "step_06",
        "step_number": 6,
        "title": "Hold Chawan with Both Hands and Savor",
        "instruction_spoken": "Lift the chawan with both hands, placing your right hand on the side and resting the base in your left palm. Enjoy your fresh ceremonial matcha.",
        "instruction_detailed": "Traditional appreciation emphasizes gratitude, warmth in the hands, and enjoying the vibrant aroma before the first sip.",
        "source_timestamp_seconds": 96.0,
        "tips": [
          "Drink while warm within 3 minutes before the suspended matcha solids settle to the bottom."
        ],
        "done_looks_like": "Both hands hold the tea bowl: the right hand on its side and the left palm under its base.",
        "common_mistake": "Holding the bowl one-handed, with no palm under the base."
      }
    ],
    "built_in": true
  }
]
