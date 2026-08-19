// CDP smoke driver: navigate, click through UI, run gameplay, screenshot.
// Usage: node tests/smoke.js <url> <outPrefix>
const CDP_PORT = 9223;
const { execFile } = require('child_process');

const url = process.argv[2] || 'http://localhost:8199/';
const out = process.argv[3] || '/tmp/dw';

const chrome = execFile('google-chrome', [
  '--headless=new', '--no-sandbox', '--remote-debugging-port=' + CDP_PORT,
  '--window-size=' + (process.env.DW_SIZE || '1280,800'), '--use-angle=swiftshader', 'about:blank'
], () => {});

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const consoleMsgs = [];

function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
}
async function evaljs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 500));
  return r.result && r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(`${out}-${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
}

(async () => {
  // wait for devtools endpoint
  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch (e) {}
  }
  if (!target) throw new Error('no CDP target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      consoleMsgs.push(m.params.type + ': ' + m.params.args.map(a => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleMsgs.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(3500);

  console.log('screen:', await evaljs('DWUI.currentScreen()'));
  console.log('webgl renderer:', await evaljs('!!document.querySelector("#scene-host canvas")'));
  await shot('title');

  // Play -> modes
  await evaljs('document.getElementById("btn-play").click()');
  await sleep(400);
  await shot('modes');

  // start practice (miner difficulty)
  await evaljs(`DWUI.openSetup('practice-go', {id:'practice-miner', name:'Practice — Miner', version:1, seed:12345, theme:'emberdeep', overrides:{}, goals:null, limits:null, parSec:0, endless:true})`);
  await sleep(300);
  await evaljs(`[...document.querySelectorAll('#setup-panel .btn')].find(b=>b.textContent.includes('Start')).click()`);
  await sleep(2500); // countdown ~1.8s
  console.log('screen after start:', await evaljs('DWUI.currentScreen()'));
  await shot('play-early');

  // play: assign via keyboard, hire, upgrades through 30 simulated seconds
  const report = await evaljs(`(async () => {
    const sleep = ms => new Promise(r=>setTimeout(r,ms));
    const key = k => document.dispatchEvent(new KeyboardEvent('keydown', {key:k}));
    const log = [];
    key('ArrowDown'); await sleep(150);
    key('Enter'); await sleep(150);
    key('H'); await sleep(150);       // hire
    key('Enter'); await sleep(150);   // assign
    key('W'); await sleep(150);       // lift cap
    key('E'); await sleep(150);       // lift speed
    key('Q'); await sleep(150);       // shaft
    key('D'); await sleep(150);       // unlock layer
    await sleep(4000);
    const st = (window.__app_state = null, null);
    return 'keys sent';
  })()`);
  console.log(report);
  await shot('play-after-keys');

  // inspect game state via HUD values
  const hud = await evaljs(`({
    credits: document.getElementById('res-credits').textContent,
    income: document.getElementById('res-income').textContent,
    workers: document.getElementById('res-workers').textContent,
    timer: document.getElementById('hud-timer').textContent,
    labels: document.querySelectorAll('.layer-label').length,
    rightRail: document.getElementById('right-rail-body').children.length
  })`);
  console.log('HUD:', JSON.stringify(hud));

  // pause menu
  await evaljs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await sleep(400);
  await shot('pause');
  console.log('pause screen:', await evaljs('DWUI.currentScreen()'));
  await evaljs(`[...document.querySelectorAll('#settings-panel .btn')].find(b=>b.textContent.trim()==='Resume').click()`);
  await sleep(400);
  console.log('after resume:', await evaljs('DWUI.currentScreen()'));

  // wait for a flare and claim it via keyboard F (flares every 35-70s; force one for test)
  await evaljs(`(() => { /* no direct handle; wait naturally */ })()`);
  await sleep(2000);
  await shot('play-later');

  // end the practice run via pause menu: pause -> end shift
  await evaljs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await sleep(300);
  const hasEnd = await evaljs(`!![...document.querySelectorAll('#settings-panel .btn')].find(b=>b.textContent.includes('End shift'))`);
  console.log('has end-shift button:', hasEnd);
  if (hasEnd) {
    await evaljs(`[...document.querySelectorAll('#settings-panel .btn')].find(b=>b.textContent.includes('End shift')).click()`);
    await sleep(300);
    await evaljs(`[...document.querySelectorAll('#modal-root .btn')].find(b=>b.textContent.trim()==='Confirm').click()`);
    await sleep(800);
    console.log('results screen:', await evaljs('DWUI.currentScreen()'));
    await shot('results');
  }

  // journey grid
  await evaljs(`[...document.querySelectorAll('#screen-results .btn')].find(b=>b.textContent.includes('Shift select')).click()`);
  await sleep(400);
  await evaljs('document.getElementById("btn-journey").click()');
  await sleep(400);
  console.log('journey nodes:', await evaljs('document.querySelectorAll(".jnode").length'));
  await shot('journey');

  // help screen
  await evaljs('DWUI.back()'); await sleep(200);
  await evaljs('document.getElementById("btn-help").click()'); await sleep(300);
  console.log('help cards:', await evaljs('document.querySelectorAll("#help-body .card").length'));

  // learn lesson 1 smoke: enter lesson and perform assign
  await evaljs('DWUI.back()'); await sleep(200);
  await evaljs(`DWUI.openSetup('learn')`); await sleep(300);
  await evaljs(`document.querySelector('#screen-setup .card').click()`); await sleep(300);
  await evaljs(`[...document.querySelectorAll('#setup-panel .btn')].find(b=>b.textContent.includes('Start')).click()`);
  await sleep(800);
  console.log('lesson screen:', await evaljs('DWUI.currentScreen()'), 'banner:', await evaljs('document.getElementById("lesson-banner").textContent.slice(0,60)'));
  await evaljs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}))`);
  await sleep(150);
  await evaljs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`);
  await sleep(600);
  console.log('lesson step after assign:', await evaljs('document.getElementById("lesson-banner").textContent.slice(0,60)'));
  await shot('lesson');

  console.log('console problems:', consoleMsgs.length ? consoleMsgs.slice(0, 15) : 'none');
  chrome.kill();
  process.exit(consoleMsgs.filter(m => m.startsWith('EXCEPTION') || m.startsWith('error')).length ? 1 : 0);
})().catch(e => { console.error('SMOKE FAIL:', e.message); console.error(consoleMsgs.join('\n')); chrome.kill(); process.exit(1); });
