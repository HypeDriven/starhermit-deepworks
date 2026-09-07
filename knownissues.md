# Known Issues — Deepworks

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own test suites and headless-Chrome smoke.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 5210/5210 pass, 0 fail (suite: `node tests/run.js`) |
| `node tests/run.js` | 5210/5210 pass, 0 fail (legal actions, simulation & economy, terminals, scoring, serialization & migration, deterministic replay, fuzz, content validation, golden sessions, undo, away simulation) |
| `node tests/balance.js` | all 6 challenges won, all 7 upcoming dailies won, `journey fails: 0` |
| `node tests/e2e.mjs` / `npm run test:e2e` | E2E PASS — both viewport passes clean, no page errors |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `tests/*.js`) |
| HTTP fuzz of `server.js` | clean after the defect-1 decode guard |

## Resolved (fixes applied 2026-09-04)

All six confirmed defects below were re-verified against the current source before fixing;
each still reproduced in the original code and is now fixed.

### 1. `GET /%` — malformed percent-encoding could kill the server — RESOLVED

- **Fix:** `server.js:342-348` — `serveStatic` now wraps `decodeURIComponent(url.pathname)` in a
  `try/catch` and returns a `400 {"error":"bad-request"}` on a malformed percent-encoding, matching
  the intent of the existing `new URL(...)` guard. (This fix was already present uncommitted in the
  working tree when this pass began; verified live: `GET /%` → 400, then `GET /api/v1/time` → 200,
  process alive.)

### 2. Leaderboard identity keyed on display name (entries could be overwritten) — RESOLVED

- **Fix:** `server.js:191-207` (`submitScore`) — board identity is now keyed on a stable `playerId`
  instead of the freely-chosen display name. `server.js:325-329` validates a required
  `body.playerId` (`^[A-Za-z0-9_-]+$`, ≤64 chars) and `server.js:346-347`, `356-357` store it on the
  entry; `globalBoard` (`server.js:216-220`) dedupes by `playerId` too. Legacy rows without a
  `playerId` fall back to name-matching so old data still ranks. Client side: `js/session.js`
  `defaultProfile` now generates a persistent `playerId` (line 239-241), and `js/main.js:439` sends it
  in the daily submission.
- **Verified:** two submissions with the same display name but different `playerId` both produce
  their own board row (no overwrite); one `playerId` resubmitting a higher score still replaces its
  own row.

### 3. Any past or future daily board was open — RESOLVED

- **Fix:** `server.js:295-298` — `submitDailyScore` now rejects any `dayKey` that is not the server's
  own current UTC day (`DWContent.dailyInfo(new Date()).id`) with `409 {"error":"day-not-current"}`,
  per spec §2 ("one shared seed per UTC day").
- **Verified:** `POST /api/v1/scores/daily` with `dayKey:"daily-2027-09-15"` → 409 (was 200); the
  today board is still accepted.

### 4. `durationSec` was client-declared and not tied to the replay — RESOLVED

- **Fix:** `server.js:346-349`, `356-357` — elapsed time is now derived authoritatively from the
  replayed simulation (`replayRes.state.tick`, whole seconds advanced) and stored on the entry; the
  client-declared `body.durationSec` is no longer accepted as the ranking key. The tie-break in
  `sortBoard` (`server.js:188-189`) therefore uses authoritative elapsed time as spec §2 requires.
- **Verified:** a submission whose log simulated N seconds is stored with `durationSec == N`
  regardless of the declared value (`0` → authoritative value).

### 5. Foreman assigned idle workers to blocked layers — RESOLVED

- **Fix:** `js/rules.js:560-563` — `foremanAct` now `continue`s past a layer whose bin is at/past the
  98% blocked threshold instead of merely dividing its score by four, matching the documented comment
  at `js/rules.js:552-553` (assign to the highest-value **non-blocked** layer).
- **Verified:** a daily state with both unlocked layers clamped past cap and idle workers, advanced
  one foreman interval, produces `assign events: []` and leaves idle workers unassigned (no worker is
  put on a ≥98% full bin).

### 6. A full/throwing localStorage threw instead of returning `false` — RESOLVED

- **Fix:** `js/session.js:169-185` (`saveRun`), `js/session.js:268-277` (`saveProfile`) — the
  `setItem` write is now wrapped so a `QuotaExceededError`/`SecurityError` returns `false` (the
  documented contract) rather than propagating. `clearSavedRun` (`js/session.js:200-204`) is likewise
  guarded.
- **Verified:** a storage whose `setItem` throws now yields `saveRun -> false`, `saveProfile ->
  false` instead of throwing.


## Suspected — not confirmed

### 1. `validLog` puts no upper bound on a single `advance`

- **File:** `server.js:168-179` (`validLog`) — `if (!Number.isInteger(e.ms) || e.ms < 0) return false;`
- **Concern:** an idle game's whole economy is time, and one log entry may declare any positive integer
  number of milliseconds. `MAX_LOG_ENTRIES` (200 000) caps the *count* of entries, not the simulated span.
- **Why unconfirmed:** in practice it does not pay — a single `advance` of 3 600 000 ms and one of
  2 592 000 000 ms (30 days) both produced exactly the same score, 2 230 769, because the run hits its own
  terminal condition (`state.terminal`) and `advance` stops (`server.js` → `js/rules.js:452-463`). So the
  economy is bounded by the shift, not by the log. A future content change that lifts the terminal would
  expose this; today it does not.

### 2. `foremanAct`'s cooldown can go negative if a step is longer than the foreman interval

- **File:** `js/rules.js:532-538`
- **Concern:** `cooldownMs -= dtMs` followed by a single `cooldownMs += foremanIntervalSec * 1000` leaves
  the cooldown negative whenever `dtMs` exceeds the interval, so the foreman would fire again on the very
  next step instead of once per interval. A `while` loop or modulo reset is the usual fix.
- **Why unconfirmed:** unreachable today — `STEP_MS` is 100 ms (`js/rules.js:28`) and
  `foremanIntervalSec` is 2 (`js/rules.js:92`), and `advance` never passes a slice larger than `STEP_MS`
  (`js/rules.js:456-461`). It only becomes live if either constant changes or a caller invokes
  `simulateStep` directly.

### 3. There is no per-player submission limit, only a per-IP rate limit

- **File:** `server.js:190-206`
- **Concern:** combined with defect 2, a client can keep resubmitting under different names to fill the
  board (`BOARD_SIZE` cap), crowding out real players.
- **Why unconfirmed:** I did not attempt board flooding — it would write a large amount of runtime data
  and is close to a denial-of-service against a shared machine. The absence of the limit is visible in
  the source; the practical impact depends on `BOARD_SIZE` and on host-level protections.

## Checked, no defects found

- `server.js:305-326` — the submission path is otherwise sound: content version pinned, content rebuilt
  server-side from `dayKey`, `body.seed` compared against it, `validLog` shape-checks every entry, the
  log is re-simulated through `DWSession.replay`, the client's score is explicitly discarded in favour of
  the recomputed one (`server.js:313`, "the client-reported score is ignored"), and the recomputed state
  hash must equal `body.clientHash`. A client cannot inflate a score or substitute its own content.
- `js/session.js:131-143` (`replay`) — rebuilds state from the content, refuses envelopes containing an
  `undo_marker`, and applies invalid attempts as deterministic no-ops so the invalid counter stays
  faithful.
- `js/rules.js:452-463` (`advance`) — steps in `STEP_MS` slices, stops at `state.terminal`, and rejects
  non-positive `ms`.
- `server.js:182-206` (`dayBoard` / `submitScore`) — reviewed as a suspected `__proto__`-key crash
  (`s.days['__proto__']` would return a non-array whose `.findIndex` is undefined) and **disproved**:
  `submitDailyScore` rejects anything not matching `/^daily-\d{4}-\d{2}-\d{2}$/` at `server.js:291`
  before `dayBoard` is reached, and the GET route applies the same shape test at `server.js:235`.
  Verified live: `{"dayKey":"__proto__"}`, `{"dayKey":"daily-__proto__"}` and `{"dayKey":"constructor"}`
  all return `{"error":"bad-day-key"}` with the process still up, and `?day=__proto__` falls back to
  today's board.
- `server.js:190` (`submitScore`) — reviewed as a suspected "unvalidated entry fields" hole and
  **disproved**: its only caller is `submitDailyScore`, which builds `entry` itself from the *recomputed*
  replay (`server.js:328-334`); no client-supplied score, name or timestamp reaches it unchecked.
- `js/rules.js:416-425` (`applyCommand`, `case 'claim_flare'`) — reviewed as a suspected null-dereference
  of `state.flare.active` and **disproved**: `applyCommand` always runs `can(state, cmd)` first
  (`js/rules.js:369-373`), and `can`'s `claim_flare` case rejects with `NO_FLARE` when the flare is absent
  or expired (`js/rules.js:313-314`) and with `FLARE_MISMATCH` on a layer/id mismatch (line 315).
- `js/rules.js:590-769` — terminal checks (`>=` on time and move limits, strictly-under-par time bonus),
  single assignment of `state.terminal`, and integer-only score components (`earned`, `depthBonus`,
  `flareBonus`, `Math.floor`-wrapped `timeBonus` and `efficiencyPermille`).
- `js/rules.js:1-400` — RNG (`rngNext`/`rngInt`), `mergeRuleset`'s deep copy of `mechanics`/`goals`/
  `limits`, `createState`, the derived-rate formulas (`shaftMult`, `binCapMilli`, `layerRate`,
  `liftCapacity`, `liftCycleMs`, `liftRate`, `totalExtractionRate`), and every `can`/`applyCommand` pair
  (costs are recomputed from the pre-mutation state, `Math.floor` is applied throughout, and an absent
  `cmd.layer` is caught by the `!L` guards at lines 270/277/287).
- `js/session.js` persistence — corrupt-storage harness: `loadSavedRun` and `loadProfile` were called
  against a fake `localStorage` pre-filled with `{`, `null`, `[]`, `{"v":9999}`, `"a"`, `0`, `undefined`,
  `{"v":1}` and `{"v":1,"state":null}` under both `deepworks.run.v1` and `deepworks.profile.v1`. Neither
  threw.
- `server.js:343-346` — path containment: `path.resolve(ROOT, '.' + pathname)` re-checked against
  `ROOT + path.sep`; `../`, `%2e%2e%2f` and `....//` traversals all refused; `/js`, `/css`, `/tests`
  return 404.
- `server.js` under POST fuzz — 20 malformed bodies plus odd query strings on `/api/v1/scores/daily`,
  `/api/v1/scores/global`, `/api/v1/activity/start`, `/api/v1/activity/end`,
  `/api/v1/presence/heartbeat`, `/api/v1/telemetry` and `/api/v1/time` left the process alive.

## Not tested

- Long-horizon idle behaviour (multi-hour away simulation) beyond what `tests/balance.js` covers.
- Audio output (`js/audio.js`) and the WebGL layer (`js/render.js`) beyond "boots and renders without
  console errors" under SwiftShader in `tests/smoke.js`.
- `js/ui.js` (46 KB) and `js/render.js` (43 KB) were not reviewed line by line; they are exercised only
  through `tests/smoke.js`.

## Runtime artefacts

`server.js` writes its store under `data/scores.json` (tracked in this repo) and
`data/achievements.json`. The original leaderboard exploits (defects 2-4) were re-verified during this
fix pass against a **copy** of the server in a scratch directory, so nothing was written to this
folder's boards. The verification runs of the *fixed* code also used a scratch copy and were torn down
afterwards, so `git status` is clean apart from the source fixes.

---

## Review pass 2026-09-07 (Kimi)

Follow-up review. All suites re-run green after the fixes below:
`node tests/run.js` 5210/5210, `node tests/balance.js` (journey fails: 0),
`npm run test:e2e` (desktop + mobile, no page errors), plus a new targeted
browser suite `tests/review-fixes.mjs` covering each fix.

### Fixed

1. **Offline daily board stored `undefined` scores** — `js/platform.js` `submitScore`
   offline branch read `entry.score` but the client sends the ranked payload shape
   (`scoreTotal`), so local casual boards showed `NaN` and sorted wrong. Now accepts
   either field and uses the submitted display name.
2. **Escape / gamepad Start on the pause screen dumped to the title with the run
   left paused in limbo** — `UI.back()` coerces `play → title`. `js/main.js` now
   resumes the run when Escape/Start is pressed on the settings screen while a
   run is paused.
3. **Countdown could unpause the sim behind the pause menu** — pausing during the
   1.8 s countdown, then letting the countdown finish, cleared `app.paused` while
   the settings screen was still open. The countdown end now only unpauses when
   the play screen is actually showing; Escape/Start during the countdown now opens
   the pause menu instead of being a no-op.
4. **"Timing assistance" accessibility setting was a no-op** — the toggle existed
   but nothing read it. It now doubles the flare claim window in casual modes;
   the ranked daily is excluded so server-side replay validation stays
   bit-identical. Toggle label updated accordingly.
5. **Backgrounding the tab froze the game with no visible paused state** — the
   visibility handler paused silently. It now opens the pause panel so the frozen
   state is obvious on return (and still autosaves practice runs first).
6. **Resizing while paused left a stale/blank canvas** — `js/render.js` `resize()`
   now repaints the frozen frame when paused.
7. Dead code removed in `js/session.js` `createRun`; missing `LICENSE.md`
   (PolyForm Noncommercial 1.0.0) added at repo root.

### Still open (unchanged from previous pass)

- No per-player submission limit on boards (per-IP rate limit only).
- `foremanAct` cooldown can go negative if a sim step ever exceeds the foreman
  interval (unreachable with current constants).
- No upper bound on a single `advance` log entry (bounded in practice by the
  run's own terminal condition).
- Localization guidance (agents/localization.md: 9 locales) is not implemented;
  consistent with the rest of the game fleet, tracked as fleet-level debt.
