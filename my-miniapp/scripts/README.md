# scripts: the real Claude test

`real-claude-test.ts` runs the app's own Claude code (`src/background/claude.ts`) against the **real** Claude API with a real key, and prints what came back.

The unit tests in `test/` only talk to fakes. They prove the requests have the shape we meant. Only this program proves that Claude accepts them: the model names, the "thinking off" switches, the JSON shapes, photos as bytes and as a link.

## Run it

It needs Node 18 or newer and nothing else. Build one file, then run that file.

```bash
# in my-miniapp/ (needs bun). build/ is ignored by git.
bun build scripts/real-claude-test.ts --target=node --format=esm --outfile=build/real-claude-test.mjs

# on the machine that has the key
read -rs TINKER_CLAUDE_KEY && export TINKER_CLAUDE_KEY   # paste the key and press Enter. It is not shown.
node build/real-claude-test.mjs
```

It takes under a minute. The last line is `RESULT: ALL CHECKS PASSED` or `RESULT: n OF 9 CHECKS FAILED`.

| Exit code | Meaning |
| --- | --- |
| 0 | Nothing failed |
| 1 | At least one check failed |
| 2 | No usable key was given. Nothing was sent. |

## What it costs

About 9 small requests on your key:

| Requests | Model | Size |
| --- | --- | --- |
| 2 key tests (checks 1 and 2) | small | 1 token each. The wrong key in check 2 is refused, so it costs nothing. |
| 1 lesson (check 3) | large | 3 pictures of 640x480, answer capped at 3500 tokens |
| 4 photo checks (checks 4 to 7) | small | 1 or 2 pictures each, answer capped at 200 tokens |
| 2 questions (checks 8 and 9) | small | text only, answer capped at 200 tokens |

Check 6 also makes Claude download one public picture from GitHub (the team's mascot, about 0.9 MB).

## The key is never printed

- The key is read from `TINKER_CLAUDE_KEY`. Spaces, line breaks and quotes around it are removed.
- The only thing shown is `Key: starts with "sk-ant-", ends in "XXXX", N characters`.
- Every line the program prints goes through one function (`hide`) that replaces the key with `[key hidden]`, in case it ever comes back inside an error message or a reply.
- A value that does not start with `sk-ant-`, has a space inside it or is too short is refused before anything is sent.
- The key goes to `https://api.anthropic.com/v1/messages` and nowhere else. It is not written to any file.

## The nine checks

| # | Check | PASS when |
| --- | --- | --- |
| 1 | Key check | Claude accepts the key. If this fails the run stops. |
| 2 | A wrong key is rejected properly | A made-up key fails with status 401. That is the error the app's "Claude rejected this key" message hangs on. |
| 3 | Build a lesson from three captures | 2 to 4 steps, no empty fields, valid `source_capture`, spoken instructions of at most 30 words, a title |
| 4 | Check a correct attempt | `pass`, with at most 12 words |
| 5 | Check a wrong attempt | `fix` or `unclear`, at most 22 words, no mention of photo, image, picture or camera |
| 6 | A photo sent as a link | Claude opens the link and does not say `pass`. If Claude answers 400 this is a NOTE: the app then sends bytes instead. |
| 7 | Check against the built-in lesson with no expert photo | The call succeeds |
| 8 | Answer a question | At most 3 sentences and 60 words, no markdown signs, mentions 80 or 175 (digits or spelled out) |
| 9 | Answer a question the lesson cannot answer | Not empty, at most 60 words |

Two lines start with `READ THIS`. A program cannot judge them, so a person has to: in check 3 every step must come from the expert's three sentences, and in check 9 the reply must not invent a year.

A check that takes longer than 60 seconds gets an extra NOTE, because the Mentra App on the phone stops waiting after 60 seconds.

## Try it without a key (dry run)

```bash
TINKER_DRY_RUN=1 node build/real-claude-test.mjs
```

A fake inside the program answers every request, so no key is needed and no request leaves the machine. Every reply is then made up by the program. A dry run shows that the test program works. It says nothing about the real API.

`TINKER_DRY_FAULT` makes the fake misbehave on purpose. It only works in a dry run.

| Value | What the fake does | What you should see |
| --- | --- | --- |
| `check5` | Says `pass` for the empty bowl | Check 5 is FAIL, `RESULT: 1 OF 9 CHECKS FAILED`, exit code 1 |
| `link400` | Refuses the link with status 400 | Check 6 is NOTE, exit code 0 |

## The pictures are drawings

`test-photos.ts` holds four small JPEGs as base64 text: an empty bowl, a bowl with a mound of matcha powder, the same again from a slightly different place in different light, and a bowl of foamy matcha. They are **drawn** by `make-test-photos.py`. They are not real photos from the glasses, and the program says so in its output.

To change them (needs Python 3 and Pillow), edit the Python file, then:

```bash
python3 scripts/make-test-photos.py --preview /tmp/tinker-test-photos   # writes test-photos.ts, and the .jpg files to look at
```

Build the test again afterwards. The pictures are baked into the bundle.

## The second program: real-app-test.ts, the whole app on a simulated phone

`real-app-test.ts` builds the app and runs `dist/background/index.js`, the exact file the Mentra App loads on the phone, in an empty JavaScript sandbox that has only what Mentra's background engine has. Around it, the program plays the phone, the glasses and the person: it answers the app's requests for photos, speech, storage and kept photo copies, says sentences into the glasses microphone, taps buttons on the phone screen, and puts the drawings in front of the camera. Every request to Claude is real.

### What it proves, and what it does not

It proves that the parts work together with the real Claude: a wrong key is refused and the right one accepted, a lesson is taught by voice and built by Claude from photos and words, published by voice, learned with photo checks (one wrong attempt, the rest right), finished, and a spoken question is answered.

It proves nothing about real glasses: the camera, the speaker, the microphone, the button, timing. Speech takes no time on the simulated phone, and the pictures are drawings. The photo links (`photos.example`) exist nowhere on purpose, so Claude always refuses them and the app sends the photo bytes instead. A real Mentra link is tested by check 6 of `real-claude-test.ts`.

### Run it

```bash
# in my-miniapp/, needs bun. The program builds the app itself.
read -rs TINKER_CLAUDE_KEY && export TINKER_CLAUDE_KEY   # paste the key and press Enter. It is not shown.
bun scripts/real-app-test.ts
```

Dry run, with a fake Claude, no key and no network:

```bash
TINKER_DRY_RUN=1 bun scripts/real-app-test.ts
```

The last line is `RESULT: ALL CHECKS PASSED`, or it says how many checks failed, how many did not run, and whether the run stopped early.

| Exit code | Meaning |
| --- | --- |
| 0 | All 12 checks passed |
| 1 | A check failed, or the run stopped early |
| 2 | No usable key, or an unknown `TINKER_DRY_FAULT`. Nothing was sent. |

`bun run build` deletes and rewrites `dist/`, and `bun test` does too. If a run says `dist/background/index.js` is missing or cut off, another build ran at the same moment. The program builds again by itself, up to three times. If it still fails, wait 30 seconds and run it again.

### Requests and time

About 9 requests on your key:

| Requests | Model | Size |
| --- | --- | --- |
| 2 key tests | small | 1 token each. The wrong key on purpose is refused with 401 and costs nothing. |
| 2 lesson requests | large | The first is refused, because Claude cannot open the photo links. The second carries 3 pictures as bytes, answer capped at 3500 tokens. |
| 4 photo checks | small | 2 pictures each, answer capped at 200 tokens |
| 1 question | small | Text only, answer capped at 200 tokens |

When a lesson build, a check or the question fails, the person tries once more, as the app invites. A run with errors therefore sends a few more requests.

A dry run takes about 45 seconds. A real run should take 1 to 3 minutes (not yet measured): about 15 pauses of 3 seconds, plus Claude's time.

Time limits:

- Each request to Claude gets 60 seconds, the limit the Mentra App gives a background request on the phone. A request that would fail on the phone fails here too. The app gives up sooner on checks, questions and key tests (`CLAUDE_GUARD_MS` in `coach.ts`, 30 seconds on 2026-11-14).
- Every wait has its own limit. Added up, those limits could pass 6 minutes, so the run also has a hard limit: no wait goes on later than 5 minutes 45 seconds after the start, and a last timer ends the program at 5 minutes 48 seconds whatever it is doing. Either way the summary is printed.
- When a wait runs out, the run prints what it was waiting for, the last things the glasses said, what the screen showed, and every request to Claude that is still without an answer.
- If Claude never answers, the run stops after about a minute, because the app gives up on each key test after 30 seconds.

### How it waits

It waits for the app's own messages to the phone screen (`teachingState`, `tutorialGenerated`, `tutorialList`, `learningState`, `stepVerdict`, `assistantState`), never a fixed time. Before each sentence the person waits until the screen shows the app as idle, then 3 seconds more. That gap is also what lets the app's echo filter tell the person from the app's own voice: the program reads `ECHO_REPLY_MS` and `QUIET_AFTER_SPEECH_MS` from `coach.ts` and never waits less than either of them plus half a second. A sentence the app does not react to within 6 seconds is said again, and check 12 fails.

No check depends on the exact words the app speaks. Only Claude's answer to the question must reach the glasses, and that is compared loosely.

### The twelve checks

| # | Check | PASS when |
| --- | --- | --- |
| 1 | A wrong key, then the right key | The wrong key is refused with HTTP 401, the right one is tested and saved. If the right one fails, the run stops. |
| 2 | Claude builds a lesson | The lesson request carried the expert's words for each of the 3 steps, each followed by the photo the camera took at that moment. 2 to 4 steps came back, each with words to say and a "finished looks like". If no lesson comes after 2 tries, the run stops. |
| 3 | Published by voice | After "Publish lesson." the lesson is in the library as published and in the phone's storage |
| 4 | The lesson starts by voice | "Start lesson." starts the new lesson |
| 5 | A wrong attempt | The empty bowl at the powder step is not passed |
| 6 | The correct attempts | Every correct drawing is passed |
| 7 | The end | The lesson ends after the last step |
| 8 | A spoken question | "Tinker, how hot should the water be?" is answered by Claude through the glasses, and the answer mentions 80 or 175 |
| 9 | Stop by voice | "Stop lesson." ends the built-in lesson |
| 10 | No errors | The app logged no error |
| 11 | The right photos | Every photo check sent the photo the camera had just taken as the learner's photo, and the step's own expert photo |
| 12 | Understood the first time | The app reacted to every sentence and every tap within 6 seconds, the first time |

The output also shows the whole lesson Claude wrote, and every request to Claude: its HTTP status, its time, its stop reason and tokens, and for a failed request Claude's own error message and request-id, with a hint per kind of error. The notes the app put on the phone screen are listed too.

### The key is never printed

The same rules as `real-claude-test.ts`. The key comes from `TINKER_CLAUDE_KEY`, with spaces and quotes around it removed. A value that does not look like a Claude key is refused before anything is sent. Every printed line goes through one function (`hide`) that replaces the key, and anything else shaped like a Claude key, with `[key hidden]`. Only the last 4 characters are shown. The key is also kept out of the environment of the build the program starts.

Checked on 2026-11-14: a dry run with `TINKER_CLAUDE_KEY=sk-ant-test-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ` set does not contain that text anywhere in its output.

### Faults for the dry run

`TINKER_DRY_FAULT` makes the fake Claude misbehave on purpose. It only works together with `TINKER_DRY_RUN=1`.

| Value | What the fake does | What you should see |
| --- | --- | --- |
| `check5` | Passes the empty bowl at the powder step | Check 5 is FAIL, `RESULT: 1 CHECK(S) FAILED`, exit code 1 |
| `claude529` | Answers every lesson build with HTTP 529, overloaded | Two tries, both 529, with Claude's message in the summary. Then the run stops: check 2 is FAIL, checks 3 to 9 and 11 are NOT RUN, exit code 1, after about 20 seconds. |
| `hang` | Never answers | Check 1 is FAIL after about a minute, the summary shows the request still waiting, exit code 1 |

Where it matters for this run, the fake answers the way the real Claude does: 401 for a wrong key, 400 "Unable to download the file" for any photo link, 400 when an image's stated type does not match its bytes, JSON that matches the schema in each request exactly, and stop reason `max_tokens` for the 1-token key test. It also refuses an unknown model, `temperature`, and the wrong thinking switch for a model, as D9 in `docs/DECISIONS.md` says the real models do. A dry run shows that the program works. It says nothing about the real API.

## Files

| File | What it is |
| --- | --- |
| `real-claude-test.ts` | The program |
| `real-app-test.ts` | The whole built app on a simulated phone, with the real Claude. Run with bun. |
| `test-photos.ts` | Generated. The four pictures as base64 text. |
| `make-test-photos.py` | Draws the pictures and writes `test-photos.ts` |

This folder is outside `src/`, so Node things like `process` are allowed here. They are not allowed in `src/background/`.
