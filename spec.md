# Deepworks — Game Design Document (running spec)

**Status:** shipped; this document describes the game as it runs today (present tense). Anything not yet built is listed under "Design intent not yet implemented" at the end.

## 1. Overview

**Pitch:** Crew a layered mine, feed one overworked lift, find the bottleneck, fix it, automate — and keep earning while you're away.
**Genre:** idle optimization / throughput puzzle. **Players:** 1 (asynchronous daily score comparison). **Session:** 2–4 min lessons, 3–20 min journey stages, 15 min daily, endless practice.
**Platforms:** a StarHermit engine script game (engine 1.26.1, host API 1.28, `engine.minor=28`): played natively by the StarHermit client and in desktop and mobile browsers (portrait and landscape) by the engine's web runtime, from one package.
**Rendering:** a `starhermit:scene` diorama of a vertical mine cross-section under a `starhermit:ui` HUD; every action is also a button in the HUD.

| Path | Role |
|---|---|
| `starhermit.txt` | Manifest: name, description, owner, `server=score-script.js`, cover, `launch=index.html`, `engine.api/entry/version/minor/capabilities` (platform, storage, clipboard), one `control.*` and `engine.gamepad.*` line per action, Options groups |
| `index.html`, `starhermit-files.json` | The engine's web loader and the package's file index, written by `npm run package` (`starhermit package --web .`); never edited by hand |
| `native/main.ts` | Entry module: state machine, runs and their fixed-step clock, command dispatch, lessons, bottleneck cue, achievements, results bookkeeping, input (actions, taps, drag, hold to repeat), lifecycle |
| `native/screens.ts` | Every screen, the HUD, dialogs, toasts and captions on `starhermit:ui`, with the browser build's breakpoints as layouts |
| `native/render.ts` | The mine on `starhermit:scene`: procedural textures, layers, lift, particles, camera, picking, the look per graphics level |
| `native/quality.ts` | The browser build's presets and budgets per runtime quality tier and level (`lookFor`) |
| `native/audio.ts` | Clips per event on the runtime's buses, the rumble and the music rendered into clips, captions |
| `native/platform.ts` | The profile as the engine save (+ `localStorage` shim, conflict merge, migration of the browser build's cloud save and settings), the game's own options, player, invite link, platform clock, boards and score posting |
| `native/style.ts`, `assets/ui-style.json`, `tools/ui-style.css` | The style sheet (class-based rewrite of the old CSS, converted with `starhermit css`), the theme, palette and high-contrast token sets |
| `native/i18n.ts`, `native/classic.ts`, `native/glyphs.ts` | Interface language → `DWI18n`; the classic scripts loaded with `loadClassic` and their types; drawn symbols (◈ ↻ ⚒ 🔒 ✦ ▲ ⏸) |
| `js/rules.js` | Pure deterministic rules engine (`DWRules`): ruleset, legality, fixed-point sim, scoring, serialization, seeded RNG |
| `js/content.js` | Versioned content (`DWContent`): 5 themes, 5 lessons, 40 journey stages, 6 challenges, 4 practice difficulties, daily generator, validators, greedy reference player |
| `js/session.js` | Run lifecycle (`DWSession`): command dispatch with idempotent ids, replay log, undo, autosave, away simulation, profile, stars/mastery |
| `js/lift.js` | The lift's cosmetic itinerary (`DWLift`, pure): deepest-first trips docking at each floor |
| `js/i18n.js`, `js/locales/*.js` | `DWI18n`: `T(US-English text, vars)` and the per-language dictionaries |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished run's score and posts it to the `high-score` leaderboard |
| `server.js` | Local dev server (not packaged): static files + `/api/v1` with its own replay-validated daily board |
| `assets/` | Key art and illustrations (`key-art.webp`, `shift-complete.webp`, `shift-over.webp`, `crew-at-night.webp`), `ui-style.json` |
| `sfx/` | 21 Opus clips, `manifest.txt` (canonical), `manifest.json`, `manifest.md` |
| `tests/`, `tools/` | Unit, save, i18n and native tests; css, package, play-script, i18n-sync and browser-play tools (not packaged) |
| `coverart.png`, `icon.png`, `cover.jpg`, `LICENSE.md` | Platform packaging (PolyForm Noncommercial 1.0.0) |

## 2. Vision and design pillars

1. **The lift is the game.** Every layer digs into its own bin, but only one lift sells ore, deepest-first. Income is capped by transport, not by crew size, so the interesting decision is always "what is the bottleneck right now?". Rules in: bins that visibly fill and stall, a red BLOCKED gauge, a hint line that names the bottleneck. Rules out: parallel transport, per-layer sales, any upgrade that bypasses the lift.
2. **Idle, but never passive.** The economy runs on its own (and for up to 8 h while the tab is closed in Practice), but seam flares reward attention with a 14-second window and a payout of 30 seconds of a layer's output. Rules in: flares, foreman automation you can buy and switch off, "while you were away" summaries. Rules out: taps-per-second play, timing puzzles, punishment for leaving.
3. **Whole numbers, no secrets.** Ore is milli-ore, credits are milli-credits, time is whole milliseconds; every rate and cost shown in the HUD is the number the sim uses. Randomness (flare timing and layer) is one mulberry32 stream stored in state and the seed is printed on the setup screen. Rules out: floating-point drift, hidden multipliers, purchasable power.
4. **One deterministic story per day.** The Daily Vein is derived from the UTC date alone, self-calibrated by a reference bot so the goal is provably reachable, and ranked only by server-side replay of the input log. Rules out: client-declared scores, past/future days, undo in ranked play.
5. **A diorama, not a dashboard.** The mine is a tabletop cross-section framed by an authored camera; workers, bins, the lift cage and flares are the readout. The HUD rails carry the numbers, the scene carries the state. Rules out: camera swoops, screen effects that hide state (post-processing only adds glow, contact shadow and a grade), canvas-only controls.

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
| Daily Vein | `dailyInfo(date)`: 4–6 layers, 1–2 open, 2–4 workers, 100–400 credits, lift 5–10k / 3.5–6 s, hire 40–90, unlock 150–400, flares 25–45…50–90 s, random theme; goal type from [earn, earn, rate, depth] calibrated to 65% of the greedy bot's earnings / 80% of its peak rate / its depth | 900 s limit, par 720 | yes | Same seed for everyone; signed in, the score goes to the platform high-score board, otherwise to the local casual board; profile keeps best per day |
| Practice | Prospector / Miner / Foreman / Overseer overrides, random seed, endless | `end_run` from pause menu | no | Undo, autosave every 10 s, resume banner with capped away sim |
| Challenge | Ten-Minute Sprint (600 s, no goal), Hundred Moves (100 commands, earn 100k), Muscle and Bone (no lift upgrades), Half Crew (cap 2), Dropped at Depth (start at layer 4, tiny lift), Flare Frenzy (8–14 s flares, ×60 bonus, tiny bins) | per entry | no | Best score per challenge in profile |
| Score Chase | opens Leaderboards (offline: daily / all-time casual boards; signed in: the platform high-score board) | — | — | Card on the mode grid |

Progression: profile mastery XP per run = 10 + 15 if won + min(25, floor(total / 5,000 credits)); level thresholds start at 50 XP and grow ×1.25 (max level 50). Five achievements (`UI.ACHIEVEMENTS`, keys mirrored in `server.js`): `first_completion`, `mechanic_mastery` (all lessons), `streak_7` (7 distinct daily days), `deep_milestone` (six seams open), `long_haul` (10 M career credits). Content validators (`validateContent`) prove every entry has a legal opening, a bounded end, an analytically reachable goal, and no soft lock after 5 min of greedy play; `tests/run.js` checks 30 upcoming dailies.

## 6. Controls and interaction

Actions are the manifest's (players rebind keys and pad buttons in the runtime's Options › Controls, or from Settings › Controls › Change keys and buttons); How to play and the lesson prompts show the player's real keys.

| Action (`control.*`) | Keyboard | Pointer / touch | Gamepad |
|---|---|---|---|
| Select layer (`up`, `down`) | ↑ / ↓ | tap a layer in the mine or its floating label | D-pad / left stick up, down |
| Assign / recall (`assign`, `unassign`) | Enter / U | + Assign / − Recall (Foreman's Panel or the phone tray) | A (claims the flare when the selected layer flares) / B |
| Hire (`hire`) | H | Hire | Y |
| Shaft, lift capacity, lift speed (`shaft`, `liftcap`, `liftspeed`) | Q / W / E | buttons with cost | RB / LT / RT |
| Open next layer (`unlock`) | D | Open Layer N | LB |
| Claim flare (`flare`) | F (or tap the flaring layer) | ✦ Flare button / tap layer | X |
| Foreman buy / toggle (`foreman`) | G | Buy Foreman / Foreman: ON | Select |
| Undo, practice (`undo`) | Z | Undo (Z) | left stick press |
| Pause / resume / back (`pause`) | Esc | pause button | Start |
| Turn the mine | — | drag > 8 px (yaw clamped ±20°) | — |

Rules: a tap on the mine casts onto each layer's box (wider and deeper than the cavern); travel beyond 8 px becomes a drag and never selects; presses on the HUD's panels are theirs. Tapping a flaring layer claims it directly. Keys act only during play; Enter on a focused HUD button activates that button instead of assigning; arrows hand the keys back from the HUD to the mine. Every accepted command plays its clip, may spawn effects and vibrates 8 ms when haptics are on; every rejected command plays `error`, toasts the reason, announces it assertively and blinks the red marker by the depot. Command ids dedupe repeats. "Hold to repeat assign" makes a held Assign button repeat every 260 ms. The HUD is immediate-mode, so a click always lands on the button it was pressed on, whatever the economy does meanwhile.

## 7. Screens and UI flow

`title → modes → setup → play ⇄ settings(paused) → results → (play next | title)`, plus `title → journey | boards | help | settings | profile` (`main.ts show/back`, a 12-deep nav stack; `back` from play lands on title; Esc backs out of every screen). The runtime shows its own loader while the package starts. A hidden window (the runtime's suspend) autosaves practice and opens the pause panel. The 3D mine always draws behind the menus: an attract mine (Journey stage 1, restarting every 5 minutes) behind the title.

- **Title:** key art, logo, tagline, resume banner (saved practice shift: Resume / Abandon), Play, Daily Vein (with "new in Xh Ym"), Journey (n/40), Profile; links How to play, Leaderboards, Settings; identity line.
- **Setup:** rules card (seams, goal, time limit, par, mechanics, seed, ranked/casual badge), hint or description, Start shift / Back.
- **Play HUD:** top bar (objective + progress meter, credits / income / idle-total workers, timer or remaining time + moves, pause); left rail "Shift Report" (elapsed, depth, extraction, lift capacity, lifetime earned, goal %, par, bottleneck hint); right rail "Foreman's Panel" (selected layer: crew, rate, bin %, shaft level, Assign/Recall/Upgrade shaft/Claim flare; mine-wide: hire, lift cap, lift speed, open layer, foreman, undo); lesson banner; countdown; floating layer labels (`L3 ⚒2 ▲FULL ✦`, a lock when sealed; the symbols are drawn shapes) projected from the 3D anchor each frame; they are buttons.
- **Pause (settings in pause mode):** Resume, Restart shift, End shift & bank score (practice), Leave shift, then all settings groups.
- **Results:** outcome illustration, headline (Objective complete / Time is up / Out of moves / Shift ended), content name, stars, big score, breakdown (ore sold, seam flares, depth bonus, time bonus, lift efficiency, elapsed, commands/invalid), new best, achievements, leaderboard rank line (signed in, Journey/Daily/Challenge only), Next / Retry / Shift select.
- **Journey grid, Leaderboards (offline: Daily / All-time casual tabs; signed in: one High score tab from the platform board), Help (rule cards generated from current key bindings + "Describe the current mine aloud"), Profile (name, mastery meter, career stats, achievements).**

Layout (`screens.ts`, by the window's logical size): ≥ 1024 px — the rails sit beside the mine (260 px left, 280 px right; their content scrolls when taller). < 1024 px — the rails are drawers opened by the two toggles under the top bar (one at a time). ≤ 640 px, a touch screen ≤ 900 px, or a landscape window ≤ 500 px tall — the phone layout: the bottom thumb tray (Assign, Shaft, Hire, Open L n, Flare; reversed when left-handed), the resources on a second top-bar row between the drawer toggles. Landscape ≤ 500 px tall — 220 px rails, the lesson card docked left, decorative art hidden. Screens are centred panels (max 640/900 px) that scroll when taller than the window; on short windows the title's key art shrinks first. Everything sits inside the runtime's safe area; buttons are ≥ 44 px; toasts sit 90 px above the bottom during play and at the top while a screen is up; captions sit at the bottom. The mine is framed into the band between the top bar (and a wide lesson card) and the tray with a camera view offset, so labels never hide under the HUD. The runtime's interface size and text size scale the whole UI (the old `ui-scale.js`).

## 8. Art direction

**Palette (`css/styles.css`):** background `#100a06`, panel `rgba(24,15,10,.92)` / `#1c120c`, line `#3a2a1c`, text `#f0e4d4`, dim `#b8a68e`, accent `#ffb35c`, strong `#ff9a3c`, good `#7dff9e`, bad `#ff6a5e`, warn `#ffd23c`, focus `#8fd6ff`. Theme accents: glacier `#8fe0ff`/`#6fd6ff` on `#070d13`, verdant `#9dffb4`/`#7dff9e` on `#070d08`, amethyst `#d09aff`/`#c07dff` on `#0c0712`, ashen `#ffe066`/`#ffd23c` on `#0a0a0c`. High contrast: black/white/`#ffff00`/`#00ffff`. Colour-vision palettes: deuter/protan accent `#4cc9f0`, good `#f5d90a`, bad `#f72585`; tritan accent `#ff8fa3`, good `#06d6a0`, bad `#ffd166`.

**Scene themes (`content.js THEMES`)** drive rock, seam, fog, key/fill light, accent and lift colours: Emberdeep (rock `#2b1d18`, seam `#ff9a3c`, hot `#ffd28a`, fog `#140b06`, key `#ffc890`, fill `#3a4a66`), Glacier Vault (`#1d2733`, `#6fd6ff`), Verdant Hollow (`#1e2a1c`, `#7dff9e`), Amethyst Rift (`#241d2e`, `#c07dff`), Ashen Gallery (`#26262a`, `#ffe066`). Themes are cosmetic; the run's content picks the theme, the setting picks it for practice.

**Shape language:** low-poly diorama — slab galleries 15 × 2.1 × 3 units stacked 3.2 apart, a 2.6-unit timber shaft, instanced octahedral crystal shards on the back walls (per preset, below), cone workers, box-frame ore bins with a growing fill block and an inverted-cone BLOCKED marker, a caged lift on a cable, hut + hopper + headframe on the surface. Camera: 30° FOV at (0, −6, 37) looking at (0, −7.2, 0), pulled back on narrow aspects so the full width always fits. ACES tone mapping, exposure 1.15, sRGB output; lighting and effects follow the Graphics settings (below).

**Graphics.** A warm key light casts soft shadows (the engine fits the directional shadow to the view; `shadow.distance` covers the mine); a hemisphere fill and a cool rim light keep every gallery readable, and each open layer has a seam-coloured lamp with a slow shimmer. Colours keep the browser build's meaning (its sRGB swatches are the engine's hex colours, its raw r128 values set as linear), and r128's light intensities are the engine's convention; the lamps are brighter at the source because the engine's point lights fall off with the inverse square. The look follows the runtime's graphics level (Options › Graphics: Auto or a level, render scale, frame-rate limit and readout, adaptive resolution are the runtime's): `native/quality.ts` maps the level's quality tier to the browser build's preset — Low (no shadows, plain detail, MSAA, no post), Balanced (1024² shadows, bloom, grade, FXAA, reflections, detail), High (2048², ambient occlusion, SMAA), Ultra (4096², high AO, MSAA) — where reflections are image-based lighting from `PMREMGenerator.fromScene(new RoomEnvironment(renderer), 0.04)` with the old per-material `envMapIntensity`; detail is the bump-mapped procedural rock, clear-coated `MeshPhysicalMaterial` crystals and emissive helmet lamps; bloom is `renderer.bloom` (strength 0.5, radius 0.22, threshold 0.88); the grade is `renderer.grade` in display space (S-curve, saturation 1.1, cool shadows / warm highlights, 0.28 vignette); AO is `renderer.ao`. The runtime holds shadow-map size and MSAA samples to the level.

**Per-preset budgets** (`lookFor(tier, levelIndex)`; the browser build's js/gfx.js budgets, each tuned to hold 60 FPS on the weakest GPU its Auto gave the preset). Counts scale up within the tier with the level (about 1.64× a level above the tier's first, ≤ 4×, within the pools); gameplay is identical on every level.

| Budget | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Seam crystals per open layer (plain ≤ 24; pool 80) | 20 | 32 | 56 | 80 |
| Dust motes per open layer (Particles tier: low none, medium ≤ 18) | 0 | 10 | 24 | 36 |
| Burst density (× the Particles tier's 35/70/100 %) | 0.6 | 0.8 | 1.0 | 1.2 |
| Bloom resolution | ½ | ½ | ½ | full |

**The hero** is the mine itself: seams glow (emissive 0.85 ± 0.18 idle, 1.7 ± 0.8 flaring), the selected layer rises 0.32 units with an accent rim and grounded ring, bins turn `#ff6622` and pulse when blocked, the flare marker (hot-seam octahedron) bobs above the flaring gallery.

**Typography:** the runtime's system UI face; logo 41.6 px, 800 weight, 5 px tracking with the accent on "DEEP"; tabular numerals on every counter; the runtime's text size scales everything.

**Motion:** critically damped springs only (selection lift, camera yaw, lift target depth), idle sway 0.35 units, lift rides a smoothstep triangle at the rules' cycle time, pooled additive particles (512; 35%/70%/100% by the Particles setting). Event tiers: acknowledgement (button transitions) < legal move (coin burst, surface glow) < unlock (60-particle burst + 0.22 shake) < completion (screen flash, 0.55 shake, 210 particles). Reduced motion (the runtime's option) zeroes sway, shake, bob and ring pulse, halves flare pulse, drops particles to 35%, freezes dust motes and lamp shimmer, skips the completion flash and the label pulse; camera sway can be switched off alone. The completion flash is an additive white overlay over the view, drawn by the UI.

**Visual assets the design calls for:** title key art (mine cross-section), a results illustration for a completed shift and for an ended/failed shift, a "while you were away" night-surface illustration, and 16:9 cover art. All are in `assets/` and inventoried in §15; no external 3D models — all geometry is procedural.

## 9. Audio direction

Mix: the runtime's buses (Options › Audio owns the volumes, mute and voice limit): music → `music`, effects and the ambience → `effects`, the menu click and back → `interface`; the browser build's default bus levels (music 0.5, effects 0.8, ambience 0.4) are folded into each sound's gain; the unused voice bus is gone. Ambience is a looped brown-noise rumble low-passed at 220 Hz with a 0.07 Hz breathing cutoff, rendered once into a 14.3 s clip. Music is a generative A-minor-pentatonic pattern (375 ms steps by mixer time, a sine bass every 4th step) whose triangle sparkle voice appears when `intensity = extractionRate / 400 ore/s` exceeds 0.25 and jumps an octave above 0.6, its notes rendered into clips with the old envelopes and its per-run seeded pitch variants as playback pitch. Effects are the authored Opus clips, loaded one at a time once the mixer runs (natively at once, in a browser after the first press); the browser build's synthesized stand-ins are not ported, so a clip still loading is silent. A hidden window holds every sound. Every meaningful cue has a caption shown at the bottom of the screen (Settings › Text captions for sounds).

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

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**, for every player-facing string — title, modes, setups, journey, boards, help, profile, settings, HUD and rails, bottleneck hints, layer labels and the fallback board, announcements and sound captions, toasts, results, the screen-reader mine description, and the stage/lesson/challenge/difficulty/theme/achievement names and texts. "Deepworks" stays untranslated; numbers keep the game's own compact format (`formatCoins`).

- **Strings.** Code calls `T('US-English text', { vars })` (`native/i18n.ts` over `js/i18n.js`, global `DWI18n`); `js/locales/*.js` map that text per language (en-GB lists only its spellings; es-ES and fr-CA only their differences from es-419 and fr-FR). Content tables keep English source text and are translated at display time (lesson prompts substitute the player's real key bindings). `DWRules.describeState` takes the UI's translator. `npm run i18n` (`tools/i18n-sync.mjs`) drops rows no source uses and fills new keys from sibling games' dictionaries.
- **Language** is the runtime's interface language (`preferences().language`: the player's choice in Options › Language, else the account's preferred language, else the device's), mapped to the nearest shipped locale (en-GB, es-ES and fr-CA by region); a change re-renders every screen in place (the UI is rebuilt each frame). The game's own Language selector (`sh-language.js`) is gone; a browser-build account choice (`ui.language`) is removed with the other legacy settings.
- **Expansion.** Labels too long for their width become wrapping paragraphs, button rows wrap, panels and rails scroll.

## 11. Accessibility

- **Keyboard and pad:** every screen focuses its first useful control; Tab, arrows and the D-pad move focus (runtime UI); dialogs trap focus and close with Esc / B; all play actions have keys and pad buttons (§6), rebindable in Options.
- **Screen reader:** the runtime's accessibility tree covers every widget; announcements (polite) carry the objective, lesson steps, flare start/fade, layer opened, flare claimed, paused/resumed and bottleneck warnings; rejections and results are assertive; How to play's "Describe the current mine aloud" reads `DWRules.describeState`; layer labels are buttons with descriptions (crew, bin %, blocked, flare); disabled action buttons carry their reason as a tooltip.
- **Captions:** every meaningful sound has a text caption (§9); no information is audio-only.
- **Contrast and colour:** the runtime's high-contrast option swaps in the old high-contrast tokens (black, white, `#ffff00`, `#00ffff`); three colour-vision palettes (Settings › Accessibility › Color palette); blocked bins change shape (marker + pulse) and label text (▲ FULL), flares add ✦ and a border, sealed layers show a lock.
- **Motion and timing:** the runtime's reduced motion (§8), the camera sway toggle, timing assistance doubles the flare window in casual modes (excluded from the ranked daily so replays stay identical).
- **Targets and layout:** 44 px minimum, left-handed rail and tray swap, the runtime's text and interface size, hold-to-repeat, haptics off, tutorial replay from settings.

## 12. StarHermit integration

`starhermit.txt`: `name=Deepworks`, `description`, `owner`, `server=score-script.js`, `cover=cover.jpg`, `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.26.1`, `engine.minor=28`, `engine.capabilities=platform,storage,clipboard`, `control.*` lines for `up`, `down`, `assign`, `unassign`, `hire`, `shaft`, `liftcap`, `liftspeed`, `unlock`, `flare`, `foreman`, `undo`, `pause` (action names are lowercase now: a player's old rebinds of `liftCap`/`liftSpeed`, and every old SDK binding override, start from the defaults again), `engine.group.*` headings and `engine.gamepad.*` defaults.

All platform I/O is the runtime's modules (`native/platform.ts`):

- **Player:** `player()` / `onPlayerChange` — signed in, the account's display name replaces the guest name (title line "Playing as <name> · sync status"; the Profile name field becomes read-only); guests see "Sign in with StarHermit" (`requestSignIn`). "Invite a friend" copies `inviteLink()` (fetched ahead) with `clipboard.writeText` and confirms with a toast.
- **Save:** the profile document (`DWSession`'s checksummed `{sum, payload}`) is the engine save (`saves`, schema 1): on the device at once, synced to the account's cloud slot (`game:<slug>`) by the runtime. Another device's save replacing this one, or a conflict, is merged with `DWSession.mergeProfiles` (the better journey record per stage, every lesson / daily / achievement, the best practice and challenge scores, the larger mastery xp and career counters; name and settings stay this device's), and a toast says "progress synced". **Migration:** the browser build's cloud slot (the JS SDK's `saveJSON` of the same document) shows as `saves.foreign()`; its text is parsed with `DWSession.loadProfileRaw`, merged into the device's profile and saved over the slot once with `replaceForeign`; the options the old document carried in `settings` are adopted unless set since. Guests' old browser `localStorage` progress cannot migrate (a different origin and store). The saved practice shift and the guest casual boards are device storage (`storage`), as before.
- **Settings:** the game's own options (`captions`, `theme`, `cameraSway`, `holdRepeat`, `leftHanded`, `haptics`, `palette`, `timingAssist`) are `settings` keys (synced with the account). The browser build's account settings (`legacyKeys`) are read once a session: its options carry over unless set since, then every old key is removed. Volumes, mute, graphics, language, reduced motion, high contrast, text size and key bindings are the runtime's Options; Report a problem is the runtime's.
- **Clock:** `serverTime()` / `serverNow()` give the Daily Vein's UTC day and the "new in Xh Ym" countdown (the device clock until the platform answers, or offline).
- **Leaderboard:** one board, `high-score` (integer whole credits, higher is better). Signed in, every finished Journey, Daily or Challenge run (won or lost) posts `floor(score.total / 1000)` through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores }`; the script range-checks it and returns `scores`), and the results show "Leaderboard rank: #N" (or posted / not posted). Practice runs and lessons post nothing. Signed in, the Leaderboards screen reads the board's top 25 (`leaderboards.entries`); guests see this device's casual Daily / All-time boards (a finished daily is added to the Daily one). Scores are the client's total, range-checked by the script (solo-game policy); no client- or host-reported multiplayer results exist.

**Not used:** platform achievements (achievements stay local flags in the profile), multiplayer sessions, matchmaking, rooms, chat, replays, voice — the game is solo. The old local-only telemetry buffer and its consent toggle are gone (nothing was ever sent). Offline, everything plays locally.

## 13. Technical architecture

- **Modules:** the pure scripts (`js/rules.js`, `js/content.js`, `js/session.js`, `js/lift.js`, `js/i18n.js`, `js/locales/*.js`) are classic UMD scripts loaded with `loadClassic` (unchanged for the node tests and `server.js`); `native/*.ts` is the client. `js/session.js` keeps its documents in `localStorage`, which `native/platform.ts` shims onto the engine save and device storage.
- **Determinism:** fixed 100 ms rule slices, integer state, single RNG stream in state, canonical hashing; content is versioned (`CONTENT_VERSION = 1`, rules `VERSION = 1` with a migration chain). Replay envelope: `{schema:1, contentVersion, contentId, mode, seed, startedAt, log, hashes, result}`.
- **Time:** the runtime's fixed steps (`setFixedRate(60)`): an active shift advances by 1000/60 ms a step (whole milliseconds, the remainder carried) through `DWSession.tick`; the 1.8 s countdown, the bottleneck check (every 200 ms), the lesson earn check (500 ms) and the practice autosave + playtime (10 s) count steps, so pauses, a hidden window and slow frames never cost time and play scripts replay exactly. The away simulation on resuming a saved shift uses the wall clock (min(elapsed, 8 h), summary dialog when > 30 s). Decorative motion follows frame time.
- **Frame:** `onRender` builds the UI (`screens.ts`), then decides the queued presses on the mine against the HUD's rectangles, then hands the run's (or the attract) state to `render.setSnapshot`.
- **Persistence:** the engine save (profile), device storage `deepworks.run.v1` (checksummed practice snapshot + log) and `deepworks.boards.v1` (guest casual boards), game settings (§12).
- **Server (dev only):** `server.js`, zero-dependency Node http with its own replay-validated daily board, not part of the package.

## 14. Testing and acceptance criteria

`npm test` runs:
- `npm run test:unit` — `tests/run.js` (5337 assertions): legal actions and every reason code; simulation and economy; terminal states; scoring; serialization and migration; deterministic replay property test; command fuzz; content validation of every lesson/stage/challenge and 30 dailies; golden sessions; undo; away simulation; the lift itinerary (`js/lift.js`); the graphics looks per tier and level (`native/quality.ts`). `tests/save.test.mjs`: the wrapped profile document `platform.ts` seals, the browser build's cloud-slot text parsing, tamper refusal, the two-device merge, a saved practice shift resuming with capped away time. `tests/i18n.test.mjs`: every `T`/`N` key in `js/` and `native/` and every content display field exists in all nine locales with the same placeholders; no stale keys.
- `npm run test:native` — `tests/native.mjs`: the web index matches the files (`npm run package` ran after the last change); `tsc` (TypeScript 5.9, strict, no `skipLibCheck`); `starhermit check .` with no warnings; each `tests/native/*.play` as a signed-out render check driving the real UI: `screens.play` (Daily Vein sheet, Challenges, the casual boards, Journey, How to play, Profile with a typed guest name, Settings), `learn-first-lesson.play` (lesson 1 by a label click and keys to its results, then marked done), `practice-bank.play` (countdown, hire, the drawer's Foreman's Panel, Undo, pause, End shift & bank score with its confirmation, results, Retry, Leave shift, the practice best), `journey-first-stage.play` (Journey stage 1 played to "Objective complete" by keys, 3 stars, back to the title showing 1/40; generated by `npm run plays` from a plan the rules confirm).
- `npm run test:browser` — `tools/browser-play.mjs`: the packaged loader served on loopback in Chrome on the GPU (`~/games/tools/gpu-chrome.mjs`) at 1366×768, 390×844 and 844×390 (touch, DPR 3): title → modes → Practice › Miner → Start shift → hire and assign by keys → pause → Leave shift → confirmation → title, failing on console errors or warnings or the runtime's error screen. `node tests/balance.js`: the greedy bot wins all stages, challenges and upcoming dailies.

Signed-in paths (foreign save, legacy settings, score posting, the platform board) cannot run here; their document logic is covered by the save tests.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1200 × 672, 37 KB) | title-panel hero | FLUX.2 klein, seed 2712, 28 steps | generated in this pass, wired |
| `assets/shift-complete.webp` (640 × 400, 16 KB) | results illustration when the shift is won | FLUX.2 klein, seed 6001 | generated in this pass, wired |
| `assets/shift-over.webp` (640 × 400, 7 KB) | results illustration when the shift ends or is lost | FLUX.2 klein, seed 6002 | generated in this pass, wired |
| `assets/crew-at-night.webp` (640 × 400, 19 KB) | "While you were away" modal | FLUX.2 klein, seed 6003 | generated in this pass, wired |
| `coverart.png` (1200 × 675, 256-colour), `cover.jpg` | platform cover | key art rescaled | shipped |
| `icon.png` | platform icon | authored | shipped |
| `sfx/*.opus` — 15 original clips (§9 rows 1–15) | event SFX | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/bin-blocked.opus`, `flare-fizzle.opus`, `lesson-chime.opus`, `shift-start.opus`, `achievement-star.opus`, `away-return.opus` | new event SFX (§9 rows 16–21) | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | canonical binding table / generator input / generator output | — | shipped |
| 3D models, character animation | — | TRELLIS / Kimodo | not called for: all geometry is procedural, no humanoid rig |

## 16. Known limitations

- Hosted achievement unlocks in `server.js` (dev server) are filed under `guest`; local achievement flags in the profile are correct.
- Offline casual boards highlight "me" by display name; two players with the same name both highlight (the signed-in platform board highlights by user id).
- The endless-practice "bank score" plays `terminal_win` whose caption reads "Objective complete" although the results headline says "Shift ended" (kept: replays and the old behaviour).
- The platform board takes the client's score as reported (range-checked only); `server.js`'s replay validation is not part of the deployed script.
- `validLog` bounds the number of log entries, not the total simulated milliseconds; harmless today because every ranked run terminates on its own limit.
- `foremanAct` cooldown can go negative if a step ever exceeds the 2 s interval (unreachable with 100 ms slices).
- The Settings key line lists the default keys; How to play and the lesson prompts show the player's real bindings.
- Not ported from the browser build: the DOM fallback board for missing WebGL (the runtime always renders), the frosted panel blur on High/Ultra, the old Graphics panel's per-effect overrides (the runtime's Options choose a level), the synthesized sound stand-ins while clips load, and the local-only telemetry toggle. Old keyboard rebinds made through the SDK start from the defaults (action names are lowercase).
- The Daily Vein's day uses the device's UTC date until the platform clock answers (offline play included).

## Design intent not yet implemented

- Friends-only board filter.
- A dedicated caption for banking an endless shift.
