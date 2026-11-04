/* tests/cdp-throw.mjs — 真实鼠标事件验证「投石」：点击是否真的扔出石头、怪物是否真的听见。
   场景 A 验证输入链路；B 验证近距离引怪；C 验证隔墙中等距离（新增 10.5 格 / 穿墙 0.8）；
   D 统计追击中被骗概率；E 截一张瞄准虚线。 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9467;
const ROOT = 'file:///D:/%E4%B8%87%E6%98%8A%E6%9E%97/%E9%A1%B9%E7%9B%AE/%E6%81%90%E6%80%96%E6%B8%B8%E6%88%8F/index.html';
const SHOTS = 'D:\\万昊林\\项目\\恐怖游戏\\tests\\shots';
mkdirSync(SHOTS, { recursive: true });

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  const send = async (method, params = {}) => {
    await opened;
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { send, close: () => ws.close() };
}

async function ev(page, expr) {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result ? r.result.value : undefined;
}
async function waitFor(fn, timeout = 6000, step = 60) {
  const start = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await sleep(step);
  }
}
async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const f = SHOTS + '\\' + name + '.png';
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
}
async function mouseMove(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await sleep(60);
}
async function mouseClick(page, x, y) {
  await mouseMove(page, x, y);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(40);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.env.TEMP + '\\bh-throw-' + Date.now(),
  '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });

const out = { scenarios: {} };
try {
  for (let i = 0; i < 100; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) break; } catch { } await sleep(120); }
  const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(ROOT), { method: 'PUT' })).json();
  const page = connect(t.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await waitFor(() => ev(page, 'document.readyState === "complete"'), 8000);
  await ev(page, 'document.getElementById("btn-start").click()');
  await waitFor(() => ev(page, 'BH.S.mode === "playing"'), 5000);
  out.viewport = await ev(page, '({w: BH.view.w, h: BH.view.h, zoom: +BH.view.zoom.toFixed(3)})');

  async function setup(px, py, mx, my, mstate, stones) {
    await ev(page, `(function(){
      BH.player.x=${px}; BH.player.y=${py}; BH.player.hidden=null; BH.player.throwCd=0; BH.player.stones=${stones == null ? 5 : stones};
      BH.monster.x=${mx}; BH.monster.y=${my}; BH.monster.state=${JSON.stringify(mstate)};
      BH.monster.path=null; BH.monster.target=null; BH.monster.spotTarget=null; BH.monster.searchPoint=null;
      BH.monster.chaseLostT=0; BH.monster.pauseT=0; BH.monster.listenT=999;
      BH.events.length=0; BH.projectiles.length=0;
      return 1;
    })()`);
    await sleep(120);
  }

  // ---------- A. 真实点击 + 瞄准虚线（截图） ----------
  await setup(30.5, 41.5, 30.5, 6.5, 'patrol');
  const aimScreen = await ev(page, `(function(){
    var s = BH.worldToScreen(BH.player.x, BH.player.y - 4);
    return {x: Math.max(20, Math.min(BH.view.w-20, s.x)), y: Math.max(20, Math.min(BH.view.h-20, s.y))};
  })()`);
  await mouseMove(page, aimScreen.x, aimScreen.y);
  await sleep(200);
  out.scenarios.aimLine = { aim: aimScreen, screenshot: await shot(page, 'throw-aim') };
  await mouseClick(page, aimScreen.x, aimScreen.y);
  await sleep(150);
  const afterA = await ev(page, '({stones: BH.player.stones, projectiles: BH.projectiles.length, events: BH.api.events().slice(-3)})');
  out.scenarios.realClick = { after: afterA };

  // ---------- B. 怪物 6 格内巡逻：石头落地应当把它引过去 ----------
  await setup(30.5, 41.5, 30.5, 35.5, 'patrol');
  const aimB = await ev(page, 'BH.worldToScreen(30.5, 38.0)');
  await mouseClick(page, aimB.x, aimB.y);
  await sleep(1200);
  const rb = await ev(page, '({state: BH.monster.state, lastHeard: BH.monster.lastHeard, target: BH.monster.target, d:+Math.hypot(BH.monster.x-BH.player.x, BH.monster.y-BH.player.y).toFixed(2), events: BH.api.events().slice(-6)})');
  out.scenarios.nearPatrol = { after: rb, screenshot: await shot(page, 'throw-near') };

  // ---------- C. 隔墙 7~9 格：验证 10.5 格 x0.8 的新听觉半径 ----------
  // 在整张地图的地板格里找一个距石头落点 7~9 格、且连线被墙挡住的点
  const spotC = await ev(page, `(function(){
    var land = {x: 30.5, y: 39.9};
    var L = BH.level, out = null;
    function blocked(ax, ay, bx, by) {
      var n = 60;
      for (var i = 1; i < n; i++) {
        var t = i / n;
        var x = Math.floor(ax + (bx-ax)*t), y = Math.floor(ay + (by-ay)*t);
        if (L.solid[y * L.W + x]) return true;
      }
      return false;
    }
    for (var y = 2; y < L.H - 2 && !out; y++) {
      for (var x = 2; x < L.W - 2; x++) {
        if (!L.isFloor[y * L.W + x]) continue;
        var cx = x + 0.5, cy = y + 0.5;
        var d = Math.hypot(cx-land.x, cy-land.y);
        if (d > 8.2 && d < 9.2 && blocked(cx, cy, land.x, land.y)) { out = {x:cx, y:cy, d:+d.toFixed(2)}; break; }
      }
    }
    return out;
  })()`);
  if (spotC) {
    await setup(30.5, 41.5, spotC.x, spotC.y, 'patrol');
    await ev(page, 'BH.monster.pauseT = 99;'); // 让它站定，避免石头落地前它自己走远
    const aimC = await ev(page, 'BH.worldToScreen(30.5, 38.0)');
    await mouseClick(page, aimC.x, aimC.y);
    await sleep(1200);
    const rc = await ev(page, '({state: BH.monster.state, lastHeard: BH.monster.lastHeard, events: BH.api.events().slice(-5)})');
    out.scenarios.throughWall = { monster: spotC, after: rc };
  }

  // ---------- C2. 远距离（>10.5 格且隔墙）：应当听不到，作为对照 ----------
  const spotFar = await ev(page, `(function(){
    var land = {x: 30.5, y: 39.9}, L = BH.level, out = null;
    function blocked(ax, ay, bx, by) {
      var n = 80;
      for (var i = 1; i < n; i++) {
        var t = i / n;
        var x = Math.floor(ax + (bx-ax)*t), y = Math.floor(ay + (by-ay)*t);
        if (L.solid[y * L.W + x]) return true;
      }
      return false;
    }
    for (var y = 2; y < L.H - 2 && !out; y++) {
      for (var x = 2; x < L.W - 2; x++) {
        if (!L.isFloor[y * L.W + x]) continue;
        var cx = x + 0.5, cy = y + 0.5, d = Math.hypot(cx-land.x, cy-land.y);
        if (d > 16 && d < 20 && blocked(cx, cy, land.x, land.y)) { out = {x:cx, y:cy, d:+d.toFixed(2)}; break; }
      }
    }
    return out;
  })()`);
  if (spotFar) {
    await setup(30.5, 41.5, spotFar.x, spotFar.y, 'patrol');
    const aimF = await ev(page, 'BH.worldToScreen(30.5, 38.0)');
    await mouseClick(page, aimF.x, aimF.y);
    await sleep(1000);
    out.scenarios.tooFar = await ev(page, '({state: BH.monster.state, lastHeard: BH.monster.lastHeard, events: BH.api.events().slice(-4)})');
  }

  // ---------- D. 追击中被石头带偏的概率（用 API 注入 20 次，避免飞行/冷却干扰） ----------
  await setup(30.5, 41.5, 30.5, 35.5, 'chase');
  let distracted = 0;
  for (let i = 0; i < 20; i++) {
    await ev(page, `(function(){
      BH.monster.state='chase'; BH.monster.chaseLostT=0; BH.monster.path=null;
      BH.monster.x=30.5; BH.monster.y=35.5;
      BH.player.lastHeard = {source:'walk', dist:6, t: BH.S.runTime - 3.0}; // 很久没听见玩家 -> stale 分支 45%
      BH.api.emitNoise(30.5, 39.9, 10.5, 'decoy');
      return BH.monster.state;
    })()`);
    await sleep(20);
    const st = await ev(page, 'BH.monster.state');
    if (st === 'investigate') distracted++;
  }
  out.scenarios.chaseThrow = { trials: 20, distracted, expected: '0.45 stale' };

  out.errlog = await ev(page, "document.getElementById('errlog').textContent");
  out.ok = true;
  page.close();
} catch (e) {
  out.fatal = String(e.stack || e);
} finally {
  try { edge.kill(); } catch { }
  await sleep(300);
}
console.log(JSON.stringify(out, null, 1));
