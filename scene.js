// Pool 3D — scene Three.js: ruangan, meja, bola, stik, garis bidik, kamera.
(function () {
  'use strict';
  const T = PoolEngine.TABLE;
  const R = T.R, L = T.L, W = T.W, CW = T.CW;
  const RAIL = 0.13;            // lebar kayu rel
  const CUSH_TOP = 0.040;       // tinggi bantalan
  const RAIL_TOP = 0.046;

  const COLORS = {
    1: '#f2b705', 2: '#1b47c9', 3: '#d11f1f', 4: '#5a2a8c', 5: '#f0741a', 6: '#127a3b', 7: '#7c1b1b', 8: '#111111',
  };
  for (let i = 9; i <= 15; i++) COLORS[i] = COLORS[i - 8];
  const ballColor = id => (id === 0 ? '#f7f3e8' : COLORS[id]);

  let renderer, scene, camera, raycaster;
  const ballMeshes = [];
  let lampGroup, cueGroup, cueInner, aimLine, objLine, cueLine, ghost, placeRing, kitchenLine;
  const cam = { target: new THREE.Vector3(0, 0, 0), yaw: 0, pitch: 0.9, dist: 3.2 };
  const camGoal = { target: new THREE.Vector3(0, 0, 0), yaw: 0, pitch: 0.9, dist: 3.2 };
  const sinking = [];
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -R);

  function ballTexture(id) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    const col = ballColor(id);
    const stripe = id >= 9;
    g.fillStyle = stripe ? '#f7f3e8' : col;
    g.fillRect(0, 0, 512, 256);
    if (stripe) { g.fillStyle = col; g.fillRect(0, 72, 512, 112); }
    if (id > 0) {
      for (const u of [128, 384]) {
        g.fillStyle = '#f7f3e8';
        g.beginPath(); g.ellipse(u, 128, 40, 40, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#111';
        g.font = 'bold 50px Arial';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(id), u, 131);
        if (id === 6 || id === 9) { g.fillRect(u - 13, 158, 26, 4); }
      }
    } else {
      // titik merah kecil agar putaran bola putih terlihat
      g.fillStyle = '#c33';
      for (const [u, v] of [[128, 128], [384, 128], [256, 30], [0, 226]]) { g.beginPath(); g.arc(u, v, 7, 0, Math.PI * 2); g.fill(); }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function woodTexture(base, dark) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 90; i++) {
      g.strokeStyle = `rgba(${dark},${0.05 + Math.random() * 0.12})`;
      g.lineWidth = 1 + Math.random() * 3;
      g.beginPath();
      const y = Math.random() * 512;
      g.moveTo(0, y);
      for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 6);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function feltTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#1f7a4c'; g.fillRect(0, 0, 256, 256);
    const img = g.getImageData(0, 0, 256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 14;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(8, 4);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function shapeFromPts(pts) {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.closePath();
    return s;
  }
  // ekstrusi bentuk XZ ke atas: bentuk (x,z), tinggi h, dasar di y0
  function extrudeXZ(shape, h, y0, mat, bevel) {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: h, bevelEnabled: !!bevel, bevelThickness: bevel || 0, bevelSize: bevel || 0, bevelSegments: 2, curveSegments: 24,
    });
    geo.rotateX(Math.PI / 2); // (x,y,z) -> (x,-z,y): bentuk y -> dunia z, ekstrusi ke bawah
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y0 + h;
    return m;
  }

  // batas dalam kayu rel: persegi + busur di tiap kantong
  function railInnerPath() {
    const pts = [];
    const X = L + CW, Z = W + CW;
    const arc = (p, rr, a1, a2, cw) => {
      let d = a2 - a1;
      if (cw) { while (d > 0) d -= Math.PI * 2; } else { while (d < 0) d += Math.PI * 2; }
      const n = 20;
      for (let i = 0; i <= n; i++) {
        const a = a1 + d * i / n;
        pts.push([p.x + Math.cos(a) * rr, p.z + Math.sin(a) * rr]);
      }
    };
    const P = T.POCKETS;
    const cr = 0.072, sr = 0.066;
    // mulai di sisi atas (z = -Z) dari kiri ke kanan, searah jarum jam (dalam koordinat x,z)
    const cornerArc = (p, fromEdge, toEdge) => {
      // titik potong lingkaran dengan garis tepi
      const q = [];
      for (const e of [fromEdge, toEdge]) {
        if (e.axis === 'z') { const dz = e.v - p.z; const dx = Math.sqrt(Math.max(0, cr * cr - dz * dz)); q.push([p.x + e.sx * dx, e.v]); }
        else { const dx = e.v - p.x; const dz = Math.sqrt(Math.max(0, cr * cr - dx * dx)); q.push([e.v, p.z + e.sz * dz]); }
      }
      const a1 = Math.atan2(q[0][1] - p.z, q[0][0] - p.x), a2 = Math.atan2(q[1][1] - p.z, q[1][0] - p.x);
      // pilih arah yang melewati sisi luar sudut
      const out = Math.atan2(Math.sign(p.z), Math.sign(p.x));
      const within = (a, s, d) => { let t = a - s; if (d > 0) { while (t < 0) t += 2 * Math.PI; return t <= d; } while (t > 0) t -= 2 * Math.PI; return t >= d; };
      let dccw = a2 - a1; while (dccw < 0) dccw += 2 * Math.PI;
      arc(p, cr, a1, a2, !within(out, a1, dccw));
    };
    const sideArc = (p, top) => {
      const ez = top ? -Z : Z;
      const dz = ez - p.z;
      const dx = Math.sqrt(Math.max(0, sr * sr - dz * dz));
      // dari kiri ke kanan (atas) atau kanan ke kiri (bawah)
      const x1 = top ? -dx : dx, x2 = -x1;
      const a1 = Math.atan2(dz, x1 - p.x), a2 = Math.atan2(dz, x2 - p.x);
      const out = top ? -Math.PI / 2 : Math.PI / 2;
      let dccw = a2 - a1; while (dccw < 0) dccw += 2 * Math.PI;
      let t = out - a1; while (t < 0) t += 2 * Math.PI;
      arc(p, sr, a1, a2, !(t <= dccw));
    };
    // sisi atas (z=-Z): kiri-atas -> tengah-atas -> kanan-atas
    cornerArc(P[0], { axis: 'x', v: -X, sz: 1 }, { axis: 'z', v: -Z, sx: 1 });
    sideArc(P[1], true);
    cornerArc(P[2], { axis: 'z', v: -Z, sx: -1 }, { axis: 'x', v: X, sz: 1 });
    cornerArc(P[5], { axis: 'x', v: X, sz: -1 }, { axis: 'z', v: Z, sx: -1 });
    sideArc(P[4], false);
    cornerArc(P[3], { axis: 'z', v: Z, sx: 1 }, { axis: 'x', v: -X, sz: -1 });
    return pts;
  }

  function buildRoom() {
    const floorTex = woodTexture('#5b3a22', '30,15,5');
    floorTex.repeat.set(6, 6);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.8 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.78;
    floor.receiveShadow = true;
    scene.add(floor);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 1 });
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(14, 5), wallMat);
      w.position.y = 1.7;
      const a = i * Math.PI / 2;
      w.position.x = Math.sin(a) * 7; w.position.z = Math.cos(a) * 7;
      w.rotation.y = a + Math.PI;
      scene.add(w);
    }
    // lampu gantung (disembunyikan saat kamera tinggi / tampilan atas)
    lampGroup = new THREE.Group();
    scene.add(lampGroup);
    const shadeMat = new THREE.MeshStandardMaterial({ color: 0x0f3d24, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
    const glow = new THREE.MeshBasicMaterial({ color: 0xfff3d6 });
    for (const x of [-0.8, 0, 0.8]) {
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.24, 0.16, 24, 1, true), shadeMat);
      shade.position.set(x, 1.25, 0);
      lampGroup.add(shade);
      const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.2, 24), glow);
      bulb.rotation.x = Math.PI / 2; bulb.position.set(x, 1.18, 0);
      lampGroup.add(bulb);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.03, 0.05), new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.4 }));
    bar.position.set(0, 1.36, 0);
    lampGroup.add(bar);
  }

  function buildTable() {
    const felt = new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95 });
    const cushMat = new THREE.MeshStandardMaterial({ color: 0x135a36, roughness: 0.9 });
    const wood = new THREE.MeshStandardMaterial({ map: woodTexture('#6b3517', '40,15,0'), roughness: 0.45, metalness: 0.05 });
    const dark = new THREE.MeshBasicMaterial({ color: 0x030303 });

    // permukaan kain
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(2 * (L + CW), 2 * (W + CW)), felt);
    bed.rotation.x = -Math.PI / 2;
    bed.receiveShadow = true;
    scene.add(bed);

    // lubang kantong
    for (const p of T.POCKETS) {
      const corner = Math.abs(p.x) > 0.1;
      const rr = corner ? 0.072 : 0.066;
      const hole = new THREE.Mesh(new THREE.CircleGeometry(rr, 32), dark);
      hole.rotation.x = -Math.PI / 2;
      hole.position.set(p.x, 0.0015, p.z);
      scene.add(hole);
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr * 0.8, 0.12, 24, 1, true), dark);
      cup.position.set(p.x, -0.06, p.z);
      scene.add(cup);
    }

    // bantalan
    for (const poly of T.CUSHIONS) {
      const m = extrudeXZ(shapeFromPts(poly), CUSH_TOP, 0, cushMat);
      m.castShadow = false; m.receiveShadow = true;
      scene.add(m);
    }

    // kayu rel dengan lubang kantong
    const X = L + CW + RAIL, Z = W + CW + RAIL;
    const outer = shapeFromPts([[-X, -Z], [X, -Z], [X, Z], [-X, Z]]);
    const inner = railInnerPath();
    const hole = new THREE.Path();
    hole.moveTo(inner[0][0], inner[0][1]);
    for (let i = 1; i < inner.length; i++) hole.lineTo(inner[i][0], inner[i][1]);
    hole.closePath();
    outer.holes.push(hole);
    const rail = extrudeXZ(outer, RAIL_TOP + 0.03, -0.03, wood, 0.008);
    rail.castShadow = true; rail.receiveShadow = true;
    scene.add(rail);

    // diamond (titik penanda)
    const dm = new THREE.MeshStandardMaterial({ color: 0xcdbf9f, roughness: 0.4, metalness: 0.3 });
    const dg = new THREE.CircleGeometry(0.007, 4);
    const addD = (x, z) => {
      const d = new THREE.Mesh(dg, dm);
      d.rotation.x = -Math.PI / 2;
      d.position.set(x, RAIL_TOP + 0.0095, z);
      scene.add(d);
    };
    const mid = CW + RAIL / 2;
    for (let i = 1; i < 8; i++) if (i !== 4) { const x = -L + i * L / 4; addD(x, -W - mid); addD(x, W + mid); }
    for (let i = 1; i < 4; i++) { const z = -W + i * W / 2; addD(-L - mid, z); addD(L + mid, z); }

    // badan & kaki
    const body = new THREE.Mesh(new THREE.BoxGeometry(2 * X - 0.06, 0.2, 2 * Z - 0.06), wood);
    body.position.y = -0.13;
    body.castShadow = true;
    scene.add(body);
    const legG = new THREE.CylinderGeometry(0.07, 0.055, 0.56, 16);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legG, wood);
      leg.position.set(sx * (X - 0.2), -0.5, sz * (Z - 0.18));
      leg.castShadow = true;
      scene.add(leg);
    }

    // garis kepala (kitchen) samar
    const kg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(T.HEAD_X, 0.001, -W), new THREE.Vector3(T.HEAD_X, 0.001, W)]);
    kitchenLine = new THREE.Line(kg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 }));
    scene.add(kitchenLine);
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 16), new THREE.MeshBasicMaterial({ color: 0xcfe8d8 }));
    spot.rotation.x = -Math.PI / 2; spot.position.set(T.FOOT_X, 0.001, 0);
    scene.add(spot);
  }

  function buildBalls() {
    const geo = new THREE.SphereGeometry(R, 40, 28);
    for (let id = 0; id < 16; id++) {
      const mat = new THREE.MeshPhongMaterial({ map: ballTexture(id), shininess: 110, specular: 0x555555 });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.position.set(0, R, 0);
      // orientasi awal acak sedikit agar angka tidak seragam
      m.rotation.set(Math.random() * 0.6 - 0.3, Math.random() * Math.PI * 2, Math.random() * 0.6 - 0.3);
      scene.add(m);
      ballMeshes.push(m);
    }
  }

  function buildCue() {
    cueGroup = new THREE.Group();
    cueInner = new THREE.Group();
    cueGroup.add(cueInner);
    const len = 1.46;
    const parts = [
      { l: 0.012, r1: 0.0058, r2: 0.0058, c: 0x2f6fb5 },   // tip
      { l: 0.022, r1: 0.006, r2: 0.0062, c: 0xf4f1e6 },    // ferrule
      { l: 0.72, r1: 0.0062, r2: 0.0095, c: 0xc79a5c },    // shaft
      { l: 0.04, r1: 0.0095, r2: 0.0102, c: 0x222222 },    // sambungan
      { l: 0.52, r1: 0.0102, r2: 0.0142, c: 0x4a1f0e },    // butt
      { l: 0.146, r1: 0.0142, r2: 0.0148, c: 0x111111 },   // wrap
    ];
    let z = 0;
    for (const p of parts) {
      const g = new THREE.CylinderGeometry(p.r1, p.r2, p.l, 20);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: p.c, roughness: 0.4, metalness: 0.1 }));
      m.rotation.x = -Math.PI / 2; // sumbu Y -> -Z; ujung atas (tip) ke arah bola
      m.position.z = z + p.l / 2;
      m.castShadow = true;
      cueInner.add(m);
      z += p.l;
    }
    cueInner.rotation.x = -0.09;
    cueGroup.visible = false;
    scene.add(cueGroup);
    void len;
  }

  function buildAim() {
    const mk = (color, opacity, dashed) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.02, gapSize: 0.015 })
        : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
      const l = new THREE.Line(g, mat);
      l.frustumCulled = false;
      l.visible = false;
      scene.add(l);
      return l;
    };
    aimLine = mk(0xffffff, 0.8, true);
    objLine = mk(0xffe680, 0.9, false);
    cueLine = mk(0x9fd0ff, 0.6, true);
    ghost = new THREE.Mesh(new THREE.SphereGeometry(R, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }));
    ghost.visible = false;
    scene.add(ghost);
    placeRing = new THREE.Mesh(new THREE.RingGeometry(R * 1.15, R * 1.45, 32), new THREE.MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    placeRing.rotation.x = -Math.PI / 2;
    placeRing.visible = false;
    scene.add(placeRing);
  }

  function setLine(l, x1, z1, x2, z2, y) {
    const a = l.geometry.attributes.position.array;
    a[0] = x1; a[1] = y; a[2] = z1; a[3] = x2; a[4] = y; a[5] = z2;
    l.geometry.attributes.position.needsUpdate = true;
    l.geometry.computeBoundingSphere();
    if (l.material.isLineDashedMaterial) l.computeLineDistances();
    l.visible = true;
  }

  const Scene = {
    R,
    init(canvas) {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x15110f);
      scene.fog = new THREE.Fog(0x15110f, 5, 12);
      camera = new THREE.PerspectiveCamera(45, 1, 0.02, 40);
      raycaster = new THREE.Raycaster();

      scene.add(new THREE.HemisphereLight(0xfff4e0, 0x1a1410, 0.55));
      const key = new THREE.SpotLight(0xfff1d8, 1.6, 6, 0.95, 0.55, 1.2);
      key.position.set(0, 2.3, 0.1);
      key.target.position.set(0, 0, 0);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.near = 1; key.shadow.camera.far = 4;
      key.shadow.bias = -0.0004;
      key.shadow.radius = 3;
      scene.add(key); scene.add(key.target);
      for (const x of [-0.8, 0.8]) {
        const p = new THREE.PointLight(0xffe6c0, 0.45, 3.5, 2);
        p.position.set(x, 1.1, 0);
        scene.add(p);
      }

      buildRoom();
      buildTable();
      buildBalls();
      buildCue();
      buildAim();
      Scene.resize();
      window.addEventListener('resize', Scene.resize);
    },
    resize() {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    get aspect() { return camera.aspect; },

    // ---- bola ----
    setBalls(balls) {
      for (const b of balls) {
        const m = ballMeshes[b.id];
        const si = sinking.findIndex(s => s.id === b.id);
        if (si >= 0) {
          if (b.on === false) continue; // biarkan animasi masuk kantong selesai
          sinking.splice(si, 1);
        }
        m.visible = b.on !== false;
        m.position.set(b.x, R, b.z);
        m.scale.setScalar(1);
      }
    },
    moveBall(id, x, z) {
      const m = ballMeshes[id];
      const dx = x - m.position.x, dz = z - m.position.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 1e-7) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(dz / d, 0, -dx / d), d / R);
        m.quaternion.premultiply(q);
      }
      m.position.x = x; m.position.z = z; m.position.y = R;
      m.visible = true;
    },
    sinkBall(id, pocket) {
      const p = T.POCKETS[pocket];
      sinking.push({ id, px: p.x, pz: p.z, t: 0 });
    },
    ballPos(id) { return ballMeshes[id].position; },

    // ---- stik ----
    setCue(on, x, z, dx, dz, pull, sx, sy) {
      cueGroup.visible = on;
      if (!on) return;
      const rx = -dz, rz = dx;
      cueGroup.position.set(x + rx * sx * R * 0.55, R + sy * R * 0.55, z + rz * sx * R * 0.55);
      cueGroup.rotation.y = Math.atan2(-dx, -dz);
      cueInner.position.z = R + 0.012 + pull;
    },

    // ---- garis bidik ----
    setAim(info) {
      if (!info) { aimLine.visible = objLine.visible = cueLine.visible = ghost.visible = false; return; }
      const y = R * 0.35;
      const { cx, cz, p } = info;
      setLine(aimLine, cx, cz, p.gx, p.gz, y);
      aimLine.material.color.set(info.bad ? 0xff6666 : 0xffffff);
      ghost.visible = true;
      ghost.position.set(p.gx, R, p.gz);
      // garis arah setelah tumbukan (bola sasaran & bola putih) bisa dimatikan
      if (info.after === false) { objLine.visible = cueLine.visible = false; return; }
      if (p.type === 'ball') {
        const len = info.long ? 0.5 : 0.28;
        const ox = p.gx + p.ox * 2 * R, oz = p.gz + p.oz * 2 * R;
        setLine(objLine, ox, oz, ox + p.ox * len * (0.4 + Math.abs(p.cut)), oz + p.oz * len * (0.4 + Math.abs(p.cut)), y);
        const tl = Math.sqrt(p.tx * p.tx + p.tz * p.tz);
        if (tl > 0.02) setLine(cueLine, p.gx, p.gz, p.gx + p.tx / tl * 0.22 * tl, p.gz + p.tz / tl * 0.22 * tl, y);
        else cueLine.visible = false;
      } else {
        objLine.visible = false;
        setLine(cueLine, p.gx, p.gz, p.gx + p.rx * 0.25, p.gz + p.rz * 0.25, y);
      }
    },
    setPlaceRing(on, x, z, ok) {
      placeRing.visible = on;
      if (!on) return;
      placeRing.position.set(x, 0.002, z);
      placeRing.material.color.set(ok ? 0x66ff99 : 0xff5555);
    },
    setKitchen(on) { kitchenLine.material.opacity = on ? 0.6 : 0.18; },

    // ---- kamera ----
    cam, camGoal,
    snapCam() { cam.target.copy(camGoal.target); cam.yaw = camGoal.yaw; cam.pitch = camGoal.pitch; cam.dist = camGoal.dist; },
    pickTable(clientX, clientY) {
      const v = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
      raycaster.setFromCamera(v, camera);
      const out = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, out)) return null;
      return { x: out.x, z: out.z };
    },
    project(x, y, z) {
      const v = new THREE.Vector3(x, y, z).project(camera);
      return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight, behind: v.z > 1 };
    },

    frame(dt) {
      // kamera halus
      const k = 1 - Math.exp(-dt * 8);
      cam.target.lerp(camGoal.target, k);
      let dy = camGoal.yaw - cam.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      cam.yaw += dy * k;
      cam.pitch += (camGoal.pitch - cam.pitch) * k;
      cam.dist += (camGoal.dist - cam.dist) * k;
      const cp = Math.cos(cam.pitch);
      camera.position.set(
        cam.target.x + Math.sin(cam.yaw) * cp * cam.dist,
        cam.target.y + Math.sin(cam.pitch) * cam.dist,
        cam.target.z + Math.cos(cam.yaw) * cp * cam.dist);
      if (camera.position.y < 0.08) camera.position.y = 0.08;
      camera.lookAt(cam.target);
      lampGroup.visible = camera.position.y < 1.0;

      // bola masuk kantong
      for (let i = sinking.length - 1; i >= 0; i--) {
        const s = sinking[i];
        const m = ballMeshes[s.id];
        s.t += dt;
        m.position.x += (s.px - m.position.x) * Math.min(1, dt * 14);
        m.position.z += (s.pz - m.position.z) * Math.min(1, dt * 14);
        m.position.y = R - Math.min(1, s.t / 0.35) * 0.09;
        if (s.t > 0.4) { m.visible = false; sinking.splice(i, 1); }
      }
      renderer.render(scene, camera);
    },
  };
  window.PoolScene = Scene;
})();
