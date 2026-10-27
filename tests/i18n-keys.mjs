// Key extraction for the i18n coverage test (also handy for listing keys): every
// T('…') / N('…') in js/*.js and native/*.ts, and the content's names and texts.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname;
const require = createRequire(import.meta.url);
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');

export function sourceKeys() {
  const keys = new Set();
  const call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  const ternary = /(?<![\w.$])T\([^'"\n()]*?\?\s*'((?:[^'\\\n]|\\.)*)'\s*:\s*'((?:[^'\\\n]|\\.)*)'/g;
  const files = [
    ...readdirSync(join(ROOT, 'js')).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => join(ROOT, 'js', f)),
    ...readdirSync(join(ROOT, 'native')).filter((f) => f.endsWith('.ts')).map((f) => join(ROOT, 'native', f)),
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    for (const m of src.matchAll(ternary)) { keys.add(unescape(m[1])); keys.add(unescape(m[2])); }
  }
  return keys;
}

export function contentKeys() {
  const C = require('../js/content.js');
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  C.THEMES.forEach((t) => add(t.name));
  C.LESSONS.forEach((l) => { add(l.name, l.intro); (l.steps || []).forEach((s) => add(s.text)); });
  C.JOURNEY.forEach((j) => add(j.name, j.hint));
  C.CHALLENGES.forEach((c) => add(c.name, c.description));
  C.PRACTICE_DIFFICULTIES.forEach((d) => add(d.name));
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);
