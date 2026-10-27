# Deepworks

An idle optimization game set in a layered underground mine with glowing
mineral seams. Assign workers, upgrade shafts and transport, find the
bottleneck, fix it, automate — and keep earning while you're away.

## Run it

Deepworks is a StarHermit engine script game (engine 1.18.0): the StarHermit
client plays it natively, browsers through the engine's web runtime.

```
starhermit .                 # play natively (STARHERMIT runtime from ~/sh/runtime)
npm run package              # write the web loader index.html + starhermit-files.json
node server.js               # serve the packaged folder (and a dev /api) on http://localhost:8080
```

Run `npm run package` after every change and commit `index.html` and
`starhermit-files.json`.

## Modes

- **Learn** — 5 interactive lessons; each rule is introduced by doing it.
- **Journey** — 40 authored stages with par times, stars, and mastery stages.
- **Daily Vein** — one shared seed + ruleset per UTC day; server-validated scores when hosted.
- **Practice** — 4 difficulties, endless, undo allowed, unranked; survives page reloads with capped away-simulation ("while you were away" summary).
- **Challenge** — 6 constrained variants (move limits, sprints, restricted tools).
- **Score chase** — daily + all-time boards (validated when hosted, casual locally).

## Controls

Pointer/touch: tap a layer (or its label), then use the Foreman's Panel or the
phone's tray; drag the mine to turn it. Keyboard: ↑/↓ select layer, Enter
assign, U recall, H hire, Q shaft, W lift capacity, E lift speed, D open
layer, F claim flare, G foreman, Z undo, Esc pause. Gamepad: D-pad select, A
assign / claim, B recall, Y hire, X flare, shoulders and triggers for
upgrades, Start pause. Keys and buttons are rebindable in the runtime's
Options.

## Architecture

| File | Role |
|---|---|
| `js/rules.js` | Pure deterministic rules engine: legal-action queries, fixed-point integer sim, seeded RNG, scoring, serialization |
| `js/content.js` | Versioned content: 5 themes, lessons, 40 stages, challenges, self-calibrating daily generator, offline validators |
| `js/session.js` | Command dispatch (idempotent by command id), input log / replay envelope, undo, autosave, away sim, profile |
| `js/lift.js` | The lift's cosmetic itinerary |
| `native/main.ts` | Entry: state machine, runs on the runtime's fixed steps, input, lifecycle |
| `native/screens.ts` | Screens and HUD on `starhermit:ui` |
| `native/render.ts` | The mine on `starhermit:scene`, looks per graphics level (`native/quality.ts`) |
| `native/audio.ts` | Clips on the runtime's buses, rendered rumble and music, captions |
| `native/platform.ts` | Engine save (with the browser build's cloud save migrated), settings, clock, boards, score posting |
| `score-script.js` | StarHermit platform script: range-checks a finished run's score for the `high-score` board |
| `server.js` | Dev-only static + API server (not packaged) |

## Tests

```
npm test                 # unit, save and i18n tests, then tsc, starhermit check and the play scripts
npm run test:browser     # the packaged loader in Chrome on the GPU at desktop, phone and landscape
node tests/balance.js    # bot plays every stage/challenge/daily and reports completion vs par
```

## StarHermit

See `spec.md` §12: the profile is the engine save synced to the account,
finished Journey, Daily and Challenge runs post to the `high-score` board
through `score-script.js`, and the Daily Vein follows the platform clock.
