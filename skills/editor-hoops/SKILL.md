---
name: editor-hoops
description: "Edit basketball footage (pickup runs, games, highlights) in the cold NBA-edit style Uthman picked: 16:9, black-and-white and red-on-black grade, slow motion on the big moments, huge full-frame titles, negative/inverted punch-ins, light-streak and flash transitions, film-border texture. No music. Use for any basketball or sports-highlight edit or revision."
---

# editor-hoops — cold NBA-edit style, 16:9 (Oct 2026)

Reference: "7 MINUTES OF COLDEST NBA EDITS 🔥 | MAY 2026" by BigBaller8 (https://youtu.be/0XtUFPf-CW0).
Uthman's words: "forget the vertical, but the black and white, the slow motion, the big text, the transitions,
and everything else I love and need that."

Look at both frames in `reference/` before you start — they are the target:
- `reference/big-title-giants.png` — one word filling the whole frame, red on black, glowing.
- `reference/negative-punch-in-film-border.png` — tight face shot as a high-contrast inverted (negative) B&W image inside a film-strip border.

## 0. Hard rules
- **16:9, never vertical.** Keep source resolution (4K stays 4K).
- **No music, ever** — but SFX are wanted (see §6). The reference is cut to songs; here the rhythm comes from the cuts, the court sound and matched SFX.
- **Never invent facts** — no made-up scores, names, stats or dates. Text is words, moods and real facts only.
- **Never recolour surfaces to place text** (the first basketball edit turned a court neon). Big titles go on black or over a darkened/graded frame, not painted into the scene.
- Show the **PLAN** first and a **rough cut early** (draft in ./previews) — he watches and steers live.

## 0b. Do the work: study ALL the footage before cutting (his #1 complaint)
His words after round 2: "You're not taking your time, you just cut the clips anyhow. All you've done is turn it
black and white and add the BBP and outside text. I need you to actually look at all the clips, check where the
buckets are, where the high energy is, the highlight-worthy moments… be creative. Do WORK, don't be lazy."
A restyle of an old cut is NOT an edit. Every edit (and every redo) starts from the raw clips:
1. **Watch every clip** at 2–4 fps contact sheets end to end, plus the audio. Nothing gets skipped because it "looked like drills".
2. **Measure energy** per clip, second by second: audio loudness peaks (shouts, crowd, bangs — `ebur128`/`astats` per 0.25 s), motion (frame-difference / `select='gt(scene,…)'`, optical-flow magnitude), and people count/closeness. Plot or table it.
3. **Write ./LOG.md** — a moment log for every clip: timecode, what happens, rating 1–5. Mark every:
   make (verify the ball through the net at full fps), miss/brick, block, steal, crossover/ankle-breaker, and-one, dunk/layup, fast break, celebration, trash talk/reaction, funny moment, crowd/bench reaction, walk-off, faces.
4. **Pick from the log**, best first: every make worth showing, every 4–5 rated moment, reactions right after big plays. The order still tells the story of the day (arrive → run → turning point → best play → aftermath).
5. Each highlight gets a **build**: lead-in (the setup/dribble) → the move → the result → the reaction. Don't cut away before the payoff or the reaction.
6. In PLAN.md list the top 10 moments you found with timecodes, so he can see you actually watched.
Take the time this needs — a 2-hour careful edit beats a 20-minute lazy one.

## 1. Grade — three looks, used on purpose
1. **Main look: cold B&W.** Most of the edit. Desaturate fully, crush blacks hard, lift nothing, strong contrast, a little grain, vignette.
   `format=gbrp,hue=s=0,curves=master='0/0 0.18/0.04 0.5/0.47 0.82/0.93 1/1',noise=alls=10:allf=t,vignette=PI/4.5`
2. **Red-on-black.** For openers, big moments and title beats. Black-and-white image mapped to black→deep red (shadows stay pure black, highlights red, never pink).
   e.g. B&W first, then `colorchannelmixer=rr=1:rg=0:rb=0:gr=0.12:gg=0:gb=0:br=0.08:bg=0:bb=0` + crushed curves. Check that blacks are true black.
3. **Negative punch-in.** 0.3–0.8 s bursts on a tight shot (a face, a hand, the ball): B&W → invert (`negate`) → hard contrast so it reads like a high-contrast photocopy (see reference frame). Use on a beat moment — a stare, a celebration, right before a make. 2–4 times per minute max.

**Not everything is black and white** (his words: "not all need to be black and white"). Mix it with intent, roughly 50–60% B&W:
- **Colour** (natural, slightly punchy contrast, real court colours — never recoloured) for the live run of play, the makes and the celebrations — the moments that should feel alive.
- **B&W** for build-ups, slow-mo approaches, faces, the walk-in/walk-off, quieter beats.
- **Colour → B&W switch** on a freeze or the white flash to mark a big moment, or B&W → colour the instant the ball drops. These switches are where the edit feels designed.
- Red-on-black and negative only as accents (above). Never pump saturation.

## 2. Slow motion
- The biggest moments (a make, a block, a crossover, a celebration, a walk-off) go to **slow motion: 30–50% speed**. Ramp in: real speed → slow just before the peak (the release, the ball at the rim) → hold the slow through the make → snap back to real speed or cut on the flash.
- Use frame interpolation so slow-mo is smooth: `minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1` then `setpts=2.0*PTS` (or retime 60p sources directly if any exist — check with ffprobe).
- Not everything: run-of-play stays real speed and fast so the slow moments hit. Roughly 25–35% of runtime in slow-mo.

## 3. Big text
- **Full-frame title words**: one word (sometimes two) in a heavy condensed sans (Anton, Bebas Neue Bold, or Impact; download Anton from Google Fonts if missing), ALL CAPS, filling ~85–95% of frame width, letters almost touching the frame edges.
- Colour: deep red (#b00000–#d10000) with a soft red glow/bloom on black; or white on black. Slight blur/softness on the edges like the reference — not crisp vector-clean.
- Timing: 0.6–1.5 s each. Animate subtly: slow push-in (scale 100→104%), or flicker on (2–3 frame on/off), or slide up with motion blur.
- **The crew's name is BBP.** The signature title is **BBP** — exactly the reference "GIANTS" frame (same heavy condensed font, deep red, glow, filling the frame) with "GIANTS" replaced by "BBP". Use it in the cold open and as the final word. With only three letters, scale it so it still fills ~85–95% of the frame width (and most of the height).
- Other chapter beats: e.g. **OUTSIDE**, **INSIDE**, **RUN IT**, **NEXT**. Between 3 and 6 big words per minute of edit.
- Smaller supporting text (optional): white, same font, small, centred lower third or top — short real facts only ("game point", "11 to 9" only if you actually counted it).

## 4. Transitions (all on the cut, short)
- **White flash** (keep his vlog-skill flash: full-frame bloom envelope 1,1,1,1,1,.6,.25) into big moments.
- **Red light streaks on black**: 4–10 frames of thin glowing red diagonal streaks on black between scenes (generate with geq/drawbox + boxblur + glow, or film-burn style). See the reference opener.
- **Whip/motion-blur smear**: 3–6 frames of directional blur (`dblur` or `avgblur` stacked with tmix) across the cut when the camera or player moves fast.
- **Hard cut to black** for 4–12 frames before a big title — silence + black makes the title land.
- **Negative flash**: 2–3 frames of the inverted image on the cut itself.
- Mix them; never the same transition three times in a row.

## 5. Texture
- **Film-strip border** on some sections (not all): thin black frame edges with small white edge markings (frame numbers, a dot, a small triangle) running down the left/right, like the reference. Inset the picture ~3–4% with rounded-off film corners.
- Light grain throughout; occasional 1-frame gate weave (2–4 px shift) on hits.
- Letterbox bars (2.39:1) are allowed for intro/outro sections.

## 6. Sound — no music, but full sound design with SFX
No songs, no beats. But **SFX are wanted** ("add sfx that actually match"). Kit: `D:\prodProcess-toolkit\sfx\`
(38 wavs: `Whoosh\` ×18, `Impacts\` ×8, `Risers\` ×6, `Camera Sounds\` ×6 — listen/inspect each with ffprobe +
waveform image and pick by character, not by name). Every SFX must **match what's on screen**, sync to the frame:
- **Whoosh** on whip-blurs and fast transitions — short/quick ones for quick cuts, deep/long ones into slow-mo or titles. Start the whoosh 2–4 frames before the cut so its peak lands on it.
- **Impact / Deep Thud / Cinematic Hit** exactly on: the ball through the net, a block, the BBP title slam, a hard cut to black. Layer a deep hit under the real swish on the best make.
- **Riser** under the build-up before the biggest play (2–4 s), cutting dead to silence for 0.3–0.5 s, then the impact + real crowd sound.
- **Camera shutter / mechanics** on freeze-frames, photo-style stills, the negative punch-ins and the film-border sections.
- **High Pitch Ringing** once at most — after the single biggest moment, under slow-mo, like the world goes quiet.
- Court sound stays underneath everything (bounces, sneakers, the net, shouts) — cleaned (highpass 80, afftdn), and on slow-mo slowed + reverbed (`asetrate`/`atempo` down, `aecho=0.8:0.85:60|120:0.35|0.25`).
- Mix: SFX sit with the court sound, not over it — duck court sound 4–6 dB under impacts; nothing clips; final about -14 LUFS, true peak ≤ -1 dB.
- Also harvest real sounds from the footage (a clean swish, a sneaker squeak, a bounce) and reuse them as accents.

## 7. Structure for a pickup-run edit
1. Cold open (5–8 s): black → red streaks → huge red **BBP** → negative punch-in on a face.
2. Section 1 (outside / first run): fast real-speed play, 1–2 slow-mo moments, B&W.
3. Title beat (black + big word) → section 2 (inside / second run), same treatment.
4. The best moment of the day: slow-mo, maybe the one colour shot, loudest sound.
5. Out: faces, celebration, walk-off in slow-mo B&W → final red **BBP** → black.
Aim ~60–90 s unless asked; tell him what length the footage could support.

## 8. QA before export
- Grab frames of every title, every slow-mo peak, every transition into ./frames and look at them.
- Check: blacks are true black (not grey), red is deep red (not orange/pink), titles fill the frame, no text over faces, slow-mo is smooth (no stutter), audio has no clicks at cuts.
- Export H.264 + AAC, yuv420p, source resolution, `-movflags +faststart`.
