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

## Files

| File | What it is |
| --- | --- |
| `real-claude-test.ts` | The program |
| `test-photos.ts` | Generated. The four pictures as base64 text. |
| `make-test-photos.py` | Draws the pictures and writes `test-photos.ts` |

This folder is outside `src/`, so Node things like `process` are allowed here. They are not allowed in `src/background/`.
