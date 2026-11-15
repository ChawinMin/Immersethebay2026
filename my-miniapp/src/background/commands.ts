/**
 * commands.ts: the spoken commands. No Mentra code in here.
 *
 * WHAT THIS FILE IS
 *   The word lists that turn a finished sentence into a command, and the rule
 *   for where in the sentence a command may stand.
 *
 * THE RULE: A COMMAND COUNTS ONLY AT THE END OF A SENTENCE
 *   "...whisk until it foams. Next step."   is the command "capture"
 *   "The next step is to whisk."            is narration, not a command
 *   An expert explains while working, and command words come up in normal talk.
 *   Looking only at the end keeps the explanation from triggering commands.
 *
 * THE ONE EXCEPTION: QUESTIONS START WITH THE NAME
 *   While a lesson is being learned, a sentence that STARTS with "Tinker",
 *   "hey Tinker", "ok Tinker" or "okay Tinker" is a question for Claude.
 *   Speech without the name that is not a command is ignored. That is on
 *   purpose: the demo happens in a loud hall, and answering every overheard
 *   sentence would be chaos.
 *
 * To add or rename a command, edit the lists below. The Coach (coach.ts)
 * decides what each command does.
 */

/**
 * What the app is doing right now.
 *   idle         nothing
 *   recording    an expert is showing a task                  (teaching side)
 *   processing   Claude is writing the lesson                 (teaching side)
 *   review       a draft lesson is waiting to be published    (teaching side)
 *   learning     a beginner is being coached through a lesson
 */
export type Mode = "idle" | "recording" | "processing" | "review" | "learning"

/**
 * Everything a person can ask the app to do. Most commands can be spoken,
 * pressed on the glasses, or tapped on the phone. "audio" (the sound test)
 * exists only as a button on the phone screen, so it is in no list below.
 */
export type Command =
  | "teach"
  | "capture"
  | "finish"
  | "discard"
  | "publish"
  | "learn"
  | "check"
  | "next"
  | "previous"
  | "repeat"
  | "story"
  | "tips"
  | "materials"
  | "stop"
  | "ask"
  | "help"
  | "audio"

/** What `parseCommand` found in a sentence. */
export type Parsed =
  | {
      command: Exclude<Command, "ask">
      /** What the person said ahead of the command, in their own words. */
      before: string
    }
  | {
      command: "ask"
      /** Not used for questions. Always "". */
      before: string
      /** The sentence without the name in front. "" when the person said only the name. */
      question: string
    }

interface Phrase {
  command: Exclude<Command, "ask">
  words: string
  /** True: the phrase must be the whole sentence. Used for short words that come up in normal talk. */
  alone?: boolean
}

// One list per mode. A phrase only works in its own mode, so "next step"
// saves a step while recording and moves to the next step while learning.
// Write phrases in lower case with no punctuation and no apostrophes ("im done"),
// because that is the form `normalize` turns speech into before comparing.
const HELP: Phrase = {command: "help", words: "what can i say"}

const IDLE: Phrase[] = [
  {command: "teach", words: "start teaching"},
  {command: "teach", words: "teaching mode"},
  {command: "teach", words: "record a lesson"},
  {command: "learn", words: "start lesson"},
  {command: "learn", words: "start the lesson"},
  {command: "learn", words: "begin lesson"},
  {command: "learn", words: "coach me"},
  HELP,
]

const RECORDING: Phrase[] = [
  {command: "capture", words: "next step"},
  {command: "capture", words: "save step"},
  {command: "capture", words: "save this step"},
  {command: "finish", words: "finish lesson"},
  {command: "finish", words: "finish the lesson"},
  {command: "finish", words: "stop recording"},
  {command: "finish", words: "end lesson"},
  {command: "finish", words: "end the lesson"},
  {command: "discard", words: "cancel lesson"},
  {command: "discard", words: "cancel the lesson"},
  {command: "discard", words: "discard lesson"},
  HELP,
]

const REVIEW: Phrase[] = [
  {command: "publish", words: "publish lesson"},
  {command: "publish", words: "save lesson"},
  {command: "publish", words: "save the lesson"},
  {command: "discard", words: "cancel lesson"},
  {command: "discard", words: "cancel the lesson"},
  {command: "discard", words: "discard lesson"},
  HELP,
]

const LEARNING: Phrase[] = [
  {command: "check", words: "check"},
  {command: "check", words: "check it"},
  {command: "check", words: "check this"},
  {command: "check", words: "check my work"},
  {command: "check", words: "check my step"},
  {command: "check", words: "im done"},
  {command: "check", words: "i am done"},
  {command: "check", words: "done"},
  {command: "check", words: "finished"},
  {command: "check", words: "how does this look"},
  {command: "check", words: "is this right"},
  {command: "next", words: "next step"},
  {command: "next", words: "skip step"},
  {command: "next", words: "skip this step"},
  {command: "next", words: "next", alone: true},
  {command: "next", words: "skip", alone: true},
  {command: "previous", words: "previous step"},
  {command: "previous", words: "go back"},
  {command: "repeat", words: "repeat"},
  {command: "repeat", words: "repeat that"},
  {command: "repeat", words: "say that again"},
  {command: "repeat", words: "say it again"},
  {command: "story", words: "why this step"},
  {command: "story", words: "tell me why"},
  {command: "story", words: "tell me the story"},
  {command: "story", words: "why", alone: true},
  {command: "tips", words: "any tips"},
  {command: "tips", words: "give me a tip"},
  {command: "tips", words: "tip", alone: true},
  {command: "tips", words: "tips", alone: true},
  {command: "materials", words: "what do i need"},
  {command: "stop", words: "stop lesson"},
  {command: "stop", words: "stop the lesson"},
  {command: "stop", words: "end lesson"},
  HELP,
]

const BY_MODE: Record<Mode, Phrase[]> = {
  idle: IDLE,
  recording: RECORDING,
  // While Claude writes the lesson nothing else can run. The help phrase is
  // listed only so that "what can i say" is a known phrase in every mode.
  processing: [HELP],
  review: REVIEW,
  learning: LEARNING,
}

// The name that starts a question. Longest first, so "hey tinker" is cut off whole.
const WAKE_WORDS = ["okay tinker", "hey tinker", "ok tinker", "tinker"]

/** Lower case, no punctuation, single spaces. "I'm done." becomes "im done". */
export function normalize(spoken: string): string {
  return spoken
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * A pattern that finds normalized words inside the ORIGINAL sentence: any
 * capitals, any punctuation between the words, apostrophes inside them.
 * "im done" finds "I'm done".
 */
function loosely(words: string): string {
  return words
    .split(" ")
    .map((word) => word.split("").join("['’]?"))
    .join("[^a-zA-Z0-9]+")
}

/**
 * Find a command in one finished sentence. Returns null when there is none.
 *
 *   parseCommand("recording", "Whisk until it foams. Next step.")
 *     -> {command: "capture", before: "Whisk until it foams."}
 *   parseCommand("learning", "Hey Tinker, how hot should the water be?")
 *     -> {command: "ask", before: "", question: "how hot should the water be?"}
 */
export function parseCommand(mode: Mode, spoken: string): Parsed | null {
  const said = normalize(spoken)
  if (!said) return null

  // Longest phrase first, so "finish the lesson" wins over a shorter match.
  const phrases = [...BY_MODE[mode]].sort((a, b) => b.words.length - a.words.length)

  // The name at the START of a sentence. Only while a lesson is being learned.
  if (mode === "learning") {
    const wake = WAKE_WORDS.find((name) => said === name || said.startsWith(name + " "))
    if (wake) {
      const head = new RegExp("^[^a-zA-Z0-9]*" + loosely(wake) + "[^a-zA-Z0-9]*", "i")
      const rest = spoken.replace(head, "").trim()
      // "Tinker, check my work." is a command with the name in front, not a
      // question for Claude. It counts only when the rest is exactly a command.
      const asked = normalize(rest)
      const direct = phrases.find((phrase) => phrase.words === asked)
      if (direct) return {command: direct.command, before: ""}
      return {command: "ask", before: "", question: rest}
    }
  }

  for (const phrase of phrases) {
    const whole = said === phrase.words
    const atEnd = !phrase.alone && said.endsWith(" " + phrase.words)
    if (!whole && !atEnd) continue

    // Cut the command off the end of the original sentence, keeping its capitals and punctuation.
    const tail = new RegExp(loosely(phrase.words) + "[^a-zA-Z0-9]*$", "i")
    const before = whole ? "" : spoken.replace(tail, "").trim()
    return {command: phrase.command, before}
  }
  return null
}

/**
 * The commands that work in a mode, as one short spoken sentence.
 * None of these may END in a command phrase: the glasses can hear their own
 * speaker, and the app must not be able to command itself.
 */
export function helpText(mode: Mode): string {
  if (mode === "recording") return "Explain a step, say next step to save it, and say finish lesson at the end."
  if (mode === "processing") return "The lesson is being built, wait a moment."
  if (mode === "review") return "Say publish lesson to save it, or cancel lesson to throw it away."
  if (mode === "learning") {
    return "Say check, next step, go back, repeat, why, any tips, or stop lesson, or start a question with Tinker."
  }
  return "Say start lesson to learn, or say start teaching to make a new one."
}
