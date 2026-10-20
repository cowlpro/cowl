// "The Vault" COWL — versi realistis: lingkungan HDRI studio asli, lapisan ber-bevel & bersudut bulat,
// noda halus di permukaan, bayangan antar-lapisan, bloom pada bara, dan gerakan mekanis berbobot
// (lapisan terangkat, berputar, sedikit lewat, lalu "klik" mengunci). Bisa membuka, mengunci, dan terurai jadi titik.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const H = 2.3; // tinggi piramida
const W = 1.15; // setengah lebar alas
const LAYERS = [0, 0.42, 0.78, 1.1, 1.38, 1.62, 1.84, H];
const GAP = 0.03;
const Y0 = -H * 0.36; // geser supaya pusat visual dekat titik asal
const halfW = (h) => W * (1 - h / H);

// ---------- geometri lapisan: frustum persegi dengan bevel membulat & sudut membulat ----------
function slabGeometry(h0, h1, bevel, cornerR, seg = 6, bevSeg = 4) {
  const rings = []; // [y, insetDariTepi]
  for (let k = 0; k <= bevSeg; k++) { const a = (k / bevSeg) * Math.PI / 2; rings.push([h0 + bevel * (1 - Math.cos(a)), bevel * (1 - Math.sin(a))]); }
  rings.push([h0 + bevel + 0.004, 0]);
  rings.push([h1 - bevel - 0.004, 0]);
  for (let k = bevSeg; k >= 0; k--) { const a = (k / bevSeg) * Math.PI / 2; rings.push([h1 - bevel * (1 - Math.cos(a)), bevel * (1 - Math.sin(a))]); }
  const pos = [], uv = [], idx = [];
  const perRing = 4 * (seg + 1);
  // satu cincin persegi bersudut bulat
  const ringPts = (hw) => {
    const cr = Math.min(cornerR, hw * 0.45);
    const pts = [];
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    corners.forEach(([sx, sz], c) => {
      const a0 = (c * Math.PI) / 2;
      for (let s = 0; s <= seg; s++) {
        const a = a0 + (s / seg) * (Math.PI / 2);
        pts.push([sx * (hw - cr) + Math.cos(a) * cr, sz * (hw - cr) + Math.sin(a) * cr]);
      }
    });
    return pts;
  };
  rings.forEach(([y, inset]) => {
    const hw = Math.max(0.006, halfW(y) - inset);
    const pts = ringPts(hw);
    let acc = 0;
    pts.forEach(([x, z], i) => {
      if (i) acc += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      pos.push(x, y, z);
      uv.push(acc / (hw * 8), (y - h0) / (h1 - h0));
    });
  });
  for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < perRing; i++) {
    const a = r * perRing + i, b = r * perRing + ((i + 1) % perRing), c = a + perRing, d = b + perRing;
    idx.push(a, c, b, b, c, d);
  }
  // tutup bawah & atas (kipas ke titik tengah)
  const cap = (ringIndex, y, flip) => {
    const center = pos.length / 3;
    pos.push(0, y, 0); uv.push(0.5, flip ? 1 : 0);
    for (let i = 0; i < perRing; i++) {
      const a = ringIndex * perRing + i, b = ringIndex * perRing + ((i + 1) % perRing);
      if (flip) idx.push(center, b, a); else idx.push(center, a, b);
    }
  };
  cap(0, h0, false);
  cap(rings.length - 1, h1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------- tekstur prosedural: noda halus & serat sikat ----------
function noiseTexture(kind) {
  const N = 512, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  let s = kind === 'brushed' ? 11 : 23;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  g.fillStyle = 'rgb(128,128,128)'; g.fillRect(0, 0, N, N);
  if (kind === 'brushed') {
    for (let i = 0; i < 2200; i++) {
      const y = rnd() * N, v = 100 + rnd() * 70;
      g.strokeStyle = `rgba(${v},${v},${v},${0.25 + rnd() * 0.35})`; g.lineWidth = 0.5 + rnd();
      g.beginPath(); g.moveTo(0, y); g.lineTo(N, y + (rnd() - 0.5) * 2); g.stroke();
    }
  } else {
    // noda: bercak lembut besar + bintik halus
    for (let i = 0; i < 70; i++) {
      const x = rnd() * N, y = rnd() * N, r = 20 + rnd() * 90, v = rnd() > 0.5 ? 185 : 90;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${v},${v},${v},${0.18 + rnd() * 0.2})`); gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 9000; i++) { const v = 100 + rnd() * 90; g.fillStyle = `rgba(${v},${v},${v},.35)`; g.fillRect(rnd() * N, rnd() * N, 1, 1); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

const easeOutBack = (t, k = 1.25) => 1 + (k + 1) * Math.pow(t - 1, 3) + k * Math.pow(t - 1, 2);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function createVault(canvas, opts = {}) {
  const lite = !!opts.lite;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lite, alpha: false, powerPreference: 'high-performance' });
  const dpr = Math.min(opts.maxDpr || 2, devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 0.8;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (!lite) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }

  const scene = new THREE.Scene();
  // latar: gradasi radial gelap (bagian dari adegan, karena kanvas kini buram untuk bloom)
  const bgTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d'); const gr = g.createRadialGradient(256, 210, 0, 256, 256, 360);
    gr.addColorStop(0, '#16161a'); gr.addColorStop(0.45, '#08080a'); gr.addColorStop(1, '#000');
    g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  scene.background = bgTex;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;
  // HDRI studio asli menggantikan ruang buatan begitu termuat
  new RGBELoader().load(opts.hdr || '/assets/studio.hdr', (tex) => {
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
    scene.environmentIntensity = opts.envIntensity ?? 0.3;
    scene.environmentRotation.y = 0.9;
  });

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const camBase = new THREE.Vector3(0, 0.35, 8.2);
  camera.position.copy(camBase);

  // ---------- cahaya ----------
  const key = new THREE.SpotLight(0xf6f7ff, 28, 30, 0.46, 0.9, 1.2);
  key.position.set(2.2, 7.2, 3.6); key.target.position.set(0, 0.5, 0);
  if (!lite) { key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 4; }
  const rimL = new THREE.DirectionalLight(0xcfd8ff, 2.6); rimL.position.set(-5, 2, -4);
  const rimR = new THREE.DirectionalLight(0xffffff, 2.0); rimR.position.set(5, 1.5, -3);
  scene.add(key, key.target, rimL, rimR);

  // ---------- material ----------
  const smudge = noiseTexture('smudge');
  const brushed = noiseTexture('brushed');
  smudge.repeat.set(1.5, 1.5); brushed.repeat.set(1, 3);
  const mats = {
    ceramic: new THREE.MeshPhysicalMaterial({
      color: 0x010102, metalness: 0.0, roughness: 0.22, roughnessMap: smudge, clearcoat: 1, clearcoatRoughness: 0.045,
      clearcoatRoughnessMap: smudge, reflectivity: 0.5,
    }),
    titanium: new THREE.MeshPhysicalMaterial({
      color: 0x34363c, metalness: 1, roughness: 0.5, roughnessMap: brushed, anisotropy: 0.85, anisotropyRotation: 0,
    }),
    glass: lite
      ? new THREE.MeshPhysicalMaterial({ color: 0x1c1e24, metalness: 0.1, roughness: 0.06, transparent: true, opacity: 0.6, clearcoat: 1 })
      : new THREE.MeshPhysicalMaterial({
        color: 0xc4cad4, metalness: 0, roughness: 0.02, transmission: 1, thickness: 0.9, ior: 1.52, dispersion: 0.4,
        attenuationColor: new THREE.Color(0x3a3d45), attenuationDistance: 1.4, clearcoat: 1, clearcoatRoughness: 0.02,
      }),
    chrome: new THREE.MeshPhysicalMaterial({ color: 0xf1f2f6, metalness: 1, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 }),
  };
  const order = ['ceramic', 'titanium', 'glass', 'ceramic', 'titanium', 'glass', 'ceramic'];

  const vault = new THREE.Group();
  // ---------- inti bara ----------
  const coreY = 0.86 + Y0;
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x1a0500, emissive: 0xff4a1f, emissiveIntensity: 3, roughness: 0.35 });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), coreMat);
  core.position.y = coreY;
  const coreLight = new THREE.PointLight(0xff5a36, 5, 3.4, 1.6);
  coreLight.position.y = coreY;
  const cageMat = new THREE.MeshPhysicalMaterial({ color: 0xffd2bd, metalness: 1, roughness: 0.2 });
  const cage = new THREE.Group();
  {
    const o = new THREE.OctahedronGeometry(0.3, 0), e = new THREE.EdgesGeometry(o), p = e.attributes.position;
    for (let i = 0; i < p.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(p, i), b = new THREE.Vector3().fromBufferAttribute(p, i + 1);
      const len = a.distanceTo(b);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, len, 6), cageMat);
      rod.position.copy(a).add(b).multiplyScalar(0.5);
      rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      cage.add(rod);
    }
  }
  cage.position.y = coreY;
  vault.add(core, coreLight, cage);

  // ---------- lapisan ----------
  const slabs = [];
  for (let i = 0; i < LAYERS.length - 1; i++) {
    const h0 = LAYERS[i] + (i ? GAP / 2 : 0), h1 = LAYERS[i + 1] - (i < LAYERS.length - 2 ? GAP / 2 : 0.02);
    const g = slabGeometry(h0, h1, Math.min(0.035, (h1 - h0) * 0.18), 0.05, lite ? 3 : 6, lite ? 2 : 4);
    g.translate(0, -(h0 + h1) / 2, 0);
    const m = new THREE.Mesh(g, mats[order[i]]);
    m.castShadow = m.receiveShadow = !lite;
    const pivot = new THREE.Group();
    pivot.position.y = (h0 + h1) / 2 + Y0;
    pivot.add(m);
    vault.add(pivot);
    slabs.push({ pivot, base: pivot.position.y, rot: 0, from: 0, to: 0, t0: -1, dur: 1.05 });
  }

  // pendar bara
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'); const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,120,80,.9)'); gr.addColorStop(0.18, 'rgba(255,80,40,.32)'); gr.addColorStop(1, 'rgba(255,80,40,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
  })();
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.position.y = coreY; glow.scale.set(1, 1, 1); glow.renderOrder = 3;
  vault.add(glow);

  // ---------- cincin sigil (astrolab) ----------
  const rings = new THREE.Group();
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.009, 12, 320), mats.chrome);
  const ringB = new THREE.Mesh(new THREE.TorusGeometry(2.22, 0.005, 10, 320), mats.chrome);
  const arcMat = new THREE.MeshStandardMaterial({ color: 0x220700, emissive: 0xff5a36, emissiveIntensity: 2.4 });
  const arc = new THREE.Mesh(new THREE.TorusGeometry(2.08, 0.007, 8, 140, Math.PI * 0.42), arcMat);
  const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.01, 1, 0.01), mats.chrome, 60);
  const dummy = new THREE.Object3D();
  for (let k = 0; k < 60; k++) {
    const a = (k / 60) * Math.PI * 2, len = k % 5 === 0 ? 0.17 : 0.07;
    dummy.position.set(Math.cos(a) * (1.95 - len / 2 - 0.025), Math.sin(a) * (1.95 - len / 2 - 0.025), 0);
    dummy.rotation.set(0, 0, a - Math.PI / 2); dummy.scale.set(1, len, 1);
    dummy.updateMatrix(); ticks.setMatrixAt(k, dummy.matrix);
  }
  const gA = new THREE.Group(); gA.add(ringA, ticks); gA.rotation.x = Math.PI * 0.42;
  const gB = new THREE.Group(); gB.add(ringB, arc); gB.rotation.set(Math.PI * 0.62, 0.35, 0);
  rings.add(gA, gB);
  rings.position.y = coreY;
  vault.add(rings);

  // ---------- debu melayang ----------
  let sd = 9;
  const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dustN = lite ? 140 : 360;
  const dpos = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) { dpos[i * 3] = (rnd() - 0.5) * 9; dpos[i * 3 + 1] = (rnd() - 0.5) * 5; dpos[i * 3 + 2] = (rnd() - 0.5) * 4; }
  const dgeo = new THREE.BufferGeometry(); dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
  const dust = new THREE.Points(dgeo, new THREE.PointsMaterial({ color: 0x8e9098, size: 0.011, transparent: true, opacity: 0.5, depthWrite: false }));
  scene.add(dust);

  // ---------- titik untuk babak "terurai" ----------
  const NP = lite ? 2600 : 5200;
  const pFrom = new Float32Array(NP * 3), pTo = new Float32Array(NP * 3), pSeed = new Float32Array(NP), pMine = new Float32Array(NP);
  for (let n = 0; n < NP; n++) {
    const h = Math.pow(rnd(), 0.8) * H * 0.98, w = halfW(h), side = Math.floor(rnd() * 4), s = (rnd() * 2 - 1) * w;
    const x = side < 2 ? s : (side === 2 ? w : -w), z = side < 2 ? (side === 0 ? w : -w) : s;
    pFrom[n * 3] = x; pFrom[n * 3 + 1] = h + Y0; pFrom[n * 3 + 2] = z;
    pTo[n * 3] = (rnd() - 0.5) * 8; pTo[n * 3 + 1] = (rnd() - 0.5) * 4.6; pTo[n * 3 + 2] = (rnd() - 0.5) * 1.8;
    pSeed[n] = rnd(); pMine[n] = n % 331 === 7 ? 1 : 0;
  }
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.BufferAttribute(pFrom, 3));
  pgeo.setAttribute('aTo', new THREE.BufferAttribute(pTo, 3));
  pgeo.setAttribute('aSeed', new THREE.BufferAttribute(pSeed, 1));
  pgeo.setAttribute('aMine', new THREE.BufferAttribute(pMine, 1));
  const pmat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uT: { value: 0 }, uMix: { value: 0 }, uMine: { value: 0 }, uPx: { value: dpr } },
    vertexShader: `
      attribute vec3 aTo; attribute float aSeed; attribute float aMine;
      uniform float uT, uMix, uMine, uPx; varying float vA; varying float vMine;
      void main(){
        float m = smoothstep(aSeed*0.45, aSeed*0.45+0.55, uMix);
        vec3 p = mix(position, aTo, m);
        p += vec3(sin(uT*0.6+aSeed*40.0), cos(uT*0.5+aSeed*31.0), 0.0) * 0.035 * m;
        vec4 mv = modelViewMatrix * vec4(p,1.0);
        gl_Position = projectionMatrix * mv;
        vMine = aMine * uMine;
        float sz = mix(2.2, 3.6, aSeed) + vMine * 34.0;
        gl_PointSize = sz * uPx * (7.0 / -mv.z);
        vA = (0.35 + 0.65*m) * (1.0 - uMine*0.5*(1.0-aMine)) * mix(0.55, 1.0, aSeed);
      }`,
    fragmentShader: `
      varying float vA; varying float vMine;
      void main(){
        vec2 c = gl_PointCoord - 0.5; float d = length(c);
        float a = smoothstep(0.5, 0.0, d);
        a = mix(a, a*a*0.6 + smoothstep(0.12, 0.0, d), vMine);
        vec3 col = mix(vec3(0.93,0.94,0.96), vec3(1.6,0.6,0.35), vMine);
        gl_FragColor = vec4(col, a * vA);
      }`,
  });
  const points = new THREE.Points(pgeo, pmat);
  points.visible = false;
  vault.add(points);

  const root = new THREE.Group();
  root.add(vault);
  scene.add(root);

  // ---------- pasca-proses: bloom halus ----------
  let composer = null;
  if (!lite) {
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(dpr);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), opts.bloom ?? 0.22, 0.45, opts.bloomThreshold ?? 0.96));
    composer.addPass(new OutputPass());
  }

  // ---------- keadaan ----------
  const state = { t: 0, mx: 0, my: 0, smx: 0, smy: 0, next: 0.9, seq: 0, shake: 0, idle: false, pose: { x: 0, y: 0, scale: 1, open: 0, dissolve: 0, mine: 0, opacity: 1, spin: 0 } };
  const target = { ...state.pose };
  const MOVES = [[3, 1], [1, -1], [5, 1], [2, -1], [4, 1], [0, 1], [3, -1], [6, 1], [2, 1], [5, -1], [1, 1], [4, -1]];

  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    composer?.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function step(dt) {
    dt = Math.min(0.05, Math.max(0, dt));
    const t = (state.t += dt);
    const p = state.pose;
    const k = 1 - Math.pow(opts.smooth ?? 0.002, dt);
    for (const key of Object.keys(target)) p[key] += (target[key] - p[key]) * k;
    state.smx += (state.mx - state.smx) * (1 - Math.pow(0.04, dt));
    state.smy += (state.my - state.smy) * (1 - Math.pow(0.04, dt));

    // jadwal putaran lapisan
    if (t >= state.next && p.open < 0.3 && p.dissolve < 0.3) {
      const [i, dir] = MOVES[state.seq++ % MOVES.length];
      const s = slabs[i];
      s.from = s.rot; s.to = s.rot + dir * Math.PI / 2; s.t0 = t; s.clacked = false;
      state.next = t + 1.25;
    }
    const mid = (slabs.length - 1) / 2;
    slabs.forEach((s, i) => {
      let lift = 0;
      if (s.t0 >= 0) {
        const u = Math.min(1, (t - s.t0) / s.dur);
        // fase: angkat (0–0.18), putar dengan sedikit lewat (0.12–0.88), turun & klik (0.82–1)
        const ru = Math.min(1, Math.max(0, (u - 0.12) / 0.76));
        s.rot = s.from + (s.to - s.from) * easeOutBack(easeInOut(ru) * 0.999 + 0.001, 0.9);
        lift = Math.sin(Math.min(1, u / 0.18) * Math.PI / 2) * (1 - Math.max(0, (u - 0.82) / 0.18));
        if (u > 0.9 && !s.clacked) { s.clacked = true; state.shake = 1; }
        if (u >= 1) { s.t0 = -1; s.rot = s.to; }
      }
      s.pivot.rotation.y = s.rot + p.open * (i - mid) * 0.22;
      s.pivot.position.y = s.base + lift * 0.045 + p.open * (i - mid) * 0.2;
      s.pivot.position.x = p.open * Math.sin(i * 2.1) * 0.12;
    });
    state.shake *= Math.pow(0.0005, dt);

    // inti: denyut + kedip kecil seperti bara
    const flick = 0.9 + 0.06 * Math.sin(t * 13.1) * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 2.4);
    coreMat.emissiveIntensity = (2.4 + p.open * 1.6) * flick;
    coreLight.intensity = (4 + p.open * 5) * flick;
    glow.scale.setScalar((0.85 + p.open * 0.45) * flick);
    core.rotation.y = t * 0.6; cage.rotation.y = -t * 0.35; cage.rotation.x = t * 0.2;
    gA.rotation.z = t * 0.1; gA.rotation.y = Math.sin(t * 0.21) * 0.05;
    gB.rotation.z = -t * 0.17; arc.rotation.z = t * 0.8;
    dust.rotation.y = t * 0.01;

    root.position.set(p.x, p.y + Math.sin(t * 0.7) * 0.035, 0);
    root.scale.setScalar(p.scale);
    vault.rotation.y = t * 0.14 + p.spin + state.smx * 0.45;
    vault.rotation.x = 0.08 - state.smy * 0.12;
    vault.position.y = Math.sin(t * 40) * 0.004 * state.shake;
    // kamera "tangan": goyang sangat pelan + paralaks kursor
    camera.position.set(camBase.x + Math.sin(t * 0.23) * 0.06 + state.smx * 0.25, camBase.y + Math.sin(t * 0.31) * 0.04 - state.smy * 0.15, camBase.z);
    camera.lookAt(0, 0.1, 0);

    const fade = (1 - Math.min(1, p.dissolve * 1.5)) * p.opacity;
    const needT = fade < 0.995;
    for (const m of [mats.ceramic, mats.titanium, mats.chrome, coreMat, cageMat, arcMat]) {
      if (m.transparent !== needT) { m.transparent = needT; m.needsUpdate = true; }
      m.opacity = fade;
    }
    const gT = lite || needT;
    if (mats.glass.transparent !== gT) { mats.glass.transparent = gT; mats.glass.needsUpdate = true; }
    mats.glass.opacity = (lite ? 0.6 : 1) * fade;
    glow.material.opacity = fade;
    const vis = fade > 0.01;
    slabs.forEach((s) => (s.pivot.visible = vis));
    [core, cage, rings, glow].forEach((o) => (o.visible = vis));
    coreLight.intensity *= fade;
    dust.material.opacity = 0.5 * p.opacity;
    points.visible = p.dissolve > 0.01 && p.opacity > 0.01;
    pmat.uniforms.uT.value = t; pmat.uniforms.uMix.value = p.dissolve; pmat.uniforms.uMine.value = p.mine;

    // tidak terlihat sama sekali → cukup gambar latar sekali, lalu diam
    const hidden = p.opacity < 0.004 && target.opacity < 0.004;
    if (hidden && state.idle) return;
    state.idle = hidden;
    if (composer) composer.render(); else renderer.render(scene, camera);
  }

  let raf = 0, last = 0, running = false;
  function loop(ts) { const dt = last ? (ts - last) / 1000 : 0.016; last = ts; step(dt); if (running) raf = requestAnimationFrame(loop); }
  function start() { if (running) return; running = true; last = 0; raf = requestAnimationFrame(loop); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  function screenToWorld(px, py) {
    const h = canvas.clientHeight || innerHeight, w = canvas.clientWidth || innerWidth;
    const per = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camBase.z) / h;
    return { x: (px - w / 2) * per, y: -(py - h / 2) * per + 0.1, per };
  }
  resize();
  addEventListener('resize', resize);
  return {
    start, stop, step, resize, screenToWorld,
    setPointer(nx, ny) { state.mx = nx; state.my = ny; },
    setPose(p, instant = false) { Object.assign(target, p); if (instant) Object.assign(state.pose, p); },
    get running() { return running; },
  };
}
