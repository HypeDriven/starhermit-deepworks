/**
 * Targeted verification for the 2026-09-07 review fixes (dev only, not shipped):
 *  1. Escape on the pause-settings screen resumes the run (does NOT dump to title).
 *  2. Pausing during the countdown keeps the sim paused until Resume.
 *  3. Hiding the tab mid-run surfaces the pause panel on return.
 *  4. Timing-assist setting doubles the flare window in casual modes.
 *  5. Offline daily submission lands on the local casual board with a real score.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = normalize(fileURLToPath(new URL('..', import.meta.url))).replace(/[\\/]+$/, '');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.opus': 'audio/ogg', '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT + sep) && file !== ROOT) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/GL Driver|swiftshader|WebGL/i.test(m.text())) errors.push('console: ' + m.text()); });

const screenIs = (n) => page.waitForFunction((x) => window.DWUI && window.DWUI.currentScreen() === x, n, { timeout: 10000 });
const check = (name, cond) => { if (!cond) throw new Error('FAILED: ' + name); console.log('ok - ' + name); };

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await screenIs('title');

  // start a practice run
  await page.click('#btn-play');
  await page.locator('#mode-grid .card', { hasText: 'Practice' }).click();
  await page.locator('#setup-panel .card', { hasText: 'Miner' }).click();
  await page.locator('#setup-panel .btn', { hasText: 'Start shift' }).click();

  // (2) pause DURING the countdown, wait out the countdown, sim must stay paused
  await page.waitForTimeout(400); // countdown still running (1.8s)
  await page.keyboard.press('Escape');
  await page.waitForSelector('#screen-settings.active');
  await page.waitForTimeout(2200); // countdown would have ended by now
  const pausedAfterCountdown = await page.evaluate(() => {
    // sim paused => tick frozen; read twice with a gap
    return new Promise((resolve) => {
      const t1 = document.getElementById('hud-timer').textContent;
      setTimeout(() => resolve(t1 === document.getElementById('hud-timer').textContent), 700);
    });
  });
  check('countdown ending behind pause menu keeps sim paused', pausedAfterCountdown);

  // (1) Escape on the pause-settings screen resumes (not title limbo)
  await page.keyboard.press('Escape');
  await screenIs('play');
  const ticking = await page.evaluate(() => new Promise((resolve) => {
    const t1 = document.getElementById('hud-timer').textContent;
    setTimeout(() => resolve(t1 !== document.getElementById('hud-timer').textContent), 1400);
  }));
  check('Escape in pause menu resumes a ticking sim', ticking);

  // (3) hiding the tab surfaces the pause panel
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForSelector('#screen-settings.active', { timeout: 5000 });
  const pauseHead = await page.textContent('#settings-panel h2');
  check('tab hide shows Paused panel', pauseHead === 'Paused');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.locator('#settings-panel .btn.primary', { hasText: 'Resume' }).click();
  await screenIs('play');

  // (4) timing assist doubles flare duration in casual modes
  await page.keyboard.press('Escape'); // pause
  await page.waitForSelector('#screen-settings.active');
  await page.getByLabel(/Timing assistance/).check();
  await page.locator('#settings-panel .btn.primary', { hasText: 'Resume' }).click();
  await screenIs('play');
  await page.reload();
  await screenIs('title');
  await page.evaluate(() => {
    const createRun = DWSession.createRun;
    DWSession.createRun = function (...args) {
      const run = createRun.apply(this, args);
      window.reviewRun = run;
      window.reviewBaseFlareDuration = run.state.ruleset.flareDurationSec;
      return run;
    };
  });
  await page.click('#btn-play');
  await page.locator('#mode-grid .card', { hasText: 'Practice' }).click();
  await page.locator('#setup-panel .card', { hasText: 'Miner' }).click();
  await page.locator('#setup-panel .btn', { hasText: 'Start shift' }).click();
  await screenIs('play');
  check('timing assist doubles the live casual run flare window', await page.evaluate(() =>
    window.reviewRun.state.ruleset.flareDurationSec === window.reviewBaseFlareDuration * 2));

  // (5) offline daily submission lands on the local casual board with a real score
  const board = await page.evaluate(() => {
    return DWPlatform.submitScore('daily', {
      dayKey: 'daily-2026-09-07', name: 'Smoke Tester', scoreTotal: 777000, durationSec: 55,
      playerId: 'p123', clientHash: 0, log: []
    }).then(() => DWPlatform.getBoard('daily'));
  });
  check('offline daily board stores numeric score', board.entries.length > 0 && board.entries[0].score === 777000);
  check('offline daily board stores submitted name', board.entries[0].name === 'Smoke Tester');

  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  console.log('\nTARGETED CHECKS PASS');
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
