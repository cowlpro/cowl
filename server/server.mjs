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
    if (url.pathname === '/api/health') return json(res, { ok: !lastError, head, indexed: db.lastBlock, error: lastError });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    send(res, 500, 'Server error');
  }
});

await loadDb();
server.listen(PORT, HOST, () => console.log(`COWL di http://${HOST}:${PORT} · indeks dari blok ${db.lastBlock + 1}`));
syncOnce();
setInterval(syncOnce, 4000);
