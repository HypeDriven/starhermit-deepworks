// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Practice shift as Miner and keeps running the mine through the documented keyboard
// controls — hire (H), select a layer and assign crew (↓ / Enter), buy upgrades (Q W E D) — so the lift
// cycles, crystals glint, workers move, ore particles fly and new layers open.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title.active', { timeout: 20000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#gfx-preset', { state: 'visible' });
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.locator('#settings-panel .back-btn').click();
  await page.waitForSelector('#screen-title.active');
}

export async function start(page) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-modes.active');
  await page.locator('#mode-grid .card', { hasText: 'Practice' }).click();
  await page.waitForSelector('#screen-setup.active');
  await page.locator('#setup-panel .card', { hasText: 'Miner' }).click();
  await page.locator('#setup-panel .btn', { hasText: 'Start shift' }).click();
  await page.waitForSelector('#hud:not(.hidden)');
  await page.waitForTimeout(2200); // countdown
  let open = true, i = 0;
  page.once('close', () => { open = false; });
  const keys = ['h', 'Enter', 'q', 'w', 'e', 'd'];
  await page.keyboard.press('ArrowDown'); // select the first layer
  (async () => {
    while (open) {
      try {
        if (await page.locator('#screen-results.active').count()) break;
        await page.keyboard.press(keys[i++ % keys.length]);
      } catch { if (!open) return; }
      await new Promise((r) => setTimeout(r, 900));
    }
  })();
  await page.waitForTimeout(3000);
}
