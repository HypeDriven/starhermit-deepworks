// Key extraction for the i18n coverage test (also handy for listing keys).
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
  for (const f of readdirSync(join(ROOT, 'js')).filter((f) => f.endsWith('.js') && f !== 'i18n.js')) {
    const src = readFileSync(join(ROOT, 'js', f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    for (const m of src.matchAll(ternary)) { keys.add(unescape(m[1])); keys.add(unescape(m[2])); }
  }
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) keys.add(m[1].replace(/&quot;/g, '"'));
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
  // Sound captions (js/audio.js) are translated when shown.
  const audio = readFileSync(join(ROOT, 'js', 'audio.js'), 'utf8');
  for (const m of audio.matchAll(/caption: '([^']+)'/g)) add(m[1]);
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);
