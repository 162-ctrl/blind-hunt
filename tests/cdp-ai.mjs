/* =========================================================================
 * tests/cdp-ai.mjs — 怪物 AI 行为量化探针（无头 Edge + CDP + 同步模拟）
 * -------------------------------------------------------------------------
 * 用 __BH_DEBUG.simulate()（固定 0.033s 步进）在真实游戏逻辑上跑场景，
 * 测量 AI v2 的行为：升级追击、追丢后的搜索、搜索后的巡游记忆、诱饵概率、
 * 听声停顿（listen pause）、躲藏点检查。
 * 用法：D:\node.exe tests/cdp-ai.mjs
 * 输出：tests/ai-report.json
 * ========================================================================= */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9461;
const ROOT = 'file:///D:/%E4%B8%87%E6%98%8A%E6%9E%97/%E9%A1%B9%E7%9B%AE/%E6%81%90%E6%80%96%E6%B8%B8%E6%88%8F/index.html';
const OUT = 'D:\\万昊林\\项目\\恐怖游戏\\tests\\ai-report.json';
const PROFILE = process.env.TEMP + '\\bh-ai-profile-' + Date.now();
mkdirSync(PROFILE, { recursive: true });

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
    }
  };
  const send = async (method, params = {}) => {
    await opened;
    return new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  return { send, close: () => ws.close() };
}
async function evaluate(page, expr) {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
  }
  return r.result ? r.result.value : undefined;
}

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--window-size=1280,720',
  'about:blank'
], { stdio: 'ignore' });

const report = { scenarios: {}, notes: [] };
try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) break; } catch { }
    await sleep(120);
  }
  const created = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(ROOT), { method: 'PUT' });
  const target = await created.json();
  const page = connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  for (let i = 0; i < 120; i++) {
    try { if (await evaluate(page, 'document.readyState') === 'complete') break; } catch { }
    await sleep(100);
  }
  await sleep(400);
  await evaluate(page, 'document.getElementById("btn-start").click()');
  await sleep(900);

  // 页面内探针：全部同步跑，避免无头帧率干扰
  await evaluate(page, `window.__AI_PROBE = (function(){
    var S = BH.S, p = BH.player, m = BH.monster, api = BH.api;

    function reset(mx, my, px, py) {
      S.mode = 'playing';
      m.x = mx; m.y = my; m.dir = 0; m.state = 'patrol'; m.stateT = 0;
      m.target = null; m.path = null; m.pathIdx = 0; m.repathT = 0; m.waitT = 0;
      m.lastHeard = { x: px, y: py }; m.lastKnown = null; m.memoryT = 0;
      m.heardPrev = null; m.heardVel = { x: 0, y: 0 };
      m.chaseLostT = 0; m.searchT = 0;
      m.spotTarget = null; m.checkT = 0; m.searchPoint = null; m.lastNode = null;
      m.listenT = 3.0; m.pauseT = 0; m.clickT = 1.0; m.stepT = 0;
      m.lastMoveCheck = { x: mx, y: my }; m.moveCheckT = 0;
      p.x = px; p.y = py; p.hidden = null; p.holdingBreath = false; p.moveState = 'idle';
      p.sprinting = false; p.sneaking = false; p.stamina = 1; p.exhausted = false;
      p.exhaustT = 0; p.breath = 1; p.flashlightOn = false; p.stepT = 0; p.lastHeard = null;
      BH.input.keys = {}; BH.input.pressed = {}; BH.input.clicked = false;
      S.danger = 0; S.deaths = 0; S.runTime = 0;
      S.power = 0; S.gateUnlocked = false;
      S.deathInfo = null; S.winInfo = null;
      S.huntTipPlayed = true; S.decoyTipPlayed = true;
    }
    function step(n) { for (var i = 0; i < n; i++) { api.update(0.033); BH.input.pressed = {}; BH.input.clicked = false; } }
    function state() { return { mode: S.mode, state: m.state, x: +m.x.toFixed(2), y: +m.y.toFixed(2), t: +S.runTime.toFixed(2), d: +Math.hypot(m.x-p.x,m.y-p.y).toFixed(2) }; }
    function dist(a, b) { return Math.hypot(a.x-b.x, a.y-b.y); }
    function timeline(n) {
      var out = [], last = m.state, t0 = S.runTime;
      for (var i = 0; i < n; i++) {
        step(1);
        if (m.state !== last) { out.push({ t: +(S.runTime - t0).toFixed(2), from: last, to: m.state }); last = m.state; }
        if (S.mode === 'dead') { out.push({ t: +(S.runTime - t0).toFixed(2), dead: true }); break; }
      }
      return out;
    }

    return {
      /** A. 搜索中听到近距离冲刺：应该立刻升级为追击 */
      searchEscalation: function () {
        reset(30.5, 24.5, 30.5, 21.5); // 3 格内、同走廊、LOS 通
        m.state = 'search'; m.stateT = 2; m.searchT = 12; m.lastHeard = { x: 30.5, y: 23.5 };
        api.emitNoise(30.5, 21.5, 7.2, 'sprint');
        step(2);
        return { afterState: m.state, dist: +dist(m, p).toFixed(2) };
      },

      /** B. 调查中听到近距离冲刺 */
      investigateEscalation: function () {
        reset(30.5, 24.5, 30.5, 21.5);
        m.state = 'investigate'; m.target = { x: 30.5, y: 23.5 }; m.lastHeard = { x: 30.5, y: 23.5 };
        api.emitNoise(30.5, 21.5, 7.2, 'sprint');
        step(2);
        return { afterState: m.state, dist: +dist(m, p).toFixed(2) };
      },

      /** C. 追逐中玩家丢下声音后安静溜走：多久转搜索、搜索多久、之后是否在附近巡 */
      chaseLossTimeline: function () {
        reset(30.5, 20.5, 30.5, 15.5);
        api.emitNoise(30.5, 15.5, 7.2, 'sprint'); // 进入 chase
        var started = m.state;
        p.x = 30.5; p.y = 12.5;                  // 你闭着嘴、蹑手蹑脚地往北挪了 3 格
        var tl = timeline(Math.round(40 / 0.033));
        return {
          chaseStarted: started,
          timeline: tl,
          finalState: m.state,
          memoryT: +m.memoryT.toFixed(1),
          searchT: +m.searchT.toFixed(1),
          finalDist: +dist(m, p).toFixed(2)
        };
      },

      /** D. 追丢后 45 秒玩家完全不出声：它会不会一直在附近找（用最近距离/是否被发现衡量） */
      huntPersistence: function () {
        reset(30.5, 20.5, 30.5, 15.5);
        api.emitNoise(30.5, 15.5, 7.2, 'sprint');
        p.x = 30.5; p.y = 12.5;
        var minD = 1e9, samples = [], dead = false;
        for (var i = 0; i < Math.round(45 / 0.033); i++) {
          step(1);
          var dd = Math.hypot(m.x - p.x, m.y - p.y);
          if (dd < minD) minD = dd;
          if (i % 90 === 0) samples.push({ t: +S.runTime.toFixed(0), state: m.state, d: +dd.toFixed(1) });
          if (S.mode === 'dead') { dead = true; break; }
        }
        return { dead: dead, deathInfo: S.deathInfo, minDist: +minD.toFixed(2), finalState: m.state, samples: samples };
      },

      /** E. 追逐中投石诱饵：刚听过你声音时只有小概率被带走；安静一阵后概率回升 */
      decoyDistractRate: function () {
        var trials = 60;
        function run(stale) {
          var distracted = 0;
          if (api.setSeed) api.setSeed(null);
          for (var i = 0; i < trials; i++) {
            reset(30.5, 20.5, 30.5, 15.5);
            api.emitNoise(30.5, 15.5, 7.2, 'sprint'); // 进入 chase
            if (stale) { p.lastHeard = null; }
            api.emitNoise(29.0, 20.5, 8.4, 'decoy');
            step(1);
            if (m.state === 'investigate') distracted++;
          }
          return { trials: trials, distracted: distracted, rate: +(distracted / trials).toFixed(2) };
        }
        return { recentNoise: run(false), staleNoise: run(true) };
      },

      /** F. 听声停顿：搜索时它应该偶尔停下 1.35s 并向周围转头 */
      listenPause: function () {
        reset(30.5, 24.5, 30.5, 18.5);
        m.state = 'search'; m.stateT = 1; m.searchT = 20; m.lastHeard = { x: 30.5, y: 19.5 };
        m.listenT = 0.6;
        var paused = [], lastPause = false;
        for (var i = 0; i < Math.round(12 / 0.033); i++) {
          step(1);
          var now = m.pauseT > 0;
          if (now && !lastPause) paused.push({ t: +S.runTime.toFixed(2), state: m.state });
          lastPause = now;
          if (S.mode === 'dead') break;
        }
        return { pauseCount: paused.length, pauses: paused };
      },

      /** G. 搜索时检查躲藏点：屏息能活多久 / 不屏息会不会死 */
      hideSpotCheck: function () {
        var spot = null;
        for (var i = 0; i < BH.hideSpots.length; i++) {
          if (BH.hideSpots[i].x === 26 && BH.hideSpots[i].y === 31) { spot = BH.hideSpots[i]; break; }
        }
        if (!spot) spot = BH.hideSpots[0];
        var results = {};
        for (var hold = 0; hold < 2; hold++) {
          reset(spot.x + 3.5, spot.y + 0.5, spot.x + 0.5, spot.y + 0.5);
          p.hidden = { x: spot.x, y: spot.y, type: spot.type };
          p.holdingBreath = !!hold; p.breath = 1;
          m.state = 'search'; m.stateT = 2; m.searchT = 20; m.lastHeard = { x: spot.x + 0.5, y: spot.y + 0.5 };
          var tl = timeline(Math.round(20 / 0.033));
          results[hold ? 'holdBreath' : 'breathe'] = { dead: S.mode === 'dead', deathInfo: S.deathInfo, timeline: tl };
        }
        return results;
      },

      /** H. 速度对比：玩家冲刺仍应略快于怪物追击 */
      speeds: function () {
        return {
          playerWalk: BH.CFG.player.walkSpeed,
          playerSprint: +(BH.CFG.player.walkSpeed * BH.CFG.player.sprintMul).toFixed(2),
          monsterChase0: BH.CFG.monster.chaseSpeed,
          monsterChase3: +(BH.CFG.monster.chaseSpeed + 3 * BH.CFG.monster.speedPerBreaker).toFixed(2),
          staminaSprintSeconds: +(1 / BH.CFG.player.staminaSprintDrain).toFixed(2)
        };
      }
    };
  })();`);

  const scenarios = [
    'searchEscalation', 'investigateEscalation', 'chaseLossTimeline',
    'huntPersistence', 'decoyDistractRate', 'listenPause', 'hideSpotCheck', 'speeds'
  ];
  for (const name of scenarios) {
    try {
      report.scenarios[name] = await evaluate(page, 'window.__AI_PROBE.' + name + '()');
    } catch (e) {
      report.scenarios[name] = { error: String(e.message || e) };
    }
    await sleep(120);
  }
  report.errlog = await evaluate(page, "document.getElementById('errlog').textContent");
  page.close();
} catch (e) {
  report.fatal = String(e.stack || e);
} finally {
  try { edge.kill(); } catch { }
  await sleep(300);
}
writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 1));
