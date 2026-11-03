/* =========================================================================
 * js/game.js — 《盲猎》核心逻辑
 * -------------------------------------------------------------------------
 * 依赖：js/level.js（window.BlindHuntLevel）
 * 全局命名空间：window.BH
 *   BH.S            全局状态
 *   BH.player       玩家
 *   BH.monster      盲怪
 *   BH.camera       相机
 *   BH.input        由 main.js 维护的输入状态
 *   BH.hooks        由 main.js 覆盖的界面回调
 *   BH.api          由 main.js 调用的接口
 *   BH.audio        音频桥（对 window.AudioEngine 的安全封装）
 * ========================================================================= */
(function () {
  'use strict';

  var BH = window.BH = window.BH || {};
  var L = window.BlindHuntLevel;
  var TILE = 48;
  var TAU = Math.PI * 2;

  // ============================ 工具 ============================
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
  function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }

  var seed = null;
  function rnd() {
    if (seed === null) return Math.random();
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  function randRange(a, b) { return a + (b - a) * rnd(); }

  function hash2(x, y, s) {
    var h = (x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 144269;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  // ============================ 配置 ============================
  var CFG = BH.CFG = {
    player: {
      walkSpeed: 2.50,
      sneakMul: 0.44,
      sprintMul: 1.74,
      exhaustedMul: 0.62,
      staminaSprintDrain: 0.30,
      staminaRegen: 0.17,
      staminaRegenSneak: 0.23,
      staminaRegenDelay: 0.55,
      exhaustDuration: 3.9,
      exhaustRecover: 0.34,
      batteryDrain: 1 / 175,
      breathHoldDrain: 1 / 3.4,
      breathRegen: 1 / 2.6,
      radius: 0.30,
      throwRange: 9.0,
      throwSpeed: 13.5,
      maxStones: 5
    },
    monster: {
      patrolSpeed: 1.32,
      investigateSpeed: 1.95,
      chaseSpeed: 2.72,
      searchSpeed: 1.65,
      speedPerBreaker: 0.05,
      chaseRange: 6.2,
      giveUpTime: 3.6,
      searchTime: 8.0,
      searchTimePerBreaker: 1.4,
      clickPatrol: 3.1,
      clickInvestigate: 1.5,
      clickSearch: 2.3,
      clickChase: 0.95,
      killDist: 0.74,
      spotCheckDist: 1.55,
      spotCheckTime: 1.05,
      contactDist: 0.62
    },
    noise: {
      sneakRadius: 0.9,
      walkRadius: 3.0,
      sprintRadius: 7.2,
      pantRadius: 3.6,
      breathRadius: 1.5,
      gaspRadius: 5.2,
      throwRadius: 8.4,
      breakerHoldRadius: 9.0,
      breakerDoneRadius: 15.0,
      gateHoldRadius: 9.5
    },
    meterPerTile: 1.5,
    breakerHoldTime: 2.6,
    gateHoldTime: 2.8
  };

  // ============================ 关卡 ============================
  var level = BH.level = L.build();
  var W = level.W, H = level.H;

  var solidGrid = level.solid;
  // 怪物寻路额外把“躲藏家具”当障碍（它不会穿过柜子和床，而是站在旁边检查）
  var monsterBlocked = new Uint8Array(W * H);
  level.hideSpots.forEach(function (s) { monsterBlocked[s.y * W + s.x] = 1; });

  function solidAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return true;
    return solidGrid[ty * W + tx] === 1;
  }
  function monsterSolidAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return true;
    var i = ty * W + tx;
    return solidGrid[i] === 1 || monsterBlocked[i] === 1;
  }
  function inb(tx, ty) { return tx >= 0 && ty >= 0 && tx < W && ty < H; }

  function circleHitsWall(x, y, r) {
    var x0 = Math.floor(x - r), x1 = Math.floor(x + r);
    var y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        if (!solidAt(tx, ty)) continue;
        // AABB vs circle
        var cx = clamp(x, tx, tx + 1), cy = clamp(y, ty, ty + 1);
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) < r * r) return true;
      }
    }
    return false;
  }

  // 视线：沿线段采样，遇到墙则遮挡
  function hasLOS(ax, ay, bx, by) {
    var d = dist(ax, ay, bx, by);
    if (d < 0.001) return true;
    var steps = Math.ceil(d / 0.18);
    var dx = (bx - ax) / steps, dy = (by - ay) / steps;
    var x = ax, y = ay;
    for (var i = 0; i < steps; i++) {
      x += dx; y += dy;
      if (solidAt(Math.floor(x), Math.floor(y))) return false;
    }
    return true;
  }

  // 射线：返回撞墙距离（tile）
  function rayDistance(px, py, dx, dy, maxDist) {
    var step = 0.09;
    var t = 0;
    while (t < maxDist) {
      t += step;
      if (solidAt(Math.floor(px + dx * t), Math.floor(py + dy * t))) return t;
    }
    return maxDist;
  }

  // ============================ A* 寻路 ============================
  function nearestWalkable(tx, ty, blocked) {
    if (!blocked(tx, ty)) return { x: tx, y: ty };
    for (var r = 1; r <= 4; r++) {
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          var nx = tx + dx, ny = ty + dy;
          if (inb(nx, ny) && !blocked(nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  var PATH_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  function findPath(ax, ay, bx, by, blocked) {
    var sx = Math.floor(ax), sy = Math.floor(ay);
    var tx = Math.floor(bx), ty = Math.floor(by);
    if (!inb(sx, sy) || !inb(tx, ty)) return null;
    if (blocked(sx, sy)) {
      var s2 = nearestWalkable(sx, sy, blocked);
      if (!s2) return null;
      sx = s2.x; sy = s2.y;
    }
    var goal;
    if (blocked(tx, ty)) {
      goal = nearestWalkable(tx, ty, blocked);
      if (!goal) return null;
      tx = goal.x; ty = goal.y;
    }
    if (sx === tx && sy === ty) return [{ x: tx + 0.5, y: ty + 0.5 }];

    var size = W * H;
    var gScore = new Float64Array(size).fill(Infinity);
    var fScore = new Float64Array(size).fill(Infinity);
    var cameFrom = new Int32Array(size).fill(-1);
    var closed = new Uint8Array(size);
    var open = [sy * W + sx];
    gScore[sy * W + sx] = 0;
    fScore[sy * W + sx] = Math.hypot(tx - sx, ty - sy);
    var iterations = 0;
    var goalIdx = ty * W + tx;

    while (open.length && iterations < 6000) {
      iterations++;
      // 取 f 最小
      var bestAt = 0;
      for (var i = 1; i < open.length; i++) {
        if (fScore[open[i]] < fScore[open[bestAt]]) bestAt = i;
      }
      var cur = open[bestAt];
      open.splice(bestAt, 1);
      if (cur === goalIdx) {
        var path = [];
        var node = cur;
        while (node !== -1) {
          var nx2 = node % W, ny2 = (node / W) | 0;
          path.push({ x: nx2 + 0.5, y: ny2 + 0.5 });
          node = cameFrom[node];
        }
        path.reverse();
        if (path.length > 1) path.shift();
        return path;
      }
      closed[cur] = 1;
      var cx = cur % W, cy = (cur / W) | 0;
      for (var d2 = 0; d2 < PATH_DIRS.length; d2++) {
        var nxx = cx + PATH_DIRS[d2][0], nyy = cy + PATH_DIRS[d2][1];
        if (!inb(nxx, nyy)) continue;
        var ni = nyy * W + nxx;
        if (closed[ni] || blocked(nxx, nyy)) continue;
        // 禁止贴角斜穿
        if (PATH_DIRS[d2][0] !== 0 && PATH_DIRS[d2][1] !== 0) {
          if (blocked(cx + PATH_DIRS[d2][0], cy) || blocked(cx, cy + PATH_DIRS[d2][1])) continue;
        }
        var tentative = gScore[cur] + (PATH_DIRS[d2][0] && PATH_DIRS[d2][1] ? 1.41421356 : 1);
        if (tentative < gScore[ni]) {
          gScore[ni] = tentative;
          cameFrom[ni] = cur;
          fScore[ni] = tentative + Math.hypot(tx - nxx, ty - nyy);
          if (open.indexOf(ni) === -1) open.push(ni);
        }
      }
    }
    return null;
  }

  // ============================ 状态 ============================
  var S = BH.S = {
    mode: 'title',
    time: 0,
    runTime: 0,
    power: 0,
    gateUnlocked: false,
    danger: 0,
    deaths: 0,
    notesFound: 0,
    deathT: 0,
    winT: 0,
    deathInfo: null,
    winInfo: null,
    openNote: null,
    visited: {},
    powerOn: { B1: false, B2: false, B3: false },
    tips: [],
    tipIndex: 0,
    errors: []
  };
  BH.LEVEL_ERRORS = level.errors.slice();

  var player = BH.player = null;
  var monster = BH.monster = null;
  var camera = BH.camera = { x: 0, y: 0, shake: 0, zoom: 1 };
  var ripples = BH.ripples = [];
  var projectiles = BH.projectiles = [];
  var hideSpots = BH.hideSpots = [];
  var breakers = BH.breakers = [];
  var notes = BH.notes = [];
  var pickups = BH.pickups = [];
  var env = BH.env = { lightning: { next: 26, flash: 0 }, creakT: 20, dust: [] };
  var events = BH.events = [];

  function logEvent(type, data) {
    events.push({ t: +S.runTime.toFixed(2), type: type, data: data || {} });
    if (events.length > 400) events.shift();
  }

  // ============================ 音频桥 ============================
  function eng() {
    if (typeof window === 'undefined') return null;
    var e = window.AudioEngine;
    return (e && typeof e === 'object') ? e : null;
  }
  var audio = BH.audio = {
    init: function () { var e = eng(); if (e && e.init) { try { e.init(); } catch (err) { } } },
    resume: function () { var e = eng(); if (e && e.resume) { try { e.resume(); } catch (err) { } } },
    master: function (v) { var e = eng(); if (e && e.setMasterVolume) { try { e.setMasterVolume(v); } catch (err) { } } },
    sfx: function (name, x, y, vol) {
      var e = eng();
      if (!e || !e.play) return;
      try { e.play(name, { x: x, y: y, vol: vol }); } catch (err) { }
    },
    listener: function (x, y) { var e = eng(); if (e && e.setListener) { try { e.setListener(x, y); } catch (err) { } } },
    ambience: function (on) {
      var e = eng(); if (!e) return;
      try { if (on && e.startAmbience) e.startAmbience(); else if (!on && e.stopAmbience) e.stopAmbience(); } catch (err) { }
    },
    update: function (dt, st) { var e = eng(); if (e && e.update) { try { e.update(dt, st); } catch (err) { } } }
  };

  // ============================ 工具函数（对外） ============================
  function worldToScreen(wx, wy) {
    var v = BH.view || { w: 1280, h: 720, zoom: 1 };
    var z = v.zoom || 1;
    return {
      x: (wx * TILE - camera.x) * z + v.w / 2 + (BH.cameraShakeX || 0),
      y: (wy * TILE - camera.y) * z + v.h / 2 + (BH.cameraShakeY || 0)
    };
  }
  function screenToWorld(sx, sy) {
    var v = BH.view || { w: 1280, h: 720, zoom: 1 };
    var z = v.zoom || 1;
    return {
      x: ((sx - v.w / 2) / z + camera.x) / TILE,
      y: ((sy - v.h / 2) / z + camera.y) / TILE
    };
  }
  BH.worldToScreen = worldToScreen;
  BH.screenToWorld = screenToWorld;

  // ============================ 初始化 / 重置 ============================
  function resetRun() {
    player = BH.player = {
      x: level.playerSpawn.x + 0.5,
      y: level.playerSpawn.y + 0.5,
      dir: -Math.PI / 2,
      lastMoveDir: -Math.PI / 2,
      radius: CFG.player.radius,
      moveState: 'idle',
      sprinting: false,
      sneaking: false,
      stamina: 1,
      staminaDelay: 0,
      exhausted: false,
      exhaustT: 0,
      breath: 1,
      holdingBreath: false,
      breathLock: 0,
      breatheT: 0,
      hidden: null,
      flashlightOn: true,
      battery: 1,
      batteryLowPlayed: false,
      stones: 3,
      throwCd: 0,
      stepT: 0,
      pantT: 0,
      listening: false,
      interact: null,
      hold: 0,
      holdKind: null,
      holdRef: null,
      lastHeard: null,
      deathCause: null,
      noise: 0,
      animT: 0
    };

    monster = BH.monster = {
      x: level.monsterSpawn.x + 0.5,
      y: level.monsterSpawn.y + 0.5,
      dir: Math.PI / 2,
      state: 'patrol',
      stateT: 0,
      target: null,
      path: null,
      pathIdx: 0,
      repathT: 0,
      clickT: 2.5,
      stepT: 0,
      waitT: 1.0,
      searchT: 0,
      chaseLostT: 0,
      lastHeard: { x: level.monsterSpawn.x + 0.5, y: level.monsterSpawn.y + 0.5 },
      spotTarget: null,
      checkT: 0,
      searchPoint: null,
      lastNode: null,
      aggression: 0,
      animT: 0,
      lastState: 'patrol'
    };

    camera.x = player.x * TILE;
    camera.y = player.y * TILE;
    camera.shake = 0;
    BH.cameraShakeX = 0;
    BH.cameraShakeY = 0;

    ripples.length = 0;
    projectiles.length = 0;
    events.length = 0;

    hideSpots = BH.hideSpots = level.hideSpots.map(function (h) {
      return { x: h.x, y: h.y, type: h.type, checkedAt: -99 };
    });
    notes = BH.notes = level.notes.map(function (n) {
      return { id: n.id, x: n.x, y: n.y, title: n.title, text: n.text, read: false, taken: false };
    });
    pickups = BH.pickups = level.pickups.map(function (p) {
      return { id: p.id, type: p.type, x: p.x, y: p.y, amount: p.amount, taken: false };
    });
    breakers = BH.breakers = level.breakers.map(function (b) {
      return { id: b.id, name: b.name, room: b.room, x: b.x, y: b.y, lights: b.lights, on: false };
    });

    S.mode = 'playing';
    S.runTime = 0;
    S.power = 0;
    S.gateUnlocked = false;
    S.danger = 0;
    S.notesFound = 0;
    S.deathT = 0;
    S.winT = 0;
    S.deathInfo = null;
    S.winInfo = null;
    S.openNote = null;
    S.visited = {};
    S.powerOn = { B1: false, B2: false, B3: false };
    S.tips = [
      { t: 1.6, msg: '它靠声音狩猎。', sub: '你发出的每一点声响，它都听得见。' },
      { t: 10.0, msg: '按住 Shift 冲刺会发出巨大声响。', sub: '按 Ctrl 潜行几乎无声，但很慢。' },
      { t: 20.0, msg: '左键投掷石块，可以制造假声源。', sub: '让它去听石头，而不是你。' }
    ];
    S.tipIndex = 0;

    env.lightning.next = randRange(20, 34);
    env.lightning.flash = 0;
    env.creakT = randRange(14, 24);
    env.dust = [];
    for (var i = 0; i < 46; i++) {
      env.dust.push({
        x: randRange(0, W), y: randRange(0, H),
        vx: randRange(-0.05, 0.05), vy: randRange(-0.03, 0.03),
        a: randRange(0.02, 0.1), r: randRange(0.4, 1.4)
      });
    }
    logEvent('run-start', {});
  }

  // ============================ 涟漪 / 声呐 ============================
  function spawnRipple(x, y, maxR, kind, ttl) {
    ripples.push({
      x: x, y: y,
      r: 0,
      maxR: maxR,
      t: 0,
      ttl: ttl || 1.5,
      kind: kind || 'player'
    });
    if (ripples.length > 90) ripples.shift();
  }

  var RIPPLE_COLORS = {
    player: [159, 216, 255],
    monster: [255, 90, 74],
    decoy: [255, 207, 106],
    env: [127, 224, 208],
    power: [216, 192, 122]
  };
  BH.RIPPLE_COLORS = RIPPLE_COLORS;

  // ============================ 噪音系统 ============================
  var PLAYER_NOISE = {
    walk: true, sprint: true, sneak: true, breath: true, gasp: true,
    breaker: true, gate: true, power: true
  };

  function emitNoise(x, y, radius, source) {
    spawnRipple(x, y, Math.min(radius * 0.62, 7), RIPPLE_COLORS[source] ? source : 'player', 1.2 + radius * 0.06);
    if (S.mode !== 'playing') return;
    var m = monster;
    var d = dist(m.x, m.y, x, y);
    var los = hasLOS(m.x, m.y, x, y);
    var eff = radius * (los ? 1.0 : 0.58);
    if (d > eff) return;
    if (PLAYER_NOISE[source]) {
      player.lastHeard = { source: source, dist: d, t: S.runTime };
    }
    onMonsterHeard(x, y, source, d, eff);
  }

  function onMonsterHeard(x, y, source, d, eff) {
    var m = monster;
    if (m.state === 'chase') {
      if (source === 'decoy') {
        // 石块有几率把它短暂引开
        if (rnd() < 0.42) {
          m.lastHeard = { x: x, y: y };
          m.target = { x: x, y: y };
          m.chaseLostT = 0;
          m.repathT = 0;
          logEvent('decoy-distract', { d: +d.toFixed(1) });
          return;
        }
      }
      m.lastHeard = { x: x, y: y };
      m.target = { x: x, y: y };
      m.chaseLostT = 0;
      m.repathT = 0;
      return;
    }
    if (source === 'decoy') {
      m.lastHeard = { x: x, y: y };
      m.target = { x: x, y: y };
      if (m.state !== 'investigate') setMonsterState('investigate');
      m.repathT = 0;
      logEvent('decoy-heard', { d: +d.toFixed(1) });
      return;
    }
    if (d < CFG.monster.chaseRange && m.state !== 'search') {
      startChase(x, y);
      return;
    }
    m.lastHeard = { x: x, y: y };
    m.target = { x: x, y: y };
    if (m.state !== 'investigate') {
      setMonsterState('investigate');
    } else {
      m.repathT = 0;
    }
    logEvent('heard', { src: source, d: +d.toFixed(1) });
  }

  function startChase(x, y) {
    var m = monster;
    var wasChase = m.state === 'chase';
    m.lastHeard = { x: x, y: y };
    m.target = { x: x, y: y };
    m.chaseLostT = 0;
    m.repathT = 0;
    m.clickT = 0.3;
    setMonsterState('chase');
    if (!wasChase) {
      audio.sfx('monster_screech', m.x, m.y);
      spawnRipple(m.x, m.y, 3.6, 'monster', 1.4);
      camera.shake = Math.max(camera.shake, 0.9);
      logEvent('chase-start', { d: +dist(m.x, m.y, player.x, player.y).toFixed(1) });
    }
  }

  function setMonsterState(st) {
    var m = monster;
    if (m.state === st) return;
    m.lastState = m.state;
    m.state = st;
    m.stateT = 0;
    logEvent('monster-state', { from: m.lastState, to: st });
  }

  function aggression() { return S.power + (S.gateUnlocked ? 1 : 0); }

  function chaseSpeed() {
    return CFG.monster.chaseSpeed + aggression() * CFG.monster.speedPerBreaker;
  }
  function patrolSpeed() {
    return CFG.monster.patrolSpeed + aggression() * CFG.monster.speedPerBreaker;
  }
  function searchDuration() {
    return CFG.monster.searchTime + aggression() * CFG.monster.searchTimePerBreaker;
  }

  function choosePatrolTarget() {
    var m = monster;
    var best = null, bestScore = -1e9;
    for (var i = 0; i < level.patrolNodes.length; i++) {
      var n = level.patrolNodes[i];
      var d = dist(m.x, m.y, n.x + 0.5, n.y + 0.5);
      if (d < 5.5) continue;
      var score = rnd() * 1.2;
      if (S.gateUnlocked && n.y >= 30) score += 0.9;   // 合闸后偏向守南门
      if (S.power >= 1 && n.x > 30 && n.y < 20) score += 0.2;
      if (m.lastNode && n.x === m.lastNode.x && n.y === m.lastNode.y) score -= 1.4;
      if (d > 32) score -= 0.25;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    if (!best) best = level.patrolNodes[(rnd() * level.patrolNodes.length) | 0];
    m.lastNode = best;
    return { x: best.x + 0.5, y: best.y + 0.5 };
  }

  // ---------- 怪物移动 ----------
  function monsterFollow(dt, speed, tx, ty) {
    var m = monster;
    m.repathT -= dt;
    if (!m.path || m.repathT <= 0) {
      m.repathT = 0.5;
      m.path = findPath(m.x, m.y, tx, ty, monsterSolidAt);
      m.pathIdx = 0;
    }
    if (!m.path || !m.path.length) return false;
    var guard = 0;
    while (m.pathIdx < m.path.length && guard++ < 8) {
      var wp = m.path[m.pathIdx];
      var dx = wp.x - m.x, dy = wp.y - m.y;
      var d = Math.hypot(dx, dy);
      if (d < 0.14) { m.pathIdx++; continue; }
      var stepLen = speed * dt;
      var k = Math.min(stepLen, d);
      m.x += dx / d * k;
      m.y += dy / d * k;
      m.dir = Math.atan2(dy, dx);
      return true;
    }
    return false;
  }

  // ---------- 怪物更新 ----------
  var CLICK_INTERVAL = {
    patrol: CFG.monster.clickPatrol,
    investigate: CFG.monster.clickInvestigate,
    search: CFG.monster.clickSearch,
    chase: CFG.monster.clickChase
  };

  function updateMonster(dt) {
    var m = monster;
    m.stateT += dt;
    m.animT += dt;
    m.clickT -= dt;
    m.stepT -= dt;

    if (m.clickT <= 0) {
      var iv = CLICK_INTERVAL[m.state] || 3.0;
      m.clickT = iv * (0.78 + rnd() * 0.5);
      audio.sfx('monster_click', m.x, m.y);
      spawnRipple(m.x, m.y, m.state === 'chase' ? 1.9 : 1.45, 'monster', 1.7);
    }
    if (m.state === 'chase' && m.stepT <= 0) {
      m.stepT = 0.30;
      audio.sfx('monster_step', m.x, m.y);
    }

    switch (m.state) {
      case 'patrol': updatePatrol(dt); break;
      case 'investigate': updateInvestigate(dt); break;
      case 'search': updateSearch(dt); break;
      case 'chase': updateChase(dt); break;
    }

    // 接触即死（无论它是否处于追逐状态）
    if (S.mode === 'playing' && !player.hidden) {
      if (dist(m.x, m.y, player.x, player.y) < CFG.monster.contactDist) {
        killPlayer('caught');
      }
    }
  }

  function updatePatrol(dt) {
    var m = monster;
    if (m.waitT > 0) {
      m.waitT -= dt;
      return;
    }
    if (!m.target) m.target = choosePatrolTarget();
    monsterFollow(dt, patrolSpeed(), m.target.x, m.target.y);
    if (dist(m.x, m.y, m.target.x, m.target.y) < 0.6) {
      m.waitT = randRange(0.8, 2.0);
      m.target = choosePatrolTarget();
      m.path = null;
    }
  }

  function updateInvestigate(dt) {
    var m = monster;
    if (!m.target) { setMonsterState('patrol'); return; }
    monsterFollow(dt, CFG.monster.investigateSpeed + aggression() * 0.04, m.target.x, m.target.y);
    if (dist(m.x, m.y, m.target.x, m.target.y) < 0.8) {
      m.target = null;
      m.path = null;
      m.spotTarget = null;
      m.checkT = 0;
      m.searchPoint = null;
      m.searchT = searchDuration();
      setMonsterState('search');
      audio.sfx('monster_search', m.x, m.y);
    }
  }

  function updateSearch(dt) {
    var m = monster;
    m.searchT -= dt;

    // 1) 正在检查某个躲藏点
    if (m.spotTarget) {
      var sp = m.spotTarget;
      var dToSpot = dist(m.x, m.y, sp.x + 0.5, sp.y + 0.5);
      if (dToSpot <= CFG.monster.spotCheckDist) {
        if (m.checkT === 0) audio.sfx('monster_search', m.x, m.y);
        m.checkT += dt;
        m.dir = Math.atan2(sp.y + 0.5 - m.y, sp.x + 0.5 - m.x);
        if (m.checkT >= CFG.monster.spotCheckTime) {
          finishSpotCheck(sp);
        }
      } else {
        monsterFollow(dt, CFG.monster.searchSpeed, sp.x + 0.5, sp.y + 0.5);
      }
    } else {
      // 2) 找附近没检查过的躲藏点
      if (m.stateT > 0.4) {
        var cand = null, candD = 1e9;
        for (var i = 0; i < hideSpots.length; i++) {
          var s = hideSpots[i];
          if (S.runTime - s.checkedAt < 22) continue;
          var dd = dist(m.x, m.y, s.x + 0.5, s.y + 0.5);
          var dl = dist(m.lastHeard.x, m.lastHeard.y, s.x + 0.5, s.y + 0.5);
          if (dd < 7.5 && dl < 6.5 && dd < candD) { candD = dd; cand = s; }
        }
        if (cand) {
          m.spotTarget = cand;
          m.checkT = 0;
          m.path = null;
          m.repathT = 0;
          return;
        }
      }
      // 3) 在最后听见的位置附近游荡
      if (!m.searchPoint || dist(m.x, m.y, m.searchPoint.x, m.searchPoint.y) < 0.7) {
        var tries = 0;
        do {
          var ang = rnd() * TAU, rr = 1.5 + rnd() * 4.2;
          var px2 = m.lastHeard.x + Math.cos(ang) * rr;
          var py2 = m.lastHeard.y + Math.sin(ang) * rr;
          tries++;
        } while (tries < 8 && solidAt(Math.floor(px2), Math.floor(py2)));
        m.searchPoint = { x: px2, y: py2 };
        m.path = null;
        m.repathT = 0;
      }
      monsterFollow(dt, CFG.monster.searchSpeed, m.searchPoint.x, m.searchPoint.y);
    }

    if (m.searchT <= 0) {
      m.spotTarget = null;
      m.checkT = 0;
      m.target = null;
      m.path = null;
      setMonsterState('patrol');
    }
  }

  function finishSpotCheck(spot) {
    var m = monster;
    spot.checkedAt = S.runTime;
    m.spotTarget = null;
    m.checkT = 0;
    m.path = null;
    m.searchPoint = null;
    if (player.hidden && player.hidden.x === spot.x && player.hidden.y === spot.y) {
      if (player.holdingBreath && player.breath > 0.05) {
        logEvent('spot-check-survived', {});
        spawnRipple(m.x, m.y, 1.2, 'monster', 1.0);
      } else {
        killPlayer('hidden', spot);
      }
    } else {
      logEvent('spot-check-empty', {});
      spawnRipple(m.x, m.y, 1.0, 'monster', 1.0);
    }
  }

  function updateChase(dt) {
    var m = monster;
    m.chaseLostT += dt;
    var tx = m.lastHeard.x, ty = m.lastHeard.y;
    monsterFollow(dt, chaseSpeed(), tx, ty);
    var d = dist(m.x, m.y, player.x, player.y);
    if (!player.hidden && d < CFG.monster.killDist) {
      killPlayer('caught');
      return;
    }
    if (m.chaseLostT > CFG.monster.giveUpTime) {
      m.spotTarget = null;
      m.checkT = 0;
      m.searchPoint = null;
      m.searchT = searchDuration();
      setMonsterState('search');
      audio.sfx('monster_search', m.x, m.y);
    }
  }

  // ============================ 玩家 ============================
  function isDown(codes) {
    var keys = BH.input.keys;
    for (var i = 0; i < codes.length; i++) if (keys[codes[i]]) return true;
    return false;
  }
  function isPressed(codes) {
    var keys = BH.input.pressed;
    for (var i = 0; i < codes.length; i++) if (keys[codes[i]]) return true;
    return false;
  }

  function updatePlayer(dt) {
    var p = player;
    p.animT += dt;

    // ---------- 朝向（鼠标；无鼠标操作时沿移动方向） ----------
    var mouseActive = BH.input.mouseActive;
    if (mouseActive) {
      var mw = screenToWorld(BH.input.mouse.x, BH.input.mouse.y);
      p.dir = Math.atan2(mw.y - p.y, mw.x - p.x);
    } else if (mouseActive === false && p.moveState !== 'idle') {
      p.dir = p.lastMoveDir;
    }

    // ---------- 躲藏中：独立处理 ----------
    if (p.hidden) {
      updateHidden(dt);
      p.moveState = 'idle';
      p.listening = false;
      p.noise = 0;
      updateInteractPrompt();
      return;
    }

    // ---------- 倾听（站立不动，强化声呐） ----------
    p.listening = isDown(['KeyR']) && S.mode === 'playing';

    // ---------- 移动 ----------
    var ix = 0, iy = 0;
    if (isDown(['KeyW', 'ArrowUp'])) iy -= 1;
    if (isDown(['KeyS', 'ArrowDown'])) iy += 1;
    if (isDown(['KeyA', 'ArrowLeft'])) ix -= 1;
    if (isDown(['KeyD', 'ArrowRight'])) ix += 1;
    var moving = (ix !== 0 || iy !== 0);
    if (moving && p.listening) moving = false;
    if (moving) {
      var ilen = Math.hypot(ix, iy);
      ix /= ilen; iy /= ilen;
      p.lastMoveDir = Math.atan2(iy, ix);
      if (!mouseActive) p.dir = p.lastMoveDir;
    }

    var wantSprint = isDown(['ShiftLeft', 'ShiftRight']);
    var wantSneak = isDown(['ControlLeft', 'ControlRight', 'KeyC']);

    // 体力 / 力竭
    if (p.exhaustT > 0) {
      p.exhaustT -= dt;
      if (p.exhaustT <= 0 && p.stamina >= CFG.player.exhaustRecover) {
        p.exhausted = false;
      }
    }
    p.sprinting = wantSprint && moving && !p.exhausted && p.stamina > 0.01;
    p.sneaking = !p.sprinting && wantSneak;

    var speedMul = 1;
    if (p.sprinting) speedMul = CFG.player.sprintMul;
    else if (p.sneaking) speedMul = CFG.player.sneakMul;
    else if (p.exhausted) speedMul = CFG.player.exhaustedMul;

    if (p.sprinting) {
      p.stamina -= CFG.player.staminaSprintDrain * dt;
      p.staminaDelay = CFG.player.staminaRegenDelay;
      if (p.stamina <= 0) {
        p.stamina = 0;
        p.exhausted = true;
        p.exhaustT = CFG.player.exhaustDuration;
        p.sprinting = false;
        speedMul = CFG.player.exhaustedMul;
        logEvent('exhausted', {});
      }
    } else {
      if (p.staminaDelay > 0) p.staminaDelay -= dt;
      else {
        var regen = p.sneaking ? CFG.player.staminaRegenSneak : CFG.player.staminaRegen;
        p.stamina = clamp(p.stamina + regen * dt, 0, 1);
      }
    }

    var speed = CFG.player.walkSpeed * speedMul;
    if (moving) {
      var nx = p.x + ix * speed * dt;
      var ny = p.y + iy * speed * dt;
      if (!circleHitsWall(nx, p.y, p.radius)) p.x = nx;
      if (!circleHitsWall(p.x, ny, p.radius)) p.y = ny;
      p.moveState = p.sprinting ? 'sprint' : (p.sneaking ? 'sneak' : 'walk');
    } else {
      p.moveState = 'idle';
    }

    // ---------- 脚步声 ----------
    p.stepT -= dt;
    if (p.moveState !== 'idle') {
      var ivStep = p.sprinting ? 0.235 : (p.sneaking ? 0.60 : 0.42);
      if (p.stepT <= 0) {
        p.stepT += ivStep;
        var src = p.sprinting ? 'sprint' : (p.sneaking ? 'sneak' : 'walk');
        var rad = p.sprinting ? CFG.noise.sprintRadius : (p.sneaking ? CFG.noise.sneakRadius : CFG.noise.walkRadius);
        emitNoise(p.x, p.y, rad, src);
        audio.sfx(p.sprinting ? 'step_sprint' : (p.sneaking ? 'step_sneak' : 'step_walk'), p.x, p.y);
      }
    } else {
      p.stepT = 0;
    }

    // ---------- 力竭喘息 ----------
    if (p.exhausted) {
      p.pantT -= dt;
      if (p.pantT <= 0) {
        p.pantT = 0.62;
        emitNoise(p.x, p.y, CFG.noise.pantRadius, 'breath');
      }
    }

    // ---------- 手电电池 ----------
    if (isPressed(['KeyF'])) {
      p.flashlightOn = !p.flashlightOn && p.battery > 0.001;
      audio.sfx('ui_click');
      logEvent('flashlight', { on: p.flashlightOn });
    }
    if (p.flashlightOn && p.battery > 0) {
      p.battery -= CFG.player.batteryDrain * dt * (p.listening ? 0.35 : 1);
      if (p.battery <= 0) {
        p.battery = 0;
        p.flashlightOn = false;
        audio.sfx('battery_low', p.x, p.y);
        toast('手电熄灭了。', '摸黑前进——或者，靠声音。');
        logEvent('battery-dead', {});
      } else if (p.battery < 0.18 && !p.batteryLowPlayed) {
        p.batteryLowPlayed = true;
        audio.sfx('battery_low', p.x, p.y);
      }
    }
    if (p.battery < 0.18) p.batteryLowPlayed = p.batteryLowPlayed || false;

    // ---------- 投石 ----------
    p.throwCd -= dt;
    if (BH.input.clicked && p.throwCd <= 0 && p.stones > 0 && !p.listening) {
      var aim = screenToWorld(BH.input.mouse.x, BH.input.mouse.y);
      var dx = aim.x - p.x, dy = aim.y - p.y;
      var dd = Math.hypot(dx, dy);
      if (dd > 0.4) {
        p.throwCd = 0.55;
        p.stones--;
        projectiles.push({
          x: p.x, y: p.y,
          vx: dx / dd * CFG.player.throwSpeed,
          vy: dy / dd * CFG.player.throwSpeed,
          travelled: 0,
          radius: 0.16
        });
        audio.sfx('throw', p.x, p.y);
        logEvent('throw', { stones: p.stones });
      }
    }

    // ---------- 交互 ----------
    updateInteract(dt, moving);
    updatePickups();
    updateRoomVisit();
  }

  function updateHidden(dt) {
    var p = player;
    p.hidden.checkedAt = p.hidden.checkedAt; // noop
    p.throwCd = Math.max(0, p.throwCd - dt);

    // 按住空格屏息
    var hold = isDown(['Space']);
    if (p.breathLock > 0) p.breathLock -= dt;
    if (hold && p.breathLock <= 0 && p.breath > 0) {
      p.holdingBreath = true;
      p.breath -= CFG.player.breathHoldDrain * dt;
      if (p.breath <= 0) {
        p.breath = 0;
        p.holdingBreath = false;
        p.breathLock = 1.4;
        emitNoise(p.x, p.y, CFG.noise.gaspRadius, 'gasp');
        audio.sfx('gasp', p.x, p.y);
        logEvent('gasp', {});
      }
    } else {
      p.holdingBreath = false;
      if (p.breath < 1) p.breath = clamp(p.breath + CFG.player.breathRegen * dt, 0, 1);
      // 呼吸声
      p.breatheT -= dt;
      if (p.breatheT <= 0) {
        p.breatheT = 0.9 + rnd() * 0.5;
        if (p.breath < 0.95) emitNoise(p.x, p.y, CFG.noise.breathRadius, 'breath');
      }
    }

    // 按 E 离开
    if (isPressed(['KeyE'])) {
      leaveHide();
    }
  }

  function enterHide(spot) {
    var p = player;
    p.hidden = spot;
    p.holdingBreath = false;
    p.breath = 1;
    p.breathLock = 0;
    p.breatheT = 0.8;
    p.flashlightOn = false;
    p.hold = 0;
    p.holdKind = null;
    p.x = spot.x + 0.5;
    p.y = spot.y + 0.5;
    audio.sfx('door', spot.x, spot.y, 0.5);
    logEvent('hide-enter', { type: spot.type, x: spot.x, y: spot.y });
  }

  function leaveHide() {
    var p = player;
    if (!p.hidden) return;
    logEvent('hide-leave', {});
    p.hidden = null;
    p.holdingBreath = false;
    // 若柜子紧贴墙，往房间方向挪一点
    var dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    for (var i = 0; i < dirs.length; i++) {
      var nx = p.x + dirs[i][0] * 1.15, ny = p.y + dirs[i][1] * 1.15;
      if (!circleHitsWall(nx, ny, p.radius)) { p.x = nx; p.y = ny; break; }
    }
  }

  // ---------- 交互目标 ----------
  function updateInteractPrompt() {
    // 由 render/HUD 读取 p.interact
  }

  function findInteractable() {
    var p = player;
    if (p.hidden) return { kind: 'hidden', x: p.hidden.x, y: p.hidden.y };
    var best = null, bestD = 1e9;

    // 南门
    var gd = dist(p.x, p.y, level.gate.x + 0.5, level.gate.y + 0.5);
    if (gd < 1.55) {
      return S.gateUnlocked ? { kind: 'gate', x: level.gate.x, y: level.gate.y } :
        { kind: 'gate-locked', x: level.gate.x, y: level.gate.y };
    }

    // 电闸
    for (var i = 0; i < breakers.length; i++) {
      var b = breakers[i];
      if (b.on) continue;
      var d = dist(p.x, p.y, b.x + 0.5, b.y + 0.5);
      if (d < 1.35 && d < bestD) { bestD = d; best = { kind: 'breaker', ref: b, x: b.x, y: b.y, label: b.name }; }
    }
    // 笔记
    for (var j = 0; j < notes.length; j++) {
      var n = notes[j];
      if (n.read) continue;
      var dn = dist(p.x, p.y, n.x + 0.5, n.y + 0.5);
      if (dn < 1.15 && dn < bestD) { bestD = dn; best = { kind: 'note', ref: n, x: n.x, y: n.y, label: n.title }; }
    }
    // 躲藏点
    for (var k = 0; k < hideSpots.length; k++) {
      var s = hideSpots[k];
      var ds = dist(p.x, p.y, s.x + 0.5, s.y + 0.5);
      if (ds < 1.05 && ds < bestD) { bestD = ds; best = { kind: 'hide', ref: s, x: s.x, y: s.y, label: HIDE_LABEL[s.type] || '躲藏点' }; }
    }
    return best;
  }

  var HIDE_LABEL = { bed: '床底', wardrobe: '衣柜', locker: '铁柜', pew: '长椅下', desk: '办公桌下' };
  BH.HIDE_LABEL = HIDE_LABEL;

  function updateInteract(dt, moving) {
    var p = player;
    p.interact = findInteractable();

    // 需要按下的即时交互
    if (isPressed(['Space', 'KeyE'])) {
      var t = p.interact;
      if (t && t.kind === 'hide') {
        enterHide(t.ref);
        return;
      }
      if (t && t.kind === 'note') {
        openNote(t.ref);
        return;
      }
    }

    // 需要按住的长交互（合闸 / 开门）
    var t2 = p.interact;
    var holdable = t2 && (t2.kind === 'breaker' || t2.kind === 'gate');
    var down = isDown(['Space', 'KeyE']);
    if (holdable && down && !moving && !p.listening) {
      if (p.holdKind !== t2.kind || p.holdRef !== t2.ref) {
        p.holdKind = t2.kind;
        p.holdRef = t2.ref;
        p.hold = 0;
        if (t2.kind === 'breaker') audio.sfx('breaker_loop_start', t2.x, t2.y);
        else audio.sfx('gate', t2.x, t2.y);
      }
      p.hold += dt;
      p.noise = 1;
      // 持续噪声
      p.brakeT = (p.brakeT || 0) - dt;
      if (p.brakeT <= 0) {
        p.brakeT = 0.30;
        emitNoise(p.x, p.y, t2.kind === 'breaker' ? CFG.noise.breakerHoldRadius : CFG.noise.gateHoldRadius, t2.kind === 'breaker' ? 'breaker' : 'gate');
      }
      var need = t2.kind === 'breaker' ? CFG.breakerHoldTime : CFG.gateHoldTime;
      if (p.hold >= need) {
        if (t2.kind === 'breaker') {
          completeBreaker(t2.ref);
        } else {
          winGame();
        }
        p.hold = 0;
        p.holdKind = null;
        p.holdRef = null;
      }
    } else {
      if (p.hold > 0) {
        if (p.holdKind === 'breaker') audio.sfx('breaker_loop_stop');
        p.hold = 0;
        p.holdKind = null;
        p.holdRef = null;
      }
      p.noise = moving ? (p.sprinting ? 1 : p.sneaking ? 0.15 : 0.45) : 0;
    }
  }

  function openNote(n) {
    n.read = true;
    S.notesFound++;
    S.openNote = n;
    audio.sfx('note');
    setMode('note');
    logEvent('note-read', { title: n.title });
  }

  function updatePickups() {
    var p = player;
    for (var i = 0; i < pickups.length; i++) {
      var it = pickups[i];
      if (it.taken) continue;
      if (dist(p.x, p.y, it.x + 0.5, it.y + 0.5) < 0.6) {
        it.taken = true;
        if (it.type === 'stone') {
          p.stones = Math.min(CFG.player.maxStones, p.stones + it.amount);
          audio.sfx('pickup', it.x, it.y);
          toast('拾得石块', '石块数 ' + p.stones);
        } else if (it.type === 'battery') {
          p.battery = clamp(p.battery + it.amount, 0, 1);
          audio.sfx('pickup', it.x, it.y);
          toast('拾得电池', '电量 ' + Math.round(p.battery * 100) + '%');
        }
        logEvent('pickup', { type: it.type });
      }
    }
  }

  function updateRoomVisit() {
    var p = player;
    for (var i = 0; i < level.areas.length; i++) {
      var a = level.areas[i];
      if (p.x >= a.x && p.x < a.x + a.w && p.y >= a.y && p.y < a.y + a.h) {
        if (!S.visited[a.name]) {
          S.visited[a.name] = true;
          if (a.name.indexOf('走廊') === -1) {
            toast(a.name, '');
            logEvent('room-enter', { name: a.name });
          }
        }
        break;
      }
    }
  }

  // ---------- 目标 ----------
  function completeBreaker(b) {
    b.on = true;
    audio.sfx('breaker_loop_stop');
    audio.sfx('breaker_done', b.x, b.y);
    emitNoise(b.x + 0.5, b.y + 0.5, CFG.noise.breakerDoneRadius, 'power');
    spawnRipple(b.x + 0.5, b.y + 0.5, 6.5, 'power', 2.0);
    if (S.mode === 'playing') camera.shake = Math.max(camera.shake, 0.45);
    S.powerOn[b.id] = true;
    S.power = breakers.filter(function (x) { return x.on; }).length;
    updateObjective();
    toast('合闸成功：' + b.name, '灯光亮起——但整栋楼都听见了。');
    logEvent('breaker-on', { id: b.id, power: S.power });
    if (S.power >= 3) {
      S.gateUnlocked = true;
      toast('三路电力恢复', '南门电锁已释放。它正向门厅走。');
      logEvent('gate-unlocked', {});
    }
    updateObjective();
  }

  function updateObjective() {
    if (typeof BH.hooks.objective === 'function') {
      BH.hooks.objective({
        power: S.power,
        gateUnlocked: S.gateUnlocked,
        breakers: breakers.map(function (b) { return { id: b.id, name: b.name, on: b.on }; })
      });
    }
  }

  // ---------- 死亡 / 胜利 ----------
  function killPlayer(cause, spot) {
    if (S.mode !== 'playing') return;
    var p = player;
    var info = { cause: cause, spotType: spot ? spot.type : null, heard: p.lastHeard };
    p.deathCause = info;
    S.mode = 'dying';
    S.deathT = 0;
    S.deaths++;
    camera.shake = 1.4;
    audio.sfx('death', p.x, p.y);
    logEvent('death', { cause: cause });
  }

  function deathInfo() {
    var p = player;
    var c = p.deathCause || { cause: 'caught' };
    var reason, sub = '';
    if (c.cause === 'hidden') {
      reason = '它掀开了你藏身的' + (HIDE_LABEL[c.spotType] || '角落') + '。';
      sub = '屏住呼吸的时机，比躲藏的地点更重要。';
    } else if (c.cause === 'caught') {
      if (c.heard && S.runTime - c.heard.t < 6) {
        reason = '它顺着「' + noiseLabel(c.heard.source) + '」追上了你。';
        sub = '距离它 ' + (c.heard.dist * CFG.meterPerTile).toFixed(0) + ' 米时，你被听见了。';
      } else {
        reason = '它从黑暗里扑了上来。';
        sub = '它没有眼睛，却总能知道你在哪里。';
      }
    } else {
      reason = '你被它抓住了。';
    }
    var tips = [
      '声音是它唯一的感官。停下不动，它就失去了你。',
      '冲刺的声音能传很远。走廊里，尽量用潜行。',
      '躲进柜子后按住空格屏住呼吸——它靠近时，呼吸会出卖你。',
      '石块落地的声音可以把它的注意力引开。',
      '合闸的电流声会传遍整栋楼。先把退路想好。',
      '别在同一个角落躲第二次。它记得。'
    ];
    return {
      reason: reason,
      sub: sub,
      tip: tips[(S.deaths - 1) % tips.length],
      time: S.runTime,
      power: S.power,
      deaths: S.deaths
    };
  }

  function noiseLabel(src) {
    var map = {
      walk: '脚步', sprint: '冲刺', sneak: '潜行', breath: '呼吸',
      gasp: '喘息', breaker: '电流', gate: '铁门', power: '合闸巨响'
    };
    return map[src] || '声音';
  }

  function winGame() {
    if (S.mode !== 'playing') return;
    S.mode = 'winning';
    S.winT = 0;
    audio.sfx('gate', level.gate.x, level.gate.y);
    audio.sfx('win');
    logEvent('win', { time: +S.runTime.toFixed(1) });
    toast('南门开了。', '你要活着走出去。');
  }

  function winInfo() {
    return {
      time: S.runTime,
      deaths: S.deaths,
      notes: S.notesFound,
      totalNotes: notes.length,
      battery: player.battery
    };
  }

  // ---------- 提示 ----------
  function updateHints() {
    while (S.tipIndex < S.tips.length && S.runTime >= S.tips[S.tipIndex].t) {
      var tip = S.tips[S.tipIndex];
      toast(tip.msg, tip.sub);
      S.tipIndex++;
    }
  }

  function toast(msg, sub) {
    if (typeof BH.hooks.toast === 'function') BH.hooks.toast(msg, sub);
  }

  // ---------- 环境 ----------
  function updateEnv(dt) {
    // 雷暴
    env.lightning.next -= dt;
    if (env.lightning.next <= 0) {
      env.lightning.next = randRange(24, 42);
      env.lightning.flash = 1;
      audio.sfx('lightning');
      logEvent('lightning', {});
    }
    if (env.lightning.flash > 0) {
      env.lightning.flash = Math.max(0, env.lightning.flash - dt * 7.5);
    }
    // 建筑吱嘎
    env.creakT -= dt;
    if (env.creakT <= 0) {
      env.creakT = randRange(16, 30);
      var ang = rnd() * TAU, rr = randRange(6, 18);
      var cx = clamp(player.x + Math.cos(ang) * rr, 2, W - 3);
      var cy = clamp(player.y + Math.sin(ang) * rr, 2, H - 3);
      if (!solidAt(Math.floor(cx), Math.floor(cy))) {
        audio.sfx('door', cx, cy, 0.5);
        spawnRipple(cx, cy, 1.2, 'env', 1.6);
      }
    }
  }

  function updateRipples(dt) {
    var speed = player && player.listening ? 0.42 : 1.0;
    for (var i = ripples.length - 1; i >= 0; i--) {
      var r = ripples[i];
      r.t += dt * speed;
      if (r.t >= r.ttl) ripples.splice(i, 1);
    }
  }

  function updateProjectiles(dt) {
    for (var i = projectiles.length - 1; i >= 0; i--) {
      var pr = projectiles[i];
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.travelled += Math.hypot(pr.vx, pr.vy) * dt;
      var hit = solidAt(Math.floor(pr.x), Math.floor(pr.y)) || pr.travelled > CFG.player.throwRange;
      if (hit) {
        emitNoise(pr.x, pr.y, CFG.noise.throwRadius, 'decoy');
        audio.sfx('impact', pr.x, pr.y);
        spawnRipple(pr.x, pr.y, 3.2, 'decoy', 1.5);
        projectiles.splice(i, 1);
        logEvent('stone-impact', { x: +pr.x.toFixed(1), y: +pr.y.toFixed(1) });
      }
    }
  }

  function updateCamera(dt) {
    var p = player;
    var tx = p.x * TILE, ty = p.y * TILE;
    var k = 1 - Math.exp(-7.5 * dt);
    camera.x = lerp(camera.x, tx, k);
    camera.y = lerp(camera.y, ty, k);
    camera.shake = Math.max(0, camera.shake - dt * 2.4);
    if (camera.shake > 0.001) {
      BH.cameraShakeX = (rnd() - 0.5) * camera.shake * 12;
      BH.cameraShakeY = (rnd() - 0.5) * camera.shake * 12;
    } else {
      BH.cameraShakeX = 0;
      BH.cameraShakeY = 0;
    }
  }

  function computeDanger() {
    var m = monster, p = player;
    if (!m || !p) return 0;
    var d = dist(m.x, m.y, p.x, p.y);
    var w = m.state === 'chase' ? 1.0 : m.state === 'search' ? 0.82 : m.state === 'investigate' ? 0.55 : 0.32;
    var prox = clamp(1 - (d - 1.8) / 13, 0, 1);
    var v = w * prox;
    if (m.state === 'chase') v = Math.max(v, 0.32 + prox * 0.68);
    return clamp(v, 0, 1);
  }

  function updateTitle(dt) {
    // 标题界面的氛围涟漪
    if (!S._titleT) S._titleT = 0;
    S._titleT += dt;
    if (S._titleT > 2.2) {
      S._titleT = 0;
      ripples.push({
        x: randRange(0, W), y: randRange(0, H), r: 0,
        maxR: randRange(3, 8), t: 0, ttl: randRange(2.2, 3.6),
        kind: 'monster'
      });
    }
    updateRipples(dt);
  }

  // ============================ 音频状态 ============================
  function audioState() {
    var m = monster, p = player;
    var mode = S.mode;
    var gs = 'playing';
    if (mode === 'title') gs = 'title';
    else if (mode === 'paused' || mode === 'note') gs = 'paused';
    else if (mode === 'dying' || mode === 'dead') gs = 'dead';
    else if (mode === 'winning' || mode === 'won') gs = 'won';
    if (!p || !m) return { gameState: gs };
    var d = dist(m.x, m.y, p.x, p.y);
    return {
      gameState: gs,
      playerX: p.x, playerY: p.y,
      monsterX: m.x, monsterY: m.y,
      monsterState: m.state,
      monsterDistance: d,
      monsterVisible: isMonsterVisible(),
      moveState: p.hidden ? 'idle' : p.moveState,
      exhausted: p.exhausted,
      hidden: !!p.hidden,
      holdingBreath: !!p.holdingBreath,
      breath: p.breath,
      stamina: p.stamina,
      power: S.power / 3,
      battery: p.battery,
      flashlightOn: p.flashlightOn && !p.hidden,
      listening: !!p.listening,
      danger: S.danger,
      heartbeat: S.danger
    };
  }

  function isMonsterVisible() {
    var m = monster, p = player;
    if (!m || !p || p.hidden) return false;
    if (env.lightning.flash > 0.15) return true;
    var d = dist(m.x, m.y, p.x, p.y);
    if (d < 2.4 && hasLOS(p.x, p.y, m.x, m.y)) return true;
    if (p.flashlightOn && p.battery > 0) {
      var ang = Math.atan2(m.y - p.y, m.x - p.x);
      var diff = Math.abs(angDiff(ang, p.dir));
      if (d < 10 && diff < 0.42 && hasLOS(p.x, p.y, m.x, m.y)) return true;
    }
    for (var i = 0; i < level.lights.length; i++) {
      var lt = level.lights[i];
      if (!S.powerOn[lt.breaker]) continue;
      if (dist(m.x, m.y, lt.x + 0.5, lt.y + 0.5) < lt.r * 0.95 && hasLOS(lt.x + 0.5, lt.y + 0.5, m.x, m.y)) return true;
    }
    return false;
  }

  function angDiff(a, b) {
    var d = a - b;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return d;
  }
  BH.angDiff = angDiff;

  // ============================ 模式切换 ============================
  function setMode(mode, data) {
    S.mode = mode;
    logEvent('mode', { mode: mode });
    if (typeof BH.hooks.modeChange === 'function') BH.hooks.modeChange(mode, data);
  }

  // ============================ 主更新 ============================
  function update(dt) {
    S.time += dt;
    if (!player || !monster) return;

    if (S.mode === 'playing') {
      S.runTime += dt;
      updatePlayer(dt);
      updateProjectiles(dt);
      updateMonster(dt);
      updateEnv(dt);
      updateRipples(dt);
      updateCamera(dt);
      updateHints();
      S.danger = computeDanger();
      BH.danger = S.danger;
    } else if (S.mode === 'dying') {
      S.deathT += dt;
      updateCamera(dt);
      updateRipples(dt);
      camera.shake = Math.max(camera.shake, 0.35);
      if (S.deathT > 1.15) {
        S.deathInfo = deathInfo();
        setMode('dead', S.deathInfo);
      }
    } else if (S.mode === 'winning') {
      S.winT += dt;
      updateCamera(dt);
      updateRipples(dt);
      if (S.winT > 0.9) {
        S.winInfo = winInfo();
        setMode('won', S.winInfo);
      }
    } else if (S.mode === 'title') {
      updateTitle(dt);
    }

    // 音频每帧同步
    if (player) {
      audio.listener(player.x, player.y);
      audio.update(dt, audioState());
    }
  }

  // ============================ 对外 API ============================
  BH.api = {
    start: function () {
      resetRun();
      audio.init();
      audio.resume();
      audio.ambience(true);
      setMode('playing');
      updateObjective();
      toast('静默疗养院 · 停电第三夜', '恢复三路电力，从南门离开。');
    },
    restart: function () {
      resetRun();
      audio.resume();
      audio.ambience(true);
      setMode('playing');
      updateObjective();
    },
    quitToTitle: function () {
      S.mode = 'title';
      S._titleT = 0;
      ripples.length = 0;
      audio.ambience(false);
      setMode('title');
    },
    togglePause: function () {
      if (S.mode === 'playing') { setMode('paused'); audio.sfx('ui_click'); }
      else if (S.mode === 'paused') { setMode('playing'); audio.sfx('ui_click'); audio.resume(); }
    },
    resume: function () { if (S.mode === 'paused') { setMode('playing'); audio.resume(); } },
    closeNote: function () {
      if (S.mode !== 'note') return;
      S.openNote = null;
      setMode('playing');
    },
    closeDeath: function () { /* 由 retry 处理 */ },
    update: update,
    killPlayer: killPlayer,
    deathInfo: deathInfo,
    winInfo: winInfo,
    audioState: audioState,
    isMonsterVisible: isMonsterVisible,
    findInteractable: findInteractable,
    emitNoise: emitNoise,
    setSeed: function (s) { seed = s; },
    debugSnapshot: function () {
      return {
        mode: S.mode,
        runTime: +S.runTime.toFixed(2),
        player: { x: +player.x.toFixed(2), y: +player.y.toFixed(2), stamina: +player.stamina.toFixed(2), hidden: !!player.hidden },
        monster: {
          x: +monster.x.toFixed(2), y: +monster.y.toFixed(2),
          state: monster.state, aggression: aggression()
        },
        power: S.power, gateUnlocked: S.gateUnlocked,
        ripples: ripples.length
      };
    },
    events: function () { return events.slice(); }
  };

  // 默认钩子（main.js 会覆盖）
  BH.hooks = BH.hooks || {
    toast: function () { },
    objective: function () { },
    modeChange: function () { }
  };

  // 初始：标题状态也放一段涟漪氛围
  resetRun();
  S.mode = 'title';
  ripples.length = 0;
  S._titleT = 0;

  // 通关一次后暴露给调试
  BH.ready = true;
})();
