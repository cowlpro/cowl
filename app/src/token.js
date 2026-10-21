// Section token $COWL: grafik market cap dari transaksi asli di bonding curve Pons + fakta on-chain.
// Data dari /api/token (server membaca event CurveBuy/CurveSell, cadangan kurva, supply, harga ETH).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const fmtUsd = (v) => (v == null ? '—' : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K' : '$' + v.toFixed(2));
const fmtNum = (v, d = 0) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const fmtEth = (v) => (v == null ? '—' : v >= 1 ? v.toFixed(3) : v >= 0.01 ? v.toFixed(4) : v.toFixed(5));
const ago = (t) => {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - t));
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd';
};
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

let data = null;
let range = 'all';
let hover = null;

export function initToken(cfg) {
  const sec = $('#token');
  if (!sec || !cfg.token) return;
  const ex = cfg.explorer || 'https://robinhoodchain.blockscout.com';
  const T = cfg.token;
  // fakta statis dari config (bukti burn dsb.)
  $$('[data-tk-link]', sec).forEach((a) => {
    const k = a.dataset.tkLink;
    const u = { token: `${ex}/token/${T.ca}`, curve: `${ex}/address/${T.curve}`, dev: `${ex}/address/${T.dev}`, devBuy: `${ex}/tx/${T.devBuyTx}`,
      burn1: `${ex}/tx/${T.burnTxs[0]}`, burn2: `${ex}/tx/${T.burnTxs[1]}`, pons: `https://www.ponsfamily.com/launchpad/${T.ca.toLowerCase()}`,
      dex: `https://dexscreener.com/robinhood/${T.ca.toLowerCase()}` }[k];
    if (u) { a.href = u; a.target = '_blank'; a.rel = 'noopener'; }
  });
  $('[data-tk="devBurned"]', sec).textContent = fmtNum(T.devBurned);
  $('[data-tk="tax"]', sec).textContent = (T.creatorTaxBps / 100).toFixed(0) + '%';
  $$('[data-tk-range]', sec).forEach((b) => b.addEventListener('click', () => {
    range = b.dataset.tkRange;
    $$('[data-tk-range]', sec).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw();
  }));
  const cv = $('#tk-chart');
  cv.addEventListener('pointermove', (e) => { const r = cv.getBoundingClientRect(); hover = (e.clientX - r.left) / r.width; draw(); });
  cv.addEventListener('pointerleave', () => { hover = null; draw(); });
  addEventListener('resize', draw, { passive: true });
  // muat saat section mendekat, lalu segarkan berkala
  let started = false;
  const go = () => { if (started) return; started = true; load(); setInterval(() => { if (!document.hidden) load(); }, 20000); };
  if ('IntersectionObserver' in window) new IntersectionObserver((en, io) => { if (en.some((x) => x.isIntersecting)) { go(); io.disconnect(); } }, { rootMargin: '600px' }).observe(sec);
  else go();
}

async function load() {
  try {
    const r = await fetch('/api/token', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
    render();
  } catch {
    const st = $('[data-tk="status"]');
    if (st) st.textContent = 'Live data unavailable. Use the links below.';
  }
}

function render() {
  const d = data;
  const set = (k, v) => $$(`[data-tk="${k}"]`).forEach((e) => (e.textContent = v));
  set('mc', fmtUsd(d.mcUsd));
  set('mcEth', d.mcEth ? fmtEth(d.mcEth) + ' ETH' : '—');
  set('price', d.priceUsd ? '$' + d.priceUsd.toPrecision(3) : '—');
  set('vol', fmtEth(d.vol24Eth) + ' ETH');
  set('trades24', fmtNum(d.trades24));
  set('buys', fmtNum(d.buys));
  set('sells', fmtNum(d.sells));
  set('supply', fmtNum(d.supply));
  if (d.graduated) {
    set('progressPct', 'Completed');
    set('progressEth', `${d.graduationEth} ETH · now on ${d.venue}`);
    set('progressNote', `The curve reached ${d.graduationEth} ETH and liquidity moved to ${d.venue}, where it is locked. The chart continues from the pool.`);
    set('mcEth', (d.mcEth ? fmtEth(d.mcEth) + ' ETH' : '—') + (d.liquidityUsd ? ' · liquidity ' + fmtUsd(d.liquidityUsd) : ''));
  } else {
    set('progressPct', d.progress != null ? (d.progress * 100).toFixed(1) + '%' : '—');
    set('progressEth', d.trackedQuote != null ? `${d.trackedQuote.toFixed(2)} / ${d.graduationEth} ETH` : '—');
  }
  set('status', d.graduated ? `Graduated · trading on ${d.venue}` : 'Trading on the Pons bonding curve');
  const bar = $('[data-tk="bar"]');
  if (bar && d.progress != null) bar.style.setProperty('--p', d.progress);
  const list = $('[data-tk="recent"]');
  if (list) {
    const ex = 'https://robinhoodchain.blockscout.com';
    list.innerHTML = d.recent.map((t) => `<a class="tk-tr" href="${ex}/tx/${t.x}" target="_blank" rel="noopener">
      <span class="tk-side ${t.s ? 'b' : 's'}">${t.s ? 'Buy' : 'Sell'}</span>
      <span class="mono">${fmtEth(t.q)} ETH</span>
      <span class="mono tk-w">${short(t.w)}</span>
      <span class="mono tk-ago">${ago(t.t)}</span></a>`).join('');
  }
  draw();
}

function pick() {
  if (!data) return [];
  const now = Date.now() / 1000;
  const span = { '1h': 3600, '6h': 21600, '24h': 86400 }[range];
  const s = data.series;
  if (!span) return s;
  const from = now - span;
  const i = s.findIndex((p) => p[0] >= from);
  const prev = i > 0 ? s[i - 1] : null;
  const out = i < 0 ? [] : s.slice(i);
  // mulai dari harga terakhir sebelum jendela supaya garis tidak kosong
  if (prev) out.unshift([from, prev[1], -1, 0]);
  else if (!out.length && s.length) out.push([from, s[s.length - 1][1], -1, 0]);
  return out;
}

function draw() {
  const cv = $('#tk-chart');
  if (!cv || !data) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const pts = pick();
  const usd = data.ethUsd || 0, sup = data.supply || data.launchSupply;
  const now = Date.now() / 1000;
  // titik terakhir = harga kurva sekarang
  const ser = pts.map((p) => [p[0], p[1] * sup * usd, p[2], p[3]]);
  if (data.priceEth) ser.push([now, data.priceEth * sup * usd, -1, 0]);
  if (ser.length < 2) return;
  const padL = 8, padR = 64, padT = 16, padB = 26;
  const t0 = ser[0][0], t1 = ser[ser.length - 1][0];
  let lo = Math.min(...ser.map((p) => p[1])), hi = Math.max(...ser.map((p) => p[1]));
  const m = (hi - lo) * 0.12 || hi * 0.1; lo = Math.max(0, lo - m); hi += m;
  const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  // garis bantu horizontal + label sumbu kanan
  g.font = '11px "Geist Mono", ui-monospace, monospace';
  g.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4, y = Y(v);
    g.strokeStyle = '#ffffff0d'; g.lineWidth = 1; g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR + 6, y); g.stroke();
    g.fillStyle = '#6e6e75'; g.fillText(fmtUsd(v), W - padR + 12, y + 4);
  }
  // label waktu
  g.fillStyle = '#6e6e75'; g.textAlign = 'center';
  for (let i = 0; i <= 3; i++) {
    const t = t0 + ((t1 - t0) * i) / 3;
    const d = new Date(t * 1000);
    const lab = t1 - t0 > 172800 ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : d.toISOString().slice(11, 16);
    g.textAlign = i === 0 ? 'left' : i === 3 ? 'right' : 'center';
    g.fillText(lab, i === 3 ? W - padR : X(t), H - 6);
  }
  // area + garis bertangga (harga berubah hanya saat ada transaksi)
  const path = () => {
    g.beginPath(); g.moveTo(X(ser[0][0]), Y(ser[0][1]));
    for (let i = 1; i < ser.length; i++) { g.lineTo(X(ser[i][0]), Y(ser[i - 1][1])); g.lineTo(X(ser[i][0]), Y(ser[i][1])); }
  };
  path(); g.lineTo(X(t1), H - padB); g.lineTo(X(t0), H - padB); g.closePath();
  const grad = g.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, '#4a8dff38'); grad.addColorStop(1, '#4a8dff00');
  g.fillStyle = grad; g.fill();
  path(); g.strokeStyle = '#8fb3ff'; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke();
  // titik transaksi (hanya bila tidak terlalu padat)
  const real = ser.filter((p) => p[2] >= 0);
  if (real.length < 260) for (const p of real) { g.fillStyle = p[2] ? '#7ee0b0' : '#ff7a5c'; g.beginPath(); g.arc(X(p[0]), Y(p[1]), 2, 0, 7); g.fill(); }
  // titik sekarang
  const last = ser[ser.length - 1];
  g.fillStyle = '#f4f4f2'; g.beginPath(); g.arc(X(last[0]), Y(last[1]), 3.5, 0, 7); g.fill();
  g.strokeStyle = '#8fb3ff55'; g.lineWidth = 6; g.beginPath(); g.arc(X(last[0]), Y(last[1]), 6, 0, 7); g.stroke();
  // tooltip
  const tip = $('#tk-tip');
  if (hover == null) { tip.hidden = true; return; }
  const tx = t0 + ((hover * W - padL) / (W - padL - padR)) * (t1 - t0);
  let k = 0; for (let i = 0; i < ser.length; i++) if (ser[i][0] <= tx) k = i;
  const p = ser[k], x = X(Math.min(tx, t1));
  g.strokeStyle = '#ffffff30'; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, padT); g.lineTo(x, H - padB); g.stroke(); g.setLineDash([]);
  tip.hidden = false;
  tip.innerHTML = `<b>${fmtUsd(p[1])}</b><span>${new Date(p[0] * 1000).toISOString().slice(5, 16).replace('T', ' ')} UTC</span>${p[2] >= 0 ? `<span class="${p[2] ? 'b' : 's'}">${p[2] ? 'Buy' : 'Sell'} · ${fmtEth(p[3])} ETH</span>` : ''}`;
  tip.style.left = Math.min(W - 170, Math.max(0, x + 12)) + 'px';
}
