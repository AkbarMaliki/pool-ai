// Pool 3D — engine murni (tanpa DOM): fisika meja, aturan 8-ball, dan AI bot.
// Dipakai oleh browser (window.PoolEngine), Web Worker bot, dan test Node.
// Fisika hanya memakai + - * / dan sqrt agar hasil simulasi sama persis di semua klien.
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E;
  else root.PoolEngine = E;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Dimensi (meter) ----------
  const R = 0.028575;          // jari-jari bola
  const L = 1.27, W = 0.635;   // setengah panjang / lebar area main (garis hidung bantalan)
  const CM = 0.08;             // jarak ujung bantalan ke sudut (mulut kantong sudut)
  const SM = 0.062;            // setengah lebar mulut kantong tengah
  const CW = 0.05;             // tebal bantalan
  const HEAD_X = -L / 2;       // garis kepala (kitchen di kiri)
  const FOOT_X = L / 2;        // titik kaki (ujung depan rak)

  // ---------- Konstanta fisika ----------
  const G = 9.81;
  const MU_S = 0.2;            // gesek geser kain
  const MU_R = 0.011;          // gesek gulir
  const DRAG = 0.09;           // redaman sebanding kecepatan (1/s)
  const E_BALL = 0.95;
  const E_CUSH = 0.76;
  const SPIN_DECAY = 0.9985;   // peluruhan english per langkah
  const ENGLISH = 0.22;        // pengaruh english pada pantulan bantalan
  const DT = 1 / 600;
  const MAX_V = 7.5;
  const MIN_V = 0.15;
  const MAX_T = 40;            // detik, batas simulasi

  const POCKETS = [
    { x: -L - 0.02, z: -W - 0.02, r: 0.062 },
    { x: 0,         z: -W - 0.045, r: 0.056 },
    { x: L + 0.02,  z: -W - 0.02, r: 0.062 },
    { x: -L - 0.02, z: W + 0.02,  r: 0.062 },
    { x: 0,         z: W + 0.045, r: 0.056 },
    { x: L + 0.02,  z: W + 0.02,  r: 0.062 },
  ];
  // titik bidik bot per kantong (sedikit di dalam mulut)
  const POCKET_AIM = [
    { x: -L + 0.005, z: -W + 0.005 }, { x: 0, z: -W - 0.01 }, { x: L - 0.005, z: -W + 0.005 },
    { x: -L + 0.005, z: W - 0.005 },  { x: 0, z: W + 0.01 },  { x: L - 0.005, z: W - 0.005 },
  ];

  // ---------- Segmen bantalan (garis hidung + rahang kantong) ----------
  const D = CW; // panjang rahang sudut per sumbu
  const SEGS = [];
  function seg(ax, az, bx, bz) { SEGS.push({ ax, az, bx, bz }); }
  for (const sz of [-1, 1]) {
    const z = sz * W;
    // rel panjang, dua bagian dipisah kantong tengah
    seg(-L + CM, z, -SM, z);
    seg(SM, z, L - CM, z);
    // rahang kantong tengah
    seg(-SM, z, -SM, z + sz * CW);
    seg(SM, z, SM, z + sz * CW);
    // rahang kantong sudut di sisi rel panjang
    seg(-L + CM, z, -L + CM - D, z + sz * D);
    seg(L - CM, z, L - CM + D, z + sz * D);
  }
  for (const sx of [-1, 1]) {
    const x = sx * L;
    seg(x, -W + CM, x, W - CM);
    seg(x, -W + CM, x + sx * D, -W + CM - D);
    seg(x, W - CM, x + sx * D, W - CM + D);
  }
  // poligon bantalan untuk render: [hidung A, hidung B, rahang B, rahang A]
  const CUSHIONS = (() => {
    const out = [];
    for (const sz of [-1, 1]) {
      const z = sz * W, zb = z + sz * CW;
      out.push([[-L + CM, z], [-SM, z], [-SM, zb], [-L + CM - D, zb]]);
      out.push([[SM, z], [L - CM, z], [L - CM + D, zb], [SM, zb]]);
    }
    for (const sx of [-1, 1]) {
      const x = sx * L, xb = x + sx * CW;
      out.push([[x, -W + CM], [x, W - CM], [xb, W - CM + D], [xb, -W + CM - D]]);
    }
    return out;
  })();

  const TABLE = { R, L, W, CM, SM, CW, HEAD_X, FOOT_X, POCKETS, SEGS, CUSHIONS, MAX_V, MIN_V, DT };

  // ---------- Utilitas ----------
  function groupOf(id) { return id >= 1 && id <= 7 ? 'S' : id >= 9 && id <= 15 ? 'T' : null; }
  const GROUP_IDS = { S: [1, 2, 3, 4, 5, 6, 7], T: [9, 10, 11, 12, 13, 14, 15] };
  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clone = o => JSON.parse(JSON.stringify(o));

  // ---------- Rak & game baru ----------
  function rackBalls(rng) {
    rng = rng || Math.random;
    const solids = [2, 3, 4, 5, 6, 7], stripes = [9, 10, 11, 12, 13, 14, 15];
    const pick = arr => arr.splice(Math.floor(rng() * arr.length), 1)[0];
    // posisi 0 = puncak, 4 = tengah (bola 8), 10 & 14 = sudut belakang
    const order = new Array(15);
    order[0] = 1; order[4] = 8;
    const cs = pick(solids), ct = pick(stripes);
    if (rng() < 0.5) { order[10] = cs; order[14] = ct; } else { order[10] = ct; order[14] = cs; }
    const rest = solids.concat(stripes);
    for (let i = 0; i < 15; i++) if (order[i] === undefined) order[i] = pick(rest);
    const gap = 1.0004;
    const balls = [{ id: 0, x: HEAD_X - 0.12, z: 0, on: true }];
    let k = 0;
    for (let row = 0; row < 5; row++) {
      for (let j = 0; j <= row; j++) {
        balls.push({
          id: order[k++],
          x: FOOT_X + row * R * Math.sqrt(3) * gap,
          z: (j - row / 2) * 2 * R * gap,
          on: true,
        });
      }
    }
    balls.sort((a, b) => a.id - b.id);
    return balls;
  }

  function newGame(breaker, rng) {
    return {
      seq: 0,
      balls: rackBalls(rng),
      turn: breaker || 0,
      g: [null, null],
      bih: true,      // bola di tangan
      kitchen: true,  // hanya di belakang garis kepala
      brk: true,      // pukulan berikutnya = break
      win: -1,
      msg: 'Break!',
      foul: '',
      shots: 0,
    };
  }

  // ---------- Simulasi ----------
  function createSim(stateBalls, shot) {
    const balls = stateBalls.map(b => ({
      id: b.id, x: b.x, z: b.z, on: b.on !== false,
      vx: 0, vz: 0, rx: 0, rz: 0, ws: 0, pocket: -1,
    }));
    balls.sort((a, b) => a.id - b.id);
    const cue = balls[0];
    if (shot) {
      if (typeof shot.cx === 'number') { cue.x = shot.cx; cue.z = shot.cz; cue.on = true; }
      let v = Math.min(MAX_V, Math.max(MIN_V, shot.v));
      let dx = shot.dx, dz = shot.dz;
      const n = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= n; dz /= n;
      const sy = Math.max(-1, Math.min(1, shot.sy || 0));
      const sx = Math.max(-1, Math.min(1, shot.sx || 0));
      cue.vx = dx * v; cue.vz = dz * v;
      cue.rx = dx * v * 1.25 * sy; cue.rz = dz * v * 1.25 * sy;
      cue.ws = 1.25 * sx * v;
    }
    return {
      balls, t: 0, done: false,
      ev: { first: null, pocketed: [], rail: false, railBalls: [] },
      fx: [],
    };
  }

  function moving(b) {
    return b.vx !== 0 || b.vz !== 0 || b.rx !== 0 || b.rz !== 0;
  }

  function step(sim) {
    if (sim.done) return;
    const balls = sim.balls, n = balls.length, ev = sim.ev;
    let any = false;
    // gesekan + gerak
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (!b.on || !moving(b)) continue;
      const sx = b.vx - b.rx, sz = b.vz - b.rz;
      const s = Math.sqrt(sx * sx + sz * sz);
      const dv = MU_S * G * DT;
      if (s > 1e-9) {
        if (s <= 3.5 * dv) {
          const vx = (5 * b.vx + 2 * b.rx) / 7, vz = (5 * b.vz + 2 * b.rz) / 7;
          b.vx = b.rx = vx; b.vz = b.rz = vz;
        } else {
          const ux = sx / s, uz = sz / s;
          b.vx -= ux * dv; b.vz -= uz * dv;
          b.rx += ux * 2.5 * dv; b.rz += uz * 2.5 * dv;
        }
      } else {
        const sp = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
        const dec = (MU_R * G + DRAG * sp) * DT;
        if (sp <= dec) { b.vx = b.vz = b.rx = b.rz = 0; }
        else {
          const k = (sp - dec) / sp;
          b.vx *= k; b.vz *= k; b.rx = b.vx; b.rz = b.vz;
        }
      }
      b.ws *= SPIN_DECAY;
      if (Math.abs(b.vx) < 1e-4 && Math.abs(b.vz) < 1e-4 && Math.abs(b.rx) < 1e-4 && Math.abs(b.rz) < 1e-4) {
        b.vx = b.vz = b.rx = b.rz = 0; b.ws = 0;
      }
      b.x += b.vx * DT; b.z += b.vz * DT;
      any = true;
    }
    // tumbukan antar bola
    const D2 = 4 * R * R;
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      if (!a.on) continue;
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (!b.on) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= D2) continue;
        let d = Math.sqrt(d2), nx, nz;
        if (d < 1e-9) { nx = 1; nz = 0; d = 0; } else { nx = dx / d; nz = dz / d; }
        const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (rel > 0) {
          const imp = (1 + E_BALL) / 2 * rel;
          a.vx -= imp * nx; a.vz -= imp * nz;
          b.vx += imp * nx; b.vz += imp * nz;
          if (ev.first === null && (a.id === 0 || b.id === 0)) ev.first = a.id === 0 ? b.id : a.id;
          sim.fx.push({ t: 'ball', v: rel, x: a.x + nx * R, z: a.z + nz * R });
          any = true;
        }
        const ov = (2 * R - d) / 2;
        a.x -= nx * ov; a.z -= nz * ov;
        b.x += nx * ov; b.z += nz * ov;
      }
    }
    // bantalan
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (!b.on) continue;
      // lewati cek bantalan jika jauh dari tepi
      if (b.x > -L + R + 0.002 && b.x < L - R - 0.002 && b.z > -W + R + 0.002 && b.z < W - R - 0.002) continue;
      for (let k = 0; k < SEGS.length; k++) {
        const s = SEGS[k];
        const ex = s.bx - s.ax, ez = s.bz - s.az;
        let t = ((b.x - s.ax) * ex + (b.z - s.az) * ez) / (ex * ex + ez * ez);
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const qx = s.ax + ex * t, qz = s.az + ez * t;
        const dx = b.x - qx, dz = b.z - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2) || 1e-9;
        const nx = dx / d, nz = dz / d;
        const vn = b.vx * nx + b.vz * nz;
        if (vn < 0) {
          b.vx -= (1 + E_CUSH) * vn * nx; b.vz -= (1 + E_CUSH) * vn * nz;
          const rn = b.rx * nx + b.rz * nz;
          b.rx -= (1 + E_CUSH) * rn * nx; b.rz -= (1 + E_CUSH) * rn * nz;
          // english: gesekan titik kontak mengubah arah pantulan
          const kick = ENGLISH * b.ws * Math.min(1, -vn / 1.5 + 0.3);
          b.vx += kick * nz; b.vz -= kick * nx;
          b.rx += kick * nz; b.rz -= kick * nx;
          b.ws *= 0.55;
          if (ev.first !== null) {
            ev.rail = true;
            if (ev.railBalls.indexOf(b.id) < 0) ev.railBalls.push(b.id);
          }
          sim.fx.push({ t: 'cush', v: -vn, x: b.x, z: b.z });
          any = true;
        }
        b.x += nx * (R - d); b.z += nz * (R - d);
      }
    }
    // kantong
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (!b.on) continue;
      let hit = -1;
      for (let k = 0; k < POCKETS.length; k++) {
        const p = POCKETS[k];
        const dx = b.x - p.x, dz = b.z - p.z;
        if (dx * dx + dz * dz < p.r * p.r) { hit = k; break; }
      }
      if (hit < 0 && (b.x < -L - 0.015 || b.x > L + 0.015 || b.z < -W - 0.015 || b.z > W + 0.015)) {
        // lolos keluar area (seharusnya tidak terjadi) -> anggap masuk kantong terdekat
        let best = 1e9;
        for (let k = 0; k < POCKETS.length; k++) {
          const p = POCKETS[k];
          const d = (b.x - p.x) * (b.x - p.x) + (b.z - p.z) * (b.z - p.z);
          if (d < best) { best = d; hit = k; }
        }
      }
      if (hit >= 0) {
        const sp = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
        b.on = false; b.pocket = hit;
        b.vx = b.vz = b.rx = b.rz = b.ws = 0;
        ev.pocketed.push(b.id);
        sim.fx.push({ t: 'pocket', id: b.id, pocket: hit, v: sp, x: b.x, z: b.z });
      }
    }
    sim.t += DT;
    if (!any || sim.t > MAX_T) {
      sim.done = true;
      for (const b of balls) { b.vx = b.vz = b.rx = b.rz = b.ws = 0; }
    }
  }

  function runSim(sim, maxSteps) {
    let k = 0;
    while (!sim.done && k < (maxSteps || 1e9)) { step(sim); k++; }
    return sim;
  }

  function simResult(sim) {
    return {
      balls: sim.balls.map(b => ({ id: b.id, x: b.x, z: b.z, on: b.on })),
      ev: { first: sim.ev.first, pocketed: sim.ev.pocketed.slice(), rail: sim.ev.rail },
    };
  }

  function simulate(stateBalls, shot) {
    const sim = runSim(createSim(stateBalls, shot));
    sim.fx.length = 0;
    return simResult(sim);
  }

  // ---------- Penempatan bola putih ----------
  function validCuePos(balls, x, z, kitchen) {
    if (!(x >= -L + R && x <= L - R && z >= -W + R && z <= W - R)) return false;
    if (kitchen && x > HEAD_X) return false;
    for (const b of balls) {
      if (b.id === 0 || b.on === false) continue;
      const dx = b.x - x, dz = b.z - z;
      if (dx * dx + dz * dz < (2 * R + 0.001) * (2 * R + 0.001)) return false;
    }
    return true;
  }

  function freeSpot(balls, x, z, dirX, kitchen) {
    for (let i = 0; i < 400; i++) {
      const tx = x + dirX * i * 0.01, tz = z + ((i % 2) ? 1 : -1) * Math.floor(i / 40) * 0.03;
      if (validCuePos(balls, tx, tz, kitchen)) return { x: tx, z: tz };
    }
    for (let i = 0; i < 2000; i++) {
      const tx = -L + R + ((i * 0.6180339) % 1) * (2 * L - 2 * R);
      const tz = -W + R + ((i * 0.4142135) % 1) * (2 * W - 2 * R);
      if (validCuePos(balls, tx, tz, kitchen)) return { x: tx, z: tz };
    }
    return { x, z };
  }

  // ---------- Aturan 8-ball ----------
  const NAMES_G = { S: 'solid (1–7)', T: 'belang (9–15)' };

  function legalTargets(state, seat) {
    const g = state.g[seat];
    const on = id => state.balls[id] && state.balls[id].on;
    if (!g) return [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15].filter(on);
    const mine = GROUP_IDS[g].filter(on);
    return mine.length ? mine : [8];
  }

  function applyShot(state, shot, result) {
    const s = clone(state);
    const me = state.turn, op = 1 - me;
    const ev = result.ev;
    s.balls = result.balls.map(b => ({ id: b.id, x: b.x, z: b.z, on: b.on }));
    s.balls.sort((a, b) => a.id - b.id);
    s.seq = state.seq + 1;
    s.shots = (state.shots || 0) + 1;
    s.foul = '';
    const pot = ev.pocketed;
    const cuePot = pot.indexOf(0) >= 0;
    const eightPot = pot.indexOf(8) >= 0;
    const objPot = pot.filter(id => id !== 0 && id !== 8);
    const grp = state.g[me];
    const wasOn = id => state.balls[id].on;
    const cleared = !!grp && GROUP_IDS[grp].every(id => !wasOn(id));

    let foul = '';
    if (cuePot) foul = 'Bola putih masuk (scratch)';
    else if (ev.first === null) foul = 'Tidak mengenai bola apa pun';
    else if (!state.brk) {
      if (grp) {
        if (cleared ? ev.first !== 8 : groupOf(ev.first) !== grp) foul = 'Bola pertama yang dikenai bukan bola sendiri';
      } else if (ev.first === 8) foul = 'Bola 8 tidak boleh dikenai pertama saat meja terbuka';
      if (!foul && pot.length === 0 && !ev.rail) foul = 'Tidak ada bola menyentuh bantalan setelah kontak';
    }

    const msgs = [];
    if (eightPot) {
      if (state.brk) {
        const sp = freeSpot(s.balls, FOOT_X, 0, 1, false);
        s.balls[8].on = true; s.balls[8].x = sp.x; s.balls[8].z = sp.z;
        msgs.push('Bola 8 masuk saat break — dikembalikan ke titik kaki');
      } else {
        s.win = (!foul && cleared) ? me : op;
        s.winReason = s.win === me ? 'Bola 8 masuk dengan sah' :
          (foul ? 'Bola 8 masuk bersamaan dengan foul' : 'Bola 8 masuk sebelum bola sendiri habis');
      }
    }

    // penentuan grup (setelah break, meja terbuka sampai ada bola masuk sah)
    if (!state.brk && !grp && !foul && objPot.length && s.win < 0) {
      s.g[me] = groupOf(objPot[0]);
      s.g[op] = s.g[me] === 'S' ? 'T' : 'S';
      msgs.push('Grup ditentukan: ' + NAMES_G[s.g[me]]);
    }

    let cont = false;
    if (!foul) {
      if (state.brk) cont = objPot.length > 0;
      else {
        const myG = s.g[me];
        cont = myG ? objPot.some(id => groupOf(id) === myG) : false;
      }
    }

    s.brk = false;
    s.kitchen = false;
    s.bih = false;
    if (foul) {
      s.foul = foul;
      s.bih = true;
      if (cuePot) {
        const sp = freeSpot(s.balls, HEAD_X, 0, -1, false);
        s.balls[0].on = true; s.balls[0].x = sp.x; s.balls[0].z = sp.z;
      }
    }
    if (s.win < 0) s.turn = cont ? me : op;

    if (objPot.length) msgs.unshift('Masuk: ' + objPot.join(', '));
    if (foul) msgs.push('FOUL: ' + foul + ' — lawan dapat bola di tangan');
    else if (!cont && s.win < 0) msgs.push('Ganti giliran');
    s.msg = msgs.join(' · ');
    return s;
  }

  // ---------- Bot ----------
  function segClear(balls, ax, az, bx, bz, ignore, rad) {
    const ex = bx - ax, ez = bz - az;
    const l2 = ex * ex + ez * ez;
    if (l2 < 1e-12) return true;
    for (const b of balls) {
      if (!b.on || ignore.indexOf(b.id) >= 0) continue;
      let t = ((b.x - ax) * ex + (b.z - az) * ez) / l2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const dx = b.x - (ax + ex * t), dz = b.z - (az + ez * t);
      if (dx * dx + dz * dz < rad * rad) return false;
    }
    return true;
  }

  // daftar pukulan langsung yang masuk akal: (target, kantong)
  function shotCandidates(state, seat, cx, cz, balls) {
    balls = balls || state.balls;
    const out = [];
    for (const id of legalTargets(state, seat)) {
      const t = balls[id];
      if (!t.on) continue;
      for (let p = 0; p < 6; p++) {
        const P = POCKET_AIM[p];
        let ox = P.x - t.x, oz = P.z - t.z;
        const od = Math.sqrt(ox * ox + oz * oz);
        if (od < 1e-6) continue;
        ox /= od; oz /= od;
        // kantong tengah sulit dimasuki dari sudut sempit
        if (p === 1 || p === 4) { if (Math.abs(oz) < 0.45) continue; }
        const gx = t.x - ox * 2 * R, gz = t.z - oz * 2 * R;
        let dx = gx - cx, dz = gz - cz;
        const dd = Math.sqrt(dx * dx + dz * dz);
        if (dd < 1e-6) continue;
        dx /= dd; dz /= dd;
        const cos = dx * ox + dz * oz;
        if (cos < 0.18) continue;
        if (!segClear(balls, cx, cz, gx, gz, [0, id], 2 * R - 0.002)) continue;
        if (!segClear(balls, t.x, t.z, P.x, P.z, [0, id], 2 * R - 0.002)) continue;
        const score = cos * cos / (0.4 + dd * 0.6 + od * 0.9);
        // kecepatan kira-kira: jarak total + faktor potong
        const need = Math.sqrt(dd * 1.1 + od / (cos * cos) * 1.3) * 1.25 + 0.35;
        out.push({ id, p, dx, dz, score, v: Math.min(MAX_V, need), gx, gz, cos, dd, od });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function bestBIH(state, seat) {
    const balls = state.balls;
    let best = null;
    for (const id of legalTargets(state, seat)) {
      const t = balls[id];
      for (let p = 0; p < 6; p++) {
        const P = POCKET_AIM[p];
        let ox = P.x - t.x, oz = P.z - t.z;
        const od = Math.sqrt(ox * ox + oz * oz);
        ox /= od; oz /= od;
        for (const back of [0.22, 0.35, 0.15, 0.5]) {
          for (const off of [0, 0.25, -0.25]) {
            // sedikit menyudut agar bola putih tidak ikut lurus ke kantong
            const cs = Math.cos(off), sn = Math.sin(off);
            const ax = ox * cs - oz * sn, az = ox * sn + oz * cs;
            const x = t.x - ox * 2 * R - ax * back, z = t.z - oz * 2 * R - az * back;
            if (!validCuePos(balls, x, z, state.kitchen)) continue;
            const c = shotCandidates(state, seat, x, z).find(c => c.id === id && c.p === p);
            if (!c) continue;
            const sc = c.score - Math.abs(off) * 0.05;
            if (!best || sc > best.sc) best = { x, z, sc };
          }
        }
      }
    }
    if (best) return best;
    const sp = freeSpot(balls, state.kitchen ? HEAD_X - 0.2 : 0, 0, -1, state.kitchen);
    return { x: sp.x, z: sp.z };
  }

  function evalShot(state, shot) {
    const seat = state.turn;
    const stBalls = state.balls.map(b => (b.id === 0 && typeof shot.cx === 'number') ? { id: 0, x: shot.cx, z: shot.cz, on: true } : b);
    const res = simulate(stBalls, shot);
    const ns = applyShot(state, shot, res);
    let sc = 0;
    if (ns.win === seat) sc += 10000;
    else if (ns.win === 1 - seat) sc -= 10000;
    if (ns.foul) sc -= 400;
    if (ns.turn === seat && ns.win < 0) {
      sc += 300;
      const c = ns.balls[0];
      const next = shotCandidates(ns, seat, c.x, c.z);
      sc += next.length ? 60 + next[0].score * 120 : -40;
    } else if (ns.win < 0) {
      // bertahan: kurangi peluang lawan
      const c = ns.balls[0];
      const opp = ns.bih ? [{ score: 1.2 }] : shotCandidates(ns, 1 - seat, c.x, c.z);
      sc -= opp.length ? 40 + opp[0].score * 100 : 0;
      if (!ns.foul) sc += 30;
    }
    return { sc, ns };
  }

  // level: 0 mudah, 1 sedang, 2 sulit
  function botPlan(state, level, seed) {
    const rng = mulberry(seed || 1);
    const seat = state.turn;
    const shot = { seq: state.seq + 1 };
    let cx = state.balls[0].x, cz = state.balls[0].z;
    if (state.brk) {
      cx = HEAD_X - 0.15; cz = (rng() - 0.5) * 0.3;
      const apex = state.balls.reduce((m, b) => (b.id && b.on && (!m || b.x < m.x) ? b : m), null);
      let dx = apex.x - cx, dz = apex.z - cz + (rng() - 0.5) * 0.01;
      const d = Math.sqrt(dx * dx + dz * dz);
      return { seq: shot.seq, cx, cz, dx: dx / d, dz: dz / d, v: [5.5, 6.5, 7.3][level] || 6.5, sx: 0, sy: 0.1 };
    }
    if (state.bih) {
      const p = bestBIH(state, seat);
      cx = p.x; cz = p.z; shot.cx = cx; shot.cz = cz;
    }
    const withCue = st => Object.assign({ seq: shot.seq }, typeof shot.cx === 'number' ? { cx: shot.cx, cz: shot.cz } : {}, st);
    const cands = shotCandidates(state, seat, cx, cz);
    let best = null;
    const nEval = [2, 6, 10][level];
    const tryShot = st => {
      const s = withCue(st);
      const r = evalShot(state, s);
      if (!best || r.sc > best.sc) best = { sc: r.sc, shot: s };
    };
    if (level === 0 && cands.length) {
      const c = cands[Math.floor(rng() * Math.min(3, cands.length))];
      best = { sc: 0, shot: withCue({ dx: c.dx, dz: c.dz, v: c.v * (0.9 + rng() * 0.4), sx: 0, sy: 0 }) };
    } else {
      for (const c of cands.slice(0, nEval)) {
        const variants = level === 2
          ? [[1, 0], [1.3, 0], [0.8, 0], [1.1, 0.5], [1.1, -0.6], [1.6, -0.4]]
          : [[1, 0], [1.3, 0.2], [1.1, -0.4]];
        for (const [vm, sy] of variants) tryShot({ dx: c.dx, dz: c.dz, v: Math.min(MAX_V, c.v * vm), sx: 0, sy });
      }
    }
    if (!best || best.sc < 0) {
      // pukulan aman: coba beberapa arah ke bola sah
      const targets = legalTargets(state, seat);
      const n = [8, 18, 30][level];
      for (let i = 0; i < n; i++) {
        const t = state.balls[targets[Math.floor(rng() * targets.length)]];
        let dx = t.x - cx + (rng() - 0.5) * 3 * R, dz = t.z - cz + (rng() - 0.5) * 3 * R;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        tryShot({ dx: dx / d, dz: dz / d, v: 0.8 + rng() * 2.6, sx: 0, sy: (rng() - 0.5) * 0.6 });
      }
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        tryShot({ dx: Math.cos(a), dz: Math.sin(a), v: 1 + rng() * 4, sx: 0, sy: 0 });
      }
    }
    const out = best.shot;
    // ketidaktepatan sesuai level
    const noise = [0.022, 0.007, 0.0018][level];
    const a = (rng() + rng() + rng() - 1.5) * noise;
    const ca = Math.cos(a), sa = Math.sin(a);
    const dx = out.dx * ca - out.dz * sa, dz = out.dx * sa + out.dz * ca;
    out.dx = dx; out.dz = dz;
    out.v = Math.min(MAX_V, Math.max(MIN_V, out.v * (1 + (rng() - 0.5) * [0.25, 0.1, 0.04][level])));
    return out;
  }

  // ---------- Prediksi garis bidik (untuk UI) ----------
  function predictAim(balls, cx, cz, dx, dz) {
    let bestT = 1e9, hit = null;
    for (const b of balls) {
      if (b.id === 0 || !b.on) continue;
      const fx = cx - b.x, fz = cz - b.z;
      const bq = fx * dx + fz * dz;
      const c = fx * fx + fz * fz - 4 * R * R;
      const disc = bq * bq - c;
      if (disc < 0) continue;
      const t = -bq - Math.sqrt(disc);
      if (t > -1e-6 && t < bestT) { bestT = t; hit = b; }
    }
    // dinding (abaikan kantong)
    let wallT = 1e9, wn = null;
    const lim = [[dx > 0 ? (L - R - cx) / dx : dx < 0 ? (-L + R - cx) / dx : 1e9, dx > 0 ? [-1, 0] : [1, 0]],
                 [dz > 0 ? (W - R - cz) / dz : dz < 0 ? (-W + R - cz) / dz : 1e9, dz > 0 ? [0, -1] : [0, 1]]];
    for (const [t, nrm] of lim) if (t >= 0 && t < wallT) { wallT = t; wn = nrm; }
    if (hit && bestT <= wallT) {
      const gx = cx + dx * bestT, gz = cz + dz * bestT;
      let nx = hit.x - gx, nz = hit.z - gz;
      const nd = Math.sqrt(nx * nx + nz * nz) || 1;
      nx /= nd; nz /= nd;
      const dot = dx * nx + dz * nz;
      return { type: 'ball', id: hit.id, gx, gz, ox: nx, oz: nz, cut: dot, tx: dx - dot * nx, tz: dz - dot * nz };
    }
    const gx = cx + dx * wallT, gz = cz + dz * wallT;
    const dot = dx * wn[0] + dz * wn[1];
    return { type: 'wall', gx, gz, rx: dx - 2 * dot * wn[0], rz: dz - 2 * dot * wn[1] };
  }

  return {
    TABLE, newGame, rackBalls, createSim, step, runSim, simResult, simulate,
    applyShot, legalTargets, groupOf, GROUP_IDS, validCuePos, freeSpot,
    botPlan, shotCandidates, predictAim, mulberry,
  };
});
