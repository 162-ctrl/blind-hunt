/* =========================================================================
 * js/level.js — 《盲猎》关卡数据：静默疗养院（Sanatorium of Silence）
 * -------------------------------------------------------------------------
 * 建筑由「房间 / 走廊」矩形拼合，程序自动生成墙体，门 = 在墙上挖开的门洞。
 * 坐标单位：tile。地图尺寸 64 x 45。
 * 本文件不依赖 DOM，可被 Node 直接加载做连通性校验。
 * ========================================================================= */
(function (root) {
  'use strict';

  var W = 64;
  var H = 45;
  var TILE = 48;

  // 地板类型
  var F_VOID = 0;
  var F_CONCRETE = 1; // 水泥
  var F_TILE = 2;     // 白瓷砖
  var F_WOOD = 3;     // 木地板
  var F_STONE = 4;    // 石砖
  var F_METAL = 5;    // 铁板

  // ---- 区域定义（先画走廊，再画房间，后画覆盖前画） ----
  var AREAS = [
    // 主走廊（环形 + 十字）
    { name: '北走廊', x: 10, y: 4, w: 42, h: 3, floor: F_CONCRETE },
    { name: '西走廊', x: 10, y: 4, w: 3, h: 35, floor: F_CONCRETE },
    { name: '东走廊', x: 49, y: 4, w: 3, h: 35, floor: F_CONCRETE },
    { name: '中央走廊', x: 29, y: 4, w: 3, h: 35, floor: F_CONCRETE },
    { name: '中走廊', x: 10, y: 20, w: 42, h: 3, floor: F_CONCRETE },
    { name: '南走廊', x: 10, y: 36, w: 42, h: 3, floor: F_CONCRETE },

    // —— 北翼 ——
    { name: '停尸房', x: 14, y: 8, w: 7, h: 11, floor: F_TILE },
    { name: '礼拜堂', x: 22, y: 8, w: 6, h: 11, floor: F_WOOD },
    { name: '配电室', x: 33, y: 8, w: 8, h: 11, floor: F_CONCRETE },
    { name: '北翼病房', x: 42, y: 8, w: 6, h: 11, floor: F_WOOD },

    // —— 西翼 ——
    { name: '储藏室', x: 2, y: 8, w: 7, h: 5, floor: F_STONE },
    { name: '值班办公室', x: 2, y: 14, w: 7, h: 5, floor: F_WOOD },
    { name: '值班室', x: 2, y: 20, w: 7, h: 3, floor: F_WOOD },
    { name: '西翼病房', x: 2, y: 24, w: 7, h: 11, floor: F_WOOD },

    // —— 东翼 ——
    { name: '护士办公室', x: 53, y: 8, w: 7, h: 11, floor: F_WOOD },
    { name: '东侧储藏', x: 53, y: 20, w: 7, h: 3, floor: F_STONE },
    { name: '儿童病房', x: 53, y: 24, w: 7, h: 11, floor: F_WOOD },

    // —— 南翼 ——
    { name: '锅炉房', x: 14, y: 24, w: 7, h: 11, floor: F_STONE },
    { name: '西南病房', x: 22, y: 24, w: 6, h: 11, floor: F_WOOD },
    { name: '手术室', x: 33, y: 24, w: 7, h: 11, floor: F_TILE },
    { name: '东南病房', x: 41, y: 24, w: 7, h: 11, floor: F_WOOD },

    // —— 门厅（出生点 & 南门） ——
    { name: '门厅', x: 22, y: 40, w: 17, h: 4, floor: F_CONCRETE }
  ];

  // ---- 门（墙上挖开的门洞；不阻挡移动，只改变噪声与视觉） ----
  var DOORS = [
    [13, 13], [21, 14], [28, 13],
    [36, 7], [32, 12], [41, 12], [48, 12],
    [9, 10], [5, 13], [9, 16], [9, 21], [9, 29], [9, 33],
    [17, 23], [24, 23], [13, 29], [21, 29], [28, 29],
    [17, 35], [24, 35],
    [36, 23], [32, 29], [40, 29], [48, 29], [44, 35],
    [52, 13], [52, 21], [52, 29],
    [26, 39], [34, 39]
  ];

  // ---- 躲藏点 ----
  var HIDE_SPOTS = [
    { x: 4, y: 26, type: 'bed' }, { x: 4, y: 31, type: 'bed' },
    { x: 7, y: 27, type: 'bed' }, { x: 7, y: 32, type: 'bed' },
    { x: 23, y: 26, type: 'bed' }, { x: 26, y: 31, type: 'bed' }, { x: 24, y: 33, type: 'bed' },
    { x: 43, y: 10, type: 'bed' }, { x: 46, y: 13, type: 'bed' }, { x: 44, y: 17, type: 'bed' },
    { x: 42, y: 26, type: 'bed' }, { x: 45, y: 30, type: 'bed' }, { x: 43, y: 33, type: 'bed' },
    { x: 54, y: 26, type: 'bed' }, { x: 57, y: 31, type: 'bed' },
    { x: 3, y: 9, type: 'wardrobe' }, { x: 7, y: 11, type: 'wardrobe' },
    { x: 3, y: 15, type: 'wardrobe' }, { x: 7, y: 16, type: 'wardrobe' },
    { x: 4, y: 17, type: 'desk' }, { x: 7, y: 21, type: 'desk' },
    { x: 14, y: 10, type: 'locker' }, { x: 14, y: 16, type: 'locker' }, { x: 20, y: 9, type: 'locker' },
    { x: 23, y: 10, type: 'pew' }, { x: 26, y: 12, type: 'pew' }, { x: 24, y: 15, type: 'pew' },
    { x: 58, y: 10, type: 'wardrobe' }, { x: 58, y: 16, type: 'wardrobe' }, { x: 54, y: 17, type: 'wardrobe' },
    { x: 58, y: 21, type: 'locker' }
  ];

  // ---- 三处电闸 ----
  var BREAKERS = [
    {
      id: 'B1', name: '锅炉房电闸', room: '锅炉房', x: 19, y: 31,
      lights: [{ x: 17, y: 30, r: 5.4 }, { x: 24, y: 28, r: 4.6 }, { x: 17, y: 37, r: 3.4 }]
    },
    {
      id: 'B2', name: '配电室主闸', room: '配电室', x: 38, y: 10,
      lights: [{ x: 36, y: 12, r: 5.6 }, { x: 44, y: 12, r: 4.6 }, { x: 30, y: 5, r: 3.2 }]
    },
    {
      id: 'B3', name: '东翼电闸', room: '护士办公室', x: 57, y: 12,
      lights: [{ x: 56, y: 13, r: 5.6 }, { x: 56, y: 29, r: 5.0 }, { x: 50, y: 21, r: 3.0 }]
    }
  ];

  // ---- 笔记 ----
  var NOTES = [
    {
      x: 27, y: 41, title: '值班日志 · 第三夜',
      text: '停电已经三天。三号病房的病人整夜对着走廊说话。\n他们说得最多的一个词是——「别出声」。\n\n我把门反锁了。我不知道这有没有用。'
    },
    {
      x: 15, y: 37, title: '南走廊告示',
      text: '夜巡须知：\n一、脚步放轻。\n二、听见墙里有「哒、哒」的响动——立刻停下，别动。\n三、不要相信手电，它照不见该看见的东西。'
    },
    {
      x: 17, y: 9, title: '尸检记录 · 第七号',
      text: '男性，四十岁上下。双眼完整摘除，切口整齐。\n颅骨内侧有大量抓痕——像是他自己把眼睛挖出来的。\n\n记录到此为止。'
    },
    {
      x: 16, y: 24, title: '锅炉房手记',
      text: '三处保险丝全部烧断。合闸会有很大的电流声，整个楼都能听见。\n最后一次合闸之前，把退路想清楚。'
    },
    {
      x: 25, y: 9, title: '祷告词（残页）',
      text: '「……捂住你的嘴，屏住你的呼吸。\n它在门外，数着你的心跳。\n数到三的时候，它就会进来；所以你要一直数下去。」'
    },
    {
      x: 3, y: 8, title: '工具清单',
      text: '碎石若干。玻璃瓶若干——它们对声音感兴趣。\n当你不想被听见的时候，就让别的东西替你被听见。'
    },
    {
      x: 35, y: 9, title: '配电室规程',
      text: '三路电源全部合闸后，南门电锁自动释放。\n注意：合闸瞬间设备噪声极大。请勿在合闸后原地停留。'
    },
    {
      x: 58, y: 9, title: '护士长遗言',
      text: '它看不见你，但它认得你的脚步。\n别在同一个角落里躲两次——它记得。'
    }
  ];

  // ---- 可拾取物 ----
  var PICKUPS = [
    { type: 'stone', x: 18, y: 37, amount: 1 },
    { type: 'stone', x: 26, y: 37, amount: 1 },
    { type: 'stone', x: 34, y: 37, amount: 1 },
    { type: 'stone', x: 11, y: 25, amount: 1 },
    { type: 'stone', x: 48, y: 5, amount: 1 },
    { type: 'stone', x: 5, y: 12, amount: 1 },
    { type: 'stone', x: 56, y: 22, amount: 1 },
    { type: 'stone', x: 37, y: 20, amount: 1 },
    { type: 'stone', x: 14, y: 22, amount: 1 },
    { type: 'battery', x: 30, y: 40, amount: 0.5 },
    { type: 'battery', x: 20, y: 21, amount: 0.5 },
    { type: 'battery', x: 55, y: 31, amount: 0.5 },
    { type: 'battery', x: 24, y: 5, amount: 0.5 },
    { type: 'battery', x: 44, y: 20, amount: 0.5 }
  ];

  // ---- 怪物巡逻节点 ----
  var PATROL_NODES = [
    [16, 5], [24, 5], [44, 5], [30, 5],
    [16, 21], [24, 21], [44, 21], [30, 21],
    [14, 37], [30, 37], [46, 37],
    [11, 10], [11, 28], [50, 10], [50, 28],
    [30, 10], [30, 27],
    [17, 13], [25, 14], [5, 10], [5, 16],
    [37, 16], [45, 15], [17, 29], [25, 28],
    [36, 30], [44, 30], [5, 28], [56, 15], [56, 28]
  ];

  // ---- 纯装饰 ----
  var DECOR = [
    { x: 16, y: 12, type: 'gurney' }, { x: 19, y: 15, type: 'gurney' },
    { x: 15, y: 8, type: 'blood' }, { x: 18, y: 17, type: 'blood' },
    { x: 34, y: 26, type: 'gurney' }, { x: 38, y: 33, type: 'gurney' },
    { x: 36, y: 28, type: 'table' }, { x: 37, y: 31, type: 'blood' },
    { x: 24, y: 8, type: 'candle' }, { x: 26, y: 16, type: 'candle' },
    { x: 23, y: 13, type: 'papers' },
    { x: 2, y: 11, type: 'box' }, { x: 7, y: 8, type: 'box' }, { x: 6, y: 12, type: 'box' },
    { x: 14, y: 25, type: 'pipes' }, { x: 20, y: 33, type: 'pipes' },
    { x: 15, y: 34, type: 'debris' },
    { x: 5, y: 25, type: 'chair' }, { x: 6, y: 33, type: 'chair' },
    { x: 45, y: 9, type: 'chair' }, { x: 43, y: 16, type: 'chair' },
    { x: 55, y: 25, type: 'chair' }, { x: 57, y: 33, type: 'debris' },
    { x: 12, y: 15, type: 'debris' }, { x: 49, y: 33, type: 'debris' },
    { x: 31, y: 5, type: 'papers' }, { x: 48, y: 22, type: 'papers' },
    { x: 25, y: 42, type: 'chair' }, { x: 36, y: 41, type: 'chair' },
    { x: 31, y: 42, type: 'papers' }, { x: 20, y: 37, type: 'debris' },
    { x: 42, y: 37, type: 'blood' }, { x: 3, y: 29, type: 'blood' },
    { x: 33, y: 10, type: 'pipes' }, { x: 55, y: 12, type: 'table' }
  ];

  // ---- 外墙上的窗（雷电能透进来） ----
  var WINDOWS = [
    [1, 10], [1, 16], [1, 28], [1, 32],
    [15, 3], [28, 3], [40, 3], [48, 3],
    [60, 10], [60, 25], [60, 31],
    [24, 44], [36, 44]
  ];

  // ------------------------------------------------------------------
  // 构建
  // ------------------------------------------------------------------
  function build() {
    var solid = new Uint8Array(W * H);      // 1 = 不可通行
    var floorType = new Uint8Array(W * H);  // 地板类型（0 = 无私）
    var isFloor = new Uint8Array(W * H);
    var errors = [];

    function idx(x, y) { return y * W + x; }
    function inb(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }

    // 1. 画区域
    AREAS.forEach(function (a) {
      for (var y = a.y; y < a.y + a.h; y++) {
        for (var x = a.x; x < a.x + a.w; x++) {
          if (!inb(x, y)) { errors.push('区域越界: ' + a.name + ' @' + x + ',' + y); continue; }
          isFloor[idx(x, y)] = 1;
          floorType[idx(x, y)] = a.floor;
        }
      }
    });

    // 2. 挖门洞
    var doors = [];
    DOORS.forEach(function (d) {
      var x = d[0], y = d[1];
      if (!inb(x, y)) { errors.push('门越界 @' + x + ',' + y); return; }
      if (isFloor[idx(x, y)]) errors.push('门原本就是地板 @' + x + ',' + y);
      isFloor[idx(x, y)] = 1;
      floorType[idx(x, y)] = F_WOOD;
      // 判断朝向：左右是地板 → 'ew'（东西向通行，门在南北向的墙上）
      var l = inb(x - 1, y) && isFloor[idx(x - 1, y)];
      var r = inb(x + 1, y) && isFloor[idx(x + 1, y)];
      var u = inb(x, y - 1) && isFloor[idx(x, y - 1)];
      var dn = inb(x, y + 1) && isFloor[idx(x, y + 1)];
      var dir = (l || r) && (u || dn) ? 'cross' : (l || r) ? 'ew' : (u || dn) ? 'ns' : 'none';
      if (dir === 'none' || dir === 'cross') errors.push('门洞不连通 @' + x + ',' + y + ' dir=' + dir);
      doors.push({ x: x, y: y, dir: dir });
    });

    // 3. 生成墙体：贴着地板的空格 = 墙；其余为虚空中（不绘制）
    var wall = new Uint8Array(W * H);
    for (var y2 = 0; y2 < H; y2++) {
      for (var x2 = 0; x2 < W; x2++) {
        if (isFloor[idx(x2, y2)]) continue;
        var touch = false;
        for (var dy = -1; dy <= 1 && !touch; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x2 + dx, ny = y2 + dy;
            if (inb(nx, ny) && isFloor[idx(nx, ny)]) { touch = true; break; }
          }
        }
        if (touch) wall[idx(x2, y2)] = 1;
      }
    }

    // 4. 碰撞表
    for (var i = 0; i < W * H; i++) {
      solid[i] = isFloor[i] ? 0 : 1;
    }

    var level = {
      W: W, H: H, TILE: TILE,
      isFloor: isFloor,
      wall: wall,
      solid: solid,
      floorType: floorType,
      doors: doors,
      areas: AREAS.map(function (a) { return { name: a.name, x: a.x, y: a.y, w: a.w, h: a.h }; }),
      hideSpots: HIDE_SPOTS.map(function (h) { return { x: h.x, y: h.y, type: h.type }; }),
      breakers: BREAKERS.map(function (b) {
        return { id: b.id, name: b.name, room: b.room, x: b.x, y: b.y, lights: b.lights, on: false };
      }),
      notes: NOTES.map(function (n, k) { return { id: 'n' + k, x: n.x, y: n.y, title: n.title, text: n.text }; }),
      pickups: PICKUPS.map(function (p, k) {
        return { id: 'p' + k, type: p.type, x: p.x, y: p.y, amount: p.amount };
      }),
      patrolNodes: PATROL_NODES.map(function (p) { return { x: p[0], y: p[1] }; }),
      decor: DECOR.map(function (d) { return { x: d.x, y: d.y, type: d.type }; }),
      windows: WINDOWS.map(function (w) { return { x: w[0], y: w[1] }; }),
      playerSpawn: { x: 30, y: 41 },
      monsterSpawn: { x: 30, y: 5 },
      gate: { x: 30, y: 43 },
      lights: [],
      errors: errors
    };

    // 所有灯具（初始断电，合闸后亮起）
    level.breakers.forEach(function (b) {
      b.lights.forEach(function (l) { level.lights.push({ x: l.x, y: l.y, r: l.r, breaker: b.id }); });
    });

    validate(level);
    return level;
  }

  // ------------------------------------------------------------------
  // 连通性校验：从出生点 BFS，确认所有关键点可达
  // ------------------------------------------------------------------
  function validate(level) {
    var W = level.W, H = level.H;
    var idx = function (x, y) { return y * W + x; };
    var seen = new Uint8Array(W * H);
    var q = [];
    var s = level.playerSpawn;
    if (level.solid[idx(s.x, s.y)]) { level.errors.push('出生点在墙里'); return; }
    seen[idx(s.x, s.y)] = 1;
    q.push([s.x, s.y]);
    var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (q.length) {
      var p = q.shift();
      for (var d = 0; d < 4; d++) {
        var nx = p[0] + DIRS[d][0], ny = p[1] + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var k = idx(nx, ny);
        if (seen[k] || level.solid[k]) continue;
        seen[k] = 1;
        q.push([nx, ny]);
      }
    }
    level.reachable = seen;

    function check(pt, label) {
      if (!pt) return;
      var x = pt.x, y = pt.y;
      if (x < 0 || y < 0 || x >= W || y >= H) { level.errors.push(label + ' 越界 @' + x + ',' + y); return; }
      if (level.solid[idx(x, y)]) { level.errors.push(label + ' 在墙里 @' + x + ',' + y); return; }
      if (!seen[idx(x, y)]) level.errors.push(label + ' 不可达 @' + x + ',' + y);
    }
    check(level.gate, '南门');
    check(level.monsterSpawn, '怪物出生点');
    level.breakers.forEach(function (b) { check(b, '电闸 ' + b.id); });
    level.notes.forEach(function (n) { check(n, '笔记 ' + n.id); });
    level.pickups.forEach(function (p2) { check(p2, '拾取物 ' + p2.id); });
    level.hideSpots.forEach(function (h, k) { check(h, '躲藏点#' + k + ' ' + h.type); });
    level.patrolNodes.forEach(function (p3, k) { check(p3, '巡逻点#' + k); });
    level.decor.forEach(function (dc, k) {
      var kk = idx(dc.x, dc.y);
      if (level.solid[kk]) level.errors.push('装饰在墙里 ' + dc.type + ' @' + dc.x + ',' + dc.y);
    });
    if (level.errors.length) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[level] 校验发现问题 ' + level.errors.length + ' 个：\n' + level.errors.join('\n'));
      }
    }
    return level.errors;
  }

  // ------------------------------------------------------------------
  // 导出
  // ------------------------------------------------------------------
  var api = {
    build: build,
    AREAS: AREAS,
    BREAKERS: BREAKERS,
    NOTES: NOTES,
    HIDE_SPOTS: HIDE_SPOTS,
    PATROL_NODES: PATROL_NODES,
    PICKUPS: PICKUPS,
    DECOR: DECOR,
    WINDOWS: WINDOWS,
    DOORS: DOORS,
    W: W, H: H, TILE: TILE,
    F_VOID: F_VOID, F_CONCRETE: F_CONCRETE, F_TILE: F_TILE,
    F_WOOD: F_WOOD, F_STONE: F_STONE, F_METAL: F_METAL
  };

  root.BlindHuntLevel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
