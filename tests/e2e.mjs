/**
 * Deepworks — end-to-end playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → settings open/close → Play → Practice (Miner) → countdown →
 *   play (keyboard assign/hire/upgrades, undo) → pause/resume →
 *   "End shift & bank score" → results → journey grid → help.
 * Runs twice: desktop 1280x800 and mobile 390x844 (touch), where actions
 * go through the thumb-zone tray buttons instead of the keyboard.
 *
 * The game degrades to a fully local guest mode without a StarHermit launch
 * token (js/platform.js), so this test serves the repo with a minimal
 * embedded static server — the authoritative server.js is not needed and
 * is intentionally not spawned.
 *
 * Run: npm run test:e2e
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = normalize(fileURLToPath(new URL('..', import.meta.url))).replace(/[\\/]+$/, '');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ts': 'text/plain; charset=utf-8',
};
// benign GPU/swiftshader noise, from tools/production_game_audit.mjs
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const SHOT = (stage, tag) => `/tmp/deepworks-e2e-${stage}-${tag}.png`;

function startStaticServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT + sep) && file !== ROOT) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runPass(browser, tag, viewport, hasTouch) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`);
  });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${tag}] ${name}`);
  };
  const screenIs = (name) =>
    page.waitForFunction((n) => window.DWUI && window.DWUI.currentScreen() === n, name, { timeout: 10000 });
  const credits = () => page.evaluate(() => document.getElementById('res-credits').textContent);
  const income = () => page.evaluate(() => document.getElementById('res-income').textContent);
  // The HUD tray/rail buttons are rebuilt whenever the economy signature
  // changes (constantly, while earning), so locator round-trips race node
  // replacement: waitFor resolves a live button, then boundingBox() lands on
  // a stale detached one and returns null. Read the rect atomically in-page
  // instead, then tap those coordinates — a real touch on the visible button.
  const tapText = async (containerSel, text) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const box = await page.evaluate(([cs, t]) => {
        const btns = Array.from(document.querySelectorAll(cs + ' .btn'));
        const b = btns.find((x) => x.textContent.includes(t) && !x.disabled)
                 || btns.find((x) => x.textContent.includes(t));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return (r.width > 0 && r.height > 0)
          ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      }, [containerSel, text]);
      if (box) {
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        return;
      }
      await page.waitForTimeout(150); // tray rebuilt mid-tap; re-query and retry
    }
    throw new Error(`no bounding box for tap target ${containerSel} "${text}"`);
  };

  try {
    await step('load → boot → title', async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
      await page.waitForSelector('#screen-title.active', { timeout: 10000 });
      await screenIs('title');
      await page.screenshot({ path: SHOT('title', tag) });
    });

    await step('settings open/close from title', async () => {
      await page.click('#btn-settings');
      await page.waitForSelector('#screen-settings.active');
      const rm = page.getByLabel('Reduced motion');
      await rm.check();
      if (!(await rm.isChecked())) throw new Error('reduced-motion toggle did not stick');
      await rm.uncheck();
      await page.screenshot({ path: SHOT('settings', tag) });
      await page.locator('#settings-panel .back-btn').click();
      await screenIs('title');
    });

    await step('Play → mode select', async () => {
      await page.click('#btn-play');
      await page.waitForSelector('#screen-modes.active');
      const modes = await page.locator('#mode-grid .card').count();
      if (modes !== 6) throw new Error(`expected 6 mode cards, got ${modes}`);
      await page.screenshot({ path: SHOT('modes', tag) });
    });

    await step('practice setup → start shift → countdown → play', async () => {
      await page.locator('#mode-grid .card', { hasText: 'Practice' }).click();
      await page.waitForSelector('#screen-setup.active');
      await page.locator('#setup-panel .card', { hasText: 'Miner' }).click();
      await page.screenshot({ path: SHOT('setup', tag) });
      await page.locator('#setup-panel .btn', { hasText: 'Start shift' }).click();
      await page.waitForSelector('#hud:not(.hidden)');
      await page.waitForTimeout(2500); // ride out the ~1.8s countdown
      await screenIs('play');
    });

    await step('hire a worker through the UI', async () => {
      // workers start fully assigned (idle 0/N); hiring is what frees a hand
      const before = await page.evaluate(() => document.getElementById('res-workers').textContent);
      if (!before.startsWith('0/')) throw new Error(`unexpected initial workers "${before}"`);
      if (hasTouch) {
        await tapText('#hud-bottom', 'Hire');
      } else {
        await page.keyboard.press('h');
      }
      await page.waitForFunction(
        (b) => document.getElementById('res-workers').textContent !== b,
        before, { timeout: 5000 }
      );
      console.log(`  [${tag}] workers:`, before, '→',
        await page.evaluate(() => document.getElementById('res-workers').textContent));
    });

    await step('select layer and assign crew', async () => {
      const idleBefore = await page.evaluate(() => document.getElementById('res-workers').textContent);
      if (hasTouch) {
        // mobile: layer labels are the on-mine DOM buttons; actions live in the thumb tray
        await page.waitForSelector('.layer-label', { state: 'visible', timeout: 8000 });
        // labels track the 3D projection every frame, so they never settle "stable"
        await page.locator('.layer-label').first().tap({ force: true });
        await page.waitForTimeout(150);
        await tapText('#hud-bottom', 'Assign');
      } else {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(150);
        await page.keyboard.press('Enter');
      }
      await page.waitForFunction(
        (b) => document.getElementById('res-workers').textContent !== b,
        idleBefore, { timeout: 5000 }
      );
      await page.waitForFunction(
        () => document.getElementById('res-income').textContent !== '0/s',
        null, { timeout: 5000 }
      );
      console.log(`  [${tag}] income after assign:`, await income());
      await page.screenshot({ path: SHOT('play', tag) });
    });

    await step('upgrades through the UI', async () => {
      if (hasTouch) {
        // lift upgrades live in the Foreman's Panel drawer on small screens
        await page.click('#rail-toggle-right');
        const capEnabled = await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('#right-rail-body .btn'))
            .find((x) => x.textContent.includes('Lift capacity'));
          return !!b && !b.disabled;
        });
        if (capEnabled) await tapText('#right-rail-body', 'Lift capacity');
        await page.click('#rail-toggle-right');
      } else {
        for (const k of ['q', 'w', 'e', 'd']) await page.keyboard.press(k);
      }
      await page.waitForTimeout(1200);
      console.log(`  [${tag}] workers:`, await page.evaluate(() => document.getElementById('res-workers').textContent));
    });

    await step('economy advances (credits earned)', async () => {
      await page.waitForTimeout(4000);
      const c = await credits();
      if (!/[1-9]/.test(c)) throw new Error(`no credits earned, HUD shows "${c}"`);
      console.log(`  [${tag}] credits:`, c);
    });

    if (!hasTouch) {
      await step('undo (Z) in practice', async () => {
        await page.keyboard.press('z');
        await page.waitForFunction(
          () => document.getElementById('toast-root').textContent.includes('Undone'),
          null, { timeout: 4000 }
        );
      });
    }

    await step('pause → resume', async () => {
      if (hasTouch) await page.click('#btn-pause');
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#screen-settings.active');
      const heading = await page.textContent('#settings-panel h2');
      if (heading !== 'Paused') throw new Error(`expected Paused panel, got "${heading}"`);
      await page.screenshot({ path: SHOT('pause', tag) });
      await page.locator('#settings-panel .btn.primary', { hasText: 'Resume' }).click();
      await screenIs('play');
    });

    await step('end shift → results screen', async () => {
      if (hasTouch) await page.click('#btn-pause');
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#screen-settings.active');
      await page.locator('#settings-panel .btn', { hasText: 'End shift & bank score' }).click();
      await page.locator('#modal-root .btn', { hasText: 'Confirm' }).click();
      await page.waitForSelector('#screen-results.active', { timeout: 8000 });
      const score = await page.textContent('#results-panel .score-big');
      if (!score) throw new Error('results screen has no score');
      const rows = await page.locator('#results-panel .breakdown .kv, #results-panel .breakdown > *').count();
      if (rows < 5) throw new Error(`expected score breakdown rows, got ${rows}`);
      console.log(`  [${tag}] final score:`, score.trim());
      await page.screenshot({ path: SHOT('results', tag) });
    });

    await step('back to title → journey grid', async () => {
      await page.locator('#results-panel .btn', { hasText: 'Shift select' }).click();
      await screenIs('title');
      await page.click('#btn-journey');
      await page.waitForSelector('#screen-journey.active');
      const nodes = await page.locator('.jnode').count();
      if (nodes !== 40) throw new Error(`expected 40 journey stages, got ${nodes}`);
      const unlocked = await page.locator('.jnode:not(.locked)').count();
      if (unlocked < 1) throw new Error('no journey stage unlocked');
      await page.screenshot({ path: SHOT('journey', tag) });
      await page.locator('#screen-journey .back-btn').click();
      await screenIs('title');
    });

    await step('help screen', async () => {
      await page.click('#btn-help');
      await page.waitForSelector('#screen-help.active');
      const cards = await page.locator('#help-body .card').count();
      if (cards < 1) throw new Error('help screen has no cards');
      await page.locator('#screen-help .back-btn').click();
      await screenIs('title');
    });
  } finally {
    await context.close();
  }

  if (errors.length) {
    throw new Error(`[${tag}] page errors:\n` + errors.join('\n'));
  }
}

let server, browser;
try {
  server = await startStaticServer();
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  await runPass(browser, 'desktop', { width: 1280, height: 800 }, false);
  await runPass(browser, 'mobile', { width: 390, height: 844 }, true);
  console.log('\nE2E PASS — both viewport passes clean, no page errors');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
}
