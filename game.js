// Pool 3D — controller: alur game, input, kamera, bot, online (Firebase), HUD, suara.
(function () {
  'use strict';
  const E = PoolEngine, S = PoolScene, T = E.TABLE;
  const $ = id => document.getElementById(id);
  const R = T.R;

  // ---------- penyimpanan lokal ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pool3d.' + k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pool3d.' + k, v); } catch (e) { /* abaikan */ } },
  };
  let myId = store.get('uid', '');
  if (!myId) { myId = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); store.set('uid', myId); }
  const playerName = () => ($('nameIn').value.trim() || 'Pemain').slice(0, 16);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LEVELS = ['Mudah', 'Sedang', 'Sulit'];

  // ---------- state ----------
  const G = {
    mode: null,          // 'bot' | 'local' | 'online'
    state: null,
    names: ['', ''],
    bot: [false, false],
    botLevel: 1,
    mySeat: 0,
    anim: null,
    pending: null,
    lastJson: '',
    animSeq: -1,
    lastShot: null,
    aim: { th: 0, power: 0, sx: 0, sy: 0 },
    cuePos: null,
    placing: null,       // posisi kandidat saat drag bola putih {x,z,ok}
    view: 'aim',         // preferensi: 'aim' | 'top'
    camMode: 'free',
    aimPitch: 0.26,
    aimDist: 0.8,
    botBusy: false,
    botAim: null,
    remoteAim: null,
    shownAim: null,
    disc: [0, 0],
    guide: store.get('guide', '1') === '1', // garis arah setelah tumbukan
  };

  // ---------- suara ----------
  const Sound = {
    ctx: null,
    on: store.get('snd', '1') === '1',
    budget: 0,
    init() {
      if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ctx = null; } }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(freq, vol, dur, type, delay) {
      if (!this.on || !this.ctx || vol <= 0.003) return;
      const c = this.ctx, t = c.currentTime + (delay || 0);
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    noise(vol, dur, freq, delay) {
      if (!this.on || !this.ctx || vol <= 0.003) return;
      const c = this.ctx, t = c.currentTime + (delay || 0);
      const n = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const s = c.createBufferSource(); s.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
      const g = c.createGain(); g.gain.value = vol;
      s.connect(f).connect(g).connect(c.destination); s.start(t);
    },
    ball(v) { if (this.budget-- <= 0) return; const k = Math.min(1, v / 3.5); this.tone(2600 + Math.random() * 700, 0.35 * k, 0.05); this.noise(0.25 * k, 0.03, 3800); },
    cush(v) { if (this.budget-- <= 0) return; const k = Math.min(1, v / 3.5); this.tone(120, 0.45 * k, 0.1); this.noise(0.12 * k, 0.05, 600); },
    pocket() { this.tone(80, 0.5, 0.3, 'triangle'); this.noise(0.25, 0.15, 900, 0.05); this.tone(1800, 0.08, 0.05, 'sine', 0.12); },
    cue(v) { const k = Math.min(1, 0.3 + v / 7); this.tone(700, 0.35 * k, 0.06, 'triangle'); this.noise(0.3 * k, 0.03, 2000); },
    tick() { this.tone(1200, 0.05, 0.03); },
  };

  // ---------- util ----------
  const powerToV = p => T.MIN_V + (T.MAX_V - T.MIN_V) * Math.pow(p, 1.4);
  const vToPower = v => Math.pow(Math.max(0, (v - T.MIN_V) / (T.MAX_V - T.MIN_V)), 1 / 1.4);
  const yawOf = th => Math.atan2(-Math.cos(th), -Math.sin(th));
  const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  function isCtrlSeat(seat) {
    if (G.mode === 'local') return true;
    if (G.mode === 'bot') return !G.bot[seat];
    if (G.mode === 'online') return seat === G.mySeat;
    return false;
  }
  function overlayOpen() { return !$('overlay').hidden; }
  function canShoot() {
    const s = G.state;
    return !!s && s.win < 0 && !G.anim && !G.botAim && isCtrlSeat(s.turn) && !overlayOpen();
  }
  function cuePosNow() {
    if (G.cuePos) return G.cuePos;
    const b = G.state ? G.state.balls[0] : { x: T.HEAD_X - 0.12, z: 0 };
    return { x: b.x, z: b.z };
  }

  let toastTimer = 0;
  function toast(msg, cls, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.className = cls || '';
    el.hidden = false;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3200);
  }

  function showCard(id) {
    $('overlay').hidden = false;
    for (const c of ['menu', 'lobby', 'result', 'help']) $(c).hidden = c !== id;
    refreshControls();
  }
  function hideOverlay() { $('overlay').hidden = true; refreshControls(); }

  // ---------- HUD ----------
  const BALL_COL = { 1: '#f2b705', 2: '#1b47c9', 3: '#d11f1f', 4: '#5a2a8c', 5: '#f0741a', 6: '#127a3b', 7: '#7c1b1b', 8: '#111' };
  function miniBall(id, gone) {
    const col = BALL_COL[id > 8 ? id - 8 : id];
    const bg = id > 8 ? `linear-gradient(#f7f3e8 24%, ${col} 24% 76%, #f7f3e8 76%)` : col;
    return `<i class="mb${gone ? ' gone' : ''}" style="background:${bg}"><span>${id}</span></i>`;
  }
  function updateHUD() {
    const s = G.state;
    if (!s) return;
    for (let seat = 0; seat < 2; seat++) {
      const el = $('pl' + seat);
      let tag = '';
      if (G.mode === 'bot' && G.bot[seat]) tag = '🤖 ' + LEVELS[G.botLevel];
      else if ((G.mode === 'bot' || G.mode === 'online') && isCtrlSeat(seat)) tag = 'kamu';
      const off = G.mode === 'online' && G.disc[seat] ? ' <span class="off">● terputus</span>' : '';
      el.querySelector('.nm').innerHTML = esc(G.names[seat] || '—') + (tag ? ` <small>${tag}</small>` : '') + off;
      const g = s.g[seat];
      let html = '';
      if (!g) html = '<span class="open">Meja terbuka</span>';
      else {
        const ids = E.GROUP_IDS[g];
        const left = ids.filter(id => s.balls[id].on).length;
        for (const id of ids) html += miniBall(id, !s.balls[id].on);
        html += miniBall(8, left > 0);
      }
      el.querySelector('.balls').innerHTML = html;
      el.classList.toggle('turn', s.win < 0 && s.turn === seat);
    }
    let info = '';
    if (s.win >= 0) info = '🏆 ' + (G.names[s.win] || '') + ' menang';
    else {
      const who = G.names[s.turn] || '';
      if (G.mode === 'online' && G.mySeat < 0) info = 'Giliran ' + who;
      else if (G.mode !== 'local' && isCtrlSeat(s.turn)) info = 'Giliran kamu';
      else info = 'Giliran ' + who;
      if (s.brk) info += ' · Break';
      else if (s.bih) info += ' · Bola di tangan';
    }
    if (G.botBusy && !G.botAim) info = '🤖 Bot berpikir…';
    $('turnInfo').textContent = info;
  }

  function refreshControls() {
    const on = canShoot();
    $('power').hidden = !on;
    $('spinBox').hidden = !on;
    $('fineAim').hidden = !on;
    let hint = '';
    if (on) {
      hint = 'Drag untuk membidik · tarik POWER ke bawah & lepas untuk memukul';
      if (G.state.bih) hint = (G.state.kitchen ? 'Bola di tangan (di belakang garis) — ' : 'Bola di tangan — ') + 'drag bola putih untuk memindahkan';
    }
    $('hint').textContent = hint;
    $('hint').hidden = !hint;
    updatePowerUI();
  }

  function updatePowerUI() {
    const p = G.aim.power;
    const bar = $('powerBar');
    const h = bar.clientHeight || 1;
    $('powerFill').style.height = (p * 100) + '%';
    $('powerKnob').style.top = Math.max(0, Math.min(h - 8, p * h - 4)) + 'px';
    $('powerVal').textContent = Math.round(p * 100) + '%';
  }
  function updateSpinUI() {
    const d = $('spinDot');
    d.style.left = (50 + G.aim.sx * 50) + '%';
    d.style.top = (50 - G.aim.sy * 50) + '%';
  }

  // ---------- kamera ----------
  function setTopGoal() {
    const g = S.camGoal;
    const tanH = Math.tan(22.5 * Math.PI / 180);
    const hx = T.L + 0.2, hz = T.W + 0.2;
    const a = S.aspect;
    g.target.set(0, 0, 0);
    g.pitch = 1.553;
    if (a >= 1) { g.yaw = 0; g.dist = Math.max(hz / tanH, hx / (tanH * a)); }
    else { g.yaw = Math.PI / 2; g.dist = Math.max(hx / tanH, hz / (tanH * a)); }
  }
  function setCamMode(mode) {
    G.camMode = mode;
    const g = S.camGoal;
    if (mode === 'aim') { g.pitch = G.aimPitch; g.dist = G.aimDist; }
    else if (mode === 'free') { g.target.set(0, 0, 0); g.pitch = 0.9; g.dist = 3.0; }
    else if (mode === 'top') setTopGoal();
  }
  function camForState() {
    if (G.anim) {
      if (G.view === 'top') setCamMode('top');
      else {
        G.camMode = 'free';
        const c = cuePosNow(), g = S.camGoal;
        g.target.set(c.x * 0.4, 0, c.z * 0.4);
        g.pitch = 0.95; g.dist = 2.5;
      }
      return;
    }
    if (canShoot()) setCamMode(G.view === 'top' ? 'top' : 'aim');
    else if (G.view === 'top') setCamMode('top');
    else if (G.camMode !== 'free') setCamMode('free');
  }
  function camFrame() {
    const g = S.camGoal;
    if (G.camMode === 'top') setTopGoal();
    else if (G.camMode === 'aim') {
      const c = cuePosNow();
      g.target.set(c.x, 0.02, c.z);
      g.yaw = yawOf(G.aim.th);
    }
  }

  // ---------- alur game ----------
  function autoAim() {
    const s = G.state;
    const c = cuePosNow();
    let best = null, bd = 1e9;
    const targets = s.brk ? [1] : E.legalTargets(s, s.turn);
    for (const id of targets) {
      const b = s.balls[id];
      if (!b.on) continue;
      const d = Math.hypot(b.x - c.x, b.z - c.z);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) G.aim.th = Math.atan2(best.z - c.z, best.x - c.x);
  }

  function setState(s, fromShot) {
    G.state = s;
    G.lastJson = JSON.stringify(s);
    G.placing = null;
    S.setBalls(s.balls);
    G.cuePos = s.bih ? { x: s.balls[0].x, z: s.balls[0].z } : null;
    G.aim.power = 0;
    S.setKitchen(s.kitchen && s.bih);
    if (s.win < 0) {
      if ($('result').hidden === false) hideOverlay();
      if (isCtrlSeat(s.turn)) autoAim();
    }
    if (fromShot && s.msg) toast(s.msg, s.foul ? 'foul' : '', s.foul ? 4200 : 3000);
    updateHUD();
    refreshControls();
    camForState();
    if (s.win >= 0) setTimeout(() => { if (G.state === s) showResult(); }, fromShot ? 1100 : 200);
    maybeBot();
    maybeRemoteShot();
  }

  function startShot(shot) {
    const base = G.state;
    G.animSeq = shot.seq;
    const sim = E.createSim(base.balls, shot);
    if (typeof shot.cx === 'number') G.cuePos = { x: shot.cx, z: shot.cz };
    const c = sim.balls[0];
    S.setBalls(base.balls);
    S.moveBall(0, c.x, c.z);
    const n = Math.hypot(shot.dx, shot.dz) || 1;
    G.anim = {
      sim, shot, base, phase: 'strike', t: 0, acc: 0,
      cx: c.x, cz: c.z, dx: shot.dx / n, dz: shot.dz / n,
      pull: 0.02 + vToPower(shot.v) * 0.26,
    };
    G.aim.power = 0;
    S.setAim(null);
    S.setPlaceRing(false);
    refreshControls();
    updateHUD();
  }

  function stepAnim(dt) {
    const a = G.anim;
    if (a.phase === 'strike') {
      a.t += dt;
      const k = Math.min(1, a.t / 0.1);
      S.setCue(true, a.cx, a.cz, a.dx, a.dz, a.pull * (1 - k * k), a.shot.sx || 0, a.shot.sy || 0);
      if (k >= 1) { a.phase = 'roll'; a.t = 0; Sound.cue(a.shot.v); camForState(); }
      return;
    }
    a.t += dt;
    if (a.t < 0.25) S.setCue(true, a.cx, a.cz, a.dx, a.dz, -Math.min(0.06, a.t * 0.4), a.shot.sx || 0, a.shot.sy || 0);
    else S.setCue(false);
    a.acc += dt;
    let n = Math.floor(a.acc / T.DT);
    a.acc -= n * T.DT;
    n = Math.min(n, 400);
    const sim = a.sim;
    for (let i = 0; i < n && !sim.done; i++) E.step(sim);
    Sound.budget = 5;
    for (const f of sim.fx) {
      if (f.t === 'ball') Sound.ball(f.v);
      else if (f.t === 'cush') Sound.cush(f.v);
      else if (f.t === 'pocket') { Sound.pocket(); S.sinkBall(f.id, f.pocket); }
    }
    sim.fx.length = 0;
    for (const b of sim.balls) if (b.on) S.moveBall(b.id, b.x, b.z);
    if (sim.done) finishShot();
  }

  function finishShot() {
    const a = G.anim;
    G.anim = null;
    S.setCue(false);
    const res = E.simResult(a.sim);
    let ns = E.applyShot(a.base, a.shot, res);
    if (G.mode === 'online') {
      if (G.pending && G.pending.seq >= ns.seq) ns = G.pending;
      else Net.commit(ns);
    }
    G.pending = null;
    setState(ns, true);
  }

  function shoot() {
    if (!canShoot()) return;
    const p = G.aim.power;
    if (p < 0.01) return;
    const s = G.state;
    const c = cuePosNow();
    if (s.bih && !E.validCuePos(s.balls, c.x, c.z, s.kitchen)) { toast('Posisi bola putih tidak sah', 'foul'); return; }
    const shot = { seq: s.seq + 1, dx: Math.cos(G.aim.th), dz: Math.sin(G.aim.th), v: powerToV(p), sx: G.aim.sx, sy: G.aim.sy };
    if (s.bih) { shot.cx = c.x; shot.cz = c.z; }
    if (G.mode === 'online') Net.sendShot(shot);
    startShot(shot);
  }

  function newLocalGame(breaker) {
    const s = E.newGame(breaker, Math.random);
    G.animSeq = -1; G.anim = null; G.pending = null; G.botAim = null; G.botBusy = false;
    hideOverlay();
    $('hud').hidden = false; $('tbtns').hidden = false;
    setState(s, false);
    toast((G.names[breaker] || '') + ' melakukan break', '', 2200);
  }

  function showResult() {
    const s = G.state;
    if (!s || s.win < 0) return;
    let title;
    if (G.mode === 'local' || (G.mode === 'online' && G.mySeat < 0)) title = '🏆 ' + G.names[s.win] + ' Menang!';
    else title = isCtrlSeat(s.win) ? '🏆 Kamu Menang!' : '😞 Kamu Kalah';
    $('resTitle').textContent = title;
    $('resReason').textContent = s.winReason || '';
    $('btnAgain').hidden = G.mode === 'online' && G.mySeat < 0;
    $('btnAgain').disabled = false;
    $('resWait').hidden = true;
    showCard('result');
  }

  // ---------- bot ----------
  let worker = null, reqId = 0;
  const reqs = {};
  try {
    worker = new Worker('bot-worker.js');
    worker.onmessage = e => { const f = reqs[e.data.id]; delete reqs[e.data.id]; if (f) f(e.data.shot); };
    worker.onerror = () => {
      worker = null;
      for (const id in reqs) { const f = reqs[id]; delete reqs[id]; f(null); }
    };
  } catch (e) { worker = null; }
  // hitung di worker jika ada; kalau tidak (mis. file://) hitung langsung
  function planBotSend(st, lvl) {
    const seed = (Math.random() * 1e9) >>> 0;
    return new Promise(res => {
      const sync = () => setTimeout(() => res(E.botPlan(st, lvl, seed)), 30);
      if (!worker) return sync();
      const id = ++reqId;
      reqs[id] = shot => (shot ? res(shot) : sync());
      worker.postMessage({ id, state: st, level: lvl, seed });
    });
  }

  function maybeBot() {
    const s = G.state;
    if (G.mode !== 'bot' || !s || s.win >= 0 || G.anim || G.botBusy || !G.bot[s.turn]) return;
    G.botBusy = true;
    updateHUD();
    const t0 = performance.now();
    planBotSend(s, G.botLevel).then(shot => {
      if (G.state !== s || G.mode !== 'bot') { G.botBusy = false; return; }
      const wait = Math.max(0, 600 - (performance.now() - t0));
      setTimeout(() => {
        if (G.state !== s) { G.botBusy = false; return; }
        const c = typeof shot.cx === 'number' ? { x: shot.cx, z: shot.cz } : cuePosNow();
        if (s.bih) G.cuePos = c;
        G.botAim = { t: 0, from: G.aim.th, to: Math.atan2(shot.dz, shot.dx), shot, pow: vToPower(shot.v) };
        G.aim.sx = shot.sx || 0; G.aim.sy = shot.sy || 0;
        updateHUD();
      }, wait);
    });
  }
  function stepBotAim(dt) {
    const b = G.botAim;
    b.t += dt;
    const k = Math.min(1, b.t / 0.9);
    const e = k * k * (3 - 2 * k);
    G.aim.th = b.from + angDiff(b.from, b.to) * e;
    G.aim.power = b.t > 1.0 ? Math.min(b.pow, (b.t - 1.0) / 0.5 * b.pow) : 0;
    if (b.t > 1.75) {
      G.botAim = null;
      G.botBusy = false;
      G.aim.th = b.to;
      startShot(b.shot);
      G.aim.sx = 0; G.aim.sy = 0;
    }
  }

  // ---------- visual bidikan ----------
  function aimVisuals() {
    const s = G.state;
    if (!s || s.win >= 0 || G.anim) { S.setAim(null); S.setPlaceRing(false); if (!G.anim) S.setCue(false); return; }
    let th, power, sx, sy, cue, mine = false;
    if (canShoot() || G.botAim) {
      th = G.aim.th; power = G.aim.power; sx = G.aim.sx; sy = G.aim.sy; cue = cuePosNow(); mine = canShoot();
    } else if (G.mode === 'online' && G.remoteAim && G.remoteAim.seq === s.seq) {
      const ra = G.remoteAim;
      if (!G.shownAim) G.shownAim = { th: ra.th, p: ra.p };
      G.shownAim.th += angDiff(G.shownAim.th, ra.th) * 0.25;
      G.shownAim.p += (ra.p - G.shownAim.p) * 0.3;
      th = G.shownAim.th; power = G.shownAim.p; sx = ra.sx || 0; sy = ra.sy || 0;
      cue = (s.bih && typeof ra.cx === 'number') ? { x: ra.cx, z: ra.cz } : { x: s.balls[0].x, z: s.balls[0].z };
    } else { S.setAim(null); S.setCue(false); S.setPlaceRing(false); return; }
    const pl = G.placing;
    const cp = pl || cue;
    S.moveBall(0, cp.x, cp.z);
    const dx = Math.cos(th), dz = Math.sin(th);
    S.setCue(true, cp.x, cp.z, dx, dz, 0.015 + power * 0.26, sx, sy);
    const others = s.balls.filter(b => b.id !== 0);
    const p = E.predictAim(others, cp.x, cp.z, dx, dz);
    let bad = false;
    if (p.type === 'ball' && !s.brk) bad = E.legalTargets(s, s.turn).indexOf(p.id) < 0;
    S.setAim({ cx: cp.x, cz: cp.z, p, bad, long: G.mode !== 'bot' || G.botLevel < 2, after: G.guide });
    if (mine && s.bih) S.setPlaceRing(true, cp.x, cp.z, pl ? pl.ok : true);
    else S.setPlaceRing(false);
  }

  // ---------- input ----------
  const canvas = $('c');
  const ptrs = new Map();
  let drag = null, pinch0 = 0;
  function setAimToward(p) {
    const c = cuePosNow();
    if (Math.hypot(p.x - c.x, p.z - c.z) < 0.01) return;
    G.aim.th = Math.atan2(p.z - c.z, p.x - c.x);
  }
  canvas.addEventListener('pointerdown', e => {
    Sound.init();
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      drag = { type: 'pinch', dist0: G.camMode === 'aim' ? G.aimDist : S.camGoal.dist };
      return;
    }
    drag = { type: 'rotate', x: e.clientX, y: e.clientY, moved: 0 };
    if (canShoot()) {
      const p = S.pickTable(e.clientX, e.clientY);
      const c = cuePosNow();
      if (G.state.bih && p && Math.hypot(p.x - c.x, p.z - c.z) < R * 2.6) drag.type = 'cue';
      else if (G.camMode === 'top' && p) { drag.type = 'aimPoint'; setAimToward(p); }
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!drag) return;
    if (drag.type === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomTo(drag.dist0 * pinch0 / Math.max(20, d));
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.type === 'cue') {
      if (!canShoot()) return;
      const p = S.pickTable(e.clientX, e.clientY);
      if (!p) return;
      const x = Math.max(-T.L + R, Math.min(T.L - R, p.x));
      const z = Math.max(-T.W + R, Math.min(T.W - R, p.z));
      const s = G.state;
      const ok = E.validCuePos(s.balls, x, z, s.kitchen);
      G.placing = { x, z, ok };
      if (ok) G.cuePos = { x, z };
    } else if (drag.type === 'aimPoint') {
      const p = S.pickTable(e.clientX, e.clientY);
      if (p && canShoot()) setAimToward(p);
    } else if (drag.type === 'rotate') {
      const fine = e.shiftKey ? 0.15 : 1;
      if (G.camMode === 'aim' && canShoot()) {
        G.aim.th += dx * 0.0045 * fine;
        G.aimPitch = Math.max(0.06, Math.min(1.3, G.aimPitch + dy * 0.004));
        S.camGoal.pitch = G.aimPitch;
      } else if (G.camMode !== 'top') {
        S.camGoal.yaw -= dx * 0.006;
        S.camGoal.pitch = Math.max(0.1, Math.min(1.5, S.camGoal.pitch + dy * 0.005));
      }
    }
  });
  const endPtr = e => {
    ptrs.delete(e.pointerId);
    if (drag && drag.type === 'cue') {
      if (G.placing && !G.placing.ok) toast('Posisi tidak sah' + (G.state.kitchen ? ' — saat break bola putih harus di belakang garis' : ''), 'foul', 1800);
      G.placing = null;
    }
    if (ptrs.size === 0) drag = null;
  };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);
  function zoomTo(d) {
    if (G.camMode === 'aim') { G.aimDist = Math.max(0.3, Math.min(2.5, d)); S.camGoal.dist = G.aimDist; }
    else if (G.camMode === 'free') S.camGoal.dist = Math.max(0.6, Math.min(5, d));
  }
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const cur = G.camMode === 'aim' ? G.aimDist : S.camGoal.dist;
    zoomTo(cur * (1 + Math.sign(e.deltaY) * 0.1));
  }, { passive: false });

  // power bar
  const pbar = $('powerBar');
  let powering = false;
  const setPowerFromY = y => {
    const r = pbar.getBoundingClientRect();
    G.aim.power = Math.max(0, Math.min(1, (y - r.top) / r.height));
    updatePowerUI();
  };
  $('power').addEventListener('pointerdown', e => {
    if (!canShoot()) return;
    Sound.init();
    powering = true;
    $('power').setPointerCapture(e.pointerId);
    setPowerFromY(e.clientY);
  });
  $('power').addEventListener('pointermove', e => { if (powering) setPowerFromY(e.clientY); });
  const powerUp = () => {
    if (!powering) return;
    powering = false;
    if (G.aim.power > 0.02) shoot();
    else { G.aim.power = 0; updatePowerUI(); }
  };
  $('power').addEventListener('pointerup', powerUp);
  $('power').addEventListener('pointercancel', () => { powering = false; G.aim.power = 0; updatePowerUI(); });

  // spin
  const spinEl = $('spin');
  let spinning = false;
  const setSpin = e => {
    const r = spinEl.getBoundingClientRect();
    let x = ((e.clientX - r.left) / r.width) * 2 - 1, y = -(((e.clientY - r.top) / r.height) * 2 - 1);
    const d = Math.hypot(x, y);
    if (d > 0.8) { x *= 0.8 / d; y *= 0.8 / d; }
    G.aim.sx = x; G.aim.sy = y;
    updateSpinUI();
  };
  spinEl.addEventListener('pointerdown', e => { spinning = true; spinEl.setPointerCapture(e.pointerId); setSpin(e); });
  spinEl.addEventListener('pointermove', e => { if (spinning) setSpin(e); });
  spinEl.addEventListener('pointerup', () => { spinning = false; });
  $('spinReset').onclick = () => { G.aim.sx = G.aim.sy = 0; updateSpinUI(); };

  // bidik halus
  let fineTimer = 0;
  const fineStart = dir => e => {
    e.preventDefault();
    clearInterval(fineTimer);
    let n = 0;
    const tick = () => { if (canShoot()) G.aim.th += dir * (n++ < 10 ? 0.0012 : 0.003); };
    tick();
    fineTimer = setInterval(tick, 30);
  };
  const fineStop = () => clearInterval(fineTimer);
  for (const [id, dir] of [['aimL', -1], ['aimR', 1]]) {
    const b = $(id);
    b.addEventListener('pointerdown', fineStart(dir));
    b.addEventListener('pointerup', fineStop);
    b.addEventListener('pointerleave', fineStop);
    b.addEventListener('pointercancel', fineStop);
  }

  window.addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    const k = e.key;
    if (k === 't' || k === 'T') { toggleView(); return; }
    if (k === 'g' || k === 'G') { toggleGuide(); return; }
    if (!canShoot()) return;
    const fine = e.shiftKey ? 0.0015 : 0.01;
    if (k === 'ArrowLeft') { G.aim.th -= fine; e.preventDefault(); }
    else if (k === 'ArrowRight') { G.aim.th += fine; e.preventDefault(); }
    else if (k === 'ArrowUp') { G.aim.power = Math.min(1, G.aim.power + 0.05); updatePowerUI(); e.preventDefault(); }
    else if (k === 'ArrowDown') { G.aim.power = Math.max(0, G.aim.power - 0.05); updatePowerUI(); e.preventDefault(); }
    else if (k === ' ') { e.preventDefault(); Sound.init(); if (G.aim.power < 0.02) toast('Atur power dulu (↑ atau bar POWER)', '', 1500); else shoot(); }
  });

  function toggleView() {
    G.view = G.view === 'top' ? 'aim' : 'top';
    if (G.view === 'top') setCamMode('top');
    else camForState();
    if (G.view === 'aim' && G.camMode === 'top') setCamMode('free');
  }
  $('btnView').onclick = toggleView;
  const soundBtn = () => { $('btnSound').textContent = Sound.on ? '🔊' : '🔇'; };
  $('btnSound').onclick = () => { Sound.on = !Sound.on; store.set('snd', Sound.on ? '1' : '0'); soundBtn(); Sound.init(); };
  soundBtn();
  const guideBtn = () => {
    $('btnGuide').classList.toggle('off', !G.guide);
    $('btnGuide').title = 'Garis arah setelah tumbukan: ' + (G.guide ? 'ON' : 'OFF') + ' (G)';
  };
  function toggleGuide() {
    G.guide = !G.guide;
    store.set('guide', G.guide ? '1' : '0');
    guideBtn();
    toast('Garis arah setelah tumbukan: ' + (G.guide ? 'ON' : 'OFF'), '', 1400);
  }
  $('btnGuide').onclick = toggleGuide;
  guideBtn();
  $('btnHelp').onclick = () => { G.helpFrom = $('overlay').hidden ? null : [...document.querySelectorAll('.card')].find(c => !c.hidden)?.id; showCard('help'); };
  $('btnHelpClose').onclick = () => { if (G.helpFrom) showCard(G.helpFrom); else hideOverlay(); };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && G.anim) {
      E.runSim(G.anim.sim);
      G.anim.sim.fx.length = 0;
      finishShot();
    }
  });

  // ---------- loop ----------
  let last = performance.now();
  let menuSpin = 0;
  function loop(now) {
    const raw = Math.min(0.25, (now - last) / 1000);
    const dt = Math.min(0.05, raw);
    last = now;
    if (G.anim) stepAnim(raw);
    else {
      if (G.botAim) stepBotAim(dt);
      aimVisuals();
    }
    if (!G.state || (G.mode === null)) {
      menuSpin += dt * 0.08;
      S.camGoal.yaw = menuSpin; S.camGoal.pitch = 0.55; S.camGoal.dist = 2.9; S.camGoal.target.set(0, 0, 0);
    } else camFrame();
    S.frame(dt);
    Net.tickAim();
    requestAnimationFrame(loop);
  }

  // ---------- ONLINE ----------
  const SV = () => firebase.database.ServerValue.TIMESTAMP;
  const Net = {
    db: null, ref: null, code: null, seats: [null, null], players: {}, status: null, lastAimSent: '', lastAimT: 0,
    init() {
      if (this.db) return this.db;
      try {
        if (!window.firebase || !window.POOL_FIREBASE_CONFIG) throw new Error('no firebase');
        const app = firebase.apps.find(a => a.name === 'pool') || firebase.initializeApp(window.POOL_FIREBASE_CONFIG, 'pool');
        this.db = app.database();
        this.db.ref('.info/connected').on('value', s => {
          const on = !!s.val();
          $('connDot').classList.toggle('on', on);
          $('connTxt').textContent = on ? 'Terhubung ke server' : 'Menghubungkan…';
        });
      } catch (e) {
        console.error(e);
        $('connTxt').textContent = 'Firebase tidak tersedia (buka lewat http://, bukan file://)';
      }
      return this.db;
    },
    R(p) { return this.db.ref('pool/' + p); },
    async listRooms() {
      if (!this.init()) return;
      const el = $('roomList');
      try {
        const snap = await this.R('rooms').orderByChild('created').limitToLast(30).once('value');
        const rows = [];
        const now = Date.now();
        snap.forEach(ch => {
          const v = ch.val() || {};
          if (now - (v.created || 0) > 3 * 3600e3) { ch.ref.remove().catch(() => {}); return; }
          const seats = v.seats || {};
          const nPl = Object.values(v.players || {}).filter(p => p && p.conn).length;
          if (v.status === 'lobby' && !(seats.s0 && seats.s1) && nPl > 0) rows.push({ code: ch.key, hn: v.hn || '?', t: v.created });
        });
        rows.sort((a, b) => b.t - a.t);
        el.innerHTML = rows.length ? '' : '<div class="muted">Belum ada room terbuka. Buat room baru!</div>';
        for (const r of rows) {
          const b = document.createElement('button');
          b.className = 'roomRow';
          b.innerHTML = `<b>${esc(r.code)}</b><span>${esc(r.hn)}</span><small>Gabung →</small>`;
          b.onclick = () => this.join(r.code);
          el.appendChild(b);
        }
      } catch (e) {
        console.error(e);
        el.innerHTML = '<div class="muted">Gagal memuat daftar room.</div>';
      }
    },
    async create() {
      if (!this.init()) return toast('Firebase tidak tersedia', 'foul');
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (let i = 0; i < 6; i++) {
        let code = '';
        for (let k = 0; k < 5; k++) code += chars[Math.floor(Math.random() * chars.length)];
        const res = await this.R('rooms/' + code).transaction(cur => (cur ? undefined : {
          created: Date.now(), status: 'lobby', host: myId, hn: playerName(), seats: { s0: myId },
        }));
        if (res.committed) return this.enter(code);
      }
      toast('Gagal membuat room, coba lagi', 'foul');
    },
    async join(code) {
      code = String(code || '').trim().toUpperCase();
      if (!code) return;
      if (!this.init()) return toast('Firebase tidak tersedia', 'foul');
      const snap = await this.R('rooms/' + code).once('value');
      if (!snap.exists()) { toast('Room ' + code + ' tidak ditemukan', 'foul'); return; }
      await this.R('rooms/' + code + '/seats').transaction(cur => {
        cur = cur || {};
        if (cur.s0 === myId || cur.s1 === myId) return cur;
        if (!cur.s0) { cur.s0 = myId; return cur; }
        if (!cur.s1) { cur.s1 = myId; return cur; }
        return undefined; // penuh -> penonton
      });
      return this.enter(code);
    },
    async enter(code) {
      this.leaveSilently();
      this.code = code;
      this.ref = this.R('rooms/' + code);
      G.mode = 'online';
      G.state = null; G.anim = null; G.pending = null; G.animSeq = -1; G.lastShot = null; G.remoteAim = null; G.lastJson = '';
      const me = this.ref.child('players/' + myId);
      await me.set({ name: playerName(), conn: true, t: SV() });
      me.child('conn').onDisconnect().set(false);
      history.replaceState(null, '', location.pathname + '?room=' + code);
      $('roomBadge').hidden = false; $('roomBadge').textContent = '# ' + code;
      $('btnChat').hidden = false;
      $('chatLog').innerHTML = '';
      $('lobbyCode').textContent = code;
      $('lobbyLink').value = location.origin + location.pathname + '?room=' + code;
      showCard('lobby');
      const ref = this.ref;
      ref.child('seats').on('value', s => { const v = s.val() || {}; this.seats = [v.s0 || null, v.s1 || null]; this.onMeta(); });
      ref.child('players').on('value', s => { this.players = s.val() || {}; this.onMeta(); });
      ref.child('status').on('value', s => { this.status = s.val(); this.onMeta(); });
      ref.child('st').on('value', s => this.onState(s.val()));
      ref.child('shot').on('value', s => { G.lastShot = s.val(); maybeRemoteShot(); });
      ref.child('aim').on('value', s => { const v = s.val(); if (v && v.by !== myId) G.remoteAim = v; });
      ref.child('rematch').on('value', s => this.onRematch(s.val() || {}));
      ref.child('chat').limitToLast(40).on('child_added', s => addChat(s.val()));
    },
    onMeta() {
      if (!this.ref) return;
      G.mySeat = this.seats.indexOf(myId);
      for (let i = 0; i < 2; i++) {
        const uid = this.seats[i];
        const p = uid && this.players[uid];
        G.names[i] = p ? p.name : (i === 0 ? 'Pemain 1' : 'Pemain 2');
        const off = !!(uid && p && p.conn === false);
        if (off && !G.disc[i]) G.disc[i] = Date.now();
        if (!off) G.disc[i] = 0;
      }
      // lobby
      const lp = $('lobbyPlayers');
      lp.innerHTML = [0, 1].map(i => {
        const uid = this.seats[i], p = uid && this.players[uid];
        return p ? `<div class="lp"><span>${esc(p.name)}${uid === myId ? ' (kamu)' : ''}</span><span>${p.conn === false ? '⚪' : '🟢'}</span></div>`
          : '<div class="lp empty">Menunggu pemain…</div>';
      }).join('');
      if (G.mySeat < 0 && this.seats[0] && this.seats[1]) $('lobbyStatus').textContent = 'Room penuh — kamu menonton';
      else $('lobbyStatus').textContent = (this.seats[0] && this.seats[1]) ? 'Memulai…' : 'Menunggu lawan…';
      if (this.status === 'lobby') {
        if (!$('lobby').hidden || $('overlay').hidden || !$('result').hidden) {
          if ($('lobby').hidden && G.state) toast('Lawan keluar — menunggu lawan baru', 'foul');
          showCard('lobby');
          $('hud').hidden = true; $('tbtns').hidden = true;
        }
        if (this.seats[0] && this.seats[1] && G.mySeat === 0) this.startGame();
      } else if (this.status === 'playing') {
        if (!$('lobby').hidden) hideOverlay();
        $('hud').hidden = false; $('tbtns').hidden = false;
      }
      updateHUD();
      refreshControls();
    },
    async startGame() {
      const res = await this.ref.child('status').transaction(cur => (cur === 'lobby' ? 'playing' : undefined));
      if (!res.committed) return;
      const snap = await this.ref.child('st').once('value');
      const old = snap.val() ? JSON.parse(snap.val()) : null;
      const s = E.newGame(Math.random() < 0.5 ? 0 : 1, Math.random);
      s.seq = old ? old.seq + 2 : 0;
      await this.ref.update({ st: JSON.stringify(s), shot: null, aim: null, rematch: null });
    },
    onState(json) {
      if (!json || json === G.lastJson) return;
      let s;
      try { s = JSON.parse(json); } catch (e) { return; }
      if (G.anim) { if (!G.pending || s.seq >= G.pending.seq) G.pending = s; return; }
      if (G.state && s.seq < G.state.seq) return;
      const first = !G.state;
      if (first || s.seq !== G.state.seq) G.shownAim = null;
      setState(s, false);
      if (first && this.status === 'playing') { hideOverlay(); $('hud').hidden = false; $('tbtns').hidden = false; }
    },
    commit(ns) {
      const json = JSON.stringify(ns);
      this.ref.child('st').transaction(cur => {
        if (!cur) return json;
        let c; try { c = JSON.parse(cur); } catch (e) { return json; }
        return c.seq === ns.seq - 1 ? json : undefined;
      }, null, false).catch(console.error);
    },
    sendShot(shot) {
      this.ref.child('shot').set(Object.assign({ by: myId }, shot)).catch(console.error);
    },
    tickAim() {
      if (G.mode !== 'online' || !this.ref || !canShoot()) return;
      const now = performance.now();
      if (now - this.lastAimT < 120) return;
      const c = cuePosNow();
      const a = { by: myId, seq: G.state.seq, th: +G.aim.th.toFixed(4), p: +G.aim.power.toFixed(3), sx: +G.aim.sx.toFixed(2), sy: +G.aim.sy.toFixed(2) };
      if (G.state.bih) { a.cx = +c.x.toFixed(4); a.cz = +c.z.toFixed(4); }
      const key = JSON.stringify(a);
      if (key === this.lastAimSent) return;
      this.lastAimSent = key; this.lastAimT = now;
      this.ref.child('aim').set(a).catch(() => {});
    },
    rematch() {
      if (G.mySeat < 0) return;
      this.ref.child('rematch/s' + G.mySeat).set(true);
      $('btnAgain').disabled = true;
      $('resWait').hidden = false;
      $('resWait').textContent = 'Menunggu lawan…';
    },
    async onRematch(v) {
      if (!G.state || G.state.win < 0) return;
      if (v.s0 && v.s1 && G.mySeat === 0) {
        const s = E.newGame(1 - G.state.win, Math.random);
        s.seq = G.state.seq + 2;
        await this.ref.update({ st: JSON.stringify(s), shot: null, aim: null, rematch: null });
      } else if ((v.s0 || v.s1) && !$('result').hidden) {
        const other = G.mySeat === 0 ? v.s1 : v.s0;
        if (other && !v['s' + G.mySeat]) { $('resWait').hidden = false; $('resWait').textContent = 'Lawan ingin main lagi!'; }
      }
    },
    resign(winner, reason) {
      return this.ref.child('st').transaction(cur => {
        if (!cur) return undefined;
        const s = JSON.parse(cur);
        if (s.win >= 0) return undefined;
        s.win = winner; s.winReason = reason; s.seq++; s.msg = reason;
        return JSON.stringify(s);
      });
    },
    leaveSilently() {
      if (!this.ref) return;
      this.ref.off();
      for (const c of ['seats', 'players', 'status', 'st', 'shot', 'aim', 'rematch', 'chat']) this.ref.child(c).off();
      this.ref.child('players/' + myId + '/conn').onDisconnect().cancel().catch(() => {});
      this.ref = null; this.code = null;
    },
    async leave() {
      if (!this.ref) return;
      const ref = this.ref;
      const seat = G.mySeat;
      const playing = this.status === 'playing' && G.state && G.state.win < 0 && seat >= 0;
      try {
        // transaksi dijalankan selagi listener 'st' masih aktif (cache terisi)
        if (playing) await this.resign(1 - seat, playerName() + ' keluar dari permainan');
      } catch (e) { console.error(e); }
      this.leaveSilently();
      try {
        await ref.child('players/' + myId).remove();
        if (seat >= 0) {
          const cur = (await ref.child('seats/s' + seat).once('value')).val();
          if (cur === myId) await ref.child('seats/s' + seat).remove();
          await ref.child('status').set('lobby');
          await ref.child('rematch').remove();
        }
        const snap = await ref.child('players').once('value');
        const any = Object.values(snap.val() || {}).some(p => p && p.conn);
        if (!any) await ref.remove();
      } catch (e) { console.error(e); }
    },
    chat(text) {
      if (!this.ref) return;
      this.ref.child('chat').push({ n: playerName(), m: text.slice(0, 120), t: SV() });
    },
  };

  function maybeRemoteShot() {
    const sh = G.lastShot;
    if (G.mode !== 'online' || !sh || !G.state || G.anim) return;
    if (sh.seq !== G.state.seq + 1 || G.animSeq >= sh.seq) return;
    startShot(sh);
  }

  function addChat(v) {
    if (!v) return;
    const d = document.createElement('div');
    d.innerHTML = `<b>${esc(v.n || '?')}:</b> ${esc(v.m || '')}`;
    const log = $('chatLog');
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    if ($('chat').hidden) $('btnChat').classList.add('unread');
  }
  $('btnChat').onclick = () => { $('chat').hidden = !$('chat').hidden; $('btnChat').classList.remove('unread'); if (!$('chat').hidden) $('chatIn').focus(); };
  $('chatForm').onsubmit = e => {
    e.preventDefault();
    const t = $('chatIn').value.trim();
    if (t) Net.chat(t);
    $('chatIn').value = '';
  };

  // klaim menang jika lawan terputus lama
  setInterval(() => {
    const s = G.state;
    let show = false;
    if (G.mode === 'online' && s && s.win < 0 && G.mySeat >= 0) {
      const op = 1 - G.mySeat;
      show = G.disc[op] && Date.now() - G.disc[op] > 30000;
    }
    $('btnClaim').hidden = !show;
  }, 1000);
  $('btnClaim').onclick = () => Net.resign(G.mySeat, (G.names[1 - G.mySeat] || 'Lawan') + ' terputus');

  // ---------- menu ----------
  $('nameIn').value = store.get('name', '');
  $('nameIn').addEventListener('change', () => store.set('name', $('nameIn').value.trim()));
  document.querySelectorAll('.tabs button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
      $('tabOnline').hidden = b.dataset.tab !== 'online';
      $('tabOffline').hidden = b.dataset.tab !== 'offline';
      if (b.dataset.tab === 'online') Net.listRooms();
    };
  });
  function needName() {
    if ($('nameIn').value.trim()) { store.set('name', $('nameIn').value.trim()); return false; }
    toast('Isi nama dulu', 'foul', 1500);
    $('nameIn').focus();
    return true;
  }
  $('btnBot').onclick = () => {
    if (needName()) return;
    Sound.init();
    G.mode = 'bot';
    G.botLevel = +$('botLevel').value;
    G.bot = [false, true];
    G.names = [playerName(), 'Bot ' + LEVELS[G.botLevel]];
    $('roomBadge').hidden = true; $('btnChat').hidden = true;
    newLocalGame(0);
  };
  $('btnLocal').onclick = () => {
    Sound.init();
    G.mode = 'local';
    G.bot = [false, false];
    G.names = [$('nameIn').value.trim() || 'Pemain 1', 'Pemain 2'];
    $('roomBadge').hidden = true; $('btnChat').hidden = true;
    newLocalGame(0);
  };
  $('btnCreate').onclick = () => { if (!needName()) { Sound.init(); Net.create().catch(e => { console.error(e); toast('Gagal membuat room', 'foul'); }); } };
  $('btnJoin').onclick = () => { if (!needName()) { Sound.init(); Net.join($('codeIn').value).catch(e => { console.error(e); toast('Gagal bergabung', 'foul'); }); } };
  $('codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoin').click(); });
  $('btnRefresh').onclick = () => Net.listRooms();
  $('btnCopy').onclick = () => {
    const v = $('lobbyLink').value;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('Link disalin', 'good', 1400))
      .catch(() => { $('lobbyLink').select(); document.execCommand('copy'); toast('Link disalin', 'good', 1400); });
  };
  $('roomBadge').onclick = () => {
    const v = location.origin + location.pathname + '?room=' + Net.code;
    if (navigator.clipboard) navigator.clipboard.writeText(v).then(() => toast('Link undangan disalin', 'good', 1400));
  };

  function backToMenu() {
    G.mode = null; G.state = null; G.anim = null; G.botAim = null; G.botBusy = false; G.pending = null;
    $('hud').hidden = true; $('tbtns').hidden = true; $('chat').hidden = true; $('btnClaim').hidden = true;
    S.setAim(null); S.setCue(false); S.setPlaceRing(false);
    S.setBalls(E.rackBalls());
    history.replaceState(null, '', location.pathname);
    showCard('menu');
    if (!$('tabOnline').hidden) Net.listRooms();
  }
  $('btnLeave').onclick = async () => {
    const s = G.state;
    if (G.mode === 'online') {
      if (s && s.win < 0 && G.mySeat >= 0 && !confirm('Keluar sekarang berarti menyerah. Lanjutkan?')) return;
      await Net.leave();
    } else if (s && s.win < 0 && s.shots > 0 && !confirm('Keluar dari permainan?')) return;
    backToMenu();
  };
  $('btnLobbyLeave').onclick = async () => { await Net.leave(); backToMenu(); };
  $('btnMenu').onclick = async () => { if (G.mode === 'online') await Net.leave(); backToMenu(); };
  $('btnAgain').onclick = () => {
    if (G.mode === 'online') Net.rematch();
    else newLocalGame(G.state && G.state.win >= 0 ? 1 - G.state.win : 0);
  };
  window.addEventListener('beforeunload', () => { if (Net.ref) Net.ref.child('players/' + myId + '/conn').set(false); });

  // ---------- start ----------
  S.init(canvas);
  S.setBalls(E.rackBalls());
  S.snapCam();
  updateSpinUI();
  showCard('menu');
  requestAnimationFrame(loop);
  const qRoom = new URLSearchParams(location.search).get('room');
  if (qRoom) {
    $('codeIn').value = qRoom.toUpperCase();
    if ($('nameIn').value.trim()) Net.join(qRoom).catch(console.error);
    else { toast('Isi nama lalu tekan Gabung', '', 2500); $('nameIn').focus(); }
  }
  Net.listRooms();

  // untuk debug / test otomatis
  window.__pool = { G, Net, shoot, setState, E };
})();
