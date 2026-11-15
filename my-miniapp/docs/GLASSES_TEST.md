# Tinker on real glasses: the first test

For the person holding the glasses, a phone and a laptop. It takes about 30 minutes.

**Nobody has run Tinker on real Mentra Live glasses yet.** Every "Expect" below is what the code should do. Write down what really happens (section 4). Every command and sentence is listed in `docs/HOW_IT_WORKS.md`.

## 1. Before you start

- [ ] **Mentra App up to date** (App Store or Google Play). Tinker needs Mentra App 1.42.0 or newer.
- [ ] **Glasses paired and connected** in the Mentra App, and the paired glasses are Mentra Live. Tinker does not start with no glasses paired or with "Simulated Glasses".
- [ ] **Phone signed in to Mentra** in the Mentra App. Without that the glasses refuse to take photos.
- [ ] **Glasses on Wi-Fi** (in the Mentra App). Without Wi-Fi, photos come over Bluetooth and are small (about 640x640).
- [ ] **Glasses battery above 15%**, and no video recording on the glasses. Otherwise photos are refused.
- [ ] **Glasses set as the phone's Bluetooth audio output** (phone Bluetooth or sound settings). Otherwise the voice comes out of the phone speaker.
- [ ] **Glasses on your head** for the whole test. Taking them off can pause the sound.
- [ ] **Phone has internet.** Claude, speech recognition and the voice all need it.
- [ ] **Laptop with bun.** `bun --version` must print a version. This was checked with 1.4.4. Below 1.2, run `bun upgrade`.
- [ ] **Phone and laptop on the same network.** University Wi-Fi often stops devices from seeing each other. Then turn on the phone's hotspot and put the laptop on it. On Android, `bun run dev --usb` works over a USB cable instead (it needs `adb` on the laptop and USB debugging on the phone).
- [ ] **The Claude key**, ready to paste on the phone (password manager or private note). Never in a group chat, never in a file in the repository.
- [ ] **On a table:** a cup, a pen and a sheet of paper. **Next to you:** a second person to watch the light on the glasses.

## 2. Install

On the laptop, in your clone of the team repository:

```bash
git fetch origin
git checkout tinker-integration
cd my-miniapp
bun install
bun run dev
```

The branch is `tinker-integration` until the work is merged into `main`. After the merge, use `main`.

Pick one of the two:

- **`bun run dev`** (use this one if you can): the laptop must stay on, on the same network, for the whole test. Errors from the phone also show in this terminal.
- **`bun run release`**: installs a fixed copy. When the terminal shows a line that starts with "✓ Install #1", press Ctrl+C. The laptop is not needed after that.

The terminal prints a QR code. On the phone, open the Mentra App, go to **Settings > Miniapp Developer Settings > Scan Miniapp QR Code** and scan it. If the Mentra App asks to allow the camera or the microphone for Tinker, allow both.

During the test, do not save files or run `git pull` in this folder. With `bun run dev`, every saved change reloads Tinker on the phone, and a change to the background code restarts it and loses a recording in progress.

## 3. The test

**How to talk to the glasses**

1. Talk only when the glasses are quiet: wait until they stop, then about one more second.
2. After you speak, the app needs 2 to 3 seconds to react. Do not repeat yourself before that.
3. A command counts only at the end of a sentence. "Next step." saves a step. "The next step is to whisk." does not.
4. Lost? Say "What can I say."

The camera sees what your face points at. Look at your hands when a photo is taken.

### A. Open and set up

**1. Open Tinker** in the Mentra App.
- Expect: "Connecting..." for a moment, then two pills: "Glasses connected" and "Claude key missing". Under "Skill Tutorials" there is the card "How to Make Matcha: Traditional Ceremonial Method", tagged "Built in".
- If not: write down what the pills say. Still "Connecting..." after 10 seconds: see section 5.

**2. Test the sound.** Scroll down to the "Settings" card and tap **Test glasses audio**.
- Expect in the glasses: "This is the Tinker audio check. If you hear this in the glasses, sound works."
- If it comes from the phone speaker: the glasses are not the phone's audio output. Fix that before you go on.

**3. Paste the key** into the "Claude key" box in the same card, then tap **Save key**. (If the top pill already says "Claude key ready", skip this.)
- Expect: "Testing the key...", then "Key saved." and "Key saved, ends in XXXX" (the key's last 4 characters). The top pill changes to "Claude key ready".
- If not: write down the red sentence under the box.

### B. Teach a 3-step lesson

Put the paper, the cup and the pen to one side of the table.

**4. Say "Start teaching."**
- Expect in the glasses: "Recording. Do one step and explain it. Say next step when it is finished. Say finish lesson at the end." The phone switches to the Teaching tab: "Recording on the glasses" and a running clock.
- If nothing after 5 seconds: tap **Start Recording** on the Teaching tab, and write down "voice start: no".

**5. Step 1, by voice.** Lay the paper flat in front of you and say: "First I lay a sheet of paper flat on the table. Next step."
- Expect: a shutter sound, then "Step 1 saved." The screen shows "Steps saved: 1 · Photos: 1" and the photo, tagged "Saved step".
- If you hear "Step 1 saved without a photo.": the photo failed, see section 5.

**6. Step 2, with a short press.** Put the cup upside down in the middle of the paper and say: "Now I put the cup upside down in the middle of the paper, because upside down it cannot tip over." Wait until your words show under "Heard for this step". Then press the glasses button once, short.
- Expect: a shutter sound, then "Step 2 saved."
- If nothing after 3 seconds: say "Next step." and write down "short press while recording: no".

**7. Step 3, by voice.** Lay the pen across the top of the cup and say: "Last, I lay the pen across the top of the cup. Next step."
- Expect: a shutter sound, then "Step 3 saved." The screen shows "Steps saved: 3".
- Every 20 seconds without a saved step, the glasses take a silent photo: "Photos" goes up and the picture is tagged "Timed photo". That is expected.

**8. Finish with a long press.** Hold the glasses button down for about 2 seconds.
- Expect: "Building the lesson." The screen shows "Building the lesson...".
- If nothing after 3 seconds: say "Finish lesson." and write down "long press: no". If you hear "Step 4 saved." instead, the long press counted as a short one: write that down, then say "Finish lesson."

**9. Wait for the lesson.** Time it from "Building the lesson." to "Lesson ready".
- Expect: "Lesson ready. TITLE. It has 3 steps. Say publish lesson to save it, or review it on the phone." TITLE is the title Claude chose, and the number of steps can differ. The screen shows "Review & Publish" and "Generated Steps".
- From a cloud machine (not a phone), Claude took 6 to 7 seconds for a 3-step lesson. A minute or more on the phone is a problem.
- If not: the red line on the screen starts with "The lesson was not built." Write down the rest. The glasses say "I could not build the lesson. Say finish lesson to try again." Wait 3 seconds, then say "Finish lesson." once more.

**10. Review and publish.** Read the steps on the screen. Then, **3 seconds** after the glasses stop, say "Publish lesson." (The app ignores "publish lesson" for 2.5 seconds after it has said those words itself.)
- Expect: "Lesson published." The phone switches to the Learning tab, shows "Lesson published: TITLE", and the new lesson is the first card.
- If nothing after 5 seconds: tap **Publish to Library** and write down "voice publish: no".
- A title you change on the screen is used only when you publish with the screen button. A spoken publish keeps Claude's title.

### C. Learn the lesson you just recorded

Put the paper, the cup and the pen to one side again. Do the photo checks with this lesson, not the built-in one: in tests from a cloud machine, the built-in lesson (it has no expert photo) judged correct work as "fix" every time.

**11. Say "Start lesson."** It starts the newest lesson.
- Expect: "TITLE. Say check when a step is done. Step 1. ..." with Claude's first step. The screen shows the lesson: "Step 1 of 3", "2 to go".
- If nothing after 5 seconds: tap **Start Learning** on the new lesson's card.

**12. A check that should pass.** Lay the paper flat, look at it, and say "Check."
- Expect: a shutter sound, the pill shows "Thinking", then a short praise and "Step 2. ..." in one go. The light blinks **green** twice. The screen shows a chip "Passed", Claude's sentence, "The expert's photo", "Your photo", and "Step 2 of 3".
- Time it from "Check" to the first spoken word. From a cloud machine, Claude alone took 1.2 to 2.8 seconds. The photo comes on top of that.

**13. A check that should fail.** Put the cup the right way up, NEXT to the paper (wrong on purpose). Look at it and press the glasses button once, short.
- Expect: a shutter sound, "Thinking", then the glasses say what to fix and stay on step 2. The light blinks **red** twice. The chip says "Needs a fix".
- If nothing after 3 seconds: say "Check." and write down "short press in a lesson: no".
- Orange light and "Could not see it": the photo missed the work. Look straight at it and say "Check." again.

**14. Repeat, Why, Next step.** Leave 3 seconds after each answer.
- Say "Repeat." Expect: "Step 2. ..." again.
- Say "Why." Expect: the reason you gave while teaching (that it cannot tip over), or a longer explanation of the step.
- Say "Next step." Expect: "Step 3. ...", and "Step 3 of 3" with "Last step" on the screen.

**15. Ask a question.** Say "Tinker, can I use a mug instead of a cup?"
- Expect: "Thinking", then a spoken answer of one to three sentences. Your question shows as a "You" line under "Live Conversation Transcript". From a cloud machine, Claude alone took about 1 second.
- If nothing: read the "You" line. If "Tinker" came out as another word, say "Hey Tinker." Expect "Yes?". Then ask the question within 8 seconds, without the name.

**16. Say "Stop lesson."**
- Expect: "Lesson stopped." The screen goes back to the lesson list.
- If not: tap **End Session**.

### D. The built-in matcha lesson

This lesson is for reading steps aloud and for questions. No photo checks here.

**17. Start it.** Tap **Start Learning** on "How to Make Matcha: Traditional Ceremonial Method".
- Expect in the glasses: "How to Make Matcha: Traditional Ceremonial Method. Say check when a step is done. Step 1. Pour hot water into your tea bowl to warm the ceramic, and briefly rest the tips of your bamboo whisk in the warm water to soften the tines."

**18. Say "Next step.", then ask a question.**
- Expect: "Step 2. Place your fine-mesh sifter over the dry bowl and use the bamboo chashaku scoop to measure two rounded scoops of matcha powder." The screen shows "Step 2 of 6" and "4 to go".
- Then say "Tinker, how hot should the water be?" Expect a short spoken answer. (The lesson says about 80 degrees Celsius.)

**19. Close the screen in the middle of the lesson.** Use the phone's back gesture (iPhone: swipe in from the left edge) until the Tinker screen is gone and the Mentra App shows. The first swipe only shows the lesson list with a "Lesson in progress" card: keep going. Then say "Repeat."
- Expect: with the screen closed, the glasses still say "Step 2. Place your fine-mesh sifter ...".
- Now open Tinker again. Expect: "Connecting..." for a moment, then the same lesson at "Step 2 of 6".

**20. Say "Stop lesson."**
- Expect: "Lesson stopped."

## 4. What to record for the team

Fill this in as you go. Send a photo of it to the team.

| # | Step | Worked? (yes / no) | How long | What you heard or saw |
| --- | --- | --- | --- | --- |
| 1 | Tinker opens, the two pills | | | |
| 2 | Sound test heard in the glasses | | | |
| 3 | Key saved | | | |
| 4 | "Start teaching." by voice | | | |
| 5 | Step 1 saved by voice, with a photo | | | |
| 6 | Short press saved step 2 | | | |
| 7 | Step 3 saved by voice | | | |
| 8 | Long press finished the recording | | | |
| 9 | "Lesson ready" (time from "Building the lesson.") | | | |
| 10 | "Publish lesson." by voice | | | |
| 11 | "Start lesson." by voice | | | |
| 12 | Check passed, green light (time from "Check" to the first word) | | | |
| 13 | Check failed, red light, started by a short press | | | |
| 14 | Repeat, Why, Next step | | | |
| 15 | Question answered (time) | | | |
| 16 | "Stop lesson." | | | |
| 17 | Matcha lesson read aloud | | | |
| 18 | Next step and matcha question | | | |
| 19 | Glasses answered with the screen closed, same step after reopening | | | |
| 20 | "Stop lesson." | | | |

Also write down:

- iPhone or Android, the Mentra App version, and `bun run dev` or `bun run release`.
- Did the app ever react to its own voice, or show "You" lines that repeat what the glasses said?
- Commands that did nothing, and what the "You" line showed instead.
- Did the voice ever come from the phone speaker?

## 5. If something goes wrong

| What you see or hear | Likely cause | What to try |
| --- | --- | --- |
| `git checkout` refuses because of local changes | Files changed in your clone | `git stash`, then `git checkout tinker-integration` again |
| `bun install` fails | bun is too old | `bun upgrade`, then `bun install` |
| `bun run release` fails with an error about `zip` (Windows) | `release` calls the `zip` program | Use `bun run dev` |
| "Warning: Could not detect LAN IP address" | The laptop is on no network | Join the Wi-Fi or the phone's hotspot |
| The QR code in the terminal does not scan | Terminal font or window size | Open the picture named after "PNG QR:" in the terminal and scan that |
| Tinker does not appear or does not open after the scan | The phone cannot reach the laptop, no real glasses paired ("Simulated Glasses"), or a Mentra App older than 1.42.0 | Phone hotspot, `bun run dev --usb` on Android, or `bun run release`. Pair the Mentra Live. Update the Mentra App. |
| Stays on "Connecting..." | The background part of Tinker did not start | Close Tinker and open it again. With `bun run dev`, read the laptop terminal. |
| "Glasses not connected", but the glasses talk and take photos | The status is wrong, not the glasses | Carry on and write it down |
| "Glasses not connected", and nothing works | The glasses are not connected in the Mentra App | Reconnect them in the Mentra App |
| The voice comes from the phone | The glasses are not the phone's audio output | Pick the glasses in the phone's Bluetooth or sound settings |
| No sound at all | Media volume down, or the glasses were taken off | Turn up the volume, keep the glasses on, tap **Test glasses audio** |
| Nothing you say shows up | No microphone permission, or no internet | Allow the microphone for Tinker in the Mentra App. Check the phone's internet. |
| A command does nothing | Said while the glasses talked, said too soon after a prompt with the same words, or the app was still busy | Wait until quiet, then one more second. After "Lesson ready", wait 3 seconds before "Publish lesson." |
| The app reacts to its own voice | The microphone hears the glasses' speaker | Turn the volume down. Write down what it heard and did. |
| "Step 2 saved without a photo." or "I could not take a photo. Say check to try again." | Glasses not connected, phone not signed in to Mentra, battery under 15%, a video recording, or the last photo not finished | Check those, wait a few seconds, try again |
| Photos are small or blurry | The glasses are not on Wi-Fi, so photos come over Bluetooth | Connect the glasses to Wi-Fi in the Mentra App |
| "That is not a Claude key. A Claude key starts with sk-ant-." | Something else was pasted | Copy the key again |
| "Claude rejected this key. Copy it again from the Claude Console." | Wrong or deleted key | Copy it again |
| "The test request failed. ..." | No internet, or Claude refused the request | Check the phone's internet. Write down the whole sentence. |
| Red line "The lesson was not built. ..." | The words after it are the reason | Write it down. Wait 3 seconds, say "Finish lesson." again. On an iPhone a request with no answer after 60 seconds is cut off: record shorter steps. |
| "I could not check that. Say check to try again." | The photo check failed | The reason is a note under "Live Conversation Transcript". Write it down. |
| "I could not answer that. Ask again." | The question failed | The reason is a note under "Live Conversation Transcript". Write it down. |
| A correct step gets "Needs a fix" in the matcha lesson | Known: the built-in lesson has no expert photo | Do checks with a lesson you recorded |
| Buttons on the screen stay grey | The app is busy: talking, taking a photo, or waiting for Claude | Wait. "End Session" and "Discard" always work. |
| The glasses button does nothing | The presses do not reach Tinker | Use your voice or the screen. Write it down. |
| A photo disappears from the screen later | Photo links work for 10 minutes | Expected. The lesson keeps its own copy of the expert's photos. |
| A sentence ends in "Okay." or starts with "So," | Expected: it stops the app from commanding itself | Nothing |
