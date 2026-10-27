// Keeps js/locales/*.js in step with the client's keys (tests/i18n-keys.mjs):
// drops rows no source uses any more, and adds missing keys from a sibling
// game's dictionaries (the same English text, already translated there), in
// the primary block of each file (es-419, fr-FR, de-DE, pt-BR, it-IT).
// Prints keys it could not find. Run after adding strings, then npm test.
//   node tools/i18n-sync.mjs [SIBLING_GAME_DIR...]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { ALL } from '../tests/i18n-keys.mjs';

const root = new URL('..', import.meta.url).pathname;
const siblings = process.argv.slice(2).length ? process.argv.slice(2) : ['../cube-pop', '../crown-draughts', '../cushion-and-cue'];
const PRIMARY = { 'es.js': 'es-419', 'de.js': 'de-DE', 'fr.js': 'fr-FR', 'pt.js': 'pt-BR', 'it.js': 'it-IT' };
// Every dictionary (locale → {en: translated}) a sibling game's locale scripts define.
function dictsOf(dir) {
  const out = {};
  const ctx = vm.createContext({});
  for (const sub of ['js/locales', 'js/i18n/locales']) {
    for (const f of Object.keys(PRIMARY)) {
      const p = join(resolve(root, dir), sub, f);
      if (!existsSync(p)) continue;
      try { vm.runInContext(readFileSync(p, 'utf8'), ctx); } catch { /* another layout */ }
    }
  }
  for (const v of Object.values(ctx)) if (v && typeof v === 'object') for (const [loc, d] of Object.entries(v)) if (d && typeof d === 'object') out[loc] = { ...(out[loc] || {}), ...d };
  return out;
}
const found = siblings.map(dictsOf);
const lookup = (loc, key) => { for (const d of found) if (d[loc] && typeof d[loc][key] === 'string') return d[loc][key]; return null; };
const q = (s) => JSON.stringify(s);
for (const [file, loc] of Object.entries(PRIMARY)) {
  const p = join(root, 'js/locales', file);
  let src = readFileSync(p, 'utf8');
  // Drop stray rows ("key": "value", one per line).
  src = src.split('\n').filter((line) => {
    const m = line.match(/^\s*("(?:[^"\\]|\\.)*")\s*:/);
    return !m || ALL.has(JSON.parse(m[1]));
  }).join('\n');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  const dict = ctx.DW_LOCALES[loc];
  const add = [];
  for (const key of ALL) {
    if (Object.prototype.hasOwnProperty.call(dict, key)) continue;
    const t = lookup(loc, key);
    if (t == null) { console.log(`missing ${loc}: ${key}`); continue; }
    add.push(`    ${q(key)}: ${q(t)}`);
  }
  // Fix trailing commas inside each block, then insert into the primary block.
  src = src.replace(/,(\s*\n\s*\};)/g, '$1');
  if (add.length) {
    const head = src.indexOf(`L['${loc}'] = {`);
    const end = src.indexOf('\n  };', head);
    src = src.slice(0, end) + ',\n' + add.join(',\n') + src.slice(end);
  }
  writeFileSync(p, src);
  console.log(`${file}: +${add.length}`);
}
