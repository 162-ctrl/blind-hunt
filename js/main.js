/* =========================================================================
 * js/main.js — 《盲猎》引导层
 * -------------------------------------------------------------------------
 * 负责：画布 / 输入 / 主循环 / HUD / 全屏界面 / 与 game.js 的钩子对接
 * 脚本加载顺序：audio.js → level.js → game.js → render.js → main.js
 * ========================================================================= */
(function () {
  'use strict';

  var BH = window.BH;
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d', { alpha: false });

  if (!ctx) {
    var log = document.getElementById('errlog');
    if (log) log.textContent = 'ERROR: 无法创建 Canvas 2D 上下文';
    return;
  }

  // =====================================================================
  //  错误收集
  // =====================================================================
  var errors = window.__BH_ERRORS || [];

  function pushError(msg) {
    errors.push(String(msg));
    if (errors.length > 30) errors.shift();
    var log = document.getElementById('errlog');
    if (log) log.textContent = errors.join('\n');
  }
  window.__BH_PUSH_ERROR = pushError;

  window.addEventListener('error', function (e) {
    pushError('ERROR: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    pushError('REJECTION: ' + (r && (r.stack || r.message) ? (r.stack || r.message) : String(r)));
  });

  if (BH.LEVEL_ERRORS && BH.LEVEL_ERRORS.length) {
    pushError('LEVEL: ' + BH.LEVEL_ERRORS.join(' | '));
  } else {
    var log0 = document.getElementById('errlog');
    if (log0) log0.textContent = 'OK';
  }

  // =====================================================================
  //  常用 DOM
  // =====================================================================
  function $(id) { return document.getElementById(id); }

  var UI = {
    hud: $('hud'),
    objText: $('obj-text'),
    breakerIcons: Array.prototype.slice.call(document.querySelectorAll('#breaker-icons i')),
    battery: $('battery-fill'),
    stamina: $('stamina-fill'),
    stones: $('stone-count'),
    noiseBars: Array.prototype.slice.call(document.querySelectorAll('#noise-meter .noise-bars i')),
    breathWrap: $('breath-wrap'),
    breathFill: $('breath-fill'),
    breathLabel: $('breath-label'),
    breathHint: $('breath-hint'),
    prompt: $('prompt'),
    progressWrap: $('progress-wrap'),
    progressLabel: $('progress-label'),
    progressFill: $('progress-fill'),
    toast: $('toast'),
    hint: $('hint'),
    danger: $('danger-vignette'),
    damage: $('damage-flash'),
    screens: {
      title: $('screen-title'),
      pause: $('screen-pause'),
      dead: $('screen-dead'),
      win: $('screen-win'),
      note: $('screen-note')
    },
    deadReason: $('dead-reason'),
    deadSub: $('dead-sub'),
    deadTime: $('dead-time'),
    deadPower: $('dead-power'),
    deadCount: $('dead-count'),
    deadTip: $('dead-tip'),
    winTime: $('win-time'),
    winDeaths: $('win-deaths'),
    winNotes: $('win-notes'),
    winBattery: $('win-battery'),
    noteTitle: $('note-title'),
    noteText: $('note-text')
  };

  // =====================================================================
  //  画布尺寸
  // =====================================================================
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    var w = window.innerWidth || document.documentElement.clientWidth || 1280;
    var h = window.innerHeight || document.documentElement.clientHeight || 720;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var zoom = Math.max(0.82, Math.min(1.55, w / (27 * 48)));
    BH.view = { w: w, h: h, dpr: dpr, zoom: zoom };
  }
  window.addEventListener('resize', resize);
  resize();

  // =====================================================================
  //  输入
  // =====================================================================
  var input = {
    keys: {},
    pressed: {},
    mouse: { x: 0, y: 0 },
    mouseActive: false,
    clicked: false
  };
  BH.input = input;

  var PREVENT = { Space: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Tab: 1 };

  window.addEventListener('keydown', function (e) {
    if (PREVENT[e.code]) e.preventDefault();
    if (!e.repeat) input.pressed[e.code] = true;
    input.keys[e.code] = true;
    onKeyDown(e);
  });
  window.addEventListener('keyup', function (e) {
    input.keys[e.code] = false;
  });
  window.addEventListener('blur', function () {
    input.keys = {};
    input.pressed = {};
  });

  window.addEventListener('mousemove', function (e) {
    var rect = canvas.getBoundingClientRect();
    input.mouse.x = e.clientX - rect.left;
    input.mouse.y = e.clientY - rect.top;
    input.mouseActive = true;
  }, { passive: true });

  window.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    try { BH.audio.resume(); } catch (err) { }
    if (e.target === canvas) input.clicked = true;
  });

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  window.addEventListener('pointerdown', function () {
    try { BH.audio.resume(); } catch (err) { }
  }, { passive: true });

  // =====================================================================
  //  HUD
  // =====================================================================
  var muted = false;
  var toastQueue = [];
  var toastCur = null;
  var toastTimer = 0;
  var toastGap = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function pushToast(msg, sub) {
    if (!msg) return;
    toastQueue.push({ msg: msg, sub: sub || '' });
    if (toastQueue.length > 6) toastQueue.shift();
  }

  function updateToast(dt) {
    if (toastCur) {
      toastTimer -= dt;
      if (toastTimer <= 0) {
        UI.toast.classList.remove('show');
        toastCur = null;
        toastGap = 0.28;
      }
      return;
    }
    if (toastGap > 0) { toastGap -= dt; return; }
    if (toastQueue.length) {
      toastCur = toastQueue.shift();
      toastTimer = toastCur.sub ? 3.6 : 2.7;
      UI.toast.innerHTML = esc(toastCur.msg) + (toastCur.sub ? '<span class="sub">' + esc(toastCur.sub) + '</span>' : '');
      UI.toast.classList.add('show');
    }
  }

  function fmtTime(sec) {
    sec = Math.max(0, sec || 0);
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  var hudCache = { prompt: '', progress: -1, breath: -1 };

  function updateHUD(dt) {
    var S = BH.S, p = BH.player, m = BH.monster;
    if (!S || !p) return;

    var inGame = S.mode === 'playing' || S.mode === 'paused' || S.mode === 'note' ||
      S.mode === 'dying';
    UI.hud.classList.toggle('hidden', !inGame);

    // 目标
    if (UI.objText) {
      if (!S.gateUnlocked) UI.objText.textContent = '恢复电力 ' + S.power + ' / 3';
      else UI.objText.textContent = '返回南门，逃出去';
    }
    for (var i = 0; i < UI.breakerIcons.length; i++) {
      var b = BH.breakers[i];
      if (b) UI.breakerIcons[i].classList.toggle('on', !!b.on);
    }

    // 电量 / 体力 / 石块
    var bat = Math.round(clamp01(p.battery) * 100);
    if (UI.battery) {
      UI.battery.style.width = bat + '%';
      UI.battery.classList.toggle('low', p.battery < 0.2);
    }
    if (UI.stamina) {
      UI.stamina.style.width = Math.round(clamp01(p.stamina) * 100) + '%';
      UI.stamina.classList.toggle('low', p.stamina < 0.28);
    }
    if (UI.stones) UI.stones.textContent = String(p.stones);

    // 声响
    var noise = 0;
    if (!p.hidden && S.mode === 'playing') {
      if (p.sprinting) noise = 4;
      else if (p.moveState === 'walk') noise = 2;
      else if (p.moveState === 'sneak') noise = 1;
      if (p.exhausted) noise = Math.max(noise, 2);
      if (p.hold > 0) noise = 4;
    }
    for (var n = 0; n < UI.noiseBars.length; n++) {
      UI.noiseBars[n].classList.toggle('on', n < noise);
    }

    // 屏息
    if (p.hidden) {
      UI.breathWrap.classList.remove('hidden');
      var pct = Math.round(clamp01(p.breath) * 100);
      if (Math.abs(hudCache.breath - pct) > 1) {
        UI.breathFill.style.width = pct + '%';
        hudCache.breath = pct;
      }
      UI.breathFill.classList.toggle('low', p.breath < 0.28);
      if (p.holdingBreath) {
        UI.breathLabel.textContent = '屏息中…';
        UI.breathHint.textContent = '千万别松手';
        UI.breathHint.style.opacity = '0.9';
      } else if (p.breathLock > 0) {
        UI.breathLabel.textContent = '喘不上气！';
        UI.breathHint.textContent = '它听见了';
      } else {
        UI.breathLabel.textContent = '屏息';
        UI.breathHint.textContent = '松开空格会呼吸出声';
      }
    } else {
      UI.breathWrap.classList.add('hidden');
      hudCache.breath = -1;
    }

    // 提示 / 进度
    var promptHTML = '';
    var t = p.interact;
    if (S.mode === 'playing') {
      if (t) {
        if (t.kind === 'hidden') promptHTML = '按住 <b>空格</b> 屏住呼吸 · <b>E</b> 离开';
        else if (t.kind === 'hide') promptHTML = '按 <b>空格</b> 躲进' + esc(t.label);
        else if (t.kind === 'note') promptHTML = '按 <b>空格</b> 阅读「' + esc(t.label) + '」';
        else if (t.kind === 'breaker') promptHTML = '按住 <b>空格</b> 合闸 · ' + esc(t.label);
        else if (t.kind === 'gate') promptHTML = '按住 <b>空格</b> 推开南门';
        else if (t.kind === 'gate-locked') promptHTML = '南门已锁死 —— 恢复三路电力';
      }
    }
    if (hudCache.prompt !== promptHTML) {
      hudCache.prompt = promptHTML;
      UI.prompt.innerHTML = promptHTML;
      UI.prompt.classList.toggle('hidden', !promptHTML);
    }

    var holdShown = false;
    if (p.hold > 0.05 && (p.holdKind === 'breaker' || p.holdKind === 'gate')) {
      holdShown = true;
      var need = p.holdKind === 'breaker' ? BH.CFG.breakerHoldTime : BH.CFG.gateHoldTime;
      var pr = Math.round(clamp01(p.hold / need) * 100);
      if (pr !== hudCache.progress) {
        UI.progressFill.style.width = pr + '%';
        hudCache.progress = pr;
      }
      UI.progressLabel.textContent = p.holdKind === 'breaker' ? '合闸中…' : '推开南门…';
    }
    UI.progressWrap.classList.toggle('hidden', !holdShown);
    if (!holdShown) hudCache.progress = -1;

    // 危险 / 受伤闪烁
    if (UI.danger) UI.danger.style.opacity = '0';
    if (UI.damage) {
      var dmg = 0;
      if (S.mode === 'dying') dmg = Math.min(1, S.deathT * 2);
      else if (S.mode === 'dead') dmg = 0.35 + 0.2 * Math.sin(S.time * 4);
      UI.damage.style.opacity = String(dmg);
    }

    // 操作提示渐隐
    if (UI.hint) {
      var op = 1;
      if (S.runTime > 16) op = Math.max(0, 1 - (S.runTime - 16) / 5);
      if (S.mode !== 'playing' && S.mode !== 'paused') op = 0;
      UI.hint.style.opacity = String(op);
    }
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // =====================================================================
  //  界面切换
  // =====================================================================
  function hideAllScreens() {
    for (var k in UI.screens) {
      if (Object.prototype.hasOwnProperty.call(UI.screens, k)) UI.screens[k].classList.add('hidden');
    }
  }

  function showScreen(name) {
    hideAllScreens();
    if (UI.screens[name]) UI.screens[name].classList.remove('hidden');
  }

  function applyMode(mode, data) {
    if (mode === 'playing') {
      hideAllScreens();
      UI.hud.classList.remove('hidden');
    } else if (mode === 'title') {
      showScreen('title');
      UI.hud.classList.add('hidden');
    } else if (mode === 'paused') {
      showScreen('pause');
    } else if (mode === 'note') {
      var n = BH.S.openNote;
      if (n) {
        UI.noteTitle.textContent = n.title;
        UI.noteText.textContent = n.text;
      }
      showScreen('note');
    } else if (mode === 'dead') {
      var info = data || BH.S.deathInfo || {};
      UI.deadReason.textContent = info.reason || '它听见了你。';
      UI.deadSub.textContent = info.sub || '';
      UI.deadTime.textContent = fmtTime(info.time);
      UI.deadPower.textContent = (info.power || 0) + ' / 3';
      UI.deadCount.textContent = String(info.deaths || 1);
      UI.deadTip.textContent = info.tip ? '提示：' + info.tip : '';
      showScreen('dead');
      UI.hud.classList.add('hidden');
    } else if (mode === 'won') {
      var w = data || BH.S.winInfo || {};
      UI.winTime.textContent = fmtTime(w.time);
      UI.winDeaths.textContent = String(w.deaths || 0);
      UI.winNotes.textContent = (w.notes || 0) + ' / ' + (w.totalNotes || 8);
      UI.winBattery.textContent = Math.round((w.battery || 0) * 100) + '%';
      showScreen('win');
      UI.hud.classList.add('hidden');
    }
  }

  // =====================================================================
  //  游戏控制
  // =====================================================================
  function startGame() {
    try { BH.audio.init(); } catch (e) { }
    try { BH.api.start(); } catch (e) { pushError('START: ' + e.message); }
    setTimeout(function () {
      pushToast('按住 R 倾听', '声呐会勾出周围墙壁的轮廓。');
    }, 2200);
  }

  function restartGame() {
    try { BH.api.restart(); } catch (e) { pushError('RESTART: ' + e.message); }
    setTimeout(function () {
      pushToast('按住 R 倾听', '声呐会勾出周围墙壁的轮廓。');
    }, 2200);
  }

  function quitToTitle() {
    try { BH.api.quitToTitle(); } catch (e) { }
  }

  function closeNote() {
    try { BH.api.closeNote(); } catch (e) { }
  }

  function toggleMute() {
    muted = !muted;
    try { BH.audio.master(muted ? 0 : 0.9); } catch (e) { }
    pushToast(muted ? '已静音' : '声音已开启', muted ? '' : '声音是唯一的视野。');
  }

  function onKeyDown(e) {
    var S = BH.S;
    if (!S) return;
    var mode = S.mode;

    if (e.code === 'KeyM') { toggleMute(); return; }

    if (mode === 'title') {
      if (e.code === 'Enter' || e.code === 'KeyE') startGame();
      return;
    }
    if (mode === 'note') {
      if (e.code === 'Space' || e.code === 'Escape' || e.code === 'KeyE' || e.code === 'Enter') closeNote();
      return;
    }
    if (mode === 'paused') {
      if (e.code === 'Escape') BH.api.resume();
      return;
    }
    if (mode === 'dead' || mode === 'won') {
      if (e.code === 'KeyR' || e.code === 'Enter') restartGame();
      if (e.code === 'Escape') quitToTitle();
      return;
    }
    if (mode === 'playing') {
      if (e.code === 'Escape') BH.api.togglePause();
    }
  }

  // =====================================================================
  //  按钮 / 界面事件
  // =====================================================================
  function bindClick(id, fn) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      try { BH.audio.sfx('ui_click'); } catch (e) { }
      fn();
    });
  }

  bindClick('btn-start', startGame);
  bindClick('btn-resume', function () { BH.api.resume(); });
  bindClick('btn-restart-pause', restartGame);
  bindClick('btn-quit', quitToTitle);
  bindClick('btn-retry', restartGame);
  bindClick('btn-quit-dead', quitToTitle);
  bindClick('btn-again', restartGame);
  bindClick('btn-quit-win', quitToTitle);

  var noteScreen = $('screen-note');
  if (noteScreen) {
    noteScreen.addEventListener('click', function (ev) {
      ev.preventDefault();
      closeNote();
    });
  }

  // =====================================================================
  //  钩子对接
  // =====================================================================
  BH.hooks = BH.hooks || {};
  BH.hooks.toast = function (msg, sub) { pushToast(msg, sub); };
  BH.hooks.objective = function (data) {
    if (UI.objText) {
      if (!data.gateUnlocked) UI.objText.textContent = '恢复电力 ' + data.power + ' / 3';
      else UI.objText.textContent = '返回南门，逃出去';
    }
    for (var i = 0; i < UI.breakerIcons.length; i++) {
      if (data.breakers && data.breakers[i]) UI.breakerIcons[i].classList.toggle('on', data.breakers[i].on);
    }
  };
  BH.hooks.modeChange = function (mode, data) { applyMode(mode, data); };

  // =====================================================================
  //  主循环
  // =====================================================================
  var lastT = 0;
  var rafId = 0;

  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    if (!lastT) lastT = ts;
    var dt = (ts - lastT) / 1000;
    lastT = ts;
    if (!isFinite(dt)) dt = 0.016;
    dt = Math.max(0, Math.min(0.05, dt));

    try {
      BH.api.update(dt);
      if (BH.Render && BH.Render.draw) BH.Render.draw(ctx, dt);
      updateHUD(dt);
      updateToast(dt);
    } catch (e) {
      pushError('LOOP: ' + (e && e.message ? e.message : String(e)));
      if (window.console && console.error) console.error(e);
    }

    // 一次性按键标记在帧末清除
    input.pressed = {};
    input.clicked = false;
  }

  // 自动暂停（切到后台）
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && BH.S && BH.S.mode === 'playing') {
      try { BH.api.togglePause(); } catch (e) { }
    }
  });

  // =====================================================================
  //  启动
  // =====================================================================
  applyMode(BH.S.mode);

  // 初始相机 / 视图对齐
  if (BH.player) {
    BH.camera.x = BH.player.x * 48;
    BH.camera.y = BH.player.y * 48;
  }

  rafId = requestAnimationFrame(frame);

  // =====================================================================
  //  调试 / 无头测试接口
  // =====================================================================
  window.__BH_DEBUG = {
    start: startGame,
    restart: restartGame,
    quit: quitToTitle,
    snapshot: function () { return BH.api.debugSnapshot(); },
    events: function () { return BH.api.events(); },
    mode: function () { return BH.S.mode; },
    hide: function () { return !!BH.S.openNote; },
    key: function (code, down) {
      if (down) { input.keys[code] = true; input.pressed[code] = true; }
      else input.keys[code] = false;
    },
    press: function (code) {
      input.keys[code] = true;
      input.pressed[code] = true;
      setTimeout(function () { input.keys[code] = false; }, 40);
    },
    click: function (x, y) {
      if (typeof x === 'number') { input.mouse.x = x; input.mouse.y = y; input.mouseActive = true; }
      input.clicked = true;
    },
    teleport: function (x, y) {
      if (BH.player) { BH.player.x = x; BH.player.y = y; }
    },
    simulate: function (seconds) {
      var steps = Math.max(1, Math.round((seconds || 1) / 0.033));
      var snap = null;
      for (var i = 0; i < steps; i++) {
        BH.api.update(0.033);
        input.pressed = {};
        input.clicked = false;
      }
      snap = BH.api.debugSnapshot();
      return snap;
    },
    forceKill: function () { try { BH.api.killPlayer('caught'); } catch (e) { } },
    // 派发真实键盘事件：用于测试 Escape/Enter 等由 UI 层处理的按键
    sendKey: function (code) {
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: code, key: code, bubbles: true }));
        setTimeout(function () {
          window.dispatchEvent(new KeyboardEvent('keyup', { code: code, key: code, bubbles: true }));
        }, 40);
      } catch (e) { }
    }
  };

  // 自动启动（无头截图 / 测试用）：#autostart&sim=20&seed=7
  function hashParams() {
    var h = (location.hash || '').replace(/^#/, '');
    return new URLSearchParams(h);
  }
  var q = hashParams();
  if (q.has('autostart')) {
    setTimeout(function () {
      try {
        var seed = q.get('seed');
        if (seed !== null && BH.api.setSeed) BH.api.setSeed(parseInt(seed, 10) || 1);
        startGame();
        var sim = parseFloat(q.get('sim') || '0');
        if (sim > 0) {
          var snap = window.__BH_DEBUG.simulate(sim);
          var out = 'SIM ' + JSON.stringify(snap);
          var log = document.getElementById('errlog');
          if (log) {
            log.textContent = (errors.length ? 'ERRORS: ' + errors.join(' ; ') + '\n' : 'OK\n') + out;
          }
          document.title = 'SHOT ' + JSON.stringify({ mode: snap.mode, power: snap.power });
        } else {
          // 让世界先跑几帧，便于截图
          window.__BH_DEBUG.simulate(0.6);
        }
      } catch (e) {
        pushError('AUTOSTART: ' + (e && e.message ? e.message : String(e)));
      }
    }, 200);
  }
})();
