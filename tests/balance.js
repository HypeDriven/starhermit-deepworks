// Scratch balance probe: greedy bot plays every journey stage + challenge;
// report completion time vs par (or failure). Not part of the shipped suite.
const R = require('../js/rules.js');
const C = require('../js/content.js');

function playBot(content, maxSec) {
  const state = C.buildState(content);
  let t = 0;
  const step = 2; // act every 2 simulated seconds
  while (!state.terminal && t < maxSec) {
    R.advance(state, step * 1000);
    t += step;
    C.greedy(state);
  }
  return { state, t, done: !!state.terminal, won: !!(state.terminal && state.terminal.won), reason: state.terminal && state.terminal.reason };
}

function scoreBound(content) { return content.parSec * 4; }

console.log('== JOURNEY ==');
let fails = 0;
for (const st of C.JOURNEY) {
  const r = playBot(st, scoreBound(st));
  const ok = r.won;
  if (!ok) fails++;
  console.log(`${st.n}\t${st.name.padEnd(24)} ${ok ? 'OK ' : 'FAIL'} t=${r.t}s par=${st.parSec}s reason=${r.reason} coins=${Math.floor(r.state.coins / 1000)} rate=${R.totalExtractionRate(r.state)}`);
}
console.log('== CHALLENGES ==');
for (const ch of C.CHALLENGES) {
  const r = playBot(ch, (ch.limits && ch.limits.timeSec ? ch.limits.timeSec : 1800) + 10);
  console.log(`${ch.id.padEnd(18)} won=${r.won} t=${r.t}s reason=${r.reason} coins=${Math.floor(r.state.coins / 1000)} moves=${r.state.stats.playerCommands}`);
}
console.log('== DAILY (next 7 days) ==');
for (let d = 0; d < 7; d++) {
  const date = new Date(Date.UTC(2026, 7, 18 + d));
  const info = C.dailyInfo(date);
  const r = playBot(info, 910);
  console.log(`${info.key} goal=${info.goals.type}:${info.goals.amount} won=${r.won} t=${r.t}s`);
}
console.log('journey fails:', fails);
