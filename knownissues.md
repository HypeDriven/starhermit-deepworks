# Known Issues — Deepworks

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own test suites and headless-Chrome smoke.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | not available — this game ships no `package.json`; `npm test` exits with `ENOENT ... /deepworks/package.json` |
| `node tests/run.js` | 5210/5210 pass, 0 fail (legal actions, simulation & economy, terminals, scoring, serialization & migration, deterministic replay, fuzz, content validation, golden sessions, undo, away simulation) |
| `node tests/balance.js` | all 6 challenges won, all 7 upcoming dailies won, `journey fails: 0` |
| `node tests/smoke.js` (headless Chrome via CDP, against `PORT=39309 node server.js`) | PASS — title → modes → play → pause/resume → results → journey → help → lesson, "console problems: none" |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `tests/*.js`) |
| HTTP fuzz of `server.js` | **found a remote crash** — see confirmed defect 1 |

## Confirmed defects

Defect 1 was reproduced against a freshly started `server.js` whose PID I tracked. Defects 2-4 were
reproduced against a copy of the server in a scratch directory. Defects 5 and 6 were reproduced against
the shipped `js/rules.js` and `js/session.js` directly.

### 1. `GET /%` — any malformed percent-encoding kills the server process

- **File:** `server.js:341` (`let pathname = decodeURIComponent(url.pathname);` inside `serveStatic`)
- **Trigger:** one unauthenticated request — `GET /%`.
- **Behaviour:** `decodeURIComponent` throws `URIError: URI malformed`. The dispatcher wraps only the API
  branch in error handling (`server.js:374`, `handleApi(...).catch(...)`); the static branch at
  `server.js:376` calls `serveStatic` bare, and there is no `try/catch` around the handler and no
  `process.on('uncaughtException')`. Node exits.
- **Expected:** a malformed URL is a 400, not a service outage. (The `try { url = new URL(...) } catch`
  at `server.js:367-372` shows the intent; the decode step just was not covered.)
- **Evidence:**

  ```
  GET /api/v1/time              -> 200
  GET /%                        -> 000   (connection dropped)
  process alive afterwards      -> NO

  server log:
  /home/albert/games/deepworks/server.js:341
    let pathname = decodeURIComponent(url.pathname);
                   ^
  URIError: URI malformed
      at decodeURIComponent (<anonymous>)
      at serveStatic (/home/albert/games/deepworks/server.js:341:18)
      at Server.<anonymous> (/home/albert/games/deepworks/server.js:376:5)
  ```

### 2. The leaderboard's identity key is the display name, so entries can be overwritten

- **File:** `server.js:190-206` (`submitScore`), specifically `board.findIndex((e) => e.name === entry.name)`
  on line 192 and the `board.splice(existing, 1)` on line 198
- **Trigger:** submit a valid replay whose `name` matches an existing board entry, with a higher score.
- **Behaviour:** the only identity the server records is `sanitizeName(body.name)` (`server.js:329`) —
  there is no token, header or session binding. `submitScore` finds the row with the same name and, if
  the incoming score is higher, removes it and pushes the new one. The victim's score, duration and
  timestamp are replaced, not merely outranked, and the board still shows their name.
- **Expected:** spec.md §6 "Identity, profile, presence, and preferences" — board identity comes from the
  host's verified identity. A display name chosen freely in the body cannot be a primary key.
- **Evidence:** an honest entry, then a submission under the same name:

  ```
  before: {"name":"honest","score":1269230,"durationSec":900,"when":1787250848127}
  after : {"name":"honest","score":2230769,"durationSec":0,  "when":1787250856283}
  ```

  One row, replaced.

### 3. Any past or future daily board can be submitted to

- **File:** `server.js:289-304` (`submitDailyScore`)
- **Trigger:** `POST /api/v1/scores/daily` with `dayKey: "daily-2027-09-15"`.
- **Behaviour:** the only date validation is the shape test `/^daily-\d{4}-\d{2}-\d{2}$/` (line 291) and
  the self-consistency check `content.id !== dayKey` (line 299), which passes for every valid date because
  `DWContent.dailyInfo` is deterministic. Nothing compares the key to the server's current UTC day, so a
  player can generate, solve and submit any future daily now.
- **Expected:** spec.md §2 "Modes" — "Daily: one shared seed and ruleset per UTC day, synchronized to
  platform time".
- **Evidence:**

  ```
  POST /api/v1/scores/daily  dayKey=daily-2027-09-15  -> 200 {"ok":true,"rank":1,"authoritative":true}
  GET  /api/v1/scores/daily?day=2027-09-15
    {"entries":[{"name":"preSolver","score":1110169,"durationSec":1,"dayKey":"daily-2027-09-15"}],"authoritative":true}
  ```

### 4. `durationSec` is client-declared, unrelated to the replay, and is the second ranking key

- **File:** `server.js:308-311` (validation) and `server.js:331` (storage), with the comparator at
  `server.js:187-188`
- **Trigger:** submit any valid replay with `durationSec: 0`.
- **Behaviour:** the server checks only `Number.isFinite && >= 0 && <= 86400`. It never derives elapsed
  time from its own clock, and never relates it to the simulated time in the replay log — my accepted
  submission declared `durationSec: 0` while its log advanced 1800 seconds of simulated time.
  `sortBoard` uses `a.durationSec - b.durationSec` as the tie-break after score.
- **Expected:** spec.md §2 "Scoring and victory" — ties use "lower **authoritative** elapsed time". The
  server does expose `/api/v1/time` but never cross-checks.
- **Evidence:** the stored row above carries `"durationSec":0` for a run whose log simulates 1800 s; the
  server accepted it with `{"ok":true,"rank":1,"authoritative":true}`.

### 5. The foreman assigns idle workers to blocked layers, contradicting its documented rule

- **File:** `js/rules.js:554-570` (`foremanAct`), specifically lines 561-564, against the comment at
  `js/rules.js:552-553`
- **Trigger:** every unlocked layer's bin is at or past the 98% "blocked" threshold
  (`js/rules.js:548-550`) while idle workers exist and the foreman is enabled.
- **Behaviour:** the comment states the foreman should "assign idle workers to the highest-value
  **non-blocked** layer". The code does not skip blocked layers — it merely divides their score by four
  (`if (blocked) score = Math.floor(score / 4);`). Since the score stays positive, `bestScore` is still
  beaten and the `while (state.workers.idle > 0)` loop assigns every idle worker to the least-bad blocked
  layer. Those workers then produce ore that is immediately clamped at the bin cap, so the assignment is
  wasted until the lift drains the bin.
- **Expected:** the documented behaviour at `js/rules.js:552-553`; spec.md §2 "Core loop" expects
  automation to make the next useful action, not a wasted one.
- **Evidence:** a daily state with both unlocked layers' bins pushed far past the cap and 5 idle workers,
  advanced 2500 ms (one foreman tick):

  ```
  unlocked layers=2 idle before=5 workers before=[0,0,0,0,0]
  idle after=0        workers after =[0,5,0,0,0]
  foreman assigned workers to a bin that is >=98% full: true
  ```


### 6. A full localStorage throws out of `saveRun` / `saveProfile` instead of returning `false`

- **File:** `js/session.js:169-181` (`saveRun`, the bare `st.setItem` on line 178) and the matching
  `saveProfile` around `js/session.js:264`
- **Trigger:** localStorage reaching quota part-way through a session, then any autosave.
- **Behaviour:** both functions already handle *unavailable* storage — `var st = storage(); if (!st) return false;`
  (line 170-171), and `storage()` itself is wrapped in a `try/catch` (`js/session.js:161-164`). But the
  write itself is unguarded, so a later `QuotaExceededError` or `SecurityError` propagates to the caller
  rather than producing the documented `false`. The call sites in `js/main.js` (lines 147, 255, 257, 397,
  444, 469) are bare, including the autosave inside the run loop.
- **Expected:** the function's own contract — `false` on failure — and spec.md §5 "Loading and
  resilience", which expects a session to stay playable when persistence is unavailable.
- **Evidence:** with a storage whose `setItem` throws `QuotaExceededError`:

  ```
  createRun -> ok
    saveRun     -> THREW QuotaExceededError
    saveProfile -> THREW QuotaExceededError
  ```

  For contrast, `loadSavedRun` (`js/session.js:182-...`) is fully defensive: absent key, bad JSON and
  checksum mismatch all return `null`.


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

`server.js` writes its store under a path that this repo already ignores — `git status` is clean after
this pass. The three leaderboard exploits were run against a **copy** of the game in a scratch
directory, so nothing was written to this folder's boards. (That copy needed a
`package.json` containing `{"type":"commonjs"}` added to it, because the scratch directory it lived in
carries a `"type":"module"` manifest; the game's own folder needs no such file.)
