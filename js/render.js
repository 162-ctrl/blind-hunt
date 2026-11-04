/* =========================================================================
 * js/render.js — 《盲猎》渲染层
 * -------------------------------------------------------------------------
 * 依赖：js/level.js、js/game.js（BH 命名空间）
 * 全局：BH.Render.draw(ctx, dt)
 *
 * 渲染管线：
 *   1. 预渲染静态地图（地板 / 墙 / 门 / 窗 / 装饰 / 家具）到离屏 canvas，只生成一次
 *   2. 每帧绘制静态层 + 动态对象（玩家 / 盲怪 / 电闸 / 纸条 / 投石 / 南门）
 *   3. 屏幕空间光照遮罩：环境光 + 手电锥形光 + 电闸灯 + 闪电，全部做遮挡射线
 *   4. 声呐涟漪、危险红晕、颗粒噪点、暗角
 *   5. 死亡特写：盲怪的脸
 * ========================================================================= */
(function () {
  'use strict';

  var BH = window.BH;
  var TILE = 48;
  var TAU = Math.PI * 2;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }

  function hash2(x, y, s) {
    var h = (x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 144269;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  // ---------- 离屏画布 ----------
  var staticCanvas = null;
  var staticCtx = null;
  var lightCanvas = document.createElement('canvas');
  var lightCtx = lightCanvas.getContext('2d');
  var grainCanvas = document.createElement('canvas');
  var grainPattern = null;

  function makeGrain() {
    grainCanvas.width = 160;
    grainCanvas.height = 160;
    var g = grainCanvas.getContext('2d');
    var img = g.createImageData(160, 160);
    for (var i = 0; i < img.data.length; i += 4) {
      var v = (Math.random() * 255) | 0;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 18 + ((Math.random() * 34) | 0);
    }
    g.putImageData(img, 0, 0);
  }

  // =======================================================================
  //  调色 / 基础绘制
  // =======================================================================
  var FLOOR_BASE = {
    1: [26, 28, 32],   // 水泥
    2: [32, 36, 41],   // 瓷砖
    3: [30, 24, 18],   // 木
    4: [25, 27, 30],   // 石
    5: [27, 32, 36]    // 铁
  };

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  function shade(c, d) {
    return [clamp(c[0] + d, 0, 255), clamp(c[1] + d, 0, 255), clamp(c[2] + d, 0, 255)];
  }

  function noiseDots(g, x, y, n, seed, light) {
    for (var i = 0; i < n; i++) {
      var rx = hash2(x * 7 + i, y * 13 + i * 3, seed) * TILE;
      var ry = hash2(x * 11 + i * 5, y * 7 + i, seed + 1) * TILE;
      var rr = 0.5 + hash2(i, x + y, seed + 2) * 1.6;
      g.fillStyle = 'rgba(' + (light ? '255,255,255' : '0,0,0') + ',' + (light ? 0.022 : 0.10 + hash2(i, 3, 4) * 0.1) + ')';
      g.beginPath();
      g.arc(x * TILE + rx, y * TILE + ry, rr, 0, TAU);
      g.fill();
    }
  }

  function drawFloorTile(g, tx, ty, type) {
    var x = tx * TILE, y = ty * TILE;
    var base = FLOOR_BASE[type] || FLOOR_BASE[1];
    var v = (hash2(tx, ty, 3) - 0.5) * 7;
    var c = shade(base, v);
    g.fillStyle = 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
    g.fillRect(x, y, TILE + 1, TILE + 1);

    if (type === 2) {
      // 瓷砖：砖缝 + 高光
      g.strokeStyle = 'rgba(0,0,0,0.32)';
      g.lineWidth = 2;
      g.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
      g.strokeStyle = 'rgba(255,255,255,0.025)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x + 2, y + 2); g.lineTo(x + TILE - 2, y + 2);
      g.moveTo(x + 2, y + 2); g.lineTo(x + 2, y + TILE - 2);
      g.stroke();
      if (hash2(tx, ty, 21) < 0.16) {
        // 裂纹
        g.strokeStyle = 'rgba(0,0,0,0.35)';
        g.lineWidth = 1;
        g.beginPath();
        var cx = x + hash2(tx, ty, 22) * TILE, cy = y + hash2(tx, ty, 23) * TILE;
        g.moveTo(cx, cy);
        g.lineTo(cx + (hash2(tx, ty, 24) - 0.5) * 26, cy + (hash2(tx, ty, 25) - 0.5) * 26);
        g.stroke();
      }
    } else if (type === 3) {
      // 木地板
      g.strokeStyle = 'rgba(0,0,0,0.22)';
      g.lineWidth = 1;
      var off = (hash2(tx, ty, 31) * 8) | 0;
      for (var ly = 0; ly < TILE; ly += 11) {
        g.beginPath();
        g.moveTo(x, y + ly + off);
        g.lineTo(x + TILE, y + ly + off);
        g.stroke();
      }
      g.strokeStyle = 'rgba(255,255,255,0.02)';
      g.beginPath();
      g.moveTo(x, y + off + 1); g.lineTo(x + TILE, y + off + 1);
      g.stroke();
      // 板缝
      g.strokeStyle = 'rgba(0,0,0,0.18)';
      g.beginPath();
      var jx = x + hash2(tx, ty, 32) * TILE;
      g.moveTo(jx, y); g.lineTo(jx, y + TILE);
      g.stroke();
      if (hash2(tx, ty, 33) < 0.18) {
        g.fillStyle = 'rgba(0,0,0,0.16)';
        g.beginPath();
        g.ellipse(x + TILE * 0.5, y + TILE * 0.5, TILE * 0.42, TILE * 0.3, hash2(tx, ty, 34) * 3, 0, TAU);
        g.fill();
      }
    } else if (type === 4) {
      // 石砖
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 1.5;
      var rowOff = (ty % 2) * 24;
      g.beginPath();
      g.moveTo(x, y + 24); g.lineTo(x + TILE, y + 24);
      g.moveTo(x + rowOff, y); g.lineTo(x + rowOff, y + 24);
      g.moveTo(x + 24 - rowOff, y + 24); g.lineTo(x + 24 - rowOff, y + TILE);
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.018)';
      g.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
    } else if (type === 5) {
      // 铁板
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 1.5;
      g.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
      g.fillStyle = 'rgba(0,0,0,0.22)';
      for (var rx = 0; rx < 2; rx++) {
        for (var ry = 0; ry < 2; ry++) {
          g.beginPath();
          g.arc(x + 8 + rx * (TILE - 16), y + 8 + ry * (TILE - 16), 1.6, 0, TAU);
          g.fill();
        }
      }
    } else {
      // 水泥：伸缩缝
      if (hash2(tx, ty, 41) < 0.1) {
        g.strokeStyle = 'rgba(0,0,0,0.28)';
        g.lineWidth = 1.5;
        g.beginPath();
        if (tx % 2 === 0) { g.moveTo(x + TILE * 0.5, y); g.lineTo(x + TILE * 0.5, y + TILE); }
        else { g.moveTo(x, y + TILE * 0.5); g.lineTo(x + TILE, y + TILE * 0.5); }
        g.stroke();
      }
    }
    noiseDots(g, tx, ty, 5, 7, false);

    // 血迹 / 水渍
    if (hash2(tx, ty, 51) < 0.085) {
      g.fillStyle = 'rgba(0,0,0,0.24)';
      g.beginPath();
      g.ellipse(
        x + TILE * (0.25 + hash2(tx, ty, 52) * 0.5),
        y + TILE * (0.25 + hash2(tx, ty, 53) * 0.5),
        TILE * (0.15 + hash2(tx, ty, 54) * 0.2),
        TILE * (0.1 + hash2(tx, ty, 55) * 0.14),
        hash2(tx, ty, 56) * TAU, 0, TAU);
      g.fill();
    }
  }

  function drawWallTile(g, tx, ty) {
    var x = tx * TILE, y = ty * TILE;
    var v = (hash2(tx, ty, 61) - 0.5) * 6;
    var c = shade([33, 36, 42], v);
    g.fillStyle = 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
    g.fillRect(x, y, TILE + 1, TILE + 1);
    noiseDots(g, tx, ty, 7, 63, false);
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, TILE, TILE);
    // 墙脚阴影 / 顶部高光：依据与地板的相邻关系
    if (LV && LV.isFloor[(ty + 1) * LV.W + tx]) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x, y + TILE - 5, TILE, 5);
      g.fillStyle = 'rgba(255,255,255,0.03)';
      g.fillRect(x, y + TILE - 7, TILE, 2);
    }
    if (LV && LV.isFloor[(ty - 1) * LV.W + tx]) {
      g.fillStyle = 'rgba(255,255,255,0.02)';
      g.fillRect(x, y, TILE, 3);
    }
    if (LV && LV.isFloor[ty * LV.W + tx + 1]) {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(x + TILE - 4, y, 4, TILE);
    }
    if (LV && LV.isFloor[ty * LV.W + tx - 1]) {
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(x, y, 4, TILE);
    }
  }

  // 地板贴墙的环境光遮蔽
  function drawFloorAO(g, tx, ty) {
    var x = tx * TILE, y = ty * TILE;
    function dark(sx, sy, w, h) {
      var gr = g.createLinearGradient(x + sx, y + sy, x + sx + w, y + sy + h);
      gr.addColorStop(0, 'rgba(0,0,0,0.38)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(x + Math.min(sx, sx + w), y + Math.min(sy, sy + h), Math.abs(w), Math.abs(h));
    }
    if (LV.solid[(ty - 1) * LV.W + tx]) dark(0, 0, 0, 14);
    if (LV.solid[(ty + 1) * LV.W + tx]) dark(0, TILE, 0, -14);
    if (LV.solid[ty * LV.W + tx - 1]) dark(0, 0, 14, 0);
    if (LV.solid[ty * LV.W + tx + 1]) dark(TILE, 0, -14, 0);
  }

  var LV = null;

  // =======================================================================
  //  静态层构建
  // =======================================================================
  function buildStatic() {
    LV = BH.level;
    var W = LV.W, H = LV.H;
    staticCanvas = document.createElement('canvas');
    staticCanvas.width = W * TILE;
    staticCanvas.height = H * TILE;
    var g = staticCtx = staticCanvas.getContext('2d');
    g.fillStyle = '#05060a';
    g.fillRect(0, 0, staticCanvas.width, staticCanvas.height);

    var x, y;

    // ---- 地板 ----
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        if (LV.isFloor[y * W + x]) drawFloorTile(g, x, y, LV.floorType[y * W + x]);
      }
    }
    // ---- 地板 AO ----
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        if (LV.isFloor[y * W + x]) drawFloorAO(g, x, y);
      }
    }
    // ---- 门洞 ----
    LV.doors.forEach(function (d) { drawDoor(g, d); });
    // ---- 墙 ----
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        if (LV.wall[y * W + x]) drawWallTile(g, x, y);
      }
    }
    // ---- 窗 ----
    LV.windows.forEach(function (w) { drawWindow(g, w.x, w.y); });
    // ---- 装饰 ----
    LV.decor.forEach(function (d) { drawDecor(g, d); });
    // ---- 躲藏家具 ----
    LV.hideSpots.forEach(function (h) { drawHideSpot(g, h); });
  }

  function drawDoor(g, d) {
    var x = d.x * TILE, y = d.y * TILE;
    // 木质门槛
    g.fillStyle = '#241b13';
    g.fillRect(x, y, TILE + 1, TILE + 1);
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 1;
    for (var i = 0; i < 4; i++) {
      g.beginPath();
      g.moveTo(x, y + i * 12 + 4);
      g.lineTo(x + TILE, y + i * 12 + 4);
      g.stroke();
    }
    // 门框立柱
    g.fillStyle = '#141518';
    if (d.dir === 'ew') {
      g.fillRect(x, y - 1, TILE + 1, 6);
      g.fillRect(x, y + TILE - 5, TILE + 1, 6);
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(x + 3, y + 7, TILE - 6, 2);
    } else {
      g.fillRect(x - 1, y, 6, TILE + 1);
      g.fillRect(x + TILE - 5, y, 6, TILE + 1);
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(x + 7, y + 3, 2, TILE - 6);
    }
  }

  function drawWindow(g, tx, ty) {
    var x = tx * TILE, y = ty * TILE;
    if (!LV.wall[ty * LV.W + tx] && LV.solid[ty * LV.W + tx]) { /* 仍是墙 */ }
    var east = LV.isFloor[ty * LV.W + tx + 1];
    g.save();
    g.fillStyle = '#0c1016';
    if (east) {
      // 竖向窗（东侧贴地板）
      g.fillRect(x + TILE - 16, y + 5, 10, TILE - 10);
      g.fillStyle = '#1d2b3d';
      g.fillRect(x + TILE - 14, y + 7, 6, TILE - 14);
      g.strokeStyle = '#0a0d12';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x + TILE - 11, y + 8); g.lineTo(x + TILE - 11, y + TILE - 8);
      g.stroke();
      g.fillStyle = 'rgba(120,160,220,0.06)';
      g.fillRect(x + TILE - 24, y + 6, 8, TILE - 12);
    } else {
      g.fillRect(x + 5, y + TILE - 16, TILE - 10, 10);
      g.fillStyle = '#1d2b3d';
      g.fillRect(x + 7, y + TILE - 14, TILE - 14, 6);
      g.strokeStyle = '#0a0d12';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x + 8, y + TILE - 11); g.lineTo(x + TILE - 8, y + TILE - 11);
      g.stroke();
      g.fillStyle = 'rgba(120,160,220,0.06)';
      g.fillRect(x + 6, y + TILE - 24, TILE - 12, 8);
    }
    g.restore();
  }

  // ---- 家具 / 装饰 ----
  function drawHideSpot(g, h) {
    var x = h.x * TILE + TILE / 2, y = h.y * TILE + TILE / 2;
    // 家具下阴影
    g.fillStyle = 'rgba(0,0,0,0.42)';
    g.beginPath();
    g.ellipse(x, y + 9, 25, 12, 0, 0, TAU);
    g.fill();
    g.save();
    g.translate(x, y);
    if (h.type === 'bed') {
      g.fillStyle = '#1b1e22';
      roundRect(g, -23, -16, 46, 32, 4); g.fill();
      g.fillStyle = '#31363d';
      roundRect(g, -20, -13, 40, 24, 3); g.fill();
      g.fillStyle = '#40464e';
      roundRect(g, -18, -11, 22, 12, 2); g.fill();   // 枕头
      g.fillStyle = 'rgba(120,124,130,0.35)';
      roundRect(g, -16, 3, 34, 8, 2); g.fill();      // 毯子
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 1.5;
      roundRect(g, -23, -16, 46, 32, 4); g.stroke();
    } else if (h.type === 'wardrobe') {
      g.fillStyle = '#20180f';
      roundRect(g, -16, -21, 32, 42, 3); g.fill();
      g.fillStyle = '#2b2015';
      roundRect(g, -14, -19, 28, 38, 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(0, -19); g.lineTo(0, 19); g.stroke();
      g.fillStyle = '#3b3f45';
      g.beginPath(); g.arc(-2.5, 3, 1.4, 0, TAU); g.fill();
      g.beginPath(); g.arc(2.5, 3, 1.4, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.03)';
      g.beginPath(); g.moveTo(-13, -18); g.lineTo(13, -18); g.stroke();
    } else if (h.type === 'locker') {
      g.fillStyle = '#1c2226';
      roundRect(g, -14, -19, 28, 38, 2); g.fill();
      g.fillStyle = '#262e34';
      roundRect(g, -12, -17, 24, 34, 1); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      for (var i = 0; i < 4; i++) {
        g.beginPath();
        g.moveTo(-9, -12 + i * 4); g.lineTo(9, -12 + i * 4);
        g.stroke();
      }
      g.fillStyle = '#3a4046';
      g.fillRect(8, -2, 3, 6);
    } else if (h.type === 'pew') {
      g.fillStyle = '#1f1811';
      roundRect(g, -23, -8, 46, 16, 2); g.fill();
      g.fillStyle = '#2b2117';
      roundRect(g, -21, -6, 42, 10, 1); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.beginPath(); g.moveTo(-21, -1); g.lineTo(21, -1); g.stroke();
      g.fillStyle = '#1a140e';
      g.fillRect(-20, 4, 4, 5);
      g.fillRect(16, 4, 4, 5);
    } else {
      // 办公桌
      g.fillStyle = '#1d1712';
      roundRect(g, -19, -13, 38, 26, 2); g.fill();
      g.fillStyle = '#2a2118';
      roundRect(g, -17, -11, 34, 20, 1); g.fill();
      g.fillStyle = 'rgba(180,180,170,0.10)';
      g.fillRect(-14, -8, 12, 8);
      g.fillRect(2, -5, 9, 6);
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 1.5;
      roundRect(g, -19, -13, 38, 26, 2); g.stroke();
    }
    g.restore();
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawDecor(g, d) {
    var x = d.x * TILE + TILE / 2, y = d.y * TILE + TILE / 2;
    g.save();
    g.translate(x, y);
    if (d.type === 'gurney') {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.ellipse(0, 8, 22, 10, 0, 0, TAU); g.fill();
      g.fillStyle = '#2e343a';
      roundRect(g, -21, -12, 42, 22, 3); g.fill();
      g.fillStyle = '#3d444c';
      roundRect(g, -19, -10, 38, 16, 2); g.fill();
      g.fillStyle = '#1b1f23';
      g.beginPath(); g.arc(-15, 11, 3, 0, TAU); g.fill();
      g.beginPath(); g.arc(15, 11, 3, 0, TAU); g.fill();
    } else if (d.type === 'blood') {
      g.fillStyle = 'rgba(58,12,12,0.5)';
      g.beginPath();
      for (var i = 0; i < 7; i++) {
        var a = i / 7 * TAU;
        var r = 8 + hash2(d.x, d.y, i) * 9;
        if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(80,16,14,0.35)';
      g.beginPath(); g.ellipse(2, 1, 5, 4, 0.4, 0, TAU); g.fill();
    } else if (d.type === 'chair') {
      g.fillStyle = '#211a12';
      g.fillRect(-8, -8, 16, 15);
      g.fillRect(-8, -12, 16, 5);
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.strokeRect(-8, -8, 16, 15);
    } else if (d.type === 'table') {
      g.fillStyle = '#231b13';
      roundRect(g, -14, -10, 28, 20, 2); g.fill();
      g.fillStyle = '#2f2419';
      roundRect(g, -12, -8, 24, 16, 1); g.fill();
    } else if (d.type === 'box') {
      g.fillStyle = '#2a2117';
      g.fillRect(-11, -11, 22, 22);
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      g.strokeRect(-11, -11, 22, 22);
      g.strokeStyle = 'rgba(180,170,140,0.12)';
      g.beginPath(); g.moveTo(-11, -2); g.lineTo(11, -2); g.moveTo(-11, 4); g.lineTo(11, 4); g.stroke();
    } else if (d.type === 'papers') {
      g.fillStyle = 'rgba(190,188,175,0.18)';
      g.save(); g.rotate(hash2(d.x, d.y, 3) * TAU);
      g.fillRect(-9, -6, 18, 12);
      g.rotate(0.4); g.fillRect(-6, -8, 14, 10);
      g.restore();
    } else if (d.type === 'candle') {
      g.fillStyle = 'rgba(255,190,110,0.16)';
      g.beginPath(); g.arc(0, 0, 14, 0, TAU); g.fill();
      g.fillStyle = '#3a3021';
      g.fillRect(-4, -2, 8, 10);
      g.fillStyle = '#ffcf8a';
      g.beginPath(); g.ellipse(0, -5, 2.4, 4, 0, 0, TAU); g.fill();
    } else if (d.type === 'pipes') {
      g.strokeStyle = '#2c3238';
      g.lineWidth = 5;
      g.beginPath(); g.moveTo(-22, -6); g.lineTo(22, -6); g.stroke();
      g.beginPath(); g.moveTo(-22, 8); g.lineTo(22, 8); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.05)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(-22, -8); g.lineTo(22, -8); g.stroke();
    } else if (d.type === 'debris') {
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.ellipse(0, 4, 16, 8, 0, 0, TAU); g.fill();
      g.fillStyle = 'rgba(60,62,66,0.8)';
      for (var j = 0; j < 6; j++) {
        g.fillRect((hash2(d.x, d.y, j) - 0.5) * 26, (hash2(d.x, d.y, j + 9) - 0.5) * 20, 3 + hash2(j, d.x, 2) * 7, 2 + hash2(j, d.y, 5) * 4);
      }
    }
    g.restore();
  }

  // =======================================================================
  //  每帧渲染
  // =======================================================================
  function draw(ctx, dt) {
    var v = BH.view;
    var S = BH.S;
    if (!v || !S) return;
    if (!staticCanvas) {
      try { buildStatic(); } catch (e) { staticCanvas = null; }
      if (!grainPattern) { makeGrain(); grainPattern = ctx.createPattern(grainCanvas, 'repeat'); }
    }
    var p = BH.player, m = BH.monster;

    ensureLightSize(v);

    ctx.save();
    ctx.fillStyle = '#040508';
    ctx.fillRect(0, 0, v.w, v.h);

    if (S.mode === 'title' || !p || !m) {
      drawTitle(ctx, dt);
      ctx.restore();
      return;
    }

    var z = v.zoom || 1;
    var shakeX = BH.cameraShakeX || 0, shakeY = BH.cameraShakeY || 0;

    // ---------- 世界层 ----------
    ctx.save();
    ctx.translate(v.w / 2 - BH.camera.x * z + shakeX, v.h / 2 - BH.camera.y * z + shakeY);
    ctx.scale(z, z);

    if (staticCanvas) ctx.drawImage(staticCanvas, 0, 0);
    drawGate(ctx);
    drawBreakers(ctx);
    drawNotes(ctx);
    drawPickups(ctx);
    drawProjectiles(ctx);
    drawDust(ctx);
    if (!p.hidden) drawPlayer(ctx, p, S);
    drawMonster(ctx, m, S);
    ctx.restore();

    // ---------- 光照 ----------
    drawLighting(ctx, p, m, S);

    // ---------- 屏幕空间叠加 ----------
    drawRipples(ctx, S);
    drawListeningRing(ctx, p, S);
    drawSonar(ctx, p, S);
    drawDanger(ctx, S);
    drawLightningOverlay(ctx, S);
    drawVignette(ctx, S);
    drawGrain(ctx, S);
    drawAim(ctx, S);

    if (S.mode === 'dying' || S.mode === 'dead') drawDeathCloseUp(ctx, S);
    if (S.mode === 'winning' || S.mode === 'won') drawWinFlash(ctx, S);

    ctx.restore();
  }

  function ensureLightSize(v) {
    if (lightCanvas.width !== Math.max(1, Math.floor(v.w)) || lightCanvas.height !== Math.max(1, Math.floor(v.h))) {
      lightCanvas.width = Math.max(1, Math.floor(v.w));
      lightCanvas.height = Math.max(1, Math.floor(v.h));
    }
  }

  // ---------- 动态物 ----------
  function drawGate(ctx) {
    var g = BH.level.gate;
    var S = BH.S;
    var x = (g.x + 0.5) * TILE, y = (g.y + 0.9) * TILE;
    var w = TILE * 3.4, h = TILE * 1.05;
    ctx.save();
    ctx.translate(x, y);
    // 门框
    ctx.fillStyle = '#15181c';
    ctx.fillRect(-w / 2 - 6, -h / 2 - 4, w + 12, h + 8);
    ctx.fillStyle = '#2b3138';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    // 两扇铁门
    ctx.fillStyle = '#333a42';
    ctx.fillRect(-w / 2 + 3, -h / 2 + 3, w / 2 - 5, h - 6);
    ctx.fillRect(2, -h / 2 + 3, w / 2 - 5, h - 6);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-w / 2 + 3, -h / 2 + 3, w / 2 - 5, h - 6);
    ctx.strokeRect(2, -h / 2 + 3, w / 2 - 5, h - 6);
    // 横向加强筋
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 4, -h / 4); ctx.lineTo(w / 2 - 4, -h / 4);
    ctx.moveTo(-w / 2 + 4, h / 4); ctx.lineTo(w / 2 - 4, h / 4);
    ctx.stroke();
    // 电锁：三颗指示灯
    for (var i = 0; i < 3; i++) {
      var lx = -22 + i * 22;
      var on = !!S.powerOn['B' + (i + 1)];
      ctx.fillStyle = on ? '#7dffb0' : '#ff5a4a';
      ctx.shadowColor = on ? '#4dff9a' : '#ff3a2a';
      ctx.shadowBlur = on ? 12 : 7;
      ctx.beginPath();
      ctx.arc(lx, 0, 3.4, 0, TAU);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    // 解锁后门缝发光
    if (S.gateUnlocked) {
      ctx.fillStyle = 'rgba(160,220,255,0.25)';
      ctx.fillRect(-1.5, -h / 2 + 4, 3, h - 8);
    }
    ctx.restore();
  }

  function drawBreakers(ctx) {
    var S = BH.S;
    BH.breakers.forEach(function (b) {
      var x = (b.x + 0.5) * TILE, y = (b.y + 0.5) * TILE;
      ctx.save();
      ctx.translate(x, y);
      // 阴影
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath(); ctx.ellipse(0, 13, 19, 8, 0, 0, TAU); ctx.fill();
      // 铁柜
      ctx.fillStyle = '#22282d';
      roundRect(ctx, -17, -20, 34, 40, 3); ctx.fill();
      ctx.fillStyle = '#2e363d';
      roundRect(ctx, -14, -17, 28, 30, 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 2;
      roundRect(ctx, -17, -20, 34, 40, 3); ctx.stroke();
      // 仪表
      ctx.fillStyle = '#0d1012';
      ctx.fillRect(-10, -14, 20, 9);
      if (b.on) {
        ctx.fillStyle = 'rgba(125,255,176,0.55)';
        ctx.fillRect(-8, -12, 16, 2);
        ctx.fillRect(-8, -8, 10, 2);
      } else {
        ctx.fillStyle = 'rgba(255,90,74,0.5)';
        ctx.fillRect(-8, -12, 5, 2);
      }
      // 拉杆
      ctx.strokeStyle = b.on ? '#7dffb0' : '#c9a15e';
      ctx.lineWidth = 4;
      ctx.beginPath();
      if (b.on) { ctx.moveTo(0, -2); ctx.lineTo(0, 10); }
      else { ctx.moveTo(0, -2); ctx.lineTo(-7, 7); }
      ctx.stroke();
      if (!b.on) {
        // 未合闸：红色小灯
        ctx.fillStyle = 'rgba(255,90,74,0.75)';
        ctx.beginPath(); ctx.arc(10, 7, 2.4, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(125,255,176,0.9)';
        ctx.beginPath(); ctx.arc(10, 7, 2.4, 0, TAU); ctx.fill();
      }
      ctx.restore();
    });
  }

  function drawNotes(ctx) {
    BH.notes.forEach(function (n) {
      if (n.read) return;
      var x = (n.x + 0.5) * TILE, y = (n.y + 0.5) * TILE;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(hash2(n.x, n.y, 5) * 0.7 - 0.35);
      ctx.fillStyle = 'rgba(212,204,184,0.10)';
      roundRect(ctx, -10, -13, 20, 26, 2); ctx.fill();
      ctx.fillStyle = 'rgba(228,222,204,0.85)';
      roundRect(ctx, -8, -11, 16, 22, 1); ctx.fill();
      ctx.fillStyle = 'rgba(40,38,34,0.55)';
      for (var i = 0; i < 4; i++) ctx.fillRect(-6, -7 + i * 4, 12 - (i === 3 ? 5 : 0), 1.2);
      ctx.restore();
    });
  }

  function drawPickups(ctx) {
    BH.pickups.forEach(function (it) {
      if (it.taken) return;
      var x = (it.x + 0.5) * TILE, y = (it.y + 0.5) * TILE;
      ctx.save();
      ctx.translate(x, y);
      if (it.type === 'stone') {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.ellipse(0, 4, 7, 3, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#6a6f74';
        ctx.beginPath();
        ctx.moveTo(-6, 2); ctx.lineTo(-3, -4); ctx.lineTo(4, -3); ctx.lineTo(6, 3); ctx.lineTo(0, 5);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath(); ctx.moveTo(-3, -4); ctx.lineTo(4, -3); ctx.lineTo(1, -1); ctx.closePath(); ctx.fill();
      } else {
        // 电池
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.ellipse(0, 5, 9, 3, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#2b3a2f';
        roundRect(ctx, -5, -10, 10, 18, 2); ctx.fill();
        ctx.fillStyle = '#4f7a5c';
        roundRect(ctx, -4, -9, 8, 16, 1); ctx.fill();
        ctx.fillStyle = '#8fd6a6';
        ctx.fillRect(-2.5, -12, 5, 3);
        ctx.fillStyle = 'rgba(143,214,166,0.22)';
        ctx.beginPath(); ctx.arc(0, -1, 9, 0, TAU); ctx.fill();
      }
      ctx.restore();
    });
  }

  function drawProjectiles(ctx) {
    BH.projectiles.forEach(function (pr) {
      var x = pr.x * TILE, y = pr.y * TILE;
      ctx.save();
      ctx.strokeStyle = 'rgba(200,200,190,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - pr.vx * 1.6, y - pr.vy * 1.6);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = '#8a8f93';
      ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fill();
      ctx.restore();
    });
  }

  function drawDust(ctx) {
    var S = BH.S;
    if (!S || !BH.env) return;
    ctx.fillStyle = 'rgba(200,205,215,0.10)';
    for (var i = 0; i < BH.env.dust.length; i++) {
      var d = BH.env.dust[i];
      ctx.beginPath();
      ctx.arc(d.x * TILE, d.y * TILE, d.r, 0, TAU);
      ctx.fill();
    }
  }

  // ---------- 玩家 ----------
  function drawPlayer(ctx, p, S) {
    var x = p.x * TILE, y = p.y * TILE;
    var t = p.animT;
    var moving = p.moveState !== 'idle';
    var speed = p.moveState === 'sprint' ? 16 : p.moveState === 'sneak' ? 6 : 10;
    var bob = moving ? Math.sin(t * speed) * 1.4 : Math.sin(t * 2.1) * 0.8;

    ctx.save();
    ctx.translate(x, y);

    // 影子
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(0, 6, 12, 6, 0, 0, TAU);
    ctx.fill();

    ctx.rotate(p.dir + Math.PI / 2);
    ctx.translate(0, bob);

    // 冲刺残影
    if (p.moveState === 'sprint') {
      ctx.fillStyle = 'rgba(150,170,190,0.06)';
      ctx.beginPath(); ctx.ellipse(0, 9, 9, 14, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(150,170,190,0.04)';
      ctx.beginPath(); ctx.ellipse(0, 18, 8, 13, 0, 0, TAU); ctx.fill();
    }

    // 大衣
    ctx.fillStyle = '#1f242b';
    ctx.beginPath();
    ctx.ellipse(0, 2, 9.5, 13, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#293039';
    ctx.beginPath();
    ctx.ellipse(0, -1, 7.5, 9.5, 0, 0, TAU);
    ctx.fill();
    // 肩线
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-8, 0); ctx.quadraticCurveTo(0, -5, 8, 0);
    ctx.stroke();

    // 腿（走动摆动）
    var legSwing = moving ? Math.sin(t * speed) * 4 : 0;
    ctx.strokeStyle = '#161a1f';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(-4, 9); ctx.lineTo(-4 - legSwing * 0.4, 17 + legSwing);
    ctx.moveTo(4, 9); ctx.lineTo(4 + legSwing * 0.4, 17 - legSwing);
    ctx.stroke();

    // 头 / 兜帽
    ctx.fillStyle = '#2c333c';
    ctx.beginPath(); ctx.arc(0, -7, 7, 0, TAU); ctx.fill();
    ctx.fillStyle = '#8c7962';
    ctx.beginPath(); ctx.arc(0, -8.5, 4.4, 0, TAU); ctx.fill();
    ctx.fillStyle = '#1b2027';
    ctx.beginPath(); ctx.arc(0, -11, 4.8, Math.PI * 0.95, Math.PI * 2.05); ctx.fill();

    // 手臂 + 手电
    ctx.strokeStyle = '#232a32';
    ctx.lineWidth = 4;
    var armSwing = moving ? Math.sin(t * speed + 1) * 3 : 0;
    ctx.beginPath();
    ctx.moveTo(-8, -2); ctx.lineTo(-11, -12 - armSwing * 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(8, -2); ctx.lineTo(11, -13 + armSwing * 0.5);
    ctx.stroke();
    if (p.flashlightOn && p.battery > 0) {
      ctx.fillStyle = '#d8c9a8';
      ctx.fillRect(9, -17 + armSwing * 0.5, 4, 6);
      ctx.fillStyle = 'rgba(255,240,200,0.5)';
      ctx.beginPath();
      ctx.arc(11, -18 + armSwing * 0.5, 2.2, 0, TAU);
      ctx.fill();
    } else {
      ctx.fillStyle = '#8c7962';
      ctx.beginPath(); ctx.arc(11, -15 + armSwing * 0.5, 2.4, 0, TAU); ctx.fill();
    }

    // 力竭：身体下沉
    if (p.exhausted) {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(0, 12, 10, 4, 0, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  // ---------- 盲怪 ----------
  function drawMonster(ctx, m, S) {
    var x = m.x * TILE, y = m.y * TILE;
    var t = m.animT;
    var chase = m.state === 'chase';
    var search = m.state === 'search';
    var moving = m.state === 'chase' || m.state === 'investigate' || m.state === 'patrol' || m.state === 'search';
    var stride = moving ? Math.sin(t * (chase ? 11 : 5.5)) : Math.sin(t * 1.6) * 0.4;

    ctx.save();
    ctx.translate(x, y);

    // 追逐时脚下红色光晕
    if (chase) {
      var gr = ctx.createRadialGradient(0, 4, 2, 0, 4, 34);
      gr.addColorStop(0, 'rgba(160,30,24,0.22)');
      gr.addColorStop(1, 'rgba(160,30,24,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(0, 4, 34, 0, TAU); ctx.fill();
    }
    // 影子
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.ellipse(0, 10, 13, 6, 0, 0, TAU); ctx.fill();

    ctx.rotate(m.dir + Math.PI / 2);

    // 腿：细长，反关节感
    ctx.strokeStyle = '#0f1113';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-4, 8); ctx.lineTo(-5 - stride * 2, 20 + stride * 3);
    ctx.moveTo(4, 8); ctx.lineTo(5 + stride * 2, 20 - stride * 3);
    ctx.stroke();

    // 躯干
    ctx.fillStyle = '#15171a';
    ctx.beginPath(); ctx.ellipse(0, 0, 8.5, 15, 0, 0, TAU); ctx.fill();
    // 皮肤质感（苍白）
    ctx.fillStyle = 'rgba(150,144,132,0.22)';
    ctx.beginPath(); ctx.ellipse(0, -1, 5.5, 11, 0, 0, TAU); ctx.fill();
    // 肋骨阴影
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1.2;
    for (var i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(-5, -3 + i * 3.4);
      ctx.quadraticCurveTo(0, -1.5 + i * 3.4, 5, -3 + i * 3.4);
      ctx.stroke();
    }

    // 手臂：过长
    var armSwing = moving ? stride * 5 : Math.sin(t * 2) * 2;
    ctx.strokeStyle = '#1b1d20';
    ctx.lineWidth = 3.4;
    if (chase) {
      // 前伸
      ctx.beginPath();
      ctx.moveTo(-6, -6); ctx.quadraticCurveTo(-13, -16, -8 + armSwing, -26);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(6, -6); ctx.quadraticCurveTo(13, -16, 8 - armSwing, -26);
      ctx.stroke();
      ctx.fillStyle = '#8f8878';
      ctx.beginPath(); ctx.arc(-8 + armSwing, -26, 2.4, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(8 - armSwing, -26, 2.4, 0, TAU); ctx.fill();
      // 爪
      ctx.strokeStyle = 'rgba(160,150,132,0.55)';
      ctx.lineWidth = 1;
      for (var c = 0; c < 2; c++) {
        ctx.beginPath();
        ctx.moveTo(-9 + armSwing + c * 2, -27); ctx.lineTo(-10 + armSwing + c * 2, -31);
        ctx.moveTo(7 - armSwing + c * 2, -27); ctx.lineTo(6 - armSwing + c * 2, -31);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(-6, -4); ctx.quadraticCurveTo(-12, 4, -10, 16 + armSwing);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(6, -4); ctx.quadraticCurveTo(12, 4, 10, 16 - armSwing);
      ctx.stroke();
    }

    // 脖子 + 头（没有眼睛）
    ctx.fillStyle = '#121417';
    ctx.fillRect(-2.5, -22, 5, 8);
    var tilt = search ? Math.sin(t * 1.4) * 0.28 : 0;
    ctx.save();
    ctx.translate(0, -24);
    ctx.rotate(tilt);
    // 头部：苍白，略微前倾拉长
    ctx.fillStyle = '#8e887a';
    ctx.beginPath();
    ctx.ellipse(0, -2, 6.4, 8.6, 0, 0, TAU);
    ctx.fill();
    // 阴影面
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(1.5, -1, 4.4, 6.6, 0, 0, TAU);
    ctx.fill();
    // 没有眼睛 —— 只有两处凹陷
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(-2.6, -5, 1.7, 1.1, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(2.6, -5, 1.7, 1.1, 0, 0, TAU); ctx.fill();
    // 嘴：追逐时张开
    if (chase) {
      ctx.fillStyle = '#2a0d0c';
      ctx.beginPath(); ctx.ellipse(0, 2.4, 2.6, 3.6 + Math.sin(t * 8) * 0.8, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(180,170,150,0.5)';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(-1.8, 1.2); ctx.lineTo(-1.2, 2.6);
      ctx.moveTo(1.8, 1.2); ctx.lineTo(1.2, 2.6); ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(30,24,20,0.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-2, 3.4); ctx.lineTo(2, 3.4); ctx.stroke();
    }
    // 头顶稀疏毛发
    ctx.strokeStyle = 'rgba(10,10,12,0.7)';
    ctx.lineWidth = 0.8;
    for (var h = 0; h < 5; h++) {
      var hx = -3 + h * 1.5;
      ctx.beginPath();
      ctx.moveTo(hx, -9.6);
      ctx.lineTo(hx + (hash2(h, 3, 9) - 0.5) * 3, -12 - hash2(h, 4, 9) * 2);
      ctx.stroke();
    }
    ctx.restore();

    ctx.restore();
  }

  // =======================================================================
  //  光照
  // =======================================================================
  function drawLighting(ctx, p, m, S) {
    var v = BH.view;
    var z = v.zoom || 1;
    var lc = lightCtx;
    var t = S.time;

    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, v.w, v.h);
    lc.fillStyle = '#000';
    lc.fillRect(0, 0, v.w, v.h);
    lc.globalCompositeOperation = 'destination-out';

    // 玩家自身环境光（贴地，小范围，有遮挡）
    if (!p.hidden) {
      var flick = p.battery < 0.18 ? (0.82 + Math.random() * 0.18) : 1;
      omniLight(lc, p.x, p.y, 2.5, 0.92 * flick);
    }

    // 手电锥形光
    if (!p.hidden && p.flashlightOn && p.battery > 0) {
      var intense = 1;
      if (p.battery < 0.25) intense = 0.55 + 0.45 * Math.abs(Math.sin(t * 21 + Math.sin(t * 5.3) * 3));
      if (p.exhausted) intense *= 0.92;
      coneLight(lc, p.x, p.y, p.dir, 0.40, 10.5, intense);
      // 近处补光
      omniLight(lc, p.x, p.y, 1.5, 0.55 * intense);
    }

    // 电闸灯（断电则不亮）
    for (var i = 0; i < BH.level.lights.length; i++) {
      var lt = BH.level.lights[i];
      if (!S.powerOn[lt.breaker]) continue;
      var fl = 0.88 + Math.sin(t * 7.1 + i * 2.3) * 0.05;
      var drop = hash2(Math.floor(t * 6), i, 77);
      if (drop < 0.035) fl *= 0.35;
      omniLight(lc, lt.x + 0.5, lt.y + 0.5, lt.r, 0.86 * fl);
    }

    // 闪电
    var flash = BH.env.lightning.flash;
    if (flash > 0) {
      lc.globalAlpha = clamp(flash, 0, 1) * 0.95;
      lc.fillStyle = '#fff';
      lc.fillRect(0, 0, v.w, v.h);
      lc.globalAlpha = 1;
      // 窗口方向的冷光
      for (var w = 0; w < BH.level.windows.length; w++) {
        var win = BH.level.windows[w];
        omniLight(lc, win.x + 0.5, win.y + 0.5, 5.5, flash * 0.9);
      }
    }

    lc.globalCompositeOperation = 'source-over';
    ctx.drawImage(lightCanvas, 0, 0, v.w, v.h);

    // 暖色灯光染色（只加一点点）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var k = 0; k < BH.level.lights.length; k++) {
      var l2 = BH.level.lights[k];
      if (!S.powerOn[l2.breaker]) continue;
      var sp = BH.worldToScreen(l2.x + 0.5, l2.y + 0.5);
      var rp = l2.r * TILE * z;
      var g2 = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, rp);
      g2.addColorStop(0, 'rgba(201,161,94,0.055)');
      g2.addColorStop(1, 'rgba(201,161,94,0)');
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, rp, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function omniLight(lc, wx, wy, rTiles, alpha) {
    var v = BH.view;
    var z = v.zoom || 1;
    var sx = (wx * TILE - BH.camera.x) * z + v.w / 2;
    var sy = (wy * TILE - BH.camera.y) * z + v.h / 2;
    var rp = rTiles * TILE * z;
    if (sx + rp < 0 || sy + rp < 0 || sx - rp > v.w || sy - rp > v.h) return;

    var rays = 38;
    lc.beginPath();
    for (var i = 0; i <= rays; i++) {
      var a = i / rays * TAU;
      var dx = Math.cos(a), dy = Math.sin(a);
      var d = rayDist(wx, wy, dx, dy, rTiles);
      var px = wx + dx * d, py = wy + dy * d;
      var spx = (px * TILE - BH.camera.x) * z + v.w / 2;
      var spy = (py * TILE - BH.camera.y) * z + v.h / 2;
      if (i === 0) lc.moveTo(spx, spy);
      else lc.lineTo(spx, spy);
    }
    lc.closePath();
    var grd = lc.createRadialGradient(sx, sy, 0, sx, sy, rp);
    grd.addColorStop(0, 'rgba(0,0,0,' + alpha + ')');
    grd.addColorStop(0.45, 'rgba(0,0,0,' + (alpha * 0.82) + ')');
    grd.addColorStop(0.78, 'rgba(0,0,0,' + (alpha * 0.38) + ')');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    lc.fillStyle = grd;
    lc.fill();
  }

  function coneLight(lc, wx, wy, dir, halfAngle, range, intensity) {
    var v = BH.view;
    var z = v.zoom || 1;
    var sx = (wx * TILE - BH.camera.x) * z + v.w / 2;
    var sy = (wy * TILE - BH.camera.y) * z + v.h / 2;
    var rp = range * TILE * z;
    var rays = 34;
    lc.beginPath();
    lc.moveTo(sx, sy);
    for (var i = 0; i <= rays; i++) {
      var a = dir - halfAngle + (2 * halfAngle) * i / rays;
      var dx = Math.cos(a), dy = Math.sin(a);
      var d = rayDist(wx, wy, dx, dy, range);
      var px = wx + dx * d, py = wy + dy * d;
      var spx = (px * TILE - BH.camera.x) * z + v.w / 2;
      var spy = (py * TILE - BH.camera.y) * z + v.h / 2;
      lc.lineTo(spx, spy);
    }
    lc.closePath();
    var grd = lc.createRadialGradient(sx, sy, 0, sx, sy, rp);
    grd.addColorStop(0, 'rgba(0,0,0,' + (0.98 * intensity) + ')');
    grd.addColorStop(0.12, 'rgba(0,0,0,' + (0.9 * intensity) + ')');
    grd.addColorStop(0.45, 'rgba(0,0,0,' + (0.62 * intensity) + ')');
    grd.addColorStop(0.75, 'rgba(0,0,0,' + (0.28 * intensity) + ')');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    lc.fillStyle = grd;
    lc.fill();
  }

  function rayDist(px, py, dx, dy, maxDist) {
    var step = 0.1;
    var t = 0;
    var LV2 = BH.level;
    while (t < maxDist) {
      t += step;
      var tx = Math.floor(px + dx * t), ty = Math.floor(py + dy * t);
      if (tx < 0 || ty < 0 || tx >= LV2.W || ty >= LV2.H) return t;
      if (LV2.solid[ty * LV2.W + tx]) return t;
    }
    return maxDist;
  }

  // =======================================================================
  //  屏幕空间特效
  // =======================================================================
  function drawRipples(ctx, S) {
    var v = BH.view;
    var z = v.zoom || 1;
    var listening = BH.player && BH.player.listening;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < BH.ripples.length; i++) {
      var r = BH.ripples[i];
      var prog = clamp(r.t / r.ttl, 0, 1);
      var radT = easeOutQuad(prog) * r.maxR;
      var alpha = (1 - prog);
      alpha *= alpha;
      var col = BH.RIPPLE_COLORS[r.kind] || BH.RIPPLE_COLORS.player;
      var sp = BH.worldToScreen(r.x, r.y);
      var rp = radT * TILE * z;
      if (rp < 1) continue;
      if (sp.x + rp < 0 || sp.y + rp < 0 || sp.x - rp > v.w || sp.y - rp > v.h) continue;
      var boost = listening ? 1.5 : 1;
      ctx.strokeStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (alpha * 0.55 * boost) + ')';
      ctx.lineWidth = (r.kind === 'monster' ? 2.4 : 1.6) * (1.15 - prog * 0.5);
      ctx.beginPath(); ctx.arc(sp.x, sp.y, rp, 0, TAU); ctx.stroke();
      // 第二圈
      ctx.strokeStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (alpha * 0.22 * boost) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, rp * 0.82, 0, TAU); ctx.stroke();
      // 中心亮点
      if (prog < 0.25) {
        ctx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (0.5 * (1 - prog / 0.25) * boost) + ')';
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 3 * (1 - prog / 0.25) + 1, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawListeningRing(ctx, p, S) {
    if (!p || !p.listening || p.hidden) return;
    var v = BH.view;
    var z = v.zoom || 1;
    var sp = BH.worldToScreen(p.x, p.y);
    var pulse = (S.time * 0.9) % 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var k = 0; k < 2; k++) {
      var pr = clamp(pulse + k * 0.5, 0, 1);
      var rad = pr * 3.4 * TILE * z;
      ctx.strokeStyle = 'rgba(150,210,255,' + (0.16 * (1 - pr)) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(sp.x, sp.y, rad, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  // 声呐：按住 R 倾听时，声波扫过墙壁，短暂勾出墙的轮廓。
  // 这是玩家在黑暗中唯一能"看见"地形的能力 —— 停下来，听。
  function drawSonar(ctx, p, S) {
    if (!p || p.hidden || !p.listening) return;
    var LV = BH.level;
    if (!LV || !LV.wall) return;
    var v = BH.view, z = v.zoom || 1, T = TILE;
    var R = 10.0;               // 声呐最大半径（格）
    var period = 1.9;           // 脉冲周期（秒）
    var prog = (S.time % period) / period;
    var radT = easeOutQuad(prog) * R;
    var fade = Math.pow(1 - prog, 0.82);
    if (fade <= 0.02) return;
    var bandW = 0.95 + radT * 0.05;
    var px = p.x, py = p.y;
    var ptx = Math.floor(px), pty = Math.floor(py);
    var rr = Math.ceil(R) + 1;
    var baseA = 0.88 * fade;   // 声波前锋：最亮
    var echoA = 0.48 * fade;   // 已扫过的墙面残影：让轮廓短暂留在黑暗里
    var y0 = Math.max(0, pty - rr), y1 = Math.min(LV.H - 1, pty + rr);
    var x0 = Math.max(0, ptx - rr), x1 = Math.min(LV.W - 1, ptx + rr);
    var s, si, mx, my, d, diff, a, a1, a2, edge;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        if (!LV.wall[ty * LV.W + tx]) continue;
        var segs = [];
        if (ty > 0 && !LV.wall[(ty - 1) * LV.W + tx]) segs.push([tx, ty, tx + 1, ty]);
        if (ty < LV.H - 1 && !LV.wall[(ty + 1) * LV.W + tx]) segs.push([tx, ty + 1, tx + 1, ty + 1]);
        if (tx > 0 && !LV.wall[ty * LV.W + tx - 1]) segs.push([tx, ty, tx, ty + 1]);
        if (tx < LV.W - 1 && !LV.wall[ty * LV.W + tx + 1]) segs.push([tx + 1, ty, tx + 1, ty + 1]);
        for (si = 0; si < segs.length; si++) {
          s = segs[si];
          mx = (s[0] + s[2]) / 2;
          my = (s[1] + s[3]) / 2;
          d = Math.sqrt((mx - px) * (mx - px) + (my - py) * (my - py));
          if (d > radT + bandW) continue;         // 声波还没扫到这里
          diff = Math.abs(d - radT);
          if (diff <= bandW) {
            // 前锋亮线
            a = baseA * (1 - diff / bandW) * (1 - Math.min(1, d / (R + 1)) * 0.55);
            edge = true;
          } else {
            // 扫过之后的残影
            a = echoA * Math.pow(1 - d / (R + 1), 1.1) * (1 - Math.min(1, (radT - d) / (R + 1)) * 0.35);
            edge = false;
          }
          if (a < 0.015) continue;
          a1 = BH.worldToScreen(s[0], s[1]);
          a2 = BH.worldToScreen(s[2], s[3]);
          ctx.strokeStyle = 'rgba(158,214,255,' + a.toFixed(3) + ')';
          ctx.lineWidth = edge ? 2.2 : 1.5;
          ctx.beginPath();
          ctx.moveTo(a1.x, a1.y);
          ctx.lineTo(a2.x, a2.y);
          ctx.stroke();
        }
      }
    }
    // 脉冲环本体
    var sp = BH.worldToScreen(px, py);
    ctx.strokeStyle = 'rgba(158,214,255,' + (0.26 * fade) + ')';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, radT * T * z, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  function drawDanger(ctx, S) {
    var v = BH.view;
    var d = S.danger || 0;
    if (d <= 0.01 && S.mode !== 'dying' && S.mode !== 'dead') return;
    var heartbeat = 0.5 + 0.5 * Math.sin(S.time * (3.0 + d * 4.0));
    var alpha = 0.05 + d * 0.26 + heartbeat * d * 0.05;
    var cx = v.w / 2, cy = v.h / 2;
    var inner = Math.min(v.w, v.h) * 0.28;
    var outer = Math.max(v.w, v.h) * 0.78;
    var g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    g.addColorStop(0, 'rgba(70,6,6,0)');
    g.addColorStop(0.6, 'rgba(80,8,8,' + (alpha * 0.5) + ')');
    g.addColorStop(1, 'rgba(46,3,3,' + alpha + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.w, v.h);

    if (S.mode === 'dying' || S.mode === 'dead') {
      var k = S.mode === 'dying' ? clamp(S.deathT / 0.6, 0, 1) : 1;
      ctx.fillStyle = 'rgba(60,4,4,' + (0.32 * k) + ')';
      ctx.fillRect(0, 0, v.w, v.h);
    }
  }

  function drawLightningOverlay(ctx, S) {
    var f = BH.env.lightning.flash;
    if (f <= 0.01) return;
    ctx.fillStyle = 'rgba(200,220,255,' + (f * 0.10) + ')';
    ctx.fillRect(0, 0, BH.view.w, BH.view.h);
  }

  function drawVignette(ctx, S) {
    var v = BH.view;
    var g = ctx.createRadialGradient(v.w / 2, v.h / 2, Math.min(v.w, v.h) * 0.34, v.w / 2, v.h / 2, Math.max(v.w, v.h) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.7, 'rgba(0,0,0,0.26)');
    g.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.w, v.h);
  }

  function drawGrain(ctx, S) {
    if (!grainPattern) return;
    var v = BH.view;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.translate((Math.random() * 160) | 0, (Math.random() * 160) | 0);
    ctx.fillStyle = grainPattern;
    ctx.fillRect(-160, -160, v.w + 320, v.h + 320);
    ctx.restore();
  }

  function drawAim(ctx, S) {
    var p = BH.player;
    var inp = BH.input;
    if (!p || !inp || !inp.mouseActive || S.mode !== 'playing' || p.hidden) return;
    ctx.save();
    var hasStone = p.stones > 0;
    // 虚线指出石头会落在哪：没有这条线，玩家很难判断投石的作用范围
    if (hasStone) {
      var ps = BH.worldToScreen(p.x, p.y);
      var dx = inp.mouse.x - ps.x, dy = inp.mouse.y - ps.y;
      var dl = Math.hypot(dx, dy) || 1;
      var z = (BH.view && BH.view.zoom) || 1;
      var len = Math.min(dl, 9 * TILE * z);
      var ex = ps.x + dx / dl * len, ey = ps.y + dy / dl * len;
      ctx.setLineDash([3, 7]);
      ctx.strokeStyle = 'rgba(206,220,236,0.20)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ps.x, ps.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(206,220,236,0.45)';
      ctx.beginPath();
      ctx.arc(ex, ey, 2.2, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = hasStone ? 'rgba(220,230,240,0.34)' : 'rgba(220,230,240,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(inp.mouse.x, inp.mouse.y, 3.5, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- 死亡特写：它的脸 ----------
  function drawDeathCloseUp(ctx, S) {
    var v = BH.view;
    var t = S.mode === 'dying' ? S.deathT : 1.0 + S.deathT;
    var k = clamp(t / 0.7, 0, 1);
    // 先压黑
    ctx.fillStyle = 'rgba(0,0,0,' + (0.55 * k) + ')';
    ctx.fillRect(0, 0, v.w, v.h);
    var cx = v.w / 2 + Math.sin(t * 31) * 3 * (1 - k);
    var cy = v.h / 2 + Math.cos(t * 27) * 3 * (1 - k);
    var scale = (0.5 + k * 0.62) * Math.min(v.w / 900, v.h / 560);
    if (scale < 0.1) return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.globalAlpha = clamp(k * 1.2, 0, 1);
    // 头骨形状
    ctx.fillStyle = '#9a9385';
    ctx.beginPath();
    ctx.ellipse(0, 0, 150, 195, 0, 0, TAU);
    ctx.fill();
    // 侧面阴影
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(38, 4, 110, 170, 0.06, 0, TAU);
    ctx.fill();
    // 皮肉纹理
    ctx.strokeStyle = 'rgba(30,26,22,0.18)';
    ctx.lineWidth = 2;
    for (var i = 0; i < 7; i++) {
      ctx.beginPath();
      ctx.moveTo(-120 + i * 38, -150 + (i % 3) * 30);
      ctx.quadraticCurveTo(-90 + i * 30, -40 + (i % 2) * 20, -110 + i * 34, 120);
      ctx.stroke();
    }
    // 没有眼睛：两个凹陷
    ctx.fillStyle = 'rgba(10,8,8,0.55)';
    ctx.beginPath(); ctx.ellipse(-52, -40, 34, 24, -0.12, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(52, -40, 34, 24, 0.12, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(-52, -38, 20, 13, -0.12, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(52, -38, 20, 13, 0.12, 0, TAU); ctx.fill();
    // 鼻
    ctx.fillStyle = 'rgba(20,16,14,0.45)';
    ctx.beginPath(); ctx.ellipse(0, 34, 12, 20, 0, 0, TAU); ctx.fill();
    // 嘴：黑色纵裂，缓慢张开
    var mouthOpen = 0.35 + 0.65 * clamp((t - 0.5) / 0.7, 0, 1);
    ctx.fillStyle = '#0b0a0a';
    ctx.beginPath();
    ctx.ellipse(0, 108, 26 + mouthOpen * 10, 14 + mouthOpen * 46, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(70,20,16,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(0, 108, 26 + mouthOpen * 10, 14 + mouthOpen * 46, 0, 0, TAU); ctx.stroke();
    // 牙
    ctx.fillStyle = 'rgba(190,182,164,0.7)';
    for (var d2 = 0; d2 < 5; d2++) {
      var ang = -0.5 + d2 * 0.25;
      ctx.fillRect(Math.sin(ang) * -60 - 4, 100 + Math.cos(ang) * 8, 8, 14);
    }
    ctx.restore();
    // 血雾
    ctx.fillStyle = 'rgba(90,6,6,' + (0.18 * k) + ')';
    ctx.fillRect(0, 0, v.w, v.h);
  }

  function drawWinFlash(ctx, S) {
    var v = BH.view;
    var k = S.mode === 'winning' ? clamp(S.winT / 0.9, 0, 1) : 1;
    ctx.fillStyle = 'rgba(220,235,255,' + (0.10 * k) + ')';
    ctx.fillRect(0, 0, v.w, v.h);
  }

  // =======================================================================
  //  标题界面背景
  // =======================================================================
  function drawTitle(ctx, dt) {
    var v = BH.view;
    var t = BH.S ? BH.S.time : 0;
    var S = BH.S;

    // 底色
    var g = ctx.createLinearGradient(0, 0, 0, v.h);
    g.addColorStop(0, '#06070b');
    g.addColorStop(0.45, '#0b0c12');
    g.addColorStop(1, '#040508');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.w, v.h);

    // 缓慢流动的雾
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 4; i++) {
      var fx = v.w * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.05 + i * 1.7)));
      var fy = v.h * (0.3 + 0.5 * (0.5 + 0.5 * Math.cos(t * 0.04 + i * 2.1)));
      var fr = Math.min(v.w, v.h) * (0.45 + i * 0.1);
      var fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, fr);
      fg.addColorStop(0, 'rgba(60,72,92,0.05)');
      fg.addColorStop(1, 'rgba(60,72,92,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(fx - fr, fy - fr, fr * 2, fr * 2);
    }
    ctx.restore();

    // 远处若隐若现的身影
    var alpha = 0.05 + 0.03 * Math.sin(t * 0.4);
    var mx = v.w * 0.68, my = v.h * 0.52;
    ctx.save();
    ctx.translate(mx, my);
    var s = Math.min(v.w, v.h) / 700;
    ctx.scale(s, s);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#c9c2b2';
    ctx.beginPath(); ctx.ellipse(0, -120, 16, 22, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#16171a';
    ctx.beginPath(); ctx.ellipse(0, -20, 24, 85, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = alpha * 0.7;
    ctx.beginPath(); ctx.ellipse(-22, -10, 30, 12, 0.2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(22, -10, 30, 12, -0.2, 0, TAU); ctx.fill();
    ctx.restore();

    // 涟漪
    drawRipples(ctx, S);

    // 暗角 + 颗粒
    drawVignette(ctx, S);
    drawGrain(ctx, S);
  }

  // =======================================================================
  //  导出
  // =======================================================================
  BH.Render = {
    draw: draw,
    buildStatic: buildStatic
  };
})();
