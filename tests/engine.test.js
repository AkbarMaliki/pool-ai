// Test engine: node tests/engine.test.js
const assert = require('assert');
const E = require('../engine.js');
const { TABLE: T } = E;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  -', name); }
  catch (e) { console.error('FAIL-', name); console.error(e); process.exitCode = 1; }
}

function emptyState(extra) {
  const st = E.newGame(0, E.mulberry(1));
  st.balls.forEach(b => { if (b.id) b.on = false; });
  st.brk = false; st.kitchen = false; st.bih = false;
  return Object.assign(st, extra || {});
}
function place(st, id, x, z) { st.balls[id] = { id, x, z, on: true }; }
function res(st, ev, mutate) {
  const balls = JSON.parse(JSON.stringify(st.balls));
  if (mutate) mutate(balls);
  return { balls, ev: Object.assign({ first: null, pocketed: [], rail: false }, ev) };
}

test('rak berisi 16 bola, 8 di tengah, tidak tumpang tindih', () => {
  const st = E.newGame(0, E.mulberry(7));
  assert.strictEqual(st.balls.length, 16);
  st.balls.forEach((b, i) => assert.strictEqual(b.id, i));
  const b8 = st.balls[8];
  assert.ok(Math.abs(b8.z) < 1e-9);
  for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
    const d = Math.hypot(st.balls[i].x - st.balls[j].x, st.balls[i].z - st.balls[j].z);
    assert.ok(d >= 2 * T.R, 'overlap ' + i + ',' + j);
  }
});

test('simulasi deterministik', () => {
  const st = E.newGame(0, E.mulberry(3));
  const shot = { cx: T.HEAD_X - 0.1, cz: 0.02, dx: 1, dz: 0.01, v: 7, sx: 0.2, sy: -0.3 };
  const a = E.simulate(st.balls, shot), b = E.simulate(st.balls, shot);
  assert.deepStrictEqual(a, b);
});

test('semua bola tetap di dalam meja setelah banyak break', () => {
  for (let s = 1; s <= 40; s++) {
    const st = E.newGame(0, E.mulberry(s));
    const rng = E.mulberry(s * 99);
    const r = E.simulate(st.balls, { cx: T.HEAD_X - 0.1, cz: (rng() - 0.5) * 0.4, dx: 1, dz: (rng() - 0.5) * 0.08, v: 5 + rng() * 2.5, sx: 0, sy: 0 });
    for (const b of r.balls) if (b.on) {
      assert.ok(Math.abs(b.x) <= T.L + 1e-6 && Math.abs(b.z) <= T.W + 1e-6, 'bola ' + b.id + ' di luar meja');
    }
    for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
      const A = r.balls[i], B = r.balls[j];
      if (!A.on || !B.on) continue;
      assert.ok(Math.hypot(A.x - B.x, A.z - B.z) > 2 * T.R - 1e-3, 'overlap setelah break');
    }
  }
});

test('pukulan lurus ke kantong sudut masuk', () => {
  const st = emptyState();
  place(st, 0, 0, 0); place(st, 3, 0.8, -0.3);
  const P = { x: T.L - 0.005, z: -T.W + 0.005 };
  let ox = P.x - 0.8, oz = P.z + 0.3; const od = Math.hypot(ox, oz); ox /= od; oz /= od;
  const gx = 0.8 - ox * 2 * T.R, gz = -0.3 - oz * 2 * T.R, gd = Math.hypot(gx, gz);
  const r = E.simulate(st.balls, { dx: gx / gd, dz: gz / gd, v: 2 });
  assert.deepStrictEqual(r.ev.pocketed.filter(i => i), [3]);
  assert.strictEqual(r.ev.first, 3);
});

test('scratch = foul, lawan dapat bola di tangan', () => {
  const st = emptyState({ g: ['S', 'T'] });
  place(st, 2, 0.3, 0); place(st, 10, -0.3, 0.2);
  const ns = E.applyShot(st, {}, res(st, { first: 2, pocketed: [2, 0], rail: true }, b => { b[0].on = false; b[2].on = false; }));
  assert.strictEqual(ns.turn, 1);
  assert.ok(ns.bih);
  assert.ok(ns.balls[0].on);
  assert.ok(ns.foul);
});

test('kena bola lawan dulu = foul', () => {
  const st = emptyState({ g: ['S', 'T'] });
  place(st, 2, 0.3, 0); place(st, 10, -0.3, 0.2);
  const ns = E.applyShot(st, {}, res(st, { first: 10, rail: true }));
  assert.strictEqual(ns.turn, 1); assert.ok(ns.bih);
});

test('tidak ada bantalan setelah kontak = foul', () => {
  const st = emptyState({ g: ['S', 'T'] });
  place(st, 2, 0.3, 0);
  const ns = E.applyShot(st, {}, res(st, { first: 2, rail: false }));
  assert.ok(ns.foul); assert.strictEqual(ns.turn, 1);
});

test('memasukkan bola sendiri = lanjut giliran', () => {
  const st = emptyState({ g: ['S', 'T'] });
  place(st, 2, 0.3, 0); place(st, 5, 0.5, 0);
  const ns = E.applyShot(st, {}, res(st, { first: 2, pocketed: [2] }, b => { b[2].on = false; }));
  assert.strictEqual(ns.turn, 0); assert.ok(!ns.foul); assert.ok(!ns.bih);
});

test('meja terbuka: bola masuk pertama menentukan grup', () => {
  const st = emptyState();
  place(st, 11, 0.3, 0); place(st, 4, 0.5, 0);
  const ns = E.applyShot(st, {}, res(st, { first: 11, pocketed: [11] }, b => { b[11].on = false; }));
  assert.deepStrictEqual(ns.g, ['T', 'S']);
  assert.strictEqual(ns.turn, 0);
});

test('break: bola masuk tidak menentukan grup tapi lanjut', () => {
  const st = E.newGame(1, E.mulberry(2));
  const ns = E.applyShot(st, {}, res(st, { first: 1, pocketed: [9], rail: true }, b => { b[9].on = false; }));
  assert.deepStrictEqual(ns.g, [null, null]);
  assert.strictEqual(ns.turn, 1); assert.ok(!ns.brk);
});

test('bola 8 masuk saat break dikembalikan', () => {
  const st = E.newGame(0, E.mulberry(2));
  const ns = E.applyShot(st, {}, res(st, { first: 1, pocketed: [8], rail: true }, b => { b[8].on = false; }));
  assert.ok(ns.balls[8].on); assert.strictEqual(ns.win, -1);
});

test('bola 8 sebelum grup habis = kalah', () => {
  const st = emptyState({ g: ['S', 'T'] });
  place(st, 2, 0.3, 0); place(st, 8, 0.6, 0);
  const ns = E.applyShot(st, {}, res(st, { first: 2, pocketed: [8], rail: true }, b => { b[8].on = false; }));
  assert.strictEqual(ns.win, 1);
});

test('bola 8 sah setelah grup habis = menang; dengan scratch = kalah', () => {
  const st = emptyState({ g: ['S', 'T'] });
  place(st, 8, 0.6, 0); place(st, 12, -0.6, 0);
  const ok = E.applyShot(st, {}, res(st, { first: 8, pocketed: [8] }, b => { b[8].on = false; }));
  assert.strictEqual(ok.win, 0);
  const bad = E.applyShot(st, {}, res(st, { first: 8, pocketed: [8, 0] }, b => { b[8].on = false; b[0].on = false; }));
  assert.strictEqual(bad.win, 1);
});

test('memasukkan bola terakhir + 8 dalam satu pukulan = kalah', () => {
  const st = emptyState({ g: ['S', 'T'] });
  place(st, 7, 0.3, 0); place(st, 8, 0.6, 0);
  const ns = E.applyShot(st, {}, res(st, { first: 7, pocketed: [7, 8] }, b => { b[7].on = false; b[8].on = false; }));
  assert.strictEqual(ns.win, 1);
});

test('validasi posisi bola putih (kitchen & tumpang tindih)', () => {
  const st = E.newGame(0, E.mulberry(1));
  assert.ok(E.validCuePos(st.balls, T.HEAD_X - 0.1, 0, true));
  assert.ok(!E.validCuePos(st.balls, 0, 0, true));
  assert.ok(E.validCuePos(st.balls, 0, 0, false));
  assert.ok(!E.validCuePos(st.balls, st.balls[5].x, st.balls[5].z, false));
  assert.ok(!E.validCuePos(st.balls, T.L, 0, false));
});

test('bot memainkan game penuh sampai selesai (sulit vs sedang)', () => {
  let wins = [0, 0];
  const t0 = Date.now();
  for (let g = 0; g < 3; g++) {
    let st = E.newGame(g % 2, E.mulberry(100 + g));
    let n = 0;
    while (st.win < 0 && n < 250) {
      const lvl = st.turn === 0 ? 2 : 1;
      const shot = E.botPlan(st, lvl, 1000 * g + n + 1);
      assert.ok(Number.isFinite(shot.dx) && Number.isFinite(shot.v));
      if (st.bih) assert.ok(E.validCuePos(st.balls, shot.cx, shot.cz, st.kitchen), 'penempatan BIH tidak sah');
      const r = E.simulate(st.balls, shot);
      st = E.applyShot(st, shot, r);
      n++;
    }
    assert.ok(st.win >= 0, 'game tidak selesai dalam 250 pukulan');
    wins[st.win]++;
    console.log('     game', g, 'selesai dalam', n, 'pukulan, pemenang kursi', st.win, '-', st.winReason);
  }
  console.log('     menang sulit/sedang:', wins.join('/'), 'waktu', Date.now() - t0, 'ms');
});

console.log(passed + ' test lulus');
