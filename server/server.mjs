// Server COWL: menyajikan situs statis + mengindeks pengumuman ERC-5564 dari Robinhood Chain.
// Server hanya menyalin log publik. Ia tidak pernah menerima kunci, tanda tangan, atau tahu pembayaran milik siapa:
// browser mengunduh SEMUA pengumuman lalu mencocokkannya sendiri.
import http from 'node:http';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = process.env.COWL_PUBLIC || path.join(ROOT, '..', 'app', 'public');
const DATA = process.env.COWL_DATA || path.join(ROOT, '..', 'data');
const PORT = Number(process.env.PORT || 4791);
const HOST = process.env.HOST || '127.0.0.1';

// konfigurasi jaringan dibaca dari berkas yang sama dengan browser (public/config.json)
// COWL_CONFIG = berkas config pengganti (dipakai untuk uji lokal di fork); disajikan juga sebagai /config.json
const CFG_FILE = process.env.COWL_CONFIG || path.join(PUBLIC, 'config.json');
const cfg = JSON.parse(readFileSync(CFG_FILE, 'utf8'));
const RPCS = (process.env.COWL_RPC ? process.env.COWL_RPC.split(',') : cfg.indexerRpcs);
const ANNOUNCER = cfg.announcer.toLowerCase();
const ROUTER = (cfg.router || '').toLowerCase();
const START_BLOCK = Number(process.env.COWL_START_BLOCK || cfg.startBlock || 0);
const ANNOUNCEMENT_TOPIC = '0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7';
const CHUNK = 5000;

// ---------- RPC dengan cadangan ----------
let rpcIdx = 0;
async function rpc(method, params) {
  let lastErr;
  for (let n = 0; n < RPCS.length; n++) {
    const url = RPCS[(rpcIdx + n) % RPCS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      rpcIdx = (rpcIdx + n) % RPCS.length;
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---------- penyimpanan ----------
const DB_FILE = path.join(DATA, 'announcements.json');
let db = { lastBlock: START_BLOCK - 1, items: [] };
async function loadDb() {
  await mkdir(DATA, { recursive: true });
  if (existsSync(DB_FILE)) {
    db = JSON.parse(await readFile(DB_FILE, 'utf8'));
    if (db.lastBlock < START_BLOCK - 1) db = { lastBlock: START_BLOCK - 1, items: [] };
  }
}
async function saveDb() {
  const tmp = DB_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(db));
  await rename(tmp, DB_FILE);
}

// ---------- pengindeks ----------
const tsCache = new Map();
async function blockTime(bn) {
  if (tsCache.has(bn)) return tsCache.get(bn);
  const b = await rpc('eth_getBlockByNumber', ['0x' + bn.toString(16), false]);
  const t = Number(b.timestamp);
  tsCache.set(bn, t);
  if (tsCache.size > 2000) tsCache.delete(tsCache.keys().next().value);
  return t;
}

// ABI-decode data Announcement: (bytes ephemeralPubKey, bytes metadata)
function decodeData(hex) {
  const d = hex.slice(2);
  const word = (i) => parseInt(d.slice(i * 64, i * 64 + 64), 16);
  const readBytes = (off) => {
    const len = parseInt(d.slice(off * 2, off * 2 + 64), 16);
    return '0x' + d.slice(off * 2 + 64, off * 2 + 64 + len * 2);
  };
  return { eph: readBytes(word(0)), meta: readBytes(word(1)) };
}

let head = 0;
let syncing = false;
let lastError = null;
async function syncOnce() {
  if (syncing) return;
  syncing = true;
  try {
    head = Number(await rpc('eth_blockNumber', []));
    while (db.lastBlock < head) {
      const from = db.lastBlock + 1;
      const to = Math.min(head, from + CHUNK - 1);
      const logs = await rpc('eth_getLogs', [{
        address: ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC],
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      }]);
      for (const l of logs) {
        if (Number(l.topics[1]) !== 1) continue; // hanya skema 1 (secp256k1)
        const { eph, meta } = decodeData(l.data);
        const bn = Number(l.blockNumber);
        db.items.push({
          b: bn,
          x: l.transactionHash,
          s: '0x' + l.topics[2].slice(26),
          c: '0x' + l.topics[3].slice(26),
          e: eph,
          m: meta,
          t: await blockTime(bn),
        });
      }
      db.lastBlock = to;
      if (logs.length || to === head) await saveDb();
    }
    lastError = null;
  } catch (e) {
    lastError = String(e.message || e);
  } finally {
    syncing = false;
  }
}

// ---------- token $COWL: transaksi asli dari bonding curve Pons ----------
// DexScreener baru membaca pool Uniswap setelah graduasi, jadi selama di kurva grafik dibangun dari event CurveBuy/CurveSell.
const TOK = cfg.token || null;
const TOK_FILE = path.join(DATA, 'token.json');
const BUY_TOPIC = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455';
const SELL_TOPIC = '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df';
let tok = { lastBlock: TOK ? TOK.launchBlock - 50 : 0, trades: [] };
let tokLive = { reserves: null, supply: null, trackedQuote: null, graduated: false, ethUsd: null, at: 0 };
let tokSyncing = false;
const big = (h) => BigInt(h);
const toNum = (v, d = 18) => Number(v) / 10 ** d;
async function loadTok() {
  if (TOK && existsSync(TOK_FILE)) { try { tok = JSON.parse(await readFile(TOK_FILE, 'utf8')); } catch {} }
}
async function saveTok() { const tmp = TOK_FILE + '.tmp'; await writeFile(tmp, JSON.stringify(tok)); await rename(tmp, TOK_FILE); }
const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
async function ethUsd() {
  const srcs = [
    async () => Number((await (await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(8000) })).json()).data.amount),
    async () => Number((await (await fetch('https://api.kraken.com/0/public/Ticker?pair=ETHUSD', { signal: AbortSignal.timeout(8000) })).json()).result.XETHZUSD.c[0]),
    async () => Number((await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { signal: AbortSignal.timeout(8000) })).json()).ethereum.usd),
  ];
  for (const f of srcs) { try { const v = await f(); if (v > 0) return v; } catch {} }
  return tokLive.ethUsd;
}
async function syncToken() {
  if (!TOK || tokSyncing) return;
  tokSyncing = true;
  try {
    const top = head || Number(await rpc('eth_blockNumber', []));
    while (tok.lastBlock < top) {
      const from = tok.lastBlock + 1, to = Math.min(top, from + CHUNK - 1);
      const logs = await rpc('eth_getLogs', [{ address: TOK.curve, topics: [[BUY_TOPIC, SELL_TOPIC]], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
      for (const l of logs) {
        const d = l.data.slice(2).match(/.{64}/g).map((w) => big('0x' + w));
        const buy = l.topics[0] === BUY_TOPIC;
        // buy: quoteIn, tokensOut, fee, tax  ·  sell: tokensIn, quoteOut, fee, tax
        const quote = buy ? d[0] : d[1], tokens = buy ? d[1] : d[0], fee = d[2], tax = d[3];
        if (tokens === 0n) continue;
        // harga bersih di kurva (tanpa fee/pajak) supaya beli & jual tidak zig-zag
        const net = buy ? quote - fee - tax : quote + fee + tax;
        const bn = Number(l.blockNumber);
        tok.trades.push({ t: await blockTime(bn), b: bn, x: l.transactionHash, s: buy ? 1 : 0, w: '0x' + l.topics[1].slice(26), q: toNum(quote), k: toNum(tokens), p: Number(net) / Number(tokens) });
      }
      tok.lastBlock = to;
      if (logs.length || to === top) await saveTok();
    }
    const [res, sup, tq, grad] = await Promise.all([
      ethCall(TOK.curve, '0x0902f1ac'), ethCall(TOK.ca, '0x18160ddd'), ethCall(TOK.curve, '0xca52b0b7').catch(() => null), ethCall(TOK.curve, '0xe7c2b772').catch(() => null),
    ]);
    const r = res.slice(2).match(/.{64}/g).map((w) => big('0x' + w));
    tokLive.reserves = [toNum(r[0]), toNum(r[1])];
    tokLive.supply = toNum(big(sup));
    tokLive.trackedQuote = tq && tq !== '0x' ? toNum(big(tq)) : null;
    tokLive.graduated = grad && grad !== '0x' ? big(grad) !== 0n : false;
    if (Date.now() - tokLive.at > 60000 || !tokLive.ethUsd) { tokLive.ethUsd = await ethUsd(); tokLive.at = Date.now(); }
  } catch (e) {
    console.error('token sync:', e.message || e);
  } finally { tokSyncing = false; }
}
function tokenPayload() {
  const [qr, tr] = tokLive.reserves || [0, 0];
  const priceEth = tr ? qr / tr : null;
  const supply = tokLive.supply;
  const usd = tokLive.ethUsd;
  const day = Date.now() / 1000 - 86400;
  const d24 = tok.trades.filter((t) => t.t >= day);
  return {
    ca: TOK.ca, curve: TOK.curve, launchpad: TOK.launchpad, ethUsd: usd, priceEth, priceUsd: priceEth && usd ? priceEth * usd : null,
    mcEth: priceEth && supply ? priceEth * supply : null, mcUsd: priceEth && supply && usd ? priceEth * supply * usd : null,
    supply, launchSupply: TOK.launchSupply, burned: supply ? TOK.launchSupply - supply : null,
    trackedQuote: tokLive.trackedQuote, graduationEth: TOK.graduationEth, graduated: tokLive.graduated,
    progress: tokLive.trackedQuote != null ? Math.min(1, tokLive.trackedQuote / TOK.graduationEth) : null,
    trades: tok.trades.length, buys: tok.trades.filter((t) => t.s).length, sells: tok.trades.filter((t) => !t.s).length,
    vol24Eth: d24.reduce((a, t) => a + t.q, 0), trades24: d24.length,
    // seri harga ringkas: [waktu, harga ETH, sisi, ETH]
    series: tok.trades.map((t) => [t.t, t.p, t.s, +t.q.toFixed(6)]),
    recent: tok.trades.slice(-10).reverse().map((t) => ({ t: t.t, s: t.s, q: t.q, k: t.k, w: t.w, x: t.x })),
    indexed: tok.lastBlock, updated: Math.floor(Date.now() / 1000),
  };
}

// ---------- HTTP ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
  res.end(body);
}
const json = (res, obj, code = 200) =>
  send(res, code, JSON.stringify(obj), { 'content-type': TYPES['.json'], 'cache-control': 'no-store', 'access-control-allow-origin': '*' });

// rute halaman aplikasi
const APP_ROUTES = [/^\/app\/?$/, /^\/pay\/[^/]+\/?$/, /^\/inbox\/?$/, /^\/receive\/?$/, /^\/send\/?$/];

async function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (APP_ROUTES.some((r) => r.test(p))) p = '/app.html';
  else if (p === '/' ) p = '/index.html';
  else if (p === '/transparency' || p === '/transparency/') p = '/transparency.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) || path.basename(file).startsWith('.')) return send(res, 404, 'Not found');
  let st;
  try { st = await stat(file); } catch { return send(res, 404, 'Not found', { 'content-type': 'text/plain' }); }
  if (!st.isFile()) return send(res, 404, 'Not found');
  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  // html/config/live: selalu segar (CA bisa berubah saat launch); aset ber-?v= boleh disimpan lama
  let cache = 'public, max-age=604800, immutable';
  if (ext === '.html' || p === '/config.json' || p === '/live.json') cache = 'no-store';
  else if (!/[?&]v=/.test(req.url)) cache = 'public, max-age=300';
  // dukung Range untuk video
  const range = req.headers.range;
  const body = await readFile(file);
  if (range && (ext === '.mp4' || ext === '.webm')) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    return send(res, 206, body.subarray(start, end + 1), {
      'content-type': type, 'content-range': `bytes ${start}-${end}/${body.length}`, 'accept-ranges': 'bytes',
      'content-length': end - start + 1, 'cache-control': cache,
    });
  }
  send(res, 200, req.method === 'HEAD' ? undefined : body, { 'content-type': type, 'cache-control': cache, 'content-length': body.length });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/announcements') {
      // ?since=N → item mulai indeks N (browser menyimpan posisi terakhirnya)
      const since = Math.max(0, Number(url.searchParams.get('since') || 0) | 0);
      return json(res, { items: db.items.slice(since, since + 5000), total: db.items.length, head, indexed: db.lastBlock });
    }
    if (url.pathname === '/api/stats') {
      const viaCowl = ROUTER ? db.items.filter((i) => i.c === ROUTER).length : 0;
      return json(res, {
        announcements: db.items.length, viaCowl, head, indexed: db.lastBlock,
        lag: head ? head - db.lastBlock : null, ok: !lastError, latest: db.items.slice(-6).reverse().map((i) => ({ t: i.t, s: i.s, x: i.x, m: i.m.slice(0, 12) })),
      });
    }
    if (url.pathname === '/config.json' && process.env.COWL_CONFIG) {
      return send(res, 200, readFileSync(CFG_FILE), { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/token') return TOK ? json(res, tokenPayload()) : json(res, { error: 'no token' }, 404);
    if (url.pathname === '/api/health') return json(res, { ok: !lastError, head, indexed: db.lastBlock, error: lastError });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    send(res, 500, 'Server error');
  }
});

await loadDb();
await loadTok();
server.listen(PORT, HOST, () => console.log(`COWL di http://${HOST}:${PORT} · indeks dari blok ${db.lastBlock + 1}`));
syncOnce();
setInterval(syncOnce, 4000);
syncToken();
setInterval(syncToken, 15000);
