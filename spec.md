# Deepworks — Game Design Document (running spec)

**Status:** shipped; this document describes the game as it runs today (present tense). Anything not yet built is listed under "Design intent not yet implemented" at the end.

## 1. Overview

**Pitch:** Crew a layered mine, feed one overworked lift, find the bottleneck, fix it, automate — and keep earning while you're away.
**Genre:** idle optimization / throughput puzzle. **Players:** 1 (asynchronous daily score comparison). **Session:** 2–4 min lessons, 3–20 min journey stages, 15 min daily, endless practice.
**Platforms:** desktop and mobile browsers (portrait and landscape), hosted on StarHermit or standalone from any static server.
**Rendering:** Three.js r128 (vendored) diorama of a vertical mine cross-section; the whole game is also playable from the semantic HTML HUD, and a DOM-only board replaces the canvas when WebGL is unavailable.

| Path | Role |
|---|---|
| `index.html` | Entry point (`launch` in `starhermit.txt`); HUD, screens, live regions, script order |
| `css/styles.css` | Palette tokens, themes, breakpoints, safe areas, accessibility variants |
| `js/rules.js` | Pure deterministic rules engine (`DWRules`): ruleset, legality, fixed-point sim, scoring, serialization, seeded RNG |
| `js/content.js` | Versioned content (`DWContent`): 5 themes, 5 lessons, 40 journey stages, 6 challenges, 4 practice difficulties, daily generator, validators, greedy reference player |
| `js/session.js` | Run lifecycle (`DWSession`): command dispatch with idempotent ids, replay log, undo, autosave, away simulation, profile, stars/mastery |
| `js/render.js` | Three.js scene (`DWRender`): procedural mine, instanced seams and workers, lift, particles, picking, quality tiers |
| `js/ui.js` | DOM shell (`DWUI`): screens, HUD rails, setup/results/boards/help/profile/settings builders, toasts, captions, modals, layer labels |
| `js/audio.js` | WebAudio (`DWAudio`): 4 buses, synthesized fallbacks, lazily decoded Opus clips, adaptive music, captions |
| `js/platform.js` | StarHermit adapter (`DWPlatform`): launch token, server time, boards, achievements, activity/presence, consent-gated telemetry, offline fallbacks |
| `js/main.js` | Bootstrap, state machine, frame loop, input mapping, persistence glue, achievements, audio/VFX wiring |
| `server.js` | Authoritative game script (`server` in `starhermit.txt`): static files + `/api/v1`, replay-validated daily board |
| `assets/` | Generated key art and illustrations (`key-art.webp`, `shift-complete.webp`, `shift-over.webp`, `crew-at-night.webp`) |
| `sfx/` | 21 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` (generator output) |
| `data/scores.json` | Server-side daily board store (runtime data, tracked) |
| `vendor/three.min.js` | Three.js r128 UMD |
| `tests/` | `run.js` (5210 assertions), `e2e.mjs` (Playwright UI drive), `balance.js`, `smoke.js`, `review-fixes.mjs` — dev only, never served |
| `coverart.png`, `icon.png`, `favicon.svg`, `starhermit.txt`, `LICENSE.md` | Platform packaging (PolyForm Noncommercial 1.0.0) |

## 2. Vision and design pillars

1. **The lift is the game.** Every layer digs into its own bin, but only one lift sells ore, deepest-first. Income is capped by transport, not by crew size, so the interesting decision is always "what is the bottleneck right now?". Rules in: bins that visibly fill and stall, a red BLOCKED gauge, a hint line that names the bottleneck. Rules out: parallel transport, per-layer sales, any upgrade that bypasses the lift.
2. **Idle, but never passive.** The economy runs on its own (and for up to 8 h while the tab is closed in Practice), but seam flares reward attention with a 14-second window and a payout of 30 seconds of a layer's output. Rules in: flares, foreman automation you can buy and switch off, "while you were away" summaries. Rules out: taps-per-second play, timing puzzles, punishment for leaving.
3. **Whole numbers, no secrets.** Ore is milli-ore, credits are milli-credits, time is whole milliseconds; every rate and cost shown in the HUD is the number the sim uses. Randomness (flare timing and layer) is one mulberry32 stream stored in state and the seed is printed on the setup screen. Rules out: floating-point drift, hidden multipliers, purchasable power.
4. **One deterministic story per day.** The Daily Vein is derived from the UTC date alone, self-calibrated by a reference bot so the goal is provably reachable, and ranked only by server-side replay of the input log. Rules out: client-declared scores, past/future days, undo in ranked play.
5. **A diorama, not a dashboard.** The mine is a tabletop cross-section framed by an authored camera; workers, bins, the lift cage and flares are the readout. The DOM rails carry the numbers, the canvas carries the state. Rules out: camera swoops, post-processing, canvas-only controls.

## 3. Player experience

**Target player:** someone who likes incremental/optimization games but wants a bounded, replayable session with a score that means something — plus an endless mode for the idle fantasy.

**First 60 seconds:** Boot shows a progress meter with mine-flavoured status lines, then the title with key art, a live attract mine (Journey stage 1 replays behind the panel, reset every 300 s) and one dominant Play button. Play → "Choose your shift" cards (each states duration and ranked/casual). Learn is the intended first stop: lesson 1 "Hands in the Dark" starts with one idle worker and a banner "Assign them to Layer 1 (tap the layer, then Assign — or press A)"; every lesson step is completed by performing the real command (`main.js lessonCheckCommand`/`lessonCheckEarn`), and lessons unlock in order. Outside Learn, every run opens with a 1.8 s countdown (sim held), an objective line in the HUD, a Shift Report rail whose last line always names the next useful action (`ui.js bottleneckHint`), and disabled buttons that explain why (`reasonText`) in their tooltip.

**Session shape:** pick content → setup screen (seams, goal, time limit, par, mechanics, seed, ranked badge) → countdown → play (assign/hire/upgrade/unlock, claim flares) → terminal → results with a component breakdown, stars, best/achievement lines, board rank, and "Next" or "Retry".

**Emotional beat:** the moment a bin turns red, you buy the lift upgrade, and the income counter jumps — relief followed by the next constraint appearing one layer deeper.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; nothing else mutates state except through `DWSession.dispatch` → `DWRules.applyCommand`.

### 4.1 Entities (`createState`)
- `layers[i]` (i = 0…layerCount−1, max 6): `unlocked`, `workers`, `shaftLevel`, `milliOre` (bin contents), `carry`/`haulCarry` (sub-milli remainders).
- `workers {total, idle}`; all starting workers begin on layer 0.
- `lift {capLevel, speedLevel}`; `foreman {unlocked, enabled, cooldownMs}`; `flare {active:{layer,id,expiresTick}|null, nextAt, counter}`.
- `coins`, `lifetimeEarned`, `flareEarned` (milli-credits); `tick` (whole seconds, monotonic), `tickMs`; `stats {soldMilliOre, flaresClaimed, invalidActions, playerCommands, maxRateMilliOreSec}`; `terminal {reason, tick, won}|null`; `rngState`.

### 4.2 Standard ruleset (`defaultRuleset`; content overrides any field)
| Field | Value |
|---|---|
| layerCount / startUnlocked / startWorkers / startCoins | 6 / 1 / 2 / 50 credits |
| workerCapPerLayer | 5 |
| layerRich (milli-ore per worker per s) | 1200, 2200, 3800, 6200, 9800, 15000 |
| layerValue (milli-credits per ore) | 1000, 1600, 2600, 4200, 6800, 11000 |
| binCap (milli-ore) | 40k, 60k, 90k, 130k, 190k, 270k |
| lift: capBase 8000 milli-ore/trip ×1.65^level; cycleBase 4000 ms ×0.86^level, floor 600 ms | |
| shaft upgrade: rate ×1.30, bin ×1.45 per level | |
| costs (credits): hire 40×1.35^hires; shaft 60×(i+1)×1.75^level; lift cap 80×1.8^level; lift speed 70×1.85^level; unlock 150×2.6^(idx−startUnlocked); foreman 900 | |
| flares: next in 35–70 s (first at max(8, r/2)), duration 14 s, bonus mult 30 | |
| foreman interval 2 s; parSec 600; awayCapSec 28800; mechanics {flares, foreman, lift, shaftUpgrades} all on | |

### 4.3 Derived rates
- `layerRate(i)` = floor(workers × layerRich[i] × 1.30^shaftLevel) milli-ore/s; 0 if sealed.
- `binCapMilli(i)` = floor(binCap[i] × 1.45^shaftLevel); a bin is **blocked** at ≥ 98% (`isBlocked`).
- `liftRate` = liftCapacity × 1000 / liftCycleMs milli-ore/s. `incomeRate` allocates liftRate deepest-first across producing layers × value (what the HUD's "/s" shows).

### 4.4 Legal actions (`can`, `legalActions`) and stable reason codes
`assign(layer)` needs an unlocked layer, an idle worker, crew < cap (`layer-locked`, `no-idle-worker`, `worker-cap-reached`). `unassign(layer)` needs crew > 0 (`no-workers-assigned`). `hire`, `upgrade_shaft(layer)`, `upgrade_lift_cap`, `upgrade_lift_speed`, `unlock_layer` (next sealed index; `all-layers-unlocked`), `buy_foreman` (`already-owned`) all need `coins ≥ cost` (`insufficient-credits`, cost returned). `claim_flare(layer,id)` needs an unexpired flare with matching layer and id (`no-active-flare`, `flare-elsewhere`). Mechanics switched off by the ruleset answer `mechanic-unavailable`; `toggle_foreman` needs the foreman owned; `end_run` is always legal; after a terminal everything answers `run-ended`. Invalid and malformed commands are recorded (`stats.invalidActions++`) and never throw.

### 4.5 Resolution order (`advance` → `simulateStep`, fixed 100 ms slices)
1. **Extraction:** each crewed layer adds `rate × dt` milli-ore (remainder carried); bins clamp at capacity — overflow is lost, which is the stall.
2. **Transport + sale:** `liftRate × dt` of haul budget is spent deepest-first; sold ore pays `layerValue[i]` immediately into `coins` and `lifetimeEarned`.
3. **Flares:** an expired flare emits `flare_expired` and reschedules; when `tick ≥ nextAt` a random unlocked layer flares for 14 s (`flare_started`).
4. **Foreman:** if owned and enabled, every 2 s `foremanAct` assigns idle workers to the highest `layerRich × shaftMult × layerValue` non-blocked layer, then buys one thing: if any bin is blocked → lift capacity, else lift speed, else hire; otherwise hire, else unlock, else hire.
5. **Stats + terminal check.**
Player commands are applied between slices (`session.dispatch` flushes pending advance time to the log first).

### 4.6 Terminal states (`checkTerminal`, `end_run`)
- `goal-complete` (won): earn ≥ amount, or unlocked layers ≥ amount (or all unlocked), or total extraction rate ≥ amount.
- `time-up` when `tick ≥ limits.timeSec`; `moves-exhausted` when `playerCommands ≥ limits.moves`. Both are **won only if the ruleset has no goal** (a sprint without a goal is a win; a timed goal missed is a loss).
- `player-ended` via `end_run` (pause menu "End shift & bank score", or a completed lesson): won only in objective-free runs.

### 4.7 Scoring (`score`) — all integers in milli-credits
`total = earned + depthBonus + flares + timeBonus`, where `earned = lifetimeEarned` (sales **and** flare payouts), `depthBonus = unlockedCount × 250 credits`, `flares = flareEarned` (so flare credits count in both `earned` and `flares`), `timeBonus = (par − tick) × 5 credits` only when the run is won with a goal and `tick < par`. `efficiencyPermille = sold / (sold + ore still in bins)` is displayed ("Lift efficiency") but not summed.
**Worked example** (Journey 1 "First Shift", goal earn 500, par 220 s): finish at tick 180 with lifetimeEarned 500.4 credits, 2 layers open, flares disabled → earned 500,400 + depth 500,000 + flares 0 + time (220−180)×5,000 = 200,000 → total 1,200,400 milli, shown as "1,200"; stars = 3 (tick ≤ par).

### 4.8 Ordering and tie-breaks
`compareRuns`: terminal before non-terminal, won before lost, higher total, fewer invalid actions, lower tick. Server boards (`server.js sortBoard`): score desc, authoritative `durationSec` asc (replayed `state.tick`), earlier submission.

### 4.9 RNG, seeding, replay
`rngNext` is mulberry32 with state in `state.rngState` (`seed ^ 0x9e3779b9`); it is consumed only by flare scheduling and flare layer choice. Seeds: journey `FNV1a('deepworks.journey.N')`, lessons `'deepworks.<id>'`, challenges `'deepworks.ch.<x>'`, daily `'deepworks.daily.YYYY-MM-DD'`, practice random per run. `DWSession.replay` rebuilds terminal state from content + ordered log (`advance{ms}` entries coalesced every 5 s, player commands, invalid attempts included); `hashState` is FNV-1a over a canonical sorted-key JSON. Envelopes containing `undo_marker` refuse to replay.

### 4.10 Undo and hints
Undo exists only in Practice (`session.canUndo`): the pre-command state is serialized onto a 50-deep stack; `undo` pops it and appends an `undo_marker`. Hints are the Shift Report bottleneck line, disabled-button reasons, and lesson banners; there is no move-suggestion hint.

## 5. Modes and progression

| Mode | Content | Terminal | Ranked | Notes |
|---|---|---|---|---|
| Learn | 5 lessons (`LESSONS`): Hands in the Dark, Deeper Pockets, The Lift Is the Limit, Seam Flares, Going Deep | last step done → `end_run` (won) | no | Sequential unlock (`profile.lessons`); no countdown; flares/foreman enabled per lesson |
| Journey | 40 stages in 8 blocks of 5 (extraction, transport, depth, automation, scarcity, rate targets, long hauls, combined); every 5th is a mastery stage | goal earn/depth/rate, no time limit | no | Sequential unlock; stars 3/2/1 at ≤ par / ≤ 1.5× par / any; "Next" button chains stages |
| Daily Vein | `dailyInfo(date)`: 4–6 layers, 1–2 open, 2–4 workers, 100–400 credits, lift 5–10k / 3.5–6 s, hire 40–90, unlock 150–400, flares 25–45…50–90 s, random theme; goal type from [earn, earn, rate, depth] calibrated to 65% of the greedy bot's earnings / 80% of its peak rate / its depth | 900 s limit, par 720 | yes | Same seed for everyone; validated replay when hosted, local casual board otherwise; profile keeps best per day |
| Practice | Prospector / Miner / Foreman / Overseer overrides, random seed, endless | `end_run` from pause menu | no | Undo, autosave every 10 s, resume banner with capped away sim |
| Challenge | Ten-Minute Sprint (600 s, no goal), Hundred Moves (100 commands, earn 100k), Muscle and Bone (no lift upgrades), Half Crew (cap 2), Dropped at Depth (start at layer 4, tiny lift), Flare Frenzy (8–14 s flares, ×60 bonus, tiny bins) | per entry | no | Best score per challenge in profile |
| Score Chase | opens Leaderboards (daily / all-time) | — | — | Card on the mode grid |

Progression: profile mastery XP per run = 10 + 15 if won + min(25, floor(total / 5,000 credits)); level thresholds start at 50 XP and grow ×1.25 (max level 50). Five achievements (`UI.ACHIEVEMENTS`, keys mirrored in `server.js`): `first_completion`, `mechanic_mastery` (all lessons), `streak_7` (7 distinct daily days), `deep_milestone` (six seams open), `long_haul` (10 M career credits). Content validators (`validateContent`) prove every entry has a legal opening, a bounded end, an analytically reachable goal, and no soft lock after 5 min of greedy play; `tests/run.js` checks 30 upcoming dailies.

## 6. Controls and interaction

| Action | Keyboard (default `settings.keys`) | Pointer / touch | Gamepad |
|---|---|---|---|
| Select layer | ↑ / ↓ | tap a layer in the mine or its floating label | D-pad up/down |
| Assign / recall | Enter / U | + Assign / − Recall (right rail or bottom tray) | A / B |
| Hire | H | Hire | — |
| Shaft, lift capacity, lift speed | Q / W / E | buttons with cost | — |
| Open next layer | D | Open Layer N | — |
| Claim flare | F (or tap the flaring layer) | ✦ Flare button / tap layer | A on the flaring layer |
| Foreman buy / toggle | G | Buy Foreman / Foreman: ON | — |
| Undo (practice) | Z | Undo (Z) | — |
| Pause / resume | Esc | ⏸ | Start |
| Orbit camera | — | drag > 8 px (yaw clamped ±20°) | — |

Rules: a tap on the canvas raycasts only the per-layer hit boxes; travel beyond 8 px becomes a drag and never selects. Tapping a flaring layer claims it directly. Keys are ignored while an input/select is focused, on screens other than play, and during the countdown (Esc opens the pause panel instead). Every accepted command plays its clip, may spawn VFX, vibrates 8 ms when haptics are on, and refreshes the HUD; every rejected command plays `error`, toasts the reason, announces it assertively, and blinks the red HUD anchor in the scene. Command ids (`session.newCmdId`) dedupe repeats within the last 50 log entries instead of debounce timers. "Hold to repeat assign" (settings) makes the Assign button auto-repeat every 260 ms while held.

## 7. Screens and UI flow

`boot → title → modes → setup → play ⇄ settings(paused) → results → (play next | title)`, plus `title → journey | boards | help | settings | profile` (`ui.js show/back`, a 12-deep nav stack; `back` from play or boot lands on title). Backgrounding the tab autosaves practice and opens the pause panel; resizing while paused repaints the frozen frame.

- **Title:** key art, logo, tagline, resume banner (saved practice shift: Resume / Abandon), Play, Daily Vein (with "new in Xh Ym"), Journey (n/40), Profile; links How to play, Leaderboards, Settings; identity line.
- **Setup:** rules card (seams, goal, time limit, par, mechanics, seed, ranked/casual badge), hint or description, Start shift / Back.
- **Play HUD:** top bar (objective + progress meter, credits / income / idle-total workers, timer or remaining time + moves, pause); left rail "Shift Report" (elapsed, depth, extraction, lift capacity, lifetime earned, goal %, par, bottleneck hint); right rail "Foreman's Panel" (selected layer: crew, rate, bin %, shaft level, Assign/Recall/Upgrade shaft/Claim flare; mine-wide: hire, lift cap, lift speed, open layer, foreman, undo); lesson banner; countdown; floating layer labels (`L3 ⚒2 ▲FULL ✦`, `🔒` when sealed) projected from the 3D anchor each frame.
- **Pause (settings in pause mode):** Resume, Restart shift, End shift & bank score (practice), Leave shift, then all settings groups.
- **Results:** outcome illustration, headline (Objective complete / Time is up / Out of moves / Shift ended), content name, stars, big score, breakdown (ore sold, seam flares, depth bonus, time bonus, lift efficiency, elapsed, commands/invalid), new best, achievements, board line, Next / Retry / Shift select.
- **Journey grid, Leaderboards (Daily / All-time tabs, casual note), Help (rule cards generated from current key bindings + "Describe the current mine aloud"), Profile (name, mastery meter, career stats, achievements).**

Layout: ≥ 1024 px — rails fixed at 260 px (left) and 280 px (right), top bar 70 px, panels max 640/900 px, 70ch line length. < 1024 px — rails become slide-in drawers with ◧/◨ toggles. ≤ 640 px or coarse pointer ≤ 900 px — bottom thumb tray (Assign, Shaft, Hire, Open L n, Flare), resources row wraps under the objective. Landscape ≤ 500 px tall — rails 220 px, tighter cells, decorative art hidden. All fixed chrome pads with `env(safe-area-inset-*)`; every button is ≥ 44 × 44 px; toasts sit 90 px above the bottom inset, captions 8 px above it. Must never be cut off: the objective text, credits, the pause button, the bottom tray, the lesson banner.

## 8. Art direction

**Palette (`css/styles.css`):** background `#100a06`, panel `rgba(24,15,10,.92)` / `#1c120c`, line `#3a2a1c`, text `#f0e4d4`, dim `#b8a68e`, accent `#ffb35c`, strong `#ff9a3c`, good `#7dff9e`, bad `#ff6a5e`, warn `#ffd23c`, focus `#8fd6ff`. Theme accents: glacier `#8fe0ff`/`#6fd6ff` on `#070d13`, verdant `#9dffb4`/`#7dff9e` on `#070d08`, amethyst `#d09aff`/`#c07dff` on `#0c0712`, ashen `#ffe066`/`#ffd23c` on `#0a0a0c`. High contrast: black/white/`#ffff00`/`#00ffff`. Colour-vision palettes: deuter/protan accent `#4cc9f0`, good `#f5d90a`, bad `#f72585`; tritan accent `#ff8fa3`, good `#06d6a0`, bad `#ffd166`.

**Scene themes (`content.js THEMES`)** drive rock, seam, fog, key/fill light, accent and lift colours: Emberdeep (rock `#2b1d18`, seam `#ff9a3c`, hot `#ffd28a`, fog `#140b06`, key `#ffc890`, fill `#3a4a66`), Glacier Vault (`#1d2733`, `#6fd6ff`), Verdant Hollow (`#1e2a1c`, `#7dff9e`), Amethyst Rift (`#241d2e`, `#c07dff`), Ashen Gallery (`#26262a`, `#ffe066`). Themes are cosmetic; the run's content picks the theme, the setting picks it for practice.

**Shape language:** low-poly diorama — slab galleries 15 × 2.1 × 3 units stacked 3.2 apart, a 2.6-unit timber shaft, instanced octahedral crystal shards on the back walls (24/48/80 per layer by tier), cone workers, box-frame ore bins with a growing fill block and an inverted-cone BLOCKED marker, a caged lift on a cable, hut + hopper + headframe on the surface. Camera: 30° FOV at (0, −6, 37) looking at (0, −7.2, 0), pulled back on narrow aspects so the full width always fits. ACES tone mapping, exposure 1.5, sRGB output, PCF soft shadows; no post-processing.

**The hero** is the mine itself: seams glow (emissive 0.85 ± 0.18 idle, 1.7 ± 0.8 flaring), the selected layer rises 0.32 units with an accent rim and grounded ring, bins turn `#ff6622` and pulse when blocked, the flare marker (hot-seam octahedron) bobs above the flaring gallery.

**Typography:** Segoe UI / system-ui; logo 2.6 em, 800 weight, 0.12 em tracking with the accent on "DEEP"; tabular numerals on every counter; large-text setting scales the root by 1.25.

**Motion:** critically damped springs only (selection lift, camera yaw, lift target depth), idle sway 0.35 units, lift rides a smoothstep triangle at the rules' cycle time, pooled additive particles (512; 35%/70%/100% by tier). Event tiers: acknowledgement (button transitions) < legal move (coin burst, surface glow) < unlock (60-particle burst + 0.22 shake) < completion (screen flash, 0.55 shake, 210 particles). Reduced motion (setting or `prefers-reduced-motion`) zeroes sway, shake, bob and ring pulse, halves flare pulse, drops particles to 35%, and disables CSS animation; camera sway can be switched off alone.

**Visual assets the design calls for:** title key art (mine cross-section), a results illustration for a completed shift and for an ended/failed shift, a "while you were away" night-surface illustration, and 16:9 cover art. All are in `assets/` and inventoried in §15; no external 3D models — all geometry is procedural.

## 9. Audio direction

Mix: four gain buses (music 0.5, effects 0.8, ambience 0.4, voice 0.6 defaults) under a master that mutes on "Mute all" and while the tab is hidden; sliders in settings. Ambience is a looped brown-noise rumble low-passed at 220 Hz with a 0.07 Hz breathing LFO. Music is a generative A-minor-pentatonic pattern (375 ms step, bass every 4th step) whose sparkle voice appears when `intensity = extractionRate / 400 ore/s` exceeds 0.25 and jumps an octave above 0.6. Effects prefer the authored Opus clip (fetched after the first user gesture, decoded once, cached); until decoded or if loading fails the synthesized fallback in `SOUNDS` plays, so no cue is ever silent. Pitch variants for synth cues use a per-run LCG seeded from the content seed. Every meaningful cue has a caption shown at the bottom of the screen (toggle "Text captions for sounds").

| Event id | File | Sound | Usage |
|---|---|---|---|
| ui_click | ui-click.opus | crisp wooden toggle click | every button press, layer select |
| ui_back | ui-back.opus | low wooden thunk + whoosh | back buttons, closing pause |
| error | error-denied.opus | muted double mallet knock | rejected command, no flare to claim |
| assign | worker-assign.opus | pickaxe strike with tunnel echo | worker assigned |
| unassign | worker-recall.opus | boots scuffing back on gravel | worker recalled |
| hire | worker-hire.opus | brass hand bell rung twice | worker hired |
| upgrade | upgrade-complete.opus | ratchet clicks then bolt clank | shaft / lift cap / lift speed bought |
| unlock_layer | layer-unlock.opus | stone slab grinding open, rumble | layer opened |
| claim_flare | flare-claim.opus | crystals and coins into a pan | flare claimed |
| flare_started | flare-warning.opus | rising gas hiss with tremor | rules `flare_started` |
| coin | coin-clink.opus | single coin clink | every third 100-credit earnings bucket |
| foreman | foreman-whistle.opus | short wooden whistle chirp | foreman bought / toggled |
| terminal_win | shift-victory.opus | brass mine bell ×3, cavern reverb | run closed won |
| terminal_lose | shift-defeat.opus | timbers creaking, weary thud | run closed lost |
| undo | undo-swipe.opus | reverse paper swipe | practice undo |
| bin_blocked | bin-blocked.opus | gravel jamming in a chute, hollow clunk | a bin first reaches 98% (`main.js checkBottleneck`, ≤ 1 per 8 s) |
| flare_expired | flare-fizzle.opus | flame sputtering out, faint pop | rules `flare_expired` |
| lesson_step | lesson-chime.opus | two ascending xylophone notes | lesson step completed |
| shift_start | shift-start.opus | one steam-whistle blast | countdown ends, sim starts |
| achievement | achievement-star.opus | crystal chime with sparkle tail | achievement unlocked |
| away_return | away-return.opus | hut door creak + door bell | "While you were away" summary opens |

This table is the source of `sfx/manifest.txt`; `sfx/manifest.json` carries the same 21 entries as generator input.

## 10. Localization

Shipped language: **English (en-US)** only. All strings are literals in `js/ui.js`, `js/main.js`, `js/content.js` and `index.html`; `DWRules.formatCoins` formats with `toLocaleString('en-US')`. There is no language selector and no detection of `navigator.language`. The product requirement (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) is not met — see Known limitations and Design intent. Layout already tolerates ~30% expansion: buttons wrap (`flex-wrap`), panels scroll, the objective text ellipsizes, and `[dir="rtl"]` flips the rails.

## 11. Accessibility

- **Keyboard-only path:** skip link → title focus lands on Play; every screen moves focus to its first button on show; modals trap Tab, close on Esc and restore focus; all play actions have keys (§6); rails are real buttons with reasons in `title`.
- **Screen reader:** `#live-polite` receives objective, lesson steps, flare start/fade, layer opened, flare claimed, paused/resumed, bottleneck warnings; `#live-assertive` receives rejections and results; `DWRules.describeState` narrates the whole mine from Help; layer labels are buttons; HUD resources are `role=status`.
- **Captions:** every meaningful sound has a text caption (§9); no information is audio-only.
- **Contrast and colour:** text `#f0e4d4` on `#1c120c`; high-contrast mode; three colour-vision palettes; blocked bins change shape (marker + pulse) and label text (▲FULL), flares add ✦ and a border, sealed layers show 🔒.
- **Motion and timing:** reduced motion (§8), camera sway toggle, timing assistance doubles the flare window in casual modes (excluded from the ranked daily so replays stay identical).
- **Targets and layout:** 44 px minimum, 8 px gaps, left-handed rail swap, larger text, hold-to-repeat, haptics off, tutorial replay from settings.

## 12. StarHermit integration

`starhermit.txt`: `name=Deepworks`, `launch=index.html`, `owner=…`, `server=server.js`, `cover=coverart.png`.

**Used:** hosted mode is detected by a `?launch=` (or `?token=`) launch token on an http(s) origin (`platform.init`); the token is sent as `Authorization: Bearer` on same-origin `/api/v1` calls and never stored; its unsigned payload supplies `scope`, display name and avatar for display only. `GET /api/v1/time` syncs the clock with round-trip adjustment so the daily countdown and day key follow platform time. `POST /api/v1/scores/daily` submits `{dayKey, contentVersion, seed, name, scoreTotal, durationSec, playerId, clientHash, log}`; `server.js` rebuilds the content from the day key, rejects non-current days (409 `day-not-current`), stale content versions, seed mismatches, malformed logs and bad player ids, replays the log with `DWSession.replay`, requires the recomputed hash to equal `clientHash`, and stores the recomputed score and elapsed time keyed by `playerId` (100 rows per day, 30 posts / 10 s per IP). `GET /api/v1/scores/daily[?day=]` and `/scores/global` (best per player across days) feed the Leaderboards screen. `POST /api/v1/achievements/<key>` is idempotent for the five declared keys. Activity start/end and a 60 s presence heartbeat are posted around every run; consent-gated funnel telemetry (`start, tutorial_step, round_end, retry, settings_change, error`) goes to `/api/v1/telemetry`. Structured `{"error":…}` and 429 responses surface as recoverable UI text.

**Not used:** realtime sessions, rooms, matchmaking, chat/voice, cloud saves (profile is `localStorage`), friends filtering (the `friends=1` query exists in `platform.getBoard` but no UI calls it), host-driven sign-in (guest profile with a persistent random `playerId`). Standalone (no token) everything degrades to local casual boards and local achievement flags, per https://wiki.starhermit.com/ conventions for offline-capable solo games.

## 13. Technical architecture

- **Modules** are classic scripts with UMD wrappers (`rules`, `content`, `session` also load in Node for tests and the server). Dependency order: three → rules → content → session → platform → audio → render → ui → main.
- **Determinism:** fixed 100 ms slices, integer state, single RNG stream in state, canonical hashing; content is versioned (`CONTENT_VERSION = 1`, rules `VERSION = 1` with a migration chain in `migrate`). Replay envelope: `{schema:1, contentVersion, contentId, mode, seed, startedAt, log, hashes (every 20 log entries), result}`.
- **Frame loop (`main.js frame`):** rAF; `dt` clamped to 250 ms; countdown gate; `session.tick` advances the run; HUD rebuild every 200 ms only when the rail signature changes (protects focus); practice autosave + profile playtime every 10 s; renderer receives the immutable state snapshot each frame; an attract state animates behind the title.
- **Persistence (`localStorage`):** `deepworks.run.v1` (checksummed practice snapshot + log), `deepworks.profile.v1` (checksummed profile with settings), `deepworks.boards.v1` (offline casual boards), `deepworks.telemetry.v1` (offline event buffer, 200 max). Quota/security errors return `false` instead of throwing. Away simulation on resume: min(elapsed, 8 h) advanced in 60 s chunks, summary modal when > 30 s.
- **Rendering budgets:** quality tiers low/medium/high cap DPR at 1/1.5/2, crystals 24/48/80 per layer, particles 35%/70%/100%, shadows off/512/1024; antialiasing fixed at creation; no per-frame allocations in `setSnapshot`; shaders precompiled before the first frame; the renderer stops when hidden or paused and repaints on resize. Failure to create WebGL falls back to a DOM board of layer buttons over the key art with a toast.
- **Server:** zero-dependency Node http; static files with path containment; `tests/`, `tools/`, `node_modules/`, `data/` and dotfiles are refused; MIME for html/js/css/json/png/webp/svg/opus/txt; vendor files immutable-cached; 1 MB body cap; per-IP token buckets; atomic JSON writes flushed on SIGTERM/SIGINT.
- **E2E drive:** `tests/e2e.mjs` serves the repo from an embedded static server on an ephemeral port, launches headless Chrome with SwiftShader, and clicks the visible UI (title → settings → modes → practice setup → countdown → hire/assign/upgrade via keys on desktop and via the thumb tray, layer labels and rail drawer on a 390 × 844 touch viewport → undo → pause/resume → end shift → results → journey → help), failing on any page error or console error.

## 14. Testing and acceptance criteria

`npm test` (`tests/run.js`, 5210 assertions): legal actions and every reason code; simulation and economy (monotonic tick, bin blocking, upgrade effects, seeded flares and claims, foreman automation); terminal states (goal, time, moves, end_run, commands after terminal); scoring components and tie-breaks; serialization, migration chain and corrupt input; deterministic replay property test; malformed-command fuzz; content validation of every lesson/stage/challenge and 30 dailies plus daily immutability; golden sessions (easy/medium/hard/interrupted/resumed/terminal) and idempotent duplicate command ids; undo; 2 h away simulation.
`node tests/e2e.mjs`: the desktop and mobile playthroughs in §13. `node tests/balance.js`: the greedy bot must win all 40 stages, 6 challenges and 7 upcoming dailies. `tests/review-fixes.mjs`: pause/countdown/visibility/timing-assist/offline-board regressions.

QA bar (agents/qa.md) as checkable statements: the first lesson and every stage explain the next action on screen; every feature in this document is reachable by clicking visible controls on desktop and on a 390 px touch viewport; no console errors or warnings during the e2e drive; no text or control is cut off at 1280 × 800, 390 × 844 portrait or ≤ 500 px-tall landscape; StarHermit features used are exactly those in §12.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1200 × 672, 37 KB) | title-panel hero, WebGL-fallback backdrop | FLUX.2 klein, seed 2712, 28 steps | generated in this pass, wired |
| `assets/shift-complete.webp` (640 × 400, 16 KB) | results illustration when the shift is won | FLUX.2 klein, seed 6001 | generated in this pass, wired |
| `assets/shift-over.webp` (640 × 400, 7 KB) | results illustration when the shift ends or is lost | FLUX.2 klein, seed 6002 | generated in this pass, wired |
| `assets/crew-at-night.webp` (640 × 400, 19 KB) | "While you were away" modal | FLUX.2 klein, seed 6003 | generated in this pass, wired |
| `coverart.png` (1200 × 675, 256-colour) | platform cover | key art rescaled (replaces the generic placeholder) | generated in this pass |
| `icon.png`, `favicon.svg` | platform icon, tab icon | authored SVG | shipped |
| `sfx/*.opus` — 15 original clips (§9 rows 1–15) | event SFX | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/bin-blocked.opus`, `flare-fizzle.opus`, `lesson-chime.opus`, `shift-start.opus`, `achievement-star.opus`, `away-return.opus` | new event SFX (§9 rows 16–21) | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | canonical binding table / generator input / generator output | — | shipped |
| 3D models, character animation | — | TRELLIS / Kimodo | not called for: all geometry is procedural, no humanoid rig |

## 16. Known limitations

- Only English ships; no locale switch or translated strings (fleet-wide debt).
- Hosted achievement unlocks are posted without a player name, so `server.js` files them all under `guest`; local achievement flags in the profile are correct.
- Boards highlight "me" by display name, not `playerId`; two players with the same name both highlight.
- The endless-practice "bank score" plays `terminal_win` whose caption reads "Objective complete" although the results headline says "Shift ended".
- No per-player submission limit on the daily board (per-IP bucket only); board flooding under many `playerId`s is possible.
- `validLog` bounds the number of log entries, not the total simulated milliseconds; harmless today because every ranked run terminates on its own limit.
- `foremanAct` cooldown can go negative if a step ever exceeds the 2 s interval (unreachable with 100 ms slices).
- Gamepad bindings (`settings.pad`) are not editable in the UI; keyboard bindings are stored but only editable by changing the profile.
- `tests/e2e.mjs` ignores `BASE_URL`/`PORT` and always binds an ephemeral port.
- Under SwiftShader the sky gradient renders as a flat band; hardware GL is unaffected.

## Design intent not yet implemented

- Localization into the nine required locales with a string table and language selection.
- Friends-only board filter and host-driven sign-in / cloud-saved profile.
- In-game key and gamepad remapping.
- A dedicated caption for banking an endless shift.
