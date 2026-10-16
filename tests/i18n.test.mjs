// Every player-facing string exists in all nine locales (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ALL } from './i18n-keys.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const ctx = vm.createContext({});
for (const f of ['en-GB', 'es', 'de', 'fr', 'pt', 'it']) vm.runInContext(readFileSync(`${ROOT}js/locales/${f}.js`, 'utf8'), ctx);
vm.runInContext(readFileSync(`${ROOT}js/i18n.js`, 'utf8'), ctx);
const { DICTS, LOCALES, T, setLocale } = ctx.DWI18n;
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 250, `only ${ALL.size} keys`);
});

for (const locale of LOCALES.filter((l) => !l.startsWith('en-'))) {
  test(`${locale}: every key is translated with the same placeholders`, () => {
    const dict = DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of LOCALES) {
    const stray = Object.keys(DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('T falls back to the key and fills placeholders', () => {
  setLocale('de-DE');
  assert.equal(T('No such key {x}', { x: 2 }), 'No such key 2');
  assert.notEqual(T('Back'), 'Back');
  setLocale('en-US');
  assert.equal(T('Back'), 'Back');
});
