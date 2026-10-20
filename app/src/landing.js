// Landing COWL: CA/hitung mundur, angka live, cerita 4 babak yang digerakkan gulir, momen HOLD, kanvas alamat sekali pakai.
import STOCKS from './stocks.json';
import { createVault } from './vault3d.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (t) => t * t * (3 - 2 * t);
const short = (a, n = 4) => (a ? a.slice(0, 2 + n) + '…' + a.slice(-n) : '');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let CFG = {};
let LIVE = { ca: '', launchAt: '2026-10-19T13:00:00Z' };

function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2000);
}

// ---------------------------------------------------------------- CA + hitung mundur
function applyLive() {
  const ca = (LIVE.ca || '').trim();
  const launch = Date.parse(LIVE.launchAt || '2026-10-19T13:00:00Z');
  $$('[data-ca-full]').forEach((el) => { el.textContent = ca || 'Appears here at launch'; });
  $$('[data-ca-copy]').forEach((b) => { b.hidden = !ca; });
  const chip = $('[data-ca-chip]');
  if (chip) {
    $('[data-ca-label]', chip).textContent = ca ? 'CA' : 'LAUNCH';
    $('[data-ca-short]', chip).textContent = ca ? short(ca) : '19 Oct · 13:00 UTC';
  }
  const pons = ca ? `https://www.ponsfamily.com/launchpad/${ca.toLowerCase()}` : '';
  $$('[data-buy]').forEach((a) => { if (ca) { a.href = pons; a.target = '_blank'; a.rel = 'noopener'; a.removeAttribute('aria-disabled'); } });
  // grafik DexScreener (alamat token huruf kecil)
  $$('[data-chart]').forEach((a) => { if (ca) { a.href = `https://dexscreener.com/robinhood/${ca.toLowerCase()}`; a.target = '_blank'; a.rel = 'noopener'; a.removeAttribute('aria-disabled'); } });
  $$('[data-contract]').forEach((a) => { if (ca) { a.href = `${CFG.explorer || 'https://robinhoodchain.blockscout.com'}/token/${ca}`; a.target = '_blank'; a.rel = 'noopener'; a.removeAttribute('aria-disabled'); } });
  const st = $('[data-cc-status]');
  if (ca) { st.classList.add('live'); $('[data-cc-status-text]').textContent = 'Live on Pons'; }
  tickCountdown(launch, !!ca);
}
let cdTimer;
function tickCountdown(launch, live) {
  const el = $('[data-countdown]');
  clearInterval(cdTimer);
  const draw = () => {
    if (live) { el.innerHTML = 'Live <small>ROBINHOOD CHAIN</small>'; return; }
    const s = Math.max(0, Math.floor((launch - Date.now()) / 1000));
    if (s === 0) { el.innerHTML = 'Launching <small>NOW</small>'; return; }
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    el.innerHTML = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')} <small>TO LAUNCH</small>`;
  };
  draw();
  if (!live) cdTimer = setInterval(draw, 1000);
}
async function pollLive() {
  try {
    const l = await fetch('/live.json', { cache: 'no-store' }).then((r) => r.json());
    const changed = (l.ca || '') !== (LIVE.ca || '');
    LIVE = l;
    if (changed) applyLive();
  } catch {}
}

// ---------------------------------------------------------------- angka live
const lastStats = {};
async function pollStats() {
  try {
    const s = await fetch('/api/stats', { cache: 'no-store' }).then((r) => r.json());
    for (const k of ['announcements', 'viaCowl', 'head']) {
      if (s[k] == null) continue;
      const v = Number(s[k]).toLocaleString('en-US');
      for (const el of $$(`[data-stat="${k}"]`)) {
        if (lastStats[k] !== undefined && lastStats[k] !== v && k !== 'head') { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
        el.textContent = v;
      }
      lastStats[k] = v;
    }
  } catch {}
}

// ---------------------------------------------------------------- cerita digulir + tudung 3D
const story = $('#story');
const statement = $('#statement');
const acts = $$('.story-copy article');
const rails = $$('.story-rail i');
const finalSec = $('.final');
const finalSpace = $('.final-space');
const scrambles = $$('[data-scramble]', statement).map((el) => ({ el, orig: el.textContent }));
const mobile = () => innerWidth <= 960;
let hood = null;
let hooded = false;
let lifting = false; // tombol HOLD ditahan → tudung diangkat
function setHooded(on) {
  if (on === hooded) return;
  hooded = on;
  statement.classList.toggle('hooded', on);
  for (const s of scrambles) s.el.textContent = on ? s.orig.replace(/[0-9A-Za-z]/g, '•') : s.orig;
}
const lerp = (a, b, t) => a + (b - a) * t;
const mixPose = (A, B, t) => { const o = {}; for (const k in A) o[k] = lerp(A[k], B[k] ?? A[k], t); return o; };

function heroPose() {
  if (!hood) return null;
  if (mobile()) {
    // posisi dikunci di layar (diukur saat halaman di paling atas), jadi brankas tidak ikut "lari" saat digulir
    if (!heroPose.cache || heroPose.w !== innerWidth) {
      const fig = $('.hero-figure').getBoundingClientRect();
      const top = fig.top + scrollY;
      const c = hood.screenToWorld(fig.left + fig.width / 2, top + fig.height * 0.5);
      const sc = (fig.height * c.per) / 4.2;
      heroPose.cache = { x: c.x, y: c.y - 0.3 * sc, scale: sc, open: 0, dissolve: 0, mine: 0, opacity: 1 };
      heroPose.w = innerWidth;
    }
    return { ...heroPose.cache };
  }
  return { x: 0, y: -0.02, scale: innerWidth / innerHeight > 1.25 ? 0.74 : 0.62, open: 0, dissolve: 0, mine: 0, opacity: 1 };
}
// keadaan latar per bagian; posisi TIDAK berpindah (tetap di tengah layar), hanya skala/redup/buka/urai
function bgPose(base, o) { return Object.assign({ x: 0, y: -0.02, scale: base.scale, open: 0, dissolve: 0, mine: 0, opacity: 1 }, o); }
function onScroll() {
  const y = scrollY, vh = innerHeight;
  $('#nav').classList.toggle('solid', y > 40);
  const r = story.getBoundingClientRect();
  const total = story.offsetHeight - vh;
  const p = clamp(-r.top / total);
  const pos = p * 4;
  const act = Math.min(3, Math.floor(pos));
  const t = pos - act;
  const inStory = r.top <= 0 && r.bottom >= vh;
  acts.forEach((a, i) => a.classList.toggle('on', i === act));
  rails.forEach((el, i) => el.style.setProperty('--fill', clamp(pos - i).toFixed(3)));
  setHooded(inStory && (act > 1 || (act === 1 && t > 0.35)));
  statement.classList.toggle('landing-on', inStory && act >= 2 && !lifting);
  statement.classList.toggle('mine-on', inStory && act === 3 && t > 0.15);
  if (!hood) return;

  const H = heroPose();
  const big = H.scale * 1.06;
  const docH = document.documentElement.scrollHeight - vh;
  const spin = (y / Math.max(1, docH)) * Math.PI * 1.2; // berputar pelan mengikuti gulir (bisa mundur)
  const fr = finalSec.getBoundingClientRect();
  let pose;
  if (r.top > 0) {
    // hero → cerita: membesar sedikit, meredup, mulai terbuka — tanpa berpindah tempat
    const k = ease(clamp(1 - r.top / vh));
    pose = bgPose(H, { x: H.x, y: H.y, scale: H.scale + (big - H.scale) * k, open: 0.65 * k, opacity: 1 - 0.7 * k });
  } else if (inStory) {
    if (act === 0) pose = bgPose(H, { scale: big, open: 0.65, opacity: 0.3 });
    else if (act === 1) pose = bgPose(H, { scale: big, open: 0.65 * (1 - ease(clamp(t / 0.7))), opacity: 0.3 });
    else if (act === 2) pose = bgPose(H, { scale: big, dissolve: ease(clamp(t / 0.85)), opacity: 0.45 });
    else pose = bgPose(H, { scale: big, dissolve: 1, mine: ease(clamp(t / 0.6)), opacity: 0.6 });
  } else if (fr.top < vh * 0.95) {
    // penutup: titik-titik menyatu kembali jadi brankas di ruang kosong
    const s2 = finalSpace.getBoundingClientRect();
    const c = hood.screenToWorld(s2.left + s2.width / 2, s2.top + s2.height * 0.52);
    const sc = (s2.height * c.per) / 3.6;
    const k = ease(clamp((vh - fr.top) / (vh * 0.9)));
    pose = bgPose(H, { x: 0, y: c.y - 0.32 * sc, scale: big + (sc - big) * k, dissolve: 1 - k, opacity: 0.35 + 0.65 * k });
  } else {
    // How / Proof / Honest / FAQ: titik-titik melayang samar di belakang teks
    pose = bgPose(H, { scale: big, dissolve: 1, opacity: 0.2 });
  }
  pose.spin = spin;
  if (lifting && inStory && act === 1) pose.opacity = 0.15;
  hood.setPose(pose);
}
// ---------------------------------------------------------------- HOLD: lihat seperti pengirim
function bindHold() {
  const btn = $('[data-hold]');
  if (!btn) return;
  let h = 0, raf = 0, holding = false;
  const label = $('.hold-label', btn);
  const step = () => {
    h = clamp(h + (holding ? 0.05 : -0.09));
    btn.style.setProperty('--h', h.toFixed(3));
    const show = holding && h >= 1;
    statement.classList.toggle('sender', show);
    story.classList.toggle('sending', show);
    if (show !== lifting) { lifting = show; onScroll(); label.textContent = show ? 'Release to put it back' : 'Hold to see what a sender sees'; btn.classList.toggle('active', show); }
    if (!holding && h <= 0.0001) { raf = 0; return; }
    raf = requestAnimationFrame(step);
  };
  const down = (e) => { e.preventDefault(); holding = true; if (!raf) raf = requestAnimationFrame(step); };
  const up = () => { holding = false; if (!raf) raf = requestAnimationFrame(step); };
  btn.addEventListener('pointerdown', down);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, up));
  btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(e); });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') up(); });
}

function initScene() {
  const canvas = $('#scene');
  try {
    hood = createVault(canvas, { lite: mobile(), maxDpr: mobile() ? 1.75 : 2, smooth: 0.06 });
  } catch (e) {
    hood = null;
    document.body.classList.add('no-webgl');
    return;
  }
  hood.setPose(heroPose(), true);

  hood.step(0.016);
  requestAnimationFrame(() => canvas.classList.add('ready'));
  if (!reduced) hood.start(); else hood.step(0.016);
  addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') hood.setPointer((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) hood.stop(); else if (!reduced) hood.start(); });
  window.__hood = hood; // untuk tes headless
}

// ---------------------------------------------------------------- lain-lain
function renderAssets() {
  const box = $('#asset-chips');
  if (!box) return;
  const top = STOCKS.slice(0, 22);
  box.innerHTML = `<span><span class="tok eth">ETH</span>Ether</span>` + top.map((s) => `<span><span class="tok">${s.symbol.slice(0, 4)}</span>${s.symbol}</span>`).join('') + `<span style="padding-left:14px">+${STOCKS.length - top.length} more stock tokens</span><span style="padding-left:14px">any ERC-20</span>`;
}
function bindCopy() {
  $$('[data-ca-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(LIVE.ca); toast('Contract address copied'); } catch { toast('Copy failed'); }
  }));
}
function revealOnScroll() {
  const els = $$('.sec-head, .how-grid article, .pf, .verify-self, .ledger-col, .contracts, .faq-list, .final h2, .final p, .assets');
  els.forEach((e) => e.classList.add('rv'));
  if (reduced || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -10% 0px' });
  els.forEach((e) => io.observe(e));
}
function fillContracts() {
  const ex = CFG.explorer || 'https://robinhoodchain.blockscout.com';
  for (const key of ['announcer', 'registry', 'router']) {
    const a = CFG[key];
    $$(`[data-addr="${key}"]`).forEach((el) => {
      if (!a) return;
      el.href = `${ex}/address/${a}${key === 'router' ? '?tab=contract' : ''}`;
      if (el.closest('.contracts')) el.textContent = short(a, 4);
    });
  }
  $$('[data-social]').forEach((a) => { if (CFG[a.dataset.social]) a.href = CFG[a.dataset.social]; });
  // bukti on-chain: setiap klaim menaut ke penjelajah blok
  const pr = CFG.proof || {};
  const links = {
    router: CFG.router && `${ex}/address/${CFG.router}?tab=contract`,
    routerBalance: CFG.router && `${ex}/address/${CFG.router}`,
    announcer: `${ex}/address/${CFG.announcer}`, registry: `${ex}/address/${CFG.registry}`,
    routerDeployTx: pr.routerDeployTx && `${ex}/tx/${pr.routerDeployTx}`,
    firstSendTx: pr.firstSendTx && `${ex}/tx/${pr.firstSendTx}`,
    firstWithdrawTx: pr.firstWithdrawTx && `${ex}/tx/${pr.firstWithdrawTx}`,
    firstStealth: pr.firstStealth && `${ex}/address/${pr.firstStealth}`,
  };
  $$('[data-proof]').forEach((a) => {
    const u = links[a.dataset.proof];
    if (u) a.href = u;
    if (a.dataset.proof === 'router' && CFG.router && a.closest('.pf-row')) a.textContent = short(CFG.router, 4) + ' ↗';
  });
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  $$('[data-proof-time]').forEach((el) => {
    const iso = pr[el.dataset.proofTime];
    if (!iso) return;
    const d = new Date(iso);
    el.textContent = `${d.getUTCDate()} ${MON[d.getUTCMonth()]} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  });
}

// saldo Router dibaca langsung dari chain (bukan dari server kita)
async function pollRouterBalance() {
  const el = $('[data-router-balance]');
  if (!el || !CFG.router) return;
  for (const rpc of CFG.rpcs || []) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [CFG.router, 'latest'] }), signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.result == null) continue;
      const wei = BigInt(j.result);
      el.innerHTML = `${(Number(wei) / 1e18).toFixed(6)} <small>ETH</small>`;
      return;
    } catch {}
  }
}

async function main() {
  try {
    [CFG, LIVE] = await Promise.all([
      fetch('/config.json', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/live.json', { cache: 'no-store' }).then((r) => r.json()),
    ]);
  } catch {}
  applyLive();
  fillContracts();
  bindCopy();
  renderAssets();
  initScene();
  bindHold();
  revealOnScroll();
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => { hood?.resize(); if (hood) hood.setPose(heroPose(), true); onScroll(); });
  onScroll();
  pollStats(); setInterval(pollStats, 10000);
  pollRouterBalance(); setInterval(pollRouterBalance, 15000);
  setInterval(pollLive, 20000);
}
main();
