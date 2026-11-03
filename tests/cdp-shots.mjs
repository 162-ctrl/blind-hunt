/* tests/cdp-shots.mjs — 快速视觉迭代探针：只拍关键画面，不跑完整验收 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9463;
const ROOT = 'file:///D:/%E4%B8%87%E6%98%8A%E6%9E%97/%E9%A1%B9%E7%9B%AE/%E6%81%90%E6%80%96%E6%B8%B8%E6%88%8F/index.html';
const SHOTS = 'D:\\万昊林\\项目\\恐怖游戏\\tests\\shots';
const TAG = process.argv[2] || 'probe';
mkdirSync(SHOTS, { recursive: true });

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let seq = 0; const pending = new Map();
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  const send = async (method, params = {}) => { await opened; return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); };
  return { send, close: () => ws.close() };
}
async function ev(page, expr) {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result ? r.result.value : undefined;
}
async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const f = SHOTS + '\\' + name + '.png';
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
}

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.env.TEMP + '\\bh-shots-' + Date.now(), '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
const res = {};
try {
  for (let i = 0; i < 100; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) break; } catch { } await sleep(120); }
  const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(ROOT), { method: 'PUT' })).json();
  const page = connect(t.webSocketDebuggerUrl);
  await page.send('Page.enable'); await page.send('Runtime.enable');
  for (let i = 0; i < 100; i++) { try { if (await ev(page, 'document.readyState') === 'complete') break; } catch { } await sleep(100); }
  await ev(page, 'document.getElementById("btn-start").click()');
  await sleep(1400);

  // A. 门厅，手电开着
  await ev(page, 'BH.player.x = 30.5; BH.player.y = 41.5; BH.player.flashlightOn = true; BH.player.dir = -Math.PI/2; BH.S.danger = 0;');
  await ev(page, 'BH.monster.x = 30.5; BH.monster.y = 5.5; BH.monster.state="patrol";');
  await sleep(700);
  res.foyer = await shot(page, TAG + '-foyer');

  // B. 声呐：同一画面取三个相位
  await ev(page, 'BH.player.x = 30.5; BH.player.y = 34.5; BH.player.flashlightOn = false;');
  await ev(page, 'window.__BH_DEBUG.key("KeyR", true)');
  await sleep(400);
  const phases = [0.55, 0.95, 1.35];
  res.sonar = [];
  for (let i = 0; i < phases.length; i++) {
    await ev(page, 'BH.S.time = Math.floor(BH.S.time / 1.9) * 1.9 + ' + phases[i]);
    await sleep(90);
    res.sonar.push({ phase: phases[i], value: await ev(page, '+(BH.S.time % 1.9).toFixed(2)'), file: await shot(page, TAG + '-sonar-' + (i + 1)) });
  }
  await ev(page, 'window.__BH_DEBUG.key("KeyR", false)');
  await sleep(200);

  // C. 三闸全开后的世界（暖光）
  await ev(page, `(function(){
    for (var i=0;i<BH.breakers.length;i++){ BH.breakers[i].on=true; BH.S.powerOn[BH.breakers[i].id]=true; }
    BH.S.power = 3;
    BH.player.x = 30.5; BH.player.y = 34.5; BH.player.flashlightOn = true;
    return 1;
  })()`);
  await sleep(800);
  res.lights = await shot(page, TAG + '-lights');

  res.errlog = await ev(page, "document.getElementById('errlog').textContent");
  page.close();
} catch (e) { res.fatal = String(e.stack || e); }
finally { try { edge.kill(); } catch { } await sleep(300); }
console.log(JSON.stringify(res, null, 1));
