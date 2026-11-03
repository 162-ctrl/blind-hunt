/* =========================================================================
 * tests/cdp-run.mjs — 《盲猎》无头 E2E 验收（Edge + CDP）v2
 * -------------------------------------------------------------------------
 * 用真实无头 Edge 通过 DevTools Protocol 驱动游戏，覆盖：
 *   标题 → 开始 → 手电 → 行走 → 声呐倾听 → 合闸(电闸) → 读笔记 → 拾取 →
 *   投石 → 躲藏/屏息 → 引怪追击 → 暂停/恢复 → 死亡界面 → 重开 → 开门胜利
 * 每个阶段产出 tests/shots/NN-*.png 截图与关键状态断言。
 * 用法：D:\node.exe tests/cdp-run.mjs
 * ========================================================================= */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9455;
const ROOT = 'file:///D:/%E4%B8%87%E6%98%8A%E6%9E%97/%E9%A1%B9%E7%9B%AE/%E6%81%90%E6%80%96%E6%B8%B8%E6%88%8F/index.html';
const SHOTS = 'D:\\万昊林\\项目\\恐怖游戏\\tests\\shots';
const PROFILE = process.env.TEMP + '\\bh-cdp-profile-' + Date.now();
mkdirSync(SHOTS, { recursive: true });
mkdirSync(PROFILE, { recursive: true });

const report = { stages: [], jsExceptions: [], consoleErrors: [], logEntries: [] };
const log = (...a) => console.error('[qa]', ...a);

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  async function send(method, params = {}) {
    await opened;
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return { send, events, close: () => ws.close() };
}

async function evaluate(page, expr) {
  const r = await page.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
  }
  return r.result ? r.result.value : undefined;
}

async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = SHOTS + '\\' + name + '.png';
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    report.stages.push({ name, ok: true, ms: Date.now() - t0, value });
    log('OK', name, JSON.stringify(value));
    return value;
  } catch (e) {
    report.stages.push({ name, ok: false, ms: Date.now() - t0, error: String(e.message || e) });
    log('FAIL', name, String(e.message || e));
    return null;
  }
}

// 无头渲染帧率低（约 10–20fps），且 dt 被 clamp 到 0.05s，游戏内时间推进比真实时间慢；
// 所有依赖计时/状态的阶段都必须轮询，而不能用固定 sleep 猜测。
async function waitFor(expr, timeoutMs = 12000, interval = 150) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await evaluate(page, expr);
    if (last) return last;
    await sleep(interval);
  }
  throw new Error('waitFor 超时(' + timeoutMs + 'ms): ' + expr + ' → ' + JSON.stringify(last));
}

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=Translate,MediaRouter',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--window-size=1600,900',
  'about:blank'
], { stdio: 'ignore' });

let page;
try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) break; } catch { }
    await sleep(120);
  }
  const created = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(ROOT), { method: 'PUT' });
  const target = await created.json();
  page = connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');

  for (let i = 0; i < 120; i++) {
    try { if (await evaluate(page, 'document.readyState') === 'complete') break; } catch { }
    await sleep(100);
  }
  await sleep(400);

  // 常用页面内工具
  const Q = {
    mode: () => evaluate(page, 'BH.S.mode'),
    snap: () => evaluate(page, 'BH.api.debugSnapshot()'),
    errlog: () => evaluate(page, "document.getElementById('errlog').textContent"),
    key: (code, down) => evaluate(page, `window.__BH_DEBUG.key(${JSON.stringify(code)}, ${down})`),
    press: async (code) => { await Q.key(code, true); await sleep(90); await Q.key(code, false); },
    teleport: (x, y) => evaluate(page, `(function(){BH.player.x=${x};BH.player.y=${y};return {x:BH.player.x,y:BH.player.y};})()`),
    aimAt: (x, y) => evaluate(page, `(function(){
      var sp = BH.worldToScreen(${x}, ${y});
      BH.input.mouse.x = sp.x; BH.input.mouse.y = sp.y; BH.input.mouseActive = true;
      return sp;
    })()`),
    peace: () => evaluate(page, `(function(){
      BH.monster.x = BH.level.monsterSpawn.x + 0.5; BH.monster.y = BH.level.monsterSpawn.y + 0.5;
      BH.monster.state = 'patrol'; BH.monster.chaseT = 0; BH.monster.searchT = 0;
      BH.S.danger = 0;
      return {monster:{x:BH.monster.x,y:BH.monster.y}};
    })()`)
  };

  // ------------------------------------------------------------- 1. 启动
  await step('boot', async () => ({
    mode: await Q.mode(),
    titleScreen: await evaluate(page, "!document.getElementById('screen-title').classList.contains('hidden')"),
    scripts: await evaluate(page, "Array.from(document.scripts).map(s=>s.src.split('/').pop()).join(',')"),
    errlog: await Q.errlog(),
    audio: await evaluate(page, "window.AudioEngine ? (AudioEngine.ready?'ready':'idle') : 'missing'"),
    screenshot: await shot(page, '00-title')
  }));

  // ------------------------------------------------------------- 2. 开始
  await step('start', async () => {
    await evaluate(page, 'document.getElementById("btn-start").click()');
    await sleep(1000);
    return {
      mode: await Q.mode(),
      audio: await evaluate(page, "(function(){try{return AudioEngine.ready?'ready':'idle'}catch(e){return 'threw'}})()"),
      hudVisible: await evaluate(page, "!document.getElementById('hud').classList.contains('hidden')"),
      titleHidden: await evaluate(page, "document.getElementById('screen-title').classList.contains('hidden')"),
      player: await evaluate(page, '({x:BH.player.x,y:BH.player.y,battery:+BH.player.battery.toFixed(3),flashlightOn:BH.player.flashlightOn,stones:BH.player.stones})'),
      errlog: await Q.errlog(),
      screenshot: await shot(page, '01-start')
    };
  });

  // ------------------------------------------------------------- 3. 手电开关
  await step('flashlight', async () => {
    const initial = await evaluate(page, 'BH.player.flashlightOn');
    await Q.press('KeyF');
    await sleep(250);
    const afterOff = await evaluate(page, 'BH.player.flashlightOn');
    await Q.press('KeyF');
    await sleep(250);
    const afterOn = await evaluate(page, 'BH.player.flashlightOn');
    await Q.aimAt(30.5, 36.5);
    await sleep(300);
    const scr = await shot(page, '02-flashlight');
    return { initial, afterOff, afterOn, screenshot: scr };
  });

  // ------------------------------------------------------------- 4. 行走
  await step('walk', async () => {
    const before = await evaluate(page, '({x:BH.player.x,y:BH.player.y})');
    await Q.key('KeyW', true);
    await sleep(1000);
    await Q.key('KeyW', false);
    await sleep(200);
    const after = await evaluate(page, '({x:BH.player.x,y:BH.player.y,move:BH.player.moveState,stamina:+BH.player.stamina.toFixed(3)})');
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    if (moved < 0.4) throw new Error('角色没有移动，位移=' + moved.toFixed(3));
    return { before, after, moved: +moved.toFixed(2) };
  });

  // ------------------------------------------------------------- 5. 声呐倾听
  await step('sonar_listen', async () => {
    await evaluate(page, 'BH.player.x = 30.5; BH.player.y = 32.5; BH.player.flashlightOn = false;');
    await Q.aimAt(30.5, 20);
    await sleep(200);
    await Q.key('KeyR', true);
    await sleep(300);
    const listening = await evaluate(page, '({listening:BH.player.listening, move:BH.player.moveState})');
    // 把时间对齐到声呐脉冲中段（radT 约 7.5 格），保证截图能拍到扫出的墙体轮廓
    await evaluate(page, 'BH.S.time = Math.floor(BH.S.time / 1.9) * 1.9 + 0.95');
    await sleep(150);
    const scr = await shot(page, '03-sonar');
    await Q.key('KeyR', false);
    await sleep(300);
    return { listening, phase: await evaluate(page, '+(BH.S.time % 1.9).toFixed(2)'), screenshot: scr };
  });

  // ------------------------------------------------------------- 6. 合闸
  await step('breaker', async () => {
    await Q.peace();
    const setup = await evaluate(page, `(function(){
      var b = BH.breakers[0];
      BH.player.x = b.x + 0.5; BH.player.y = b.y + 1.5;
      BH.player.stamina = 1;
      return {id:b.id,x:b.x,y:b.y,on:b.on,room:b.room};
    })()`);
    await sleep(400);
    const interact = await evaluate(page, 'BH.player.interact ? BH.player.interact.kind : null');
    await Q.key('Space', true);
    // 长按 2.6s 游戏时间；无头帧率低，轮询直到合闸完成
    await waitFor('BH.breakers[0].on === true', 12000);
    const mid = await evaluate(page, '({hold:+(BH.player.hold||0).toFixed(2),kind:BH.player.holdKind,power:BH.S.power})');
    await Q.key('Space', false);
    await sleep(500);
    const after = await evaluate(page, '({power:BH.S.power,breakerOn:BH.breakers[0].on,gateUnlocked:BH.S.gateUnlocked,obj:document.getElementById("obj-text").textContent,monster:BH.monster.state})');
    const scr = await shot(page, '04-breaker-done');
    if (!after.breakerOn) throw new Error('合闸未完成: ' + JSON.stringify(after));
    return { setup, interact, mid, after, screenshot: scr };
  });

  // ------------------------------------------------------------- 7. 读笔记
  await step('note', async () => {
    await Q.peace();
    await evaluate(page, `(function(){
      var n = BH.notes[0];
      BH.player.x = n.x + 0.5; BH.player.y = n.y + 1.0;
      return {id:n.id,title:n.title};
    })()`);
    await sleep(400);
    const interact = await evaluate(page, 'BH.player.interact ? BH.player.interact.kind : null');
    await Q.press('Space');
    await sleep(500);
    const opened = await evaluate(page, "({mode:BH.S.mode,title:document.getElementById('note-title').textContent,textLen:document.getElementById('note-text').textContent.length,visible:!document.getElementById('screen-note').classList.contains('hidden')})");
    const scr = await shot(page, '05-note');
    await Q.press('Escape');
    await sleep(400);
    const closed = await evaluate(page, 'BH.S.mode');
    if (opened.mode !== 'note') throw new Error('笔记没有打开: ' + JSON.stringify(opened));
    return { interact, opened, closed, screenshot: scr };
  });

  // ------------------------------------------------------------- 8. 拾取
  await step('pickup', async () => {
    const setup = await evaluate(page, `(function(){
      for (var i = 0; i < BH.pickups.length; i++) {
        var it = BH.pickups[i];
        if (!it.taken) {
          BH.player.x = it.x + 0.5; BH.player.y = it.y + 0.5;
          return {id:it.id,type:it.type,amount:it.amount};
        }
      }
      return null;
    })()`);
    if (!setup) throw new Error('没有可拾取物');
    await sleep(600);
    const after = await evaluate(page, '({stones:BH.player.stones,battery:+BH.player.battery.toFixed(3),taken:BH.pickups.filter(function(p){return p.taken}).length})');
    return { setup, after };
  });

  // ------------------------------------------------------------- 9. 投石
  await step('throw', async () => {
    await Q.peace();
    const before = await evaluate(page, `(function(){
      if (BH.S.mode === 'note') BH.api.closeNote();
      BH.player.x = 30.5; BH.player.y = 32.5; BH.player.throwCd = 0;
      var sp = BH.worldToScreen(30.5, 20);
      BH.input.mouse.x = sp.x; BH.input.mouse.y = sp.y; BH.input.mouseActive = true;
      BH.input.clicked = true;   // 与瞄准同帧下发，避免主循环清掉 clicked
      return {stones:BH.player.stones, mode:BH.S.mode, aim:sp};
    })()`);
    await sleep(150);
    const mid = await evaluate(page, '({stones:BH.player.stones, projectiles:(BH.projectiles||[]).length})');
    await sleep(1200);
    const after = await evaluate(page, '({stones:BH.player.stones, projectiles:(BH.projectiles||[]).length, ripples:BH.ripples.length, monster:BH.monster.state})');
    if (mid.stones !== before.stones - 1) throw new Error('投石没有消耗石块: ' + JSON.stringify({ before, mid }));
    return { before, mid, after };
  });

  // ------------------------------------------------------------- 10. 躲藏 / 屏息
  await step('hide_breath', async () => {
    await Q.peace();
    if (await Q.mode() === 'note') { await evaluate(page, 'BH.api.closeNote()'); await sleep(300); }
    // 笔记交互优先于躲藏点（1.15 > 1.05），先把笔记全部标记已读，确保走到躲藏点按空格是躲藏
    await evaluate(page, 'BH.notes.forEach(function(n){ n.read = true; })');
    const spot = await evaluate(page, `(function(){
      for (var i = 0; i < BH.hideSpots.length; i++) {
        var s = BH.hideSpots[i];
        if (s.x > 24 && s.x < 40 && s.y > 28 && s.y < 42) {
          BH.player.x = s.x + 0.5; BH.player.y = s.y + 1.0;
          return {x:s.x,y:s.y,type:s.type};
        }
      }
      var s0 = BH.hideSpots[0];
      BH.player.x = s0.x + 0.5; BH.player.y = s0.y + 1.0;
      return {x:s0.x,y:s0.y,type:s0.type};
    })()`);
    await sleep(400);
    const interact = await evaluate(page, 'BH.player.interact ? BH.player.interact.kind : null');
    await Q.press('Space');
    await sleep(500);
    const hidden = await evaluate(page, '({hidden:!!BH.player.hidden,breathWrap:!document.getElementById("breath-wrap").classList.contains("hidden")})');
    await Q.key('Space', true);
    await sleep(1400);
    const holding = await evaluate(page, '({holdingBreath:BH.player.holdingBreath,breath:+BH.player.breath.toFixed(3)})');
    const scr = await shot(page, '06-hidden');
    await Q.key('Space', false);
    await sleep(300);
    await Q.press('KeyE');
    await sleep(400);
    const left = await evaluate(page, '!!BH.player.hidden');
    if (!hidden.hidden) throw new Error('没有进入躲藏: ' + JSON.stringify({ spot, interact, hidden }));
    return { spot, interact, hidden, holding, left, screenshot: scr };
  });

  // ------------------------------------------------------------- 11. 引怪追击
  await step('chase', async () => {
    if (await Q.mode() === 'note') { await evaluate(page, 'BH.api.closeNote()'); await sleep(300); }
    await evaluate(page, `(function(){
      BH.player.x = 30.5; BH.player.y = 34.0;
      BH.player.flashlightOn = true; BH.player.stamina = 1;
      BH.monster.x = 30.5; BH.monster.y = 29.5;
      BH.monster.state = 'patrol'; BH.monster.chaseT = 0; BH.monster.path = null;
      return {dist:+(Math.hypot(BH.monster.x-BH.player.x, BH.monster.y-BH.player.y)).toFixed(2)};
    })()`);
    await Q.aimAt(30.5, 27);
    await sleep(300);
    // 直接以玩家脚下为声源发一次冲刺噪音：4.5 格 < 7.2 冲刺半径，可稳定触发听觉→chase 链路
    const heard = await evaluate(page, `(function(){
      BH.api.emitNoise(BH.player.x, BH.player.y, 7.2, 'sprint');
      return {playerHeard:BH.player.lastHeard, monster:BH.monster.state};
    })()`);
    await sleep(400);
    const chasing = await evaluate(page, '({monster:BH.monster.state, distance:+(Math.hypot(BH.monster.x-BH.player.x,BH.monster.y-BH.player.y)).toFixed(2), danger:+(BH.S.danger||0).toFixed(2)})');
    const scr = await shot(page, '07-chase');
    if (chasing.monster !== 'chase') throw new Error('噪音没有引发追击: ' + JSON.stringify({ heard, chasing }));
    return { heard, state: chasing, screenshot: scr };
  });

  // ------------------------------------------------------------- 12. 暂停/恢复
  await step('pause_resume', async () => {
    if (await Q.mode() === 'note') { await evaluate(page, 'BH.api.closeNote()'); await sleep(300); }
    // 先从可能残留的躲藏状态里出来，保证处于 playing；并把怪物支开，避免暂停前被追上
    await evaluate(page, 'if (BH.player.hidden) { BH.player.hidden=false; BH.player.holdingBreath=false; }');
    await Q.peace();
    await sleep(200);
    // Escape 由 UI 层处理（game.js 的 input.keys 不经过它），必须派发真实键盘事件
    await evaluate(page, 'window.__BH_DEBUG.sendKey("Escape")');
    await waitFor('BH.S.mode === "paused"', 6000);
    await sleep(400);
    const paused = await evaluate(page, "({mode:BH.S.mode, visible:!document.getElementById('screen-pause').classList.contains('hidden')})");
    await evaluate(page, 'document.getElementById("btn-resume").click()');
    await sleep(500);
    const resumed = await evaluate(page, 'BH.S.mode');
    if (paused.mode !== 'paused') throw new Error('没有暂停: ' + JSON.stringify(paused));
    return { paused, resumed };
  });

  // ------------------------------------------------------------- 13. 死亡
  await step('death', async () => {
    await evaluate(page, 'window.__BH_DEBUG.forceKill()');
    // dying 1.15s 游戏时间 + 死亡特写；无头帧率低，需等状态而不是等固定时长
    await waitFor('BH.S.mode === "dead"', 12000);
    await sleep(250);
    const v = await evaluate(page, `({
      mode: BH.S.mode,
      reason: document.getElementById('dead-reason').textContent,
      sub: document.getElementById('dead-sub').textContent,
      tip: document.getElementById('dead-tip').textContent,
      time: document.getElementById('dead-time').textContent,
      hudHidden: document.getElementById('hud').classList.contains('hidden'),
      deadVisible: !document.getElementById('screen-dead').classList.contains('hidden')
    })`);
    const scr = await shot(page, '08-death');
    if (v.mode !== 'dead') throw new Error('没有进入死亡界面: ' + v.mode);
    if (!v.hudHidden) throw new Error('死亡界面时 HUD 仍然可见');
    return { ...v, screenshot: scr };
  });

  // ------------------------------------------------------------- 14. 重开
  await step('retry', async () => {
    await evaluate(page, 'document.getElementById("btn-retry").click()');
    await sleep(1000);
    return {
      mode: await Q.mode(),
      power: await evaluate(page, 'BH.S.power'),
      player: await evaluate(page, '({x:+BH.player.x.toFixed(1),y:+BH.player.y.toFixed(1),battery:+BH.player.battery.toFixed(2),stones:BH.player.stones})'),
      hudVisible: await evaluate(page, "!document.getElementById('hud').classList.contains('hidden')"),
      errlog: await Q.errlog(),
      screenshot: await shot(page, '09-retry')
    };
  });

  // ------------------------------------------------------------- 15. 胜利
  await step('win', async () => {
    await evaluate(page, `(function(){
      BH.monster.x = BH.level.monsterSpawn.x + 0.5; BH.monster.y = BH.level.monsterSpawn.y + 0.5;
      BH.monster.state = 'patrol';
      for (var i = 0; i < BH.breakers.length; i++) { BH.breakers[i].on = true; BH.S.powerOn[BH.breakers[i].id] = true; }
      BH.S.power = 3; BH.S.gateUnlocked = true;
      var g = BH.level.gate;
      BH.player.x = g.x + 0.5; BH.player.y = g.y + 0.5 - 1.25;
      BH.player.hold = 0;
      return {gate:g, player:{x:BH.player.x,y:BH.player.y}};
    })()`);
    await sleep(400);
    const interact = await evaluate(page, 'BH.player.interact ? BH.player.interact.kind : null');
    await Q.key('Space', true);
    // 开门需按住 2.8s 游戏时间 + winning 0.9s
    await waitFor('BH.S.mode === "won"', 20000);
    await Q.key('Space', false);
    await sleep(400);
    const v = await evaluate(page, `({
      mode: BH.S.mode,
      interact: BH.player.interact ? BH.player.interact.kind : null,
      winVisible: !document.getElementById('screen-win').classList.contains('hidden'),
      winTime: document.getElementById('win-time').textContent,
      winDeaths: document.getElementById('win-deaths').textContent,
      winNotes: document.getElementById('win-notes').textContent,
      winBattery: document.getElementById('win-battery').textContent,
      hudHidden: document.getElementById('hud').classList.contains('hidden')
    })`);
    const scr = await shot(page, '10-win');
    if (v.mode !== 'won') throw new Error('没有进入胜利界面: ' + JSON.stringify(v));
    return { interact, ...v, screenshot: scr };
  });

  // ------------------------------------------------------------- 16. 错误
  await step('errors', async () => {
    report.jsExceptions = page.events.filter(e => e.method === 'Runtime.exceptionThrown')
      .map(e => e.params.exceptionDetails.text + ' ' + ((e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || ''));
    report.consoleErrors = page.events.filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map(e => e.params.args.map(a => a.value || a.description).join(' '));
    report.logEntries = page.events.filter(e => e.method === 'Log.entryAdded')
      .map(e => e.params.entry.level + ': ' + e.params.entry.text);
    const errlog = await Q.errlog();
    if (report.jsExceptions.length || report.consoleErrors.length) {
      throw new Error('存在未捕获 JS 异常: ' + JSON.stringify(report.consoleErrors.slice(0, 3)));
    }
    return { errlog, jsExceptions: report.jsExceptions.length, consoleErrors: report.consoleErrors.length };
  });

  report.ok = report.stages.every(s => s.ok);
} catch (e) {
  report.fatal = String((e && e.stack) || e);
  log('FATAL', report.fatal);
} finally {
  try { page && page.close(); } catch { }
  try { edge.kill(); } catch { }
  await sleep(400);
}

writeFileSync(SHOTS + '\\..\\qa-report.json', JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  ok: report.ok,
  fatal: report.fatal,
  stages: report.stages.map(s => ({ name: s.name, ok: s.ok, ms: s.ms, error: s.error }))
}, null, 2));
process.exit(report.ok ? 0 : 1);
