# Deepworks

An idle optimization game set in a layered underground mine with glowing
mineral seams. Assign workers, upgrade shafts and transport, find the
bottleneck, fix it, automate — and keep earning while you're away.

## Run it

Any static file server works:

```
node server.js        # serves the game + API on http://localhost:8080
```

or `python3 -m http.server` / any static host, then open `index.html`.

## Modes

- **Learn** — 5 interactive lessons; each rule is introduced by doing it.
- **Journey** — 40 authored stages with par times, stars, and mastery stages.
- **Daily Vein** — one shared seed + ruleset per UTC day; server-validated scores when hosted.
- **Practice** — 4 difficulties, endless, undo allowed, unranked; survives page reloads with capped away-simulation ("while you were away" summary).
- **Challenge** — 6 constrained variants (move limits, sprints, restricted tools).
- **Score chase** — daily + all-time boards (validated when hosted, casual locally).

## Controls

Pointer/touch: tap a layer, then use the Foreman's Panel. Keyboard: ↑/↓ select
layer, Enter assign, U recall, H hire, Q shaft, W lift capacity, E lift speed,
D open layer, F claim flare, G foreman, Z undo, Esc pause. Gamepad: D-pad
select, A confirm, B recall, Start pause.

## Architecture

| File | Role |
|---|---|
| `js/rules.js` | Pure deterministic rules engine: legal-action queries, fixed-point integer sim, seeded RNG, scoring, serialization |
| `js/content.js` | Versioned content: 5 themes, lessons, 40 stages, challenges, self-calibrating daily generator, offline validators |
| `js/session.js` | Command dispatch (idempotent by command id), input log / replay envelope, undo, autosave, away sim |
| `js/render.js` | Three.js (r128, vendored) scene: procedural mine, instanced seams, quality tiers, reduced-motion |
| `js/ui.js` | Semantic HTML shell: screens, HUD, accessibility mirror, settings |
| `js/audio.js` | Synthesized WebAudio: 4 buses, adaptive music, captions |
| `js/platform.js` | StarHermit adapter: launch token, server-time sync, boards, achievements, telemetry consent; offline fallback |
| `js/main.js` | Bootstrap + state machine + input mapping |
| `server.js` | Zero-dep Node static + API server; replay-validated daily leaderboard |

## Tests

```
node tests/run.js       # 5200+ assertions: rules, replay determinism, fuzz, content validation, golden sessions
node tests/balance.js   # bot plays every stage/challenge/daily and reports completion vs par
node tests/smoke.js     # headless-Chrome UI drive (needs google-chrome)
```

## StarHermit

`starhermit.txt` declares `name=Deepworks`, `launch=index.html`,
`server=server.js`. When hosted, the game reads scope from the launch token,
syncs UTC day boundaries against `/api/v1/time`, and submits daily scores with
the full input log for authoritative replay validation.
