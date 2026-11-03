/*!
 * 《盲猎》(Blind Hunt) — 程序化 WebAudio 音频引擎
 * ------------------------------------------------------------
 * 纯 WebAudio 程序化合成：无任何外部音频资源、无 fetch、无 ES module、无第三方依赖。
 * classic script，可直接 file:// 双击运行。
 *
 * 对外契约（window.AudioEngine）：
 *   ready                 : boolean
 *   init()                : 用户手势时调用，创建/恢复 AudioContext；幂等；绝不抛异常
 *   resume()              : 恢复被挂起的上下文
 *   setMasterVolume(v)    : 0..1
 *   setListener(x, y)     : 玩家 tile 浮点坐标（每帧调用）
 *   update(dt, state)     : 每帧调用；驱动心跳 / 呼吸 / 危险低频 / 环境层
 *   play(name, opts)      : 一次性音效，opts = { x, y, vol }（世界坐标 → 声像 + 衰减）
 *   startAmbience()       : 环境层开
 *   stopAmbience()        : 环境层关
 *   isPlaying(name)       : 该声音/循环当前是否在响
 *
 * 合成链路：
 *   每个声源 → 独立包络/滤波 → 声像(StereoPanner) → sfxBus ─┐
 *                                                          ├→ DynamicsCompressor → masterGain → destination
 *   环境层   → 环境总增益 → ambBus ──────────────────────────┘
 *   （另有一条程序化 IR 混响支路：verbSend → Convolver → verbReturn → compressor）
 *
 * 声像 / 衰减（契约）：
 *   pan  = clamp((x - playerX) / 12, -1, 1)
 *   gain = clamp(1 / (1 + dist / 7), 0.04, 1)
 *
 * 所有公开方法均 try/catch 包裹；无 AudioContext / 音频不可用时全部安全 no-op。
 */
(function (global) {
  'use strict';

  /* ============================================================
   * 0. 环境探测与常量
   * ============================================================ */

  var AC = null;
  try {
    if (typeof global.AudioContext === 'function') {
      AC = global.AudioContext;
    } else if (typeof global.webkitAudioContext === 'function') {
      AC = global.webkitAudioContext;
    }
  } catch (e) {
    AC = null;
  }

  var MAX_VOICES = 40;        // 同时活动的一次性声源上限（超限丢弃新音效）
  var MIN_ATTACK = 0.011;     // 一次性音效最小攻击包络（秒）——≥10ms，防爆音
  var NOISE_SECONDS = 2.0;    // 白噪声 buffer 时长（全局只生成一次）
  var DEFAULT_VOLUME = 0.9;

  /* ============================================================
   * 1. 运行时状态
   * ============================================================ */

  var ctx = null;                 // AudioContext
  var ready = false;              // 引擎是否可用
  var initAttempted = false;      // 是否已尝试过 init（失败后不再反复创建）
  var masterVolume = DEFAULT_VOLUME;

  var masterGain = null;
  var compressor = null;
  var sfxBus = null;              // 一次性音效总线
  var ambBus = null;              // 环境总线
  var verbSend = null;            // 混响发送
  var verbReturn = null;          // 混响返回
  var noiseBuffer = null;         // 唯一的白噪声 buffer（复用）

  var rumble = null;              // 危险低频压迫层（常驻节点）
  var ambience = null;            // 环境层状态
  var breaker = null;             // 电闸循环状态
  var ambienceAutoTried = false;  // 环境层兜底自动启动只尝试一次

  var voices = 0;                 // 当前活动声源数
  var listenerX = 0;
  var listenerY = 0;
  var lastError = null;

  var lastPlayed = {};            // name -> 预计结束的 AudioContext 时间（isPlaying 用）

  // 平滑后的连续参数
  var smooth = { hb: 0, rumble: 0, hum: 0 };
  var nextHeart = 0;              // 下一次心跳的 AudioContext 时间
  var breathTimer = 0.6;          // 距离下一次呼吸的秒数
  var nextGasp = 0;               // 下一次自动喘息的最早时间
  var deathUntil = 0;             // 死亡后的静默截止时间

  // 调试信息（自测页可读；不影响游戏逻辑）
  var dbg = {
    supported: !!AC,
    voices: 0,
    dropped: 0,
    dispatched: {},
    errors: 0,
    lastError: null,
    ctxState: 'none',   // 'none' | 'suspended' | 'running' | 'closed'
    version: '1.0.0'
  };

  function syncCtxState() {
    try {
      dbg.ctxState = ctx ? String(ctx.state) : 'none';
    } catch (e) {
      dbg.ctxState = 'unknown';
    }
  }

  /* ============================================================
   * 2. 小工具
   * ============================================================ */

  function noop() {}

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(v, lo, hi) {
    v = +v;
    if (!isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function num(v, d) {
    return isNum(v) ? v : d;
  }

  function rnd(a, b) {
    return a + Math.random() * (b - a);
  }

  function tanh(x) {
    if (x < -9) return -1;
    if (x > 9) return 1;
    var e = Math.exp(2 * x);
    return (e - 1) / (e + 1);
  }

  function nowAudio() {
    try {
      return ctx ? ctx.currentTime : 0;
    } catch (e) {
      return 0;
    }
  }

  function fail(e) {
    lastError = e;
    dbg.lastError = e;
    dbg.errors++;
    try {
      if (global.console && global.console.warn) {
        global.console.warn('[AudioEngine]', e);
      }
    } catch (e2) { /* ignore */ }
  }

  function syncReady() {
    try {
      api.ready = ready;
    } catch (e) { /* ignore */ }
  }

  function safeResume() {
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(noop);
      }
    } catch (e) { /* ignore */ }
  }

  // 平滑地逼近目标值（setTargetAtTime）
  function rampParam(param, value, t, tc) {
    if (!param) return;
    try {
      param.setTargetAtTime(value, t, Math.max(0.01, tc));
    } catch (e) {
      try { param.value = value; } catch (e2) { /* ignore */ }
    }
  }

  // 立即淡出并在 after 秒后停止（用于循环/环境层/死亡切断）
  function fadeAndStop(sources, nodes, t, fade, after) {
    for (var i = 0; i < sources.length; i++) {
      (function (src) {
        try { src.stop(t + fade + after); } catch (e) { /* already stopped */ }
      })(sources[i]);
    }
    var cleanup = function () {
      for (var k = 0; k < sources.length; k++) {
        try { sources[k].disconnect(); } catch (e) { /* ignore */ }
      }
      for (var n = 0; n < nodes.length; n++) {
        try { nodes[n].disconnect(); } catch (e) { /* ignore */ }
      }
    };
    try {
      if (typeof global.setTimeout === 'function') {
        global.setTimeout(cleanup, Math.round((fade + after + 0.25) * 1000));
      } else {
        cleanup();
      }
    } catch (e) {
      cleanup();
    }
  }

  function fadeGain(param, t, target, dur) {
    if (!param) return;
    try {
      if (param.cancelAndHoldAtTime) {
        param.cancelAndHoldAtTime(t);
      } else {
        param.cancelScheduledValues(t);
        try { param.setValueAtTime(param.value, t); } catch (e) { /* ignore */ }
      }
      param.linearRampToValueAtTime(Math.max(0.0001, target), t + Math.max(0.005, dur));
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 3. 音频图构建（只在 init 成功时执行一次）
   * ============================================================ */

  // 程序化生成的白噪声（全引擎唯一，复用）
  function buildNoiseBuffer() {
    var sr = ctx.sampleRate || 44100;
    var len = Math.max(1, Math.floor(sr * NOISE_SECONDS));
    var buf = ctx.createBuffer(1, len, sr);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    noiseBuffer = buf;
  }

  // 程序化生成的小房间脉冲响应（无任何外部资源）
  function buildImpulse() {
    var sr = ctx.sampleRate || 44100;
    var dur = 1.4;
    var len = Math.max(8, Math.floor(sr * dur));
    var buf = ctx.createBuffer(2, len, sr);
    var preDelay = Math.floor(sr * 0.018);
    var refl = [0.011, 0.019, 0.031, 0.047, 0.063, 0.083];
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var smoothv = 0;
      for (var i = 0; i < len; i++) {
        if (i < preDelay) { d[i] = 0; continue; }
        var t = (i - preDelay) / (len - preDelay);
        var env = Math.pow(1 - t, 2.6);
        var v = (Math.random() * 2 - 1) * env;
        smoothv = smoothv * 0.62 + v * 0.38;
        d[i] = smoothv * 0.5;
      }
      for (var r = 0; r < refl.length; r++) {
        var idx = preDelay + Math.floor(sr * refl[r]);
        if (idx < len) {
          d[idx] += (Math.random() * 2 - 1) * 0.6 * (1 - r / 9);
        }
      }
    }
    return buf;
  }

  function buildGraph() {
    masterGain = ctx.createGain();
    masterGain.gain.value = masterVolume;

    compressor = ctx.createDynamicsCompressor();
    try {
      compressor.threshold.value = -14;
      compressor.knee.value = 10;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
    } catch (e) { /* 某些实现参数名不同，忽略 */ }

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 1;
    ambBus = ctx.createGain();
    ambBus.gain.value = 1;
    sfxBus.connect(compressor);
    ambBus.connect(compressor);

    // 程序化混响支路（空间感的来源）
    try {
      var conv = ctx.createConvolver();
      conv.buffer = buildImpulse();
      verbSend = ctx.createGain();
      verbSend.gain.value = 1;
      verbReturn = ctx.createGain();
      verbReturn.gain.value = 0.42;
      verbSend.connect(conv);
      conv.connect(verbReturn);
      verbReturn.connect(compressor);
    } catch (e) {
      verbSend = null;
      verbReturn = null;
    }

    compressor.connect(masterGain);
    masterGain.connect(ctx.destination);

    buildNoiseBuffer();
    buildRumble();
  }

  // 危险低频压迫层：始终存在但默认静音，由 update 驱动增益
  function buildRumble() {
    try {
      var out = ctx.createGain();
      out.gain.value = 0;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 110;
      lp.Q.value = 0.9;

      var mix = ctx.createGain();
      mix.gain.value = 1;

      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = 31.5;

      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = 44.2;
      o2.detune.value = -7;

      var ng = ctx.createGain();
      ng.gain.value = 0.35;
      var ns = ctx.createBufferSource();
      ns.buffer = noiseBuffer;
      ns.loop = true;
      var nf = ctx.createBiquadFilter();
      nf.type = 'lowpass';
      nf.frequency.value = 85;
      nf.Q.value = 0.6;

      o1.connect(mix);
      o2.connect(mix);
      ns.connect(nf);
      nf.connect(ng);
      ng.connect(mix);
      mix.connect(lp);
      lp.connect(out);

      // 缓慢“涌动”LFO：深度随危险值缩放（静音时不会漏音）
      var lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.113;
      var lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0;
      lfo.connect(lfoDepth);
      lfoDepth.connect(out.gain);

      out.connect(compressor);

      o1.start();
      o2.start();
      ns.start();
      lfo.start();

      rumble = {
        out: out,
        lfoDepth: lfoDepth,
        sources: [o1, o2, ns, lfo],
        nodes: [out, lp, mix, ng, nf, lfoDepth]
      };
    } catch (e) {
      rumble = null;
    }
  }

  /* ============================================================
   * 4. 声部（voice）与合成基元
   * ============================================================ */

  function makeDriveCurve(amount) {
    var n = 2048;
    var curve = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = tanh(amount * x);
    }
    return curve;
  }

  function releaseVoice(v) {
    if (!v || v.released) return;
    v.released = true;
    voices = Math.max(0, voices - 1);
    dbg.voices = voices;
    var i;
    for (i = 0; i < v.nodes.length; i++) {
      try { v.nodes[i].disconnect(); } catch (e) { /* ignore */ }
    }
    for (i = 0; i < v.sources.length; i++) {
      try { v.sources[i].disconnect(); } catch (e) { /* ignore */ }
    }
    v.nodes.length = 0;
    v.sources.length = 0;
  }

  /**
   * 创建一个声部：声部内所有层共享一个声像与混响发送。
   * @param {number} pan     -1..1
   * @param {number} reverb  混响发送量 0..1
   * @param {number} drive   可选：失真量（>0 时插入波形整形 + 低通）
   */
  function createVoice(pan, reverb, drive) {
    if (!ctx || !ready) return null;
    if (voices >= MAX_VOICES) {
      dbg.dropped++;
      return null;
    }
    try {
      var g = ctx.createGain();
      g.gain.value = 1;
      var node = g;
      var nodes = [g];

      if (drive && drive > 0 && typeof ctx.createWaveShaper === 'function') {
        try {
          var ws = ctx.createWaveShaper();
          ws.curve = makeDriveCurve(drive);
          ws.oversample = '2x';
          var dg = ctx.createGain();
          dg.gain.value = 0.6;
          node.connect(ws);
          ws.connect(dg);
          node = dg;
          nodes.push(ws, dg);
        } catch (e) { /* 无失真也可继续 */ }
      }

      if (typeof ctx.createStereoPanner === 'function') {
        try {
          var p = ctx.createStereoPanner();
          p.pan.value = clamp(pan, -1, 1);
          node.connect(p);
          node = p;
          nodes.push(p);
        } catch (e) {
          try { node.disconnect(); } catch (e2) { /* ignore */ }
          node = g;
          nodes = [g];
        }
      }
      node.connect(sfxBus);

      var rv = clamp(num(reverb, 0), 0, 1);
      var send = null;
      if (rv > 0.001 && verbSend) {
        send = ctx.createGain();
        send.gain.value = rv * 0.55;
        g.connect(send);
        send.connect(verbSend);
        nodes.push(send);
      }

      var v = {
        g: g,
        nodes: nodes,
        sources: [],
        pending: 0,
        end: 0,
        released: false
      };
      voices++;
      dbg.voices = voices;
      return v;
    } catch (e) {
      fail(e);
      return null;
    }
  }

  /**
   * 合成一层声音（振荡器或噪声），自动挂 ≥10ms 攻击包络、滤波与清理。
   * spec:
   *   type   : 'sine'|'sawtooth'|'square'|'triangle'|'noise'
   *   f0,f1,f2 / glide,glide2 : 振荡器频率包络
   *   peak, attack, hold, decay : 振幅包络
   *   filter : { type, f0, f1, f2, q, glide, glide2 }
   *   rate   : 噪声播放速率
   *   detune : 音分
   */
  function sig(v, t0, spec) {
    if (!v || !ctx || !spec) return null;
    try {
      var t = Math.max(num(t0, nowAudio()), nowAudio());
      var attack = Math.max(MIN_ATTACK, num(spec.attack, 0.02));
      var hold = Math.max(0, num(spec.hold, 0.02));
      var decay = Math.max(0.02, num(spec.decay, 0.15));
      var peak = clamp(num(spec.peak, 0.2), 0.0006, 1.5);
      var end = t + attack + hold + decay;
      var isNoise = spec.type === 'noise';
      if (isNoise && !noiseBuffer) return null;

      // 振幅包络
      var env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(peak, t + attack);
      if (hold > 0.001) {
        env.gain.setValueAtTime(peak, t + attack + hold);
      }
      env.gain.exponentialRampToValueAtTime(0.0001, end);

      // 可选滤波（支持两段扫频）
      var head = env;
      var extra = [];
      if (spec.filter) {
        var f = ctx.createBiquadFilter();
        f.type = spec.filter.type || 'lowpass';
        var ff0 = Math.max(20, num(spec.filter.f0, 1000));
        f.frequency.setValueAtTime(ff0, t);
        var fgl = Math.max(0.005, num(spec.filter.glide, end - t));
        var ff1 = num(spec.filter.f1, ff0);
        if (isNum(ff1) && ff1 > 0 && Math.abs(ff1 - ff0) > 1) {
          f.frequency.exponentialRampToValueAtTime(Math.max(20, ff1), t + Math.min(fgl, end - t));
        }
        var ff2 = num(spec.filter.f2, NaN);
        if (isNum(ff2) && ff2 > 0) {
          f.frequency.exponentialRampToValueAtTime(
            Math.max(20, ff2),
            t + Math.min(Math.max(fgl + 0.01, num(spec.filter.glide2, end - t)), end - t)
          );
        }
        f.Q.value = clamp(num(spec.filter.q, 0.7), 0.0001, 40);
        f.connect(env);
        head = f;
        extra.push(f);
      }

      var src;
      var cleanup;
      if (isNoise) {
        src = ctx.createBufferSource();
        src.buffer = noiseBuffer;
        src.loop = true;
        src.playbackRate.value = clamp(num(spec.rate, 1), 0.1, 8);
        src.connect(head);
        cleanup = function () {
          try { src.disconnect(); } catch (e) { /* ignore */ }
          try { env.disconnect(); } catch (e) { /* ignore */ }
          for (var i = 0; i < extra.length; i++) {
            try { extra[i].disconnect(); } catch (e) { /* ignore */ }
          }
          v.pending = Math.max(0, v.pending - 1);
          if (v.pending === 0) releaseVoice(v);
        };
        src.onended = cleanup;
        src.start(t, Math.random() * (NOISE_SECONDS - 0.2));
        src.stop(end + 0.06);
      } else {
        src = ctx.createOscillator();
        src.type = spec.type || 'sine';
        var f0 = Math.max(0.01, num(spec.f0, 220));
        src.frequency.setValueAtTime(f0, t);
        var gl = Math.max(0.005, num(spec.glide, 0.25));
        var f1 = num(spec.f1, f0);
        if (isNum(f1) && Math.abs(f1 - f0) > 0.01) {
          src.frequency.exponentialRampToValueAtTime(Math.max(0.01, f1), t + Math.min(gl, end - t));
        }
        var f2 = num(spec.f2, NaN);
        if (isNum(f2) && f2 > 0) {
          src.frequency.exponentialRampToValueAtTime(
            Math.max(0.01, f2),
            t + Math.min(Math.max(gl + 0.01, num(spec.glide2, end - t)), end - t)
          );
        }
        src.detune.value = clamp(num(spec.detune, 0), -2400, 2400);
        src.connect(head);
        cleanup = function () {
          try { src.disconnect(); } catch (e) { /* ignore */ }
          try { env.disconnect(); } catch (e) { /* ignore */ }
          for (var i = 0; i < extra.length; i++) {
            try { extra[i].disconnect(); } catch (e) { /* ignore */ }
          }
          v.pending = Math.max(0, v.pending - 1);
          if (v.pending === 0) releaseVoice(v);
        };
        src.onended = cleanup;
        src.start(t);
        src.stop(end + 0.06);
      }

      v.pending++;
      v.sources.push(src);
      v.end = Math.max(v.end, end);
      return { end: end };
    } catch (e) {
      fail(e);
      return null;
    }
  }

  /* ============================================================
   * 5. 一次性音效（全部为程序化合成）
   * ============================================================ */

  // 脚步声：闷而低，sprint 更硬更响，sneak 极轻
  function sfxStep(pan, gain, t0, kind) {
    var v = createVoice(pan, 0.18);
    if (!v) return;
    var vol = gain * (kind === 'sprint' ? 0.95 : (kind === 'sneak' ? 0.30 : 0.62));
    var f0 = kind === 'sprint' ? rnd(115, 138) : (kind === 'sneak' ? rnd(70, 86) : rnd(92, 110));
    sig(v, t0, {
      type: 'sine',
      f0: f0,
      f1: kind === 'sneak' ? rnd(44, 54) : rnd(34, 46),
      glide: 0.09,
      peak: 0.50 * vol,
      attack: 0.012,
      hold: 0.008,
      decay: kind === 'sprint' ? 0.10 : 0.13,
      filter: { type: 'lowpass', f0: kind === 'sneak' ? 260 : 520, f1: 210, q: 1.0 }
    });
    sig(v, t0, {
      type: 'noise',
      peak: 0.34 * vol,
      attack: 0.012,
      hold: 0.010,
      decay: kind === 'sprint' ? 0.15 : 0.11,
      rate: rnd(0.9, 1.15),
      filter: {
        type: 'bandpass',
        f0: kind === 'sneak' ? 380 : (kind === 'sprint' ? 1500 : 900),
        f1: kind === 'sneak' ? 300 : 560,
        q: 0.9,
        glide: 0.1
      }
    });
    if (kind === 'sprint') {
      sig(v, t0 + rnd(0.01, 0.03), {
        type: 'noise',
        peak: 0.14 * vol,
        attack: 0.012,
        hold: 0.015,
        decay: 0.10,
        filter: { type: 'bandpass', f0: 2600, q: 1.4 }
      });
    } else if (kind === 'walk') {
      sig(v, t0 + 0.03, {
        type: 'noise',
        peak: 0.05 * vol,
        attack: 0.011,
        hold: 0.010,
        decay: 0.08,
        filter: { type: 'highpass', f0: 1800 }
      });
    }
  }

  // 门：铰链吱呀 + 空气流动 + 落闩闷响
  function sfxDoor(pan, gain, t0) {
    var v = createVoice(pan, 0.40);
    if (!v) return;
    var vol = gain * 0.75;
    sig(v, t0, {
      type: 'sawtooth',
      f0: rnd(95, 130),
      f1: rnd(150, 195),
      glide: 0.55,
      peak: 0.10 * vol,
      attack: 0.05,
      hold: 0.28,
      decay: 0.30,
      filter: { type: 'bandpass', f0: 520, f1: 900, q: 3.5, glide: 0.6 }
    });
    sig(v, t0 + 0.04, {
      type: 'sawtooth',
      f0: rnd(140, 185),
      f1: rnd(90, 125),
      glide: 0.6,
      peak: 0.05 * vol,
      attack: 0.05,
      hold: 0.25,
      decay: 0.40,
      filter: { type: 'bandpass', f0: 1200, f1: 700, q: 4.0, glide: 0.6 }
    });
    sig(v, t0, {
      type: 'noise',
      peak: 0.10 * vol,
      attack: 0.05,
      hold: 0.30,
      decay: 0.45,
      filter: { type: 'bandpass', f0: 700, f1: 340, q: 0.9, glide: 0.7 }
    });
    sig(v, t0 + 0.72, {
      type: 'sine',
      f0: 85,
      f1: 42,
      glide: 0.08,
      peak: 0.35 * vol,
      attack: 0.012,
      hold: 0.010,
      decay: 0.18,
      filter: { type: 'lowpass', f0: 200, q: 1.0 }
    });
    sig(v, t0 + 0.78, {
      type: 'noise',
      peak: 0.12 * vol,
      attack: 0.011,
      hold: 0.004,
      decay: 0.03,
      filter: { type: 'highpass', f0: 2600 }
    });
  }

  // 电闸循环：工业交流嗡鸣 + 电弧噼啪（开始/停止由 play 事件控制）
  function startBreakerLoop(pan, gain) {
    if (!ctx || !ready || !noiseBuffer) return;
    if (breaker && breaker.on) return;
    try {
      var out = ctx.createGain();
      out.gain.value = 0.0001;
      var tail = out;
      var nodes = [out];
      var sources = [];

      if (typeof ctx.createStereoPanner === 'function') {
        try {
          var p = ctx.createStereoPanner();
          p.pan.value = clamp(pan, -1, 1);
          out.connect(p);
          tail = p;
          nodes.push(p);
        } catch (e) { /* mono fallback */ }
      }
      tail.connect(sfxBus);

      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 100;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = 50.4;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 540;
      bp.Q.value = 2.4;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      o1.connect(bp);
      o2.connect(bp);
      bp.connect(lp);
      lp.connect(out);

      var ns = ctx.createBufferSource();
      ns.buffer = noiseBuffer;
      ns.loop = true;
      var nbp = ctx.createBiquadFilter();
      nbp.type = 'bandpass';
      nbp.frequency.value = 3000;
      nbp.Q.value = 1.2;
      var ng = ctx.createGain();
      ng.gain.value = 0.10;
      ns.connect(nbp);
      nbp.connect(ng);
      ng.connect(out);

      // 电弧闪烁：噪声增益上的方波 LFO
      var lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = rnd(5.5, 8.5);
      var lg = ctx.createGain();
      lg.gain.value = 0.035;
      lfo.connect(lg);
      lg.connect(ng.gain);

      var target = 0.16 * clamp(gain, 0, 1);
      out.gain.setValueAtTime(0.0001, nowAudio());
      out.gain.exponentialRampToValueAtTime(Math.max(0.001, target), nowAudio() + 0.35);

      o1.start();
      o2.start();
      ns.start();
      lfo.start();
      sources = [o1, o2, ns, lfo];
      nodes.push(bp, lp, nbp, ng, lg);

      voices++;
      dbg.voices = voices;
      breaker = { on: true, out: out, nodes: nodes, sources: sources };
    } catch (e) {
      fail(e);
      breaker = null;
    }
  }

  function stopBreakerLoop(immediate) {
    if (!breaker || !breaker.on) return;
    var b = breaker;
    breaker = null;
    b.on = false;
    try {
      var t = nowAudio();
      var fade = immediate ? 0.02 : 0.30;
      fadeGain(b.out.gain, t, 0.0001, fade);
      fadeAndStop(b.sources, b.nodes, t, fade, 0.04);
    } catch (e) {
      fail(e);
    }
    voices = Math.max(0, voices - 1);
    dbg.voices = voices;
  }

  // 电闸合闸：金属重击 + 电流涌动 + 火花
  function sfxBreakerDone(pan, gain, t0) {
    stopBreakerLoop(false);
    var v = createVoice(pan, 0.42);
    if (!v) return;
    var vol = gain * 0.85;
    var parts = [58, 117, 191, 273, 402];
    for (var i = 0; i < parts.length; i++) {
      sig(v, t0 + i * 0.004, {
        type: i % 2 ? 'sine' : 'triangle',
        f0: parts[i] * rnd(0.97, 1.03),
        f1: parts[i] * 0.94,
        glide: 0.5,
        peak: (0.24 / (i + 1)) * vol,
        attack: 0.012,
        hold: 0.02,
        decay: 0.5 - i * 0.07,
        filter: { type: 'lowpass', f0: 2200, q: 0.7 }
      });
    }
    sig(v, t0 + 0.05, {
      type: 'sawtooth',
      f0: 42,
      f1: 118,
      glide: 0.5,
      peak: 0.13 * vol,
      attack: 0.03,
      hold: 0.25,
      decay: 0.70,
      filter: { type: 'lowpass', f0: 300, f1: 1100, q: 1.2, glide: 0.7 }
    });
    sig(v, t0 + 0.05, {
      type: 'noise',
      peak: 0.16 * vol,
      attack: 0.03,
      hold: 0.20,
      decay: 0.55,
      filter: { type: 'bandpass', f0: 400, f1: 2400, q: 1.0, glide: 0.6 }
    });
    for (var s = 0; s < 3; s++) {
      sig(v, t0 + rnd(0.06, 0.4), {
        type: 'noise',
        peak: 0.10 * vol,
        attack: 0.011,
        hold: 0.003,
        decay: 0.04,
        filter: { type: 'highpass', f0: rnd(2800, 5200) }
      });
    }
  }

  // 投掷：布/石块的破空声
  function sfxThrow(pan, gain, t0) {
    var v = createVoice(pan, 0.28);
    if (!v) return;
    var vol = gain * 0.80;
    sig(v, t0, {
      type: 'noise',
      peak: 0.30 * vol,
      attack: 0.03,
      hold: 0.06,
      decay: 0.22,
      filter: { type: 'bandpass', f0: 300, f1: 2200, q: 1.3, glide: 0.2 }
    });
    sig(v, t0 + 0.14, {
      type: 'noise',
      peak: 0.18 * vol,
      attack: 0.02,
      hold: 0.04,
      decay: 0.20,
      filter: { type: 'bandpass', f0: 2000, f1: 500, q: 1.5, glide: 0.2 }
    });
  }

  // 落地撞击
  function sfxImpact(pan, gain, t0) {
    var v = createVoice(pan, 0.30);
    if (!v) return;
    var vol = gain * 0.90;
    sig(v, t0, {
      type: 'sine',
      f0: 130,
      f1: 44,
      glide: 0.07,
      peak: 0.65 * vol,
      attack: 0.012,
      hold: 0.008,
      decay: 0.16,
      filter: { type: 'lowpass', f0: 420, q: 0.9 }
    });
    sig(v, t0, {
      type: 'noise',
      peak: 0.40 * vol,
      attack: 0.012,
      hold: 0.006,
      decay: 0.09,
      filter: { type: 'lowpass', f0: 2600, f1: 700, q: 0.8, glide: 0.08 }
    });
    sig(v, t0 + 0.05, {
      type: 'noise',
      peak: 0.12 * vol,
      attack: 0.011,
      hold: 0.006,
      decay: 0.14,
      filter: { type: 'bandpass', f0: 1600, q: 1.0 }
    });
  }

  // 拾取：两声闷金属轻响（非廉价音阶铃声）
  function sfxPickup(pan, gain, t0) {
    var v = createVoice(pan, 0.30);
    if (!v) return;
    var vol = gain * 0.55;
    var f = rnd(820, 900);
    sig(v, t0, {
      type: 'sine',
      f0: f,
      f1: f * 0.99,
      glide: 0.2,
      peak: 0.30 * vol,
      attack: 0.012,
      hold: 0.010,
      decay: 0.28,
      filter: { type: 'lowpass', f0: 4200, q: 0.6 }
    });
    sig(v, t0 + 0.012, {
      type: 'sine',
      f0: f * 1.51,
      f1: f * 1.50,
      glide: 0.2,
      peak: 0.16 * vol,
      attack: 0.012,
      hold: 0.005,
      decay: 0.20,
      filter: { type: 'lowpass', f0: 5000, q: 0.6 }
    });
    sig(v, t0, {
      type: 'noise',
      peak: 0.09 * vol,
      attack: 0.011,
      hold: 0.004,
      decay: 0.04,
      filter: { type: 'highpass', f0: 3200 }
    });
  }

  // 纸张 / 笔记
  function sfxNote(pan, gain, t0) {
    var v = createVoice(pan, 0.22);
    if (!v) return;
    var vol = gain * 0.60;
    for (var i = 0; i < 4; i++) {
      sig(v, t0 + i * 0.075 + rnd(0, 0.03), {
        type: 'noise',
        peak: (0.10 - i * 0.015) * vol,
        attack: 0.011,
        hold: 0.02,
        decay: 0.08,
        filter: { type: 'bandpass', f0: rnd(1600, 3200), q: 0.9 }
      });
    }
    sig(v, t0 + 0.30, {
      type: 'noise',
      peak: 0.05 * vol,
      attack: 0.02,
      hold: 0.03,
      decay: 0.18,
      filter: { type: 'lowpass', f0: 700 }
    });
  }

  // 大铁门：非谐波金属簇 + 回声
  function sfxGate(pan, gain, t0) {
    var v = createVoice(pan, 0.55);
    if (!v) return;
    var vol = gain * 0.90;
    var parts = [49, 97, 143, 211, 307, 447];
    for (var i = 0; i < parts.length; i++) {
      sig(v, t0, {
        type: i === 0 ? 'sine' : 'triangle',
        f0: parts[i] * rnd(0.98, 1.02),
        f1: parts[i] * rnd(0.90, 0.95),
        glide: 0.8,
        peak: (0.30 / (1 + i * 0.8)) * vol,
        attack: 0.012,
        hold: 0.02,
        decay: 1.1 - i * 0.12,
        filter: { type: 'lowpass', f0: 2800, q: 0.6 }
      });
    }
    sig(v, t0, {
      type: 'noise',
      peak: 0.35 * vol,
      attack: 0.012,
      hold: 0.02,
      decay: 0.35,
      filter: { type: 'lowpass', f0: 1400, f1: 400, q: 0.7, glide: 0.3 }
    });
    var echoPan = clamp(pan + (pan <= 0 ? 0.15 : -0.15), -1, 1);
    var v2 = createVoice(echoPan, 0.50);
    if (v2) {
      sig(v2, t0 + 0.18, {
        type: 'sine',
        f0: parts[0] * 0.98,
        f1: parts[0] * 0.90,
        glide: 0.7,
        peak: 0.16 * vol,
        attack: 0.012,
        hold: 0.02,
        decay: 0.9,
        filter: { type: 'lowpass', f0: 800, q: 0.8 }
      });
    }
  }

  // 雷声：远处闪电（近处撕裂 + 远处低频轰鸣）
  function sfxLightning(pan, gain, t0) {
    var v = createVoice(isNum(pan) ? pan : rnd(-0.6, 0.6), 0.60);
    if (!v) return;
    var vol = clamp(gain, 0, 1);
    sig(v, t0, {
      type: 'noise',
      peak: 0.50 * vol,
      attack: 0.012,
      hold: 0.02,
      decay: 0.25,
      filter: { type: 'highpass', f0: 1200, f1: 3000, q: 0.7, glide: 0.15 }
    });
    sig(v, t0, {
      type: 'sawtooth',
      f0: 70,
      f1: 42,
      glide: 0.4,
      peak: 0.14 * vol,
      attack: 0.012,
      hold: 0.05,
      decay: 0.5,
      filter: { type: 'lowpass', f0: 600, q: 0.8 }
    });
    sig(v, t0 + 0.06, {
      type: 'noise',
      peak: 0.35 * vol,
      attack: 0.12,
      hold: 0.50,
      decay: 1.30,
      filter: { type: 'lowpass', f0: 180, f1: 90, q: 1.4, glide: 1.4 }
    });
  }

  // ★ 怪物点击回声定位：全游戏最有辨识度的方位线索
  //   短促高频“哒” + 两级延迟回声（声像跟随世界坐标）
  function sfxMonsterClick(pan, gain, t0) {
    var vol = gain * 0.95;
    var v = createVoice(pan, 0.40);
    if (!v) return;
    // 高频“哒”
    sig(v, t0, {
      type: 'noise',
      peak: 0.50 * vol,
      attack: 0.011,
      hold: 0.006,
      decay: 0.045,
      filter: { type: 'highpass', f0: 2600 }
    });
    // 共鸣主体
    sig(v, t0, {
      type: 'sine',
      f0: 3150,
      f1: 1980,
      glide: 0.055,
      peak: 0.42 * vol,
      attack: 0.011,
      hold: 0.006,
      decay: 0.07,
      filter: { type: 'bandpass', f0: 2600, q: 2.2 }
    });
    // 极轻的胸腔体感
    sig(v, t0, {
      type: 'sine',
      f0: 300,
      f1: 190,
      glide: 0.05,
      peak: 0.10 * vol,
      attack: 0.011,
      hold: 0.005,
      decay: 0.06,
      filter: { type: 'lowpass', f0: 900 }
    });
    // 第一层回声
    var e1 = createVoice(clamp(pan * 0.9 + rnd(-0.05, 0.05), -1, 1), 0.55);
    if (e1) {
      sig(e1, t0 + 0.17, {
        type: 'sine',
        f0: 2980,
        f1: 1750,
        glide: 0.06,
        peak: 0.30 * vol,
        attack: 0.011,
        hold: 0.004,
        decay: 0.10,
        filter: { type: 'bandpass', f0: 2100, q: 2.0 }
      });
      sig(e1, t0 + 0.17, {
        type: 'noise',
        peak: 0.14 * vol,
        attack: 0.011,
        hold: 0.003,
        decay: 0.03,
        filter: { type: 'highpass', f0: 3000 }
      });
    }
    // 第二层回声
    var e2 = createVoice(clamp(pan * 0.8, -1, 1), 0.75);
    if (e2) {
      sig(e2, t0 + 0.38, {
        type: 'sine',
        f0: 2700,
        f1: 1500,
        glide: 0.08,
        peak: 0.13 * vol,
        attack: 0.012,
        hold: 0.004,
        decay: 0.14,
        filter: { type: 'bandpass', f0: 1500, q: 1.8 }
      });
    }
  }

  // 怪物脚步：沉重、湿黏的拖步
  function sfxMonsterStep(pan, gain, t0) {
    var v = createVoice(pan, 0.25);
    if (!v) return;
    var vol = gain * 1.0;
    sig(v, t0, {
      type: 'sine',
      f0: rnd(64, 72),
      f1: rnd(34, 38),
      glide: 0.12,
      peak: 0.75 * vol,
      attack: 0.012,
      hold: 0.02,
      decay: 0.26,
      filter: { type: 'lowpass', f0: 220, q: 1.2 }
    });
    sig(v, t0, {
      type: 'noise',
      peak: 0.30 * vol,
      attack: 0.012,
      hold: 0.03,
      decay: 0.22,
      filter: { type: 'lowpass', f0: 420, f1: 180, q: 0.9, glide: 0.2 }
    });
    sig(v, t0 + 0.02, {
      type: 'noise',
      peak: 0.10 * vol,
      attack: 0.011,
      hold: 0.02,
      decay: 0.14,
      filter: { type: 'bandpass', f0: rnd(700, 900), f1: 400, q: 1.2, glide: 0.1 }
    });
  }

  // ★★ 怪物尖啸：追逐开始，全游戏最吓人的瞬间（< 1.2s）
  function sfxMonsterScreech(pan, gain, t0) {
    var vol = clamp(gain * 1.2, 0, 1.2);
    var v = createVoice(pan, 0.75, 3.5);
    if (!v) return;

    var base = rnd(286, 336);
    var ratios = [1, 1.061, 1.129, 1.191];
    var i;
    // 失谐锯齿音簇：先上扬再塌落，被波形整形器烧成咆哮
    for (i = 0; i < ratios.length; i++) {
      sig(v, t0, {
        type: 'sawtooth',
        f0: base * ratios[i] * 0.72,
        f1: base * ratios[i] * 1.5,
        f2: base * ratios[i] * 0.55,
        glide: 0.26,
        glide2: 0.95,
        detune: rnd(-14, 14),
        peak: 0.15 * vol,
        attack: 0.02,
        hold: 0.30,
        decay: 0.72
      });
    }
    // 噪声扫频：高频撕裂 → 塌入胸腔
    sig(v, t0, {
      type: 'noise',
      peak: 0.26 * vol,
      attack: 0.015,
      hold: 0.26,
      decay: 0.76,
      rate: 1,
      filter: { type: 'bandpass', f0: 5400, f1: 2500, f2: 650, q: 3.0, glide: 0.28, glide2: 0.90 }
    });
    // 次低频下坠
    sig(v, t0, {
      type: 'sine',
      f0: 66,
      f1: 30,
      glide: 0.95,
      peak: 0.34 * vol,
      attack: 0.02,
      hold: 0.30,
      decay: 0.72,
      filter: { type: 'lowpass', f0: 150, q: 1.0 }
    });
    // 高频残响
    sig(v, t0 + 0.05, {
      type: 'noise',
      peak: 0.10 * vol,
      attack: 0.02,
      hold: 0.20,
      decay: 0.50,
      filter: { type: 'highpass', f0: 3200 }
    });
  }

  // 怪物搜索：低吼 + 抽鼻嗅探
  function sfxMonsterSearch(pan, gain, t0) {
    var v = createVoice(pan, 0.30);
    if (!v) return;
    var vol = gain * 0.90;
    sig(v, t0, {
      type: 'sawtooth',
      f0: rnd(62, 74),
      f1: rnd(48, 56),
      glide: 0.5,
      peak: 0.20 * vol,
      attack: 0.04,
      hold: 0.20,
      decay: 0.40,
      filter: { type: 'lowpass', f0: 320, q: 2.0 }
    });
    sig(v, t0, {
      type: 'noise',
      peak: 0.18 * vol,
      attack: 0.05,
      hold: 0.15,
      decay: 0.40,
      filter: { type: 'lowpass', f0: 500, f1: 260, q: 1.4, glide: 0.4 }
    });
    for (var i = 0; i < 3; i++) {
      sig(v, t0 + 0.12 + i * 0.16, {
        type: 'noise',
        peak: (0.13 - i * 0.02) * vol,
        attack: 0.02,
        hold: 0.05,
        decay: 0.09,
        rate: rnd(1.1, 1.5),
        filter: { type: 'bandpass', f0: rnd(900, 1400), f1: rnd(600, 900), q: 1.6, glide: 0.08 }
      });
    }
  }

  // 声呐回波（聆听机制）
  function sfxSonar(pan, gain, t0) {
    var v = createVoice(pan, 0.60);
    if (!v) return;
    var vol = gain * 0.80;
    sig(v, t0, {
      type: 'sine',
      f0: 760,
      f1: 690,
      glide: 0.4,
      peak: 0.22 * vol,
      attack: 0.012,
      hold: 0.02,
      decay: 0.50,
      filter: { type: 'lowpass', f0: 2200, q: 0.6 }
    });
    sig(v, t0, {
      type: 'sine',
      f0: 1140,
      f1: 1040,
      glide: 0.4,
      peak: 0.06 * vol,
      attack: 0.012,
      hold: 0.02,
      decay: 0.40
    });
    var v2 = createVoice(clamp(pan * 0.7, -1, 1), 0.90);
    if (v2) {
      sig(v2, t0 + 0.28, {
        type: 'sine',
        f0: 570,
        f1: 540,
        glide: 0.5,
        peak: 0.12 * vol,
        attack: 0.012,
        hold: 0.02,
        decay: 0.70,
        filter: { type: 'lowpass', f0: 1800, q: 0.7 }
      });
    }
  }

  // 玩家喘息
  function sfxGasp(pan, gain, t0, internal) {
    var v = createVoice(pan, 0.20);
    if (!v) return;
    var vol = clamp(gain, 0, 1) * (internal ? 0.70 : 1.0);
    sig(v, t0, {
      type: 'noise',
      peak: 0.42 * vol,
      attack: 0.028,
      hold: 0.10,
      decay: 0.14,
      rate: rnd(1.1, 1.4),
      filter: { type: 'bandpass', f0: rnd(700, 900), f1: rnd(1400, 1800), q: 0.8, glide: 0.14 }
    });
    sig(v, t0 + 0.05, {
      type: 'sine',
      f0: rnd(230, 260),
      f1: rnd(180, 200),
      glide: 0.2,
      peak: 0.05 * vol,
      attack: 0.03,
      hold: 0.05,
      decay: 0.20,
      filter: { type: 'lowpass', f0: 700 }
    });
    sig(v, t0 + 0.34, {
      type: 'noise',
      peak: 0.20 * vol,
      attack: 0.04,
      hold: 0.12,
      decay: 0.25,
      filter: { type: 'bandpass', f0: 520, f1: 280, q: 0.7, glide: 0.3 }
    });
  }

  // 电量低提示：温暖、克制的两声低沉提示
  function sfxBatteryLow(pan, gain, t0) {
    var v = createVoice(pan, 0.25);
    if (!v) return;
    var vol = gain * 0.50;
    for (var i = 0; i < 2; i++) {
      sig(v, t0 + i * 0.16, {
        type: 'triangle',
        f0: 415,
        f1: 392,
        glide: 0.1,
        peak: 0.18 * vol,
        attack: 0.012,
        hold: 0.05,
        decay: 0.10,
        filter: { type: 'lowpass', f0: 1800, q: 0.7 }
      });
      sig(v, t0 + i * 0.16, {
        type: 'sine',
        f0: 207,
        f1: 196,
        glide: 0.1,
        peak: 0.08 * vol,
        attack: 0.012,
        hold: 0.05,
        decay: 0.12,
        filter: { type: 'lowpass', f0: 600 }
      });
    }
  }

  // ★ 死亡：一击 + 低频下坠 + 立即切断环境声，留静默
  function sfxDeath(pan, gain, t0) {
    // 立即切断环境层 / 电闸循环 / 低频压迫层
    ambienceStop(true);
    stopBreakerLoop(true);
    deathUntil = t0 + 1.55;
    nextHeart = t0 + 999;
    breathTimer = 0.25;
    smooth.rumble = 0;
    smooth.hb = 0;
    if (rumble) {
      rampParam(rumble.out.gain, 0, t0, 0.01);
      rampParam(rumble.lfoDepth.gain, 0, t0, 0.01);
    }
    var v = createVoice(0, 0.55);
    if (!v) return;
    var vol = clamp(gain * 1.2, 0, 1.2) * 0.95;
    sig(v, t0, {
      type: 'noise',
      peak: 0.90 * vol,
      attack: 0.012,
      hold: 0.02,
      decay: 0.35,
      filter: { type: 'lowpass', f0: 5000, f1: 260, q: 0.8, glide: 0.30 }
    });
    sig(v, t0, {
      type: 'sine',
      f0: 92,
      f1: 30,
      glide: 1.0,
      peak: 0.90 * vol,
      attack: 0.012,
      hold: 0.05,
      decay: 1.00,
      filter: { type: 'lowpass', f0: 160, q: 1.1 }
    });
    sig(v, t0, {
      type: 'sawtooth',
      f0: 120,
      f1: 28,
      glide: 1.1,
      peak: 0.25 * vol,
      attack: 0.012,
      hold: 0.02,
      decay: 1.00,
      filter: { type: 'lowpass', f0: 300, f1: 80, q: 1.2, glide: 1.0 }
    });
  }

  // 胜利：温暖、遥远、带一点不安的解决和弦
  function sfxWin(pan, gain, t0) {
    var v = createVoice(pan, 0.80);
    if (!v) return;
    var vol = clamp(gain, 0, 1) * 0.75;
    var freqs = [146.83, 220.0, 293.66, 349.23, 440.0];
    for (var i = 0; i < freqs.length; i++) {
      sig(v, t0 + i * 0.06, {
        type: 'sine',
        f0: freqs[i],
        f1: freqs[i] * 1.002,
        glide: 2.80,
        peak: (0.16 / (1 + i * 0.35)) * vol,
        attack: 0.50,
        hold: 1.10,
        decay: 2.00,
        filter: { type: 'lowpass', f0: 2400, q: 0.5 }
      });
    }
    sig(v, t0 + 0.5, {
      type: 'sine',
      f0: 587.33,
      f1: 585,
      glide: 2.0,
      peak: 0.10 * vol,
      attack: 0.02,
      hold: 0.05,
      decay: 2.20,
      filter: { type: 'lowpass', f0: 3000, q: 0.5 }
    });
  }

  // UI 点击：极轻、不刺耳
  function sfxUiClick(pan, gain, t0) {
    var v = createVoice(pan, 0.15);
    if (!v) return;
    var vol = gain * 0.50;
    sig(v, t0, {
      type: 'noise',
      peak: 0.16 * vol,
      attack: 0.011,
      hold: 0.004,
      decay: 0.028,
      filter: { type: 'highpass', f0: 2800 }
    });
    sig(v, t0, {
      type: 'sine',
      f0: 900,
      f1: 760,
      glide: 0.03,
      peak: 0.10 * vol,
      attack: 0.011,
      hold: 0.004,
      decay: 0.05,
      filter: { type: 'lowpass', f0: 2600 }
    });
  }

  /* ============================================================
   * 6. 引擎自主驱动的连续声音
   * ============================================================ */

  // 心跳（lub-dub）：低频、贴耳、不刺耳
  function heartBeat(t0, hb) {
    var amp = 0.05 + 0.50 * Math.pow(clamp(hb, 0, 1), 0.85);
    var v = createVoice(0, 0.0);
    if (!v) return;
    sig(v, t0, {
      type: 'sine',
      f0: 54 + 6 * hb,
      f1: 34,
      glide: 0.14,
      peak: amp,
      attack: 0.012,
      hold: 0.02,
      decay: 0.19,
      filter: { type: 'lowpass', f0: 200, q: 1.1 }
    });
    sig(v, t0, {
      type: 'noise',
      peak: amp * 0.12,
      attack: 0.011,
      hold: 0.006,
      decay: 0.05,
      filter: { type: 'lowpass', f0: 300, q: 0.8 }
    });
    sig(v, t0 + 0.135, {
      type: 'sine',
      f0: 49 + 5 * hb,
      f1: 32,
      glide: 0.13,
      peak: amp * 0.58,
      attack: 0.011,
      hold: 0.015,
      decay: 0.16,
      filter: { type: 'lowpass', f0: 180, q: 1.0 }
    });
  }

  // 呼吸（吸气 + 呼气；力竭时加一次颤抖的尾息）
  function doBreath(t0, exhausted, moving, breathVal) {
    var v = createVoice(0, 0.08);
    if (!v) return;
    var vol = 0.05 *
      (exhausted ? 2.2 : 1) *
      (moving === 'sprint' ? 1.5 : (moving === 'sneak' ? 0.6 : 1)) *
      (0.9 + (1 - clamp(breathVal, 0, 1)) * 0.5);
    vol = clamp(vol, 0.01, 0.18);
    sig(v, t0, {
      type: 'noise',
      peak: 0.55 * vol,
      attack: 0.10,
      hold: 0.16,
      decay: 0.16,
      rate: rnd(0.85, 1.1),
      filter: { type: 'bandpass', f0: rnd(460, 520), f1: rnd(760, 860), q: 0.9, glide: 0.30 }
    });
    sig(v, t0 + 0.60, {
      type: 'noise',
      peak: 0.42 * vol,
      attack: 0.07,
      hold: 0.20,
      decay: 0.30,
      rate: rnd(0.9, 1.15),
      filter: { type: 'bandpass', f0: rnd(420, 480), f1: rnd(230, 290), q: 0.7, glide: 0.42 }
    });
    if (exhausted) {
      sig(v, t0 + 1.05, {
        type: 'noise',
        peak: 0.20 * vol,
        attack: 0.05,
        hold: 0.08,
        decay: 0.22,
        filter: { type: 'bandpass', f0: rnd(600, 760), f1: 420, q: 1.1, glide: 0.2 }
      });
    }
  }

  // 环境层随机事件：远处滴水
  function ambienceDrip() {
    if (!ctx || !ready) return;
    var t = nowAudio();
    var v = createVoice(rnd(-0.85, 0.85), 0.90);
    if (!v) return;
    var vol = rnd(0.35, 0.7);
    sig(v, t, {
      type: 'sine',
      f0: rnd(1250, 1600),
      f1: rnd(700, 900),
      glide: 0.06,
      peak: 0.10 * vol,
      attack: 0.011,
      hold: 0.006,
      decay: 0.16,
      filter: { type: 'lowpass', f0: 3200, q: 1.2 }
    });
    sig(v, t + 0.16, {
      type: 'sine',
      f0: rnd(1000, 1300),
      f1: 700,
      glide: 0.06,
      peak: 0.03 * vol,
      attack: 0.011,
      hold: 0.004,
      decay: 0.20,
      filter: { type: 'lowpass', f0: 1800 }
    });
  }

  // 环境层随机事件：建筑吱嘎
  function ambienceCreak() {
    if (!ctx || !ready) return;
    var t = nowAudio();
    var v = createVoice(rnd(-0.8, 0.8), 0.85);
    if (!v) return;
    var vol = rnd(0.4, 0.9);
    sig(v, t, {
      type: 'sawtooth',
      f0: rnd(48, 70),
      f1: rnd(60, 90),
      glide: 0.7,
      peak: 0.055 * vol,
      attack: 0.15,
      hold: 0.30,
      decay: 0.70,
      filter: { type: 'bandpass', f0: rnd(300, 520), f1: rnd(500, 900), q: 4.5, glide: 0.8 }
    });
    sig(v, t, {
      type: 'noise',
      peak: 0.05 * vol,
      attack: 0.20,
      hold: 0.30,
      decay: 0.70,
      filter: { type: 'bandpass', f0: rnd(600, 1100), f1: rnd(300, 500), q: 3.0, glide: 0.8 }
    });
    sig(v, t + 0.90, {
      type: 'sine',
      f0: 140,
      f1: 70,
      glide: 0.1,
      peak: 0.06 * vol,
      attack: 0.012,
      hold: 0.01,
      decay: 0.30,
      filter: { type: 'lowpass', f0: 400 }
    });
  }

  /* ---------- 环境层启动 / 停止 ---------- */

  function ambienceStart() {
    if (!ctx || !ready) return;
    if (ambience && ambience.on) return;
    if (!noiseBuffer) return;
    try {
      var t = nowAudio();
      var master = ctx.createGain();
      master.gain.value = 0.0001;
      master.connect(ambBus);

      var nodes = [master];
      var sources = [];

      // 风：低通白噪声 + 缓慢阵风
      var windSrc = ctx.createBufferSource();
      windSrc.buffer = noiseBuffer;
      windSrc.loop = true;
      var windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 300;
      windFilter.Q.value = 0.6;
      var windGain = ctx.createGain();
      windGain.gain.value = 0.045;
      windSrc.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);
      windSrc.start();
      sources.push(windSrc);
      nodes.push(windFilter, windGain);

      var gustOsc = ctx.createOscillator();
      gustOsc.type = 'sine';
      gustOsc.frequency.value = 0.067;
      var gustDepth = ctx.createGain();
      gustDepth.gain.value = 0.016;
      gustOsc.connect(gustDepth);
      gustDepth.connect(windGain.gain);
      gustOsc.start();
      sources.push(gustOsc);
      nodes.push(gustDepth);

      var cutOsc = ctx.createOscillator();
      cutOsc.type = 'sine';
      cutOsc.frequency.value = 0.031;
      var cutDepth = ctx.createGain();
      cutDepth.gain.value = 90;
      cutOsc.connect(cutDepth);
      cutDepth.connect(windFilter.frequency);
      cutOsc.start();
      sources.push(cutOsc);
      nodes.push(cutDepth);

      // 细窄的穿堂风啸声
      var whistleSrc = ctx.createBufferSource();
      whistleSrc.buffer = noiseBuffer;
      whistleSrc.loop = true;
      var whFilter = ctx.createBiquadFilter();
      whFilter.type = 'bandpass';
      whFilter.frequency.value = 820;
      whFilter.Q.value = 9;
      var whGain = ctx.createGain();
      whGain.gain.value = 0.006;
      whistleSrc.connect(whFilter);
      whFilter.connect(whGain);
      whGain.connect(master);
      whistleSrc.start();
      sources.push(whistleSrc);
      nodes.push(whFilter, whGain);

      var whOsc = ctx.createOscillator();
      whOsc.type = 'sine';
      whOsc.frequency.value = 0.021;
      var whDepth = ctx.createGain();
      whDepth.gain.value = 240;
      whOsc.connect(whDepth);
      whDepth.connect(whFilter.frequency);
      whOsc.start();
      sources.push(whOsc);
      nodes.push(whDepth);

      // 电流嗡鸣（update 按 power 驱动增益；0 电闸时完全听不到）
      var humGain = ctx.createGain();
      humGain.gain.value = 0;
      var hf = ctx.createBiquadFilter();
      hf.type = 'lowpass';
      hf.frequency.value = 420;
      hf.Q.value = 0.7;
      var h1 = ctx.createOscillator();
      h1.type = 'sine';
      h1.frequency.value = 50;
      var h2 = ctx.createOscillator();
      h2.type = 'sawtooth';
      h2.frequency.value = 100.4;
      var h2g = ctx.createGain();
      h2g.gain.value = 0.35;
      h1.connect(hf);
      h2.connect(h2g);
      h2g.connect(hf);
      hf.connect(humGain);
      humGain.connect(master);
      h1.start();
      h2.start();
      sources.push(h1, h2);
      nodes.push(hf, humGain, h2g);

      // 极轻的电流底噪
      var crSrc = ctx.createBufferSource();
      crSrc.buffer = noiseBuffer;
      crSrc.loop = true;
      var crf = ctx.createBiquadFilter();
      crf.type = 'bandpass';
      crf.frequency.value = 2400;
      crf.Q.value = 0.9;
      var crg = ctx.createGain();
      crg.gain.value = 0.0022;
      crSrc.connect(crf);
      crf.connect(crg);
      crg.connect(master);
      crSrc.start();
      sources.push(crSrc);
      nodes.push(crf, crg);

      master.gain.setValueAtTime(0.0001, t);
      master.gain.exponentialRampToValueAtTime(1, t + 1.0);

      smooth.hum = 0;
      ambience = {
        on: true,
        master: master,
        humGain: humGain,
        nodes: nodes,
        sources: sources,
        dripTimer: rnd(1.5, 4.0),
        creakTimer: rnd(2.0, 6.0)
      };
    } catch (e) {
      fail(e);
      ambience = null;
    }
  }

  function ambienceStop(immediate) {
    if (!ambience) return;
    var a = ambience;
    ambience = null;
    try {
      var t = nowAudio();
      var fade = immediate ? 0.02 : 0.45;
      try {
        if (a.master && a.master.gain) {
          if (a.master.gain.cancelAndHoldAtTime) {
            a.master.gain.cancelAndHoldAtTime(t);
          } else {
            a.master.gain.cancelScheduledValues(t);
          }
          a.master.gain.linearRampToValueAtTime(0.0001, t + fade);
        }
      } catch (e) { /* ignore */ }
      fadeAndStop(a.sources, a.nodes, t, fade, 0.04);
      smooth.hum = 0;
    } catch (e) {
      fail(e);
    }
  }

  /* ============================================================
   * 7. update：每帧驱动
   * ============================================================ */

  function update(dt, st) {
    if (!ctx || !ready) return;
    try {
      if (ctx.state === 'closed') {
        ready = false;
        syncCtxState();
        syncReady();
        return;
      }
      syncCtxState();
      dt = clamp(dt, 0, 0.1);
      st = (st && typeof st === 'object') ? st : {};

      var gs = typeof st.gameState === 'string' ? st.gameState : 'playing';
      var tNow = nowAudio();

      if (isNum(st.playerX)) listenerX = st.playerX;
      if (isNum(st.playerY)) listenerY = st.playerY;

      var playing = (gs === 'playing');
      var menuish = playing || gs === 'title' || gs === 'won';
      var silenced = tNow < deathUntil;

      var danger = clamp(num(st.danger, 0), 0, 1);
      var heartbeatIn = clamp(num(st.heartbeat, 0), 0, 1);
      var power = clamp(num(st.power, 0), 0, 1);
      var breathVal = clamp(num(st.breath, 1), 0, 1);
      var exhausted = !!st.exhausted;
      var hidden = !!st.hidden;
      var holding = !!st.holdingBreath;
      var moving = typeof st.moveState === 'string' ? st.moveState : 'idle';

      var mDist = Infinity;
      if (isNum(st.monsterDistance)) {
        mDist = st.monsterDistance;
      } else if (isNum(st.monsterX) && isNum(st.monsterY) && isNum(st.playerX) && isNum(st.playerY)) {
        var ddx = st.monsterX - st.playerX;
        var ddy = st.monsterY - st.playerY;
        mDist = Math.sqrt(ddx * ddx + ddy * ddy);
      }

      // 环境层兜底：若游戏端从未调用 startAmbience，首个 playing 帧自动开一次
      if (playing && !silenced && !ambience && !ambienceAutoTried) {
        ambienceAutoTried = true;
        ambienceStart();
      }

      /* ---- 心跳 ---- */
      var hbTarget = 0;
      if (playing && !silenced) {
        hbTarget = clamp(danger * 0.62 + heartbeatIn * 0.48, 0, 1);
      }
      smooth.hb += (hbTarget - smooth.hb) * Math.min(1, dt * 5);
      if (playing && !silenced && smooth.hb > 0.035) {
        var bpm = 48 + 87 * smooth.hb;
        if (tNow >= nextHeart) {
          heartBeat(tNow + 0.005, smooth.hb);
          nextHeart = tNow + 60 / bpm;
        }
      } else {
        nextHeart = tNow + 0.35;
      }

      /* ---- 呼吸 / 喘息 ---- */
      if (playing && !silenced) {
        var quiet = (hidden && holding);
        breathTimer -= dt;
        if (!quiet && breathTimer <= 0) {
          doBreath(tNow, exhausted, moving, breathVal);
          var base = moving === 'sprint' ? 2.0 : (moving === 'walk' ? 3.2 : (moving === 'sneak' ? 4.6 : 4.0));
          if (exhausted) base *= 0.6;
          base *= (0.75 + (1 - breathVal) * 0.7);
          breathTimer = Math.max(1.1, base) * rnd(0.85, 1.2);
        }
        if (quiet) breathTimer = Math.max(breathTimer, 0.25);

        if (!quiet && breathVal < 0.32 && tNow > nextGasp) {
          sfxGasp(0, 0.7, tNow, true);
          nextGasp = tNow + rnd(4.5, 8.5);
        }
      } else {
        breathTimer = 0.8;
      }

      /* ---- 危险低频压迫层（不盖过心跳） ---- */
      var rumbleTarget = 0;
      if (playing && !silenced) {
        var prox = 0;
        if (isFinite(mDist) && mDist < 14) {
          prox = Math.pow(clamp(1 - mDist / 14, 0, 1), 1.5);
        }
        rumbleTarget = Math.pow(danger, 1.5) * 0.115 + prox * 0.030;
        if (hidden) rumbleTarget *= 0.85;
        if (hidden && holding) rumbleTarget += 0.010;
        rumbleTarget = clamp(rumbleTarget, 0, 0.155);
      }
      if (!playing || silenced) {
        smooth.rumble *= Math.max(0, 1 - dt * 14);
      } else {
        smooth.rumble += (rumbleTarget - smooth.rumble) * Math.min(1, dt * 2.5);
      }
      if (rumble) {
        rampParam(rumble.out.gain, smooth.rumble, tNow, 0.12);
        rampParam(rumble.lfoDepth.gain, Math.max(0, smooth.rumble * 0.18), tNow, 0.15);
      }

      /* ---- 电流嗡鸣：power 越高越明显 ---- */
      var humTarget = 0;
      if (ambience && ambience.on && menuish && !silenced) {
        humTarget = 0.003 + power * 0.045;
      }
      smooth.hum += (humTarget - smooth.hum) * Math.min(1, dt * 3);
      if (ambience && ambience.humGain) {
        rampParam(ambience.humGain.gain, smooth.hum, tNow, 0.25);
      }

      /* ---- 环境层随机事件（滴水 / 建筑吱嘎） ---- */
      if (ambience && ambience.on && (playing || gs === 'title') && !silenced) {
        ambience.dripTimer -= dt;
        ambience.creakTimer -= dt;
        if (ambience.dripTimer <= 0) {
          ambienceDrip();
          ambience.dripTimer = rnd(3.5, 9.5);
        }
        if (ambience.creakTimer <= 0) {
          ambienceCreak();
          ambience.creakTimer = rnd(9.0, 22.0);
        }
      }
    } catch (e) {
      fail(e);
    }
  }

  /* ============================================================
   * 8. 一次性音效时长表（isPlaying 用）
   * ============================================================ */

  var DUR = {
    step_walk: 0.35,
    step_sprint: 0.40,
    step_sneak: 0.30,
    door: 1.10,
    breaker_loop_start: 0,
    breaker_loop_stop: 0,
    breaker_done: 1.50,
    throw: 0.50,
    impact: 0.40,
    pickup: 0.60,
    note: 0.80,
    gate: 1.80,
    lightning: 2.20,
    monster_click: 0.70,
    monster_step: 0.50,
    monster_screech: 1.10,
    monster_search: 0.90,
    sonar: 1.20,
    gasp: 0.80,
    battery_low: 0.40,
    death: 2.20,
    win: 3.80,
    ui_click: 0.12
  };

  /* ============================================================
   * 9. 对外 API
   * ============================================================ */

  var api = {
    ready: false,

    /**
     * 由开始按钮的用户手势调用。幂等；失败也绝不抛异常。
     */
    init: function () {
      try {
        if (ready && ctx && ctx.state !== 'closed') {
          safeResume();
          return;
        }
        if (initAttempted && !ctx) return;
        if (!AC) {
          initAttempted = true;
          ready = false;
          syncReady();
          return;
        }
        if (ctx && ctx.state === 'closed') {
          ctx = null;
          ready = false;
          initAttempted = false;
        }
        initAttempted = true;
        var c = new AC();
        ctx = c;
        buildGraph();
        ready = true;
        syncReady();
        syncCtxState();
        safeResume();
      } catch (e) {
        fail(e);
        ready = false;
        syncReady();
        try {
          if (ctx && typeof ctx.close === 'function') {
            var p = ctx.close();
            if (p && typeof p.catch === 'function') p.catch(noop);
          }
        } catch (e2) { /* ignore */ }
        ctx = null;
        initAttempted = false; // 创建失败后允许下次用户手势重试
        syncCtxState();
      }
    },

    resume: function () {
      try {
        if (!ctx) {
          if (AC) api.init();
          return;
        }
        safeResume();
      } catch (e) {
        fail(e);
      }
    },

    setMasterVolume: function (v) {
      try {
        masterVolume = clamp(v, 0, 1);
        if (masterGain) {
          var t = nowAudio();
          try {
            masterGain.gain.setTargetAtTime(masterVolume, t, 0.05);
          } catch (e) {
            masterGain.gain.value = masterVolume;
          }
        }
      } catch (e) {
        fail(e);
      }
    },

    setListener: function (x, y) {
      try {
        if (isNum(x)) listenerX = x;
        if (isNum(y)) listenerY = y;
      } catch (e) {
        fail(e);
      }
    },

    update: function (dt, state) {
      update(dt, state);
    },

    /**
     * 播放一次性音效 / 控制循环。
     * @param {string} name 事件名
     * @param {{x?:number,y?:number,vol?:number}} [opts]
     */
    play: function (name, opts) {
      try {
        if (!ready || !ctx) return;
        if (ctx.state === 'closed') {
          ready = false;
          syncReady();
          return;
        }
        if (typeof name !== 'string') return;

        var o = (opts && typeof opts === 'object') ? opts : {};
        var pan = 0;
        var atten = 1;
        if (isNum(o.x)) {
          var oy = isNum(o.y) ? o.y : listenerY;
          var dx = o.x - listenerX;
          var dy = oy - listenerY;
          pan = clamp(dx / 12, -1, 1);
          var dist = Math.sqrt(dx * dx + dy * dy);
          atten = clamp(1 / (1 + dist / 7), 0.04, 1);
        }
        var vol = clamp(isNum(o.vol) ? o.vol : 1, 0, 1);
        var gain = atten * vol;
        if (gain <= 0.002) return;

        var t = nowAudio() + 0.005;
        dbg.dispatched[name] = (dbg.dispatched[name] || 0) + 1;

        switch (name) {
          case 'step_walk': sfxStep(pan, gain, t, 'walk'); break;
          case 'step_sprint': sfxStep(pan, gain, t, 'sprint'); break;
          case 'step_sneak': sfxStep(pan, gain, t, 'sneak'); break;
          case 'door': sfxDoor(pan, gain, t); break;
          case 'breaker_loop_start': startBreakerLoop(pan, gain); break;
          case 'breaker_loop_stop': stopBreakerLoop(false); break;
          case 'breaker_done': sfxBreakerDone(pan, gain, t); break;
          case 'throw': sfxThrow(pan, gain, t); break;
          case 'impact': sfxImpact(pan, gain, t); break;
          case 'pickup': sfxPickup(pan, gain, t); break;
          case 'note': sfxNote(pan, gain, t); break;
          case 'gate': sfxGate(pan, gain, t); break;
          case 'lightning': sfxLightning(pan, gain, t); break;
          case 'monster_click': sfxMonsterClick(pan, gain, t); break;
          case 'monster_step': sfxMonsterStep(pan, gain, t); break;
          case 'monster_screech': sfxMonsterScreech(pan, gain, t); break;
          case 'monster_search': sfxMonsterSearch(pan, gain, t); break;
          case 'sonar': sfxSonar(pan, gain, t); break;
          case 'gasp': sfxGasp(pan, gain, t, false); break;
          case 'battery_low': sfxBatteryLow(pan, gain, t); break;
          case 'death': sfxDeath(pan, gain, t); break;
          case 'win': sfxWin(pan, gain, t); break;
          case 'ui_click': sfxUiClick(pan, gain, t); break;
          default: break;
        }

        var dur = isNum(DUR[name]) ? DUR[name] : 0.5;
        if (dur > 0) {
          lastPlayed[name] = Math.max(lastPlayed[name] || 0, t + dur);
        }
      } catch (e) {
        fail(e);
      }
    },

    startAmbience: function () {
      try {
        ambienceStart();
      } catch (e) {
        fail(e);
      }
    },

    stopAmbience: function () {
      try {
        ambienceStop(false);
      } catch (e) {
        fail(e);
      }
    },

    isPlaying: function (name) {
      try {
        if (!ready || !ctx) return false;
        if (typeof name !== 'string') return false;
        if (name === 'breaker_loop_start') return !!(breaker && breaker.on);
        if (name === 'breaker_loop_stop') return false;
        if (name === 'ambience') return !!(ambience && ambience.on);
        var until = lastPlayed[name];
        return isNum(until) && nowAudio() < until;
      } catch (e) {
        return false;
      }
    },

    // 只读调试信息（自测页使用；游戏端无需关心）
    _debug: dbg
  };

  // 窗口隐藏时挂起，恢复时恢复（不使用任何 DOM 元素）
  try {
    if (typeof global.document !== 'undefined' && global.document.addEventListener) {
      global.document.addEventListener('visibilitychange', function () {
        try {
          if (!ctx) return;
          if (global.document.hidden) {
            if (ctx.state === 'running' && typeof ctx.suspend === 'function') {
              var sp = ctx.suspend();
              if (sp && typeof sp.catch === 'function') sp.catch(noop);
            }
          } else {
            safeResume();
          }
        } catch (e) { /* ignore */ }
      }, false);
    }
  } catch (e) { /* ignore */ }

  global.AudioEngine = api;
})(typeof window !== 'undefined' ? window : this);
