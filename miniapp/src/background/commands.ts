/**
 * Spoken commands.
 *
 * A command counts only when it is the END of what the person said.
 *   "...whisk until it foams. Next step."   is the command "capture"
 *   "The next step is to whisk."            is narration, not a command
 *
 * To add or rename a command, edit the lists below.
 */

import type {Mode} from "../shared/channels"

export type Command = "teach" | "capture" | "finish" | "learn" | "check" | "repeat" | "story" | "skip" | "stop" | "help"

interface Phrase {
  command: Command
  words: string
  /** True: the phrase must be the whole sentence. Used for short words that come up in normal talk. */
  alone?: boolean
}

// One list per mode. A phrase only works in its own mode, so "next step"
// does nothing while a learner is being coached.
// Write phrases in lower case with no punctuation and no apostrophes ("im done"),
// because that is the form `normalize` turns speech into before comparing.
const IDLE: Phrase[] = [
  {command: "teach", words: "start teaching"},
  {command: "teach", words: "teaching mode"},
  {command: "teach", words: "record a lesson"},
  {command: "learn", words: "start lesson"},
  {command: "learn", words: "start the lesson"},
  {command: "learn", words: "begin lesson"},
  {command: "learn", words: "coach me"},
  {command: "help", words: "what can i say"},
]

const TEACHING: Phrase[] = [
  {command: "capture", words: "next step"},
  {command: "capture", words: "save step"},
  {command: "capture", words: "save this step"},
  {command: "finish", words: "finish lesson"},
  {command: "finish", words: "finish the lesson"},
  {command: "finish", words: "end lesson"},
  {command: "finish", words: "end the lesson"},
  {command: "stop", words: "cancel lesson"},
  {command: "stop", words: "cancel the lesson"},
  {command: "help", words: "what can i say"},
]

const COACHING: Phrase[] = [
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
  {command: "repeat", words: "repeat"},
  {command: "repeat", words: "repeat that"},
  {command: "repeat", words: "say that again"},
  {command: "repeat", words: "say it again"},
  {command: "story", words: "why", alone: true},
  {command: "story", words: "why this step"},
  {command: "story", words: "tell me why"},
  {command: "story", words: "tell me the story"},
  {command: "skip", words: "skip", alone: true},
  {command: "skip", words: "skip step"},
  {command: "skip", words: "skip this step"},
  {command: "stop", words: "stop lesson"},
  {command: "stop", words: "stop the lesson"},
  {command: "stop", words: "end lesson"},
  {command: "help", words: "what can i say"},
]

const BY_MODE: Record<Mode, Phrase[]> = {
  idle: IDLE,
  teaching: TEACHING,
  building: [],
  coaching: COACHING,
}

/** Lower case, no punctuation, single spaces. "I'm done." becomes "im done". */
export function normalize(spoken: string): string {
  return spoken
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Find a command at the end of a sentence.
 * `before` is what the person said ahead of the command, in their own words.
 */
export function parseCommand(mode: Mode, spoken: string): {command: Command; before: string} | null {
  const said = normalize(spoken)
  if (!said) return null

  // Longest phrase first, so "finish the lesson" wins over a shorter match.
  const phrases = [...BY_MODE[mode]].sort((a, b) => b.words.length - a.words.length)
  for (const phrase of phrases) {
    const whole = said === phrase.words
    const atEnd = !phrase.alone && said.endsWith(" " + phrase.words)
    if (!whole && !atEnd) continue

    // Cut the command off the end of the original sentence, keeping its capitals and punctuation.
    const tail = new RegExp(phrase.words.split(" ").join("[^a-zA-Z0-9]+") + "[^a-zA-Z0-9]*$", "i")
    const before = whole ? "" : spoken.replace(tail, "").trim()
    return {command: phrase.command, before}
  }
  return null
}

/** The commands that work in a mode, as one spoken sentence. */
export function helpText(mode: Mode, hasLesson: boolean): string {
  if (mode === "teaching") {
    return "Do one step and explain it. Say next step to save it. Say finish lesson at the end."
  }
  if (mode === "coaching") {
    return "Say check when you finish a step. You can also say repeat, why, or stop lesson."
  }
  if (mode === "building") return "The lesson is being built. Wait a moment."
  return hasLesson
    ? "Say start lesson to learn. Say start teaching to record a new lesson."
    : "Say start teaching to record a lesson."
}
