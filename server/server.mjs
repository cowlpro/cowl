// Server COWL: menyajikan situs statis + mengindeks pengumuman ERC-5564 dari Robinhood Chain.
// Server hanya menyalin log publik. Ia tidak pernah menerima kunci, tanda tangan, atau tahu pembayaran milik siapa:
// browser mengunduh SEMUA pengumuman lalu mencocokkannya sendiri.
import http from 'node:http';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { recoverPersonal } from './vendor-sig.mjs';

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
// kontrak COWL yang memanggil Announcer: Router (satu penerima) dan Batch (private payroll)
const COWL_CALLERS = new Set([cfg.router, cfg.batch].filter(Boolean).map((a) => a.toLowerCase()));
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
let tok = { lastBlock: TOK ? TOK.launchBlock - 50 : 0, poolLast: 0, trades: [] };
// sesudah graduasi: likuiditas pindah ke pool Uniswap v4 (PoolManager, event Swap dengan id pool)
const POOL = TOK && TOK.pool ? TOK.pool : null;
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const Q96 = 2n ** 96n;
const int128 = (w) => { const v = BigInt('0x' + w); return v >= 2n ** 255n ? v - 2n ** 256n : v; };
// currency0 = ETH (alamat 0), currency1 = COWL → harga COWL dalam ETH = 1 / (sqrtP/2^96)^2
const priceFromSqrt = (sq) => { const r = Number(sq) / Number(Q96); return r > 0 ? 1 / (r * r) : null; };
let poolPrice = null;
let dexInfo = { liquidityUsd: null, at: 0 };
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
    // pool Uniswap v4 (setelah graduasi)
    if (POOL) {
      if (!tok.poolLast) tok.poolLast = POOL.fromBlock - 1;
      while (tok.poolLast < top) {
        const from = tok.poolLast + 1, to = Math.min(top, from + CHUNK - 1);
        const logs = await rpc('eth_getLogs', [{ address: POOL.manager, topics: [SWAP_TOPIC, POOL.id], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
        for (const l of logs) {
          const w = l.data.slice(2).match(/.{64}/g);
          const a0 = int128(w[0]), a1 = int128(w[1]);
          const sq = BigInt('0x' + w[2]);
          if (a1 === 0n) continue;
          const bn = Number(l.blockNumber);
          const t = l.blockTimestamp ? Number(l.blockTimestamp) : await blockTime(bn);
          const p = priceFromSqrt(sq);
          poolPrice = p;
          // delta milik penukar: ETH keluar dari penukar (a0 < 0) = beli COWL
          tok.trades.push({ t, b: bn, x: l.transactionHash, s: a0 < 0n ? 1 : 0, w: '0x' + l.topics[2].slice(26), q: toNum(a0 < 0n ? -a0 : a0), k: toNum(a1 < 0n ? -a1 : a1), p, v: 4 });
        }
        tok.poolLast = to;
        if (logs.length || to === top) await saveTok();
      }
      if (poolPrice == null) { const last = [...tok.trades].reverse().find((t) => t.v === 4); if (last) poolPrice = last.p; }
      if (Date.now() - dexInfo.at > 120000) {
        try {
          const j = await (await fetch(`https://api.dexscreener.com/latest/dex/pairs/robinhood/${POOL.id}`, { signal: AbortSignal.timeout(8000) })).json();
          const pr = (j.pairs || [])[0];
          dexInfo = { liquidityUsd: pr?.liquidity?.usd ?? dexInfo.liquidityUsd, at: Date.now() };
        } catch { dexInfo.at = Date.now(); }
      }
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
  // sebelum graduasi: harga dari cadangan kurva; sesudahnya: dari swap terakhir di pool v4
  const priceEth = tokLive.graduated ? poolPrice : tr ? qr / tr : null;
  const supply = tokLive.supply;
  const usd = tokLive.ethUsd;
  const day = Date.now() / 1000 - 86400;
  const d24 = tok.trades.filter((t) => t.t >= day);
  return {
    ca: TOK.ca, curve: TOK.curve, launchpad: TOK.launchpad, ethUsd: usd, priceEth, priceUsd: priceEth && usd ? priceEth * usd : null,
    mcEth: priceEth && supply ? priceEth * supply : null, mcUsd: priceEth && supply && usd ? priceEth * supply * usd : null,
    supply, launchSupply: TOK.launchSupply, burned: supply ? TOK.launchSupply - supply : null,
    trackedQuote: tokLive.trackedQuote, graduationEth: TOK.graduationEth, graduated: tokLive.graduated,
    progress: tokLive.graduated ? 1 : tokLive.trackedQuote != null ? Math.min(1, tokLive.trackedQuote / TOK.graduationEth) : null,
    venue: tokLive.graduated ? (POOL?.venue || 'Uniswap v4') : 'Pons curve', liquidityUsd: tokLive.graduated ? dexInfo.liquidityUsd : null,
    trades: tok.trades.length, buys: tok.trades.filter((t) => t.s).length, sells: tok.trades.filter((t) => !t.s).length,
    vol24Eth: d24.reduce((a, t) => a + t.q, 0), trades24: d24.length,
    // seri harga ringkas: [waktu, harga ETH, sisi, ETH]
    series: tok.trades.map((t) => [t.t, t.p, t.s, +t.q.toFixed(6)]),
    recent: tok.trades.slice(-10).reverse().map((t) => ({ t: t.t, s: t.s, q: t.q, k: t.k, w: t.w, x: t.x })),
    indexed: tok.lastBlock, updated: Math.floor(Date.now() / 1000),
  };
}

// ---------- COWL Names: cowl.pro/nama → kunci penerima (meta-address), bukan dompet ----------
// Klaim wajib memegang $COWL (dicek on-chain saat klaim). Server menyimpan hash bergaram dari dompet pengklaim
// hanya supaya dompet itu yang bisa mengubah/melepas namanya; hash tidak pernah dipublikasikan.
const NM = cfg.names || { minHold: 100000, minLen: 3, maxLen: 20 };
const NAMES_FILE = path.join(DATA, 'names.json');
let names = { salt: '', byName: {}, byOwner: {} };
const RESERVED = new Set(('receive send inbox pay app api assets roadmap transparency index lab admin cowl cowlhq cowlpro official support help team '
  + 'dev devs mod mods moderator root www mail static config live favicon robots sitemap about terms privacy blog docs names name '
  + 'robinhood pons uniswap dexscreener blockscout github telegram twitter x claim release verify proof').split(' '));
const NAME_RE = new RegExp(`^[a-z0-9](?:[a-z0-9-]{${NM.minLen - 2},${NM.maxLen - 2}})[a-z0-9]$`);
function nameProblem(n) {
  if (typeof n !== 'string' || !NAME_RE.test(n)) return `Use ${NM.minLen}–${NM.maxLen} lowercase letters, numbers or hyphens.`;
  if (n.includes('--')) return 'No double hyphens.';
  if (RESERVED.has(n)) return 'That name is reserved.';
  return null;
}
const META_RE = /^st:eth:0x(0[23][0-9a-f]{64}){2}$/;
async function loadNames() {
  if (existsSync(NAMES_FILE)) { try { names = JSON.parse(await readFile(NAMES_FILE, 'utf8')); } catch {} }
  if (!names.salt) { names.salt = randomBytes(16).toString('hex'); await saveNames(); }
}
async function saveNames() { await mkdir(DATA, { recursive: true }); const tmp = NAMES_FILE + '.tmp'; await writeFile(tmp, JSON.stringify(names)); await rename(tmp, NAMES_FILE); }
const ownerKey = (addr) => createHash('sha256').update(names.salt + ':' + addr.toLowerCase()).digest('hex');
const claimMessage = (b) => ['COWL Names · Claim', '', `Name: cowl.pro/${b.name}`, `Points to: ${b.meta}`, `Wallet: ${b.address}`, `Issued: ${b.issued}`, '', 'Signing is free. It sends nothing and moves nothing.'].join('\n');
const releaseMessage = (b) => ['COWL Names · Release', '', `Name: cowl.pro/${b.name}`, `Wallet: ${b.address}`, `Issued: ${b.issued}`, '', 'Signing is free. It sends nothing and moves nothing.'].join('\n');
async function holdingOf(addr) {
  const raw = await rpc('eth_call', [{ to: TOK.ca, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
  return raw && raw !== '0x' ? BigInt(raw) : 0n;
}
function checkSigned(b, msgFn) {
  if (!b || typeof b.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(b.address)) throw new Error('Bad wallet address');
  const age = Math.abs(Date.now() - Date.parse(b.issued));
  if (!(age < 10 * 60 * 1000)) throw new Error('Signature expired. Try again.');
  const who = recoverPersonal(msgFn(b), String(b.signature || ''));
  if (who !== b.address.toLowerCase()) throw new Error('Signature does not match the wallet');
  return who;
}
async function claimName(b) {
  const prob = nameProblem(b?.name); if (prob) throw new Error(prob);
  if (!META_RE.test(String(b.meta || '').toLowerCase())) throw new Error('Bad receive keys');
  b.meta = b.meta.toLowerCase();
  const who = checkSigned(b, claimMessage);
  const key = ownerKey(who);
  const cur = names.byName[b.name];
  if (cur && cur.owner !== key) throw new Error('That name is taken.');
  const mine = names.byOwner[key];
  if (mine && mine !== b.name) throw new Error(`This wallet already holds cowl.pro/${mine}. Release it first.`);
  const need = BigInt(NM.minHold) * 10n ** 18n;
  const have = need === 0n ? 0n : await holdingOf(who);
  if (have < need) throw new Error(`Claiming needs ${Number(NM.minHold).toLocaleString('en-US')} $COWL in this wallet.`);
  names.byName[b.name] = { meta: b.meta, owner: key, claimedAt: cur?.claimedAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  names.byOwner[key] = b.name;
  await saveNames();
  return { name: b.name, meta: b.meta };
}
async function releaseName(b) {
  const prob = nameProblem(b?.name); if (prob) throw new Error(prob);
  const who = checkSigned(b, releaseMessage);
  const key = ownerKey(who);
  const cur = names.byName[b.name];
  if (!cur || cur.owner !== key) throw new Error('This wallet does not hold that name.');
  delete names.byName[b.name]; delete names.byOwner[key];
  await saveNames();
  return { released: b.name };
}
// batas sederhana per IP untuk POST
const hits = new Map();
function limited(ip) { const now = Date.now(); const h = (hits.get(ip) || []).filter((t) => now - t < 60000); h.push(now); hits.set(ip, h); return h.length > 12; }
function readBody(req) {
  return new Promise((ok, bad) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 8192) { bad(new Error('Too large')); req.destroy(); } }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { bad(new Error('Bad JSON')); } }); });
}
const NAME_PATH = new RegExp(`^/([a-z0-9-]{${NM.minLen},${NM.maxLen}})/?$`);

// ---------- HTTP ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
  res.end(body);
}
const json = (res, obj, code = 200) =>
  send(res, code, JSON.stringify(obj), { 'content-type': TYPES['.json'], 'cache-control': 'no-store', 'access-control-allow-origin': '*' });

// rute halaman aplikasi
const APP_ROUTES = [/^\/verify\/?$/, /^\/app\/?$/, /^\/pay\/[^/]+\/?$/, /^\/inbox\/?$/, /^\/receive\/?$/, /^\/send\/?$/];

async function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (APP_ROUTES.some((r) => r.test(p))) p = '/app.html';
  else if (p === '/' ) p = '/index.html';
  else if (p === '/transparency' || p === '/transparency/') p = '/transparency.html';
  else if (p === '/roadmap' || p === '/roadmap/') p = '/roadmap.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) || path.basename(file).startsWith('.')) return send(res, 404, 'Not found');
  let st;
  try { st = await stat(file); } catch {
    if (NAME_PATH.test(p) && !RESERVED.has(p.replace(/\//g, ''))) return serveStatic(req, res, '/app.html');
    return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
  }
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
      const viaCowl = db.items.filter((i) => COWL_CALLERS.has(i.c)).length;
      return json(res, {
        announcements: db.items.length, viaCowl, head, indexed: db.lastBlock,
        lag: head ? head - db.lastBlock : null, ok: !lastError, latest: db.items.slice(-6).reverse().map((i) => ({ t: i.t, s: i.s, x: i.x, m: i.m.slice(0, 12) })),
      });
    }
    if (url.pathname === '/config.json' && process.env.COWL_CONFIG) {
      return send(res, 200, readFileSync(CFG_FILE), { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/token') return TOK ? json(res, tokenPayload()) : json(res, { error: 'no token' }, 404);
    if (url.pathname === '/api/names' && req.method === 'GET') {
      const meta = (url.searchParams.get('meta') || '').toLowerCase();
      const list = meta ? Object.entries(names.byName).filter(([, v]) => v.meta === meta).map(([k]) => k) : [];
      return json(res, { names: list, count: Object.keys(names.byName).length, minHold: NM.minHold });
    }
    if (url.pathname.startsWith('/api/names/') && req.method === 'GET') {
      const n = decodeURIComponent(url.pathname.slice(11)).toLowerCase();
      const rec = names.byName[n];
      if (rec) return json(res, { name: n, meta: rec.meta, claimedAt: rec.claimedAt });
      const prob = nameProblem(n);
      return json(res, { name: n, available: !prob, reason: prob }, 404);
    }
    if ((url.pathname === '/api/names/claim' || url.pathname === '/api/names/release') && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      if (limited(ip)) return json(res, { error: 'Too many requests. Wait a minute.' }, 429);
      try {
        const body = await readBody(req);
        const out = url.pathname.endsWith('claim') ? await claimName(body) : await releaseName(body);
        return json(res, out);
      } catch (e) { return json(res, { error: String(e.message || e) }, 400); }
    }
    if (url.pathname === '/api/health') return json(res, { ok: !lastError, head, indexed: db.lastBlock, error: lastError });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    send(res, 500, 'Server error');
  }
});

await loadDb();
await loadTok();
await loadNames();
server.listen(PORT, HOST, () => console.log(`COWL di http://${HOST}:${PORT} · indeks dari blok ${db.lastBlock + 1}`));
syncOnce();
setInterval(syncOnce, 4000);
syncToken();
setInterval(syncToken, 15000);
