// Aplikasi COWL: Receive (buat link), Send (kirim ke link), Inbox (temukan & tarik dana).
// Kunci privat hanya hidup di memori tab ini. Tidak ada yang dikirim ke server.
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import {
  SIGN_MESSAGE, keysFromSignature, generateStealth, checkAnnouncement, parseMetadata, parseMetaAddress,
} from './stealth.js';
import {
  ethers, STOCKS, CFG, LIVE, loadConfig, readProvider, broadcastProvider, safeGasPrice, discoverWallets, listWallets,
  ensureChain, ABI, ETH, tokenInfo, short, fmtAmount, timeAgo, txUrl, addrUrl, toast, copy, niceError,
} from './chain.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ZERO_META = '0x';
const MEMO_MAX = 80; // catatan tagihan hanya hidup di link, tidak pernah ditulis ke chain

const S = {
  view: 'receive',
  wallet: null, // {info, provider}
  account: null,
  keys: null,
  registered: null, // meta bytes di registry ('' = belum)
  keyMismatch: false,
  send: { to: '', meta: null, resolved: '', asset: ETH, amount: '', busy: false, step: 0, result: null, req: null },
  request: { amount: '', asset: ETH, memo: '' }, // pembuat link tagihan di Receive
  badge: 'dark',
  myName: null, // nama COWL milik kunci yang sedang terbuka
  nm: { input: '', status: null, busy: false, holding: null },
  mode: 'one', // Send: satu penerima atau banyak (private payroll)
  many: { text: '', rows: [], checking: false, busy: false, step: 0, result: null },
  inbox: { since: 0, scanned: 0, mine: new Map(), syncing: false, total: 0, err: '' },
};

// ===================================================================== rute
function routeFromPath() {
  const p = location.pathname;
  const m = p.match(/^\/pay\/([^/]+)/);
  const nmPath = p.match(/^\/([a-z0-9-]{3,20})\/?$/);
  const target = m ? decodeURIComponent(m[1]) : nmPath && !['receive', 'send', 'inbox', 'app', 'verify'].includes(nmPath[1]) ? nmPath[1] : null;
  if (target) {
    S.view = 'send'; S.send.to = target;
    const q = new URLSearchParams(location.search);
    const amount = (q.get('amount') || '').replace(',', '.');
    const memo = (q.get('memo') || '').slice(0, MEMO_MAX);
    const asset = (q.get('asset') || '').trim();
    if (amount || memo || asset) {
      S.send.req = { amount: /^\d*\.?\d+$/.test(amount) ? amount : '', memo, asset };
      if (S.send.req.amount) S.send.amount = S.send.req.amount;
    }
    return;
  }
  if (p.startsWith('/verify')) S.view = 'verify';
  else if (p.startsWith('/send')) S.view = 'send';
  else if (p.startsWith('/inbox')) S.view = 'inbox';
  else S.view = 'receive';
}
function go(view, push = true) {
  S.view = view;
  S.send.req = null; // tagihan hanya berlaku untuk link yang dibuka, bukan tab yang diklik
  if (push) history.pushState({}, '', '/' + view);
  render();
}

// ===================================================================== dompet
const KNOWN_KEY = 'cowl:wallet';
async function connect(w) {
  const accs = await w.provider.request({ method: 'eth_requestAccounts' });
  if (!accs?.length) throw new Error('No account');
  setWallet(w, accs[0]);
  try { localStorage.setItem(KNOWN_KEY, w.info.rdns); } catch {}
}
function setWallet(w, acc) {
  const changed = S.account && S.account.toLowerCase() !== acc.toLowerCase();
  S.wallet = w;
  S.account = ethers.getAddress(acc);
  if (changed) resetKeys();
  if (!bound.has(w.provider)) {
    // tanda "sudah dipasang" disimpan di WeakSet, bukan di objek dompet (detail EIP-6963 dibekukan)
    bound.add(w.provider);
    w.provider.on?.('accountsChanged', (a) => { if (a?.length) setWallet(w, a[0]); else { S.account = null; resetKeys(); } render(); });
  }
  render();
}
const bound = new WeakSet();
function resetKeys() {
  S.keys = null; S.registered = null; S.keyMismatch = false;
  S.inbox = { since: 0, scanned: 0, mine: new Map(), syncing: false, total: 0, err: '' };
}
async function autoReconnect() {
  let rdns = null;
  try { rdns = localStorage.getItem(KNOWN_KEY); } catch {}
  if (!rdns) return;
  await new Promise((r) => setTimeout(r, 300));
  const w = listWallets().find((x) => x.info.rdns === rdns);
  if (!w) return;
  try {
    const accs = await w.provider.request({ method: 'eth_accounts' });
    if (accs?.length) setWallet(w, accs[0]);
  } catch {}
}
function openWalletModal() {
  const ws = listWallets();
  modal(`
    <h3>Connect a wallet</h3>
    <p>COWL works with any EVM wallet on Robinhood Chain.</p>
    ${ws.length ? ws.map((w, i) => `<button class="wallet-item" data-i="${i}">${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : '<span class="tok">W</span>'}<span>${esc(w.info.name)}</span></button>`).join('')
      : `<div class="empty">No wallet found in this browser.<br>Install MetaMask, Rabby or Phantom, then reload.</div>`}
    <p class="note">Phantom users: enable Robinhood Chain in Settings → Active Networks.</p>`);
  $('#modal-body').querySelectorAll('.wallet-item').forEach((b) => b.addEventListener('click', async () => {
    try { await connect(ws[Number(b.dataset.i)]); closeModal(); } catch (e) { toast(niceError(e)); }
  }));
}
async function signer() {
  await ensureChain(S.wallet.provider);
  return new ethers.BrowserProvider(S.wallet.provider).getSigner(S.account);
}

// ===================================================================== kunci
async function unlock() {
  const msg = ethers.hexlify(ethers.toUtf8Bytes(SIGN_MESSAGE));
  const sig = await S.wallet.provider.request({ method: 'personal_sign', params: [msg, S.account] });
  S.keys = keysFromSignature(sig);
  await refreshRegistry();
  await fetchMyName();
  render();
}
async function refreshRegistry() {
  const reg = new ethers.Contract(CFG.registry, ABI.registry, readProvider());
  const stored = await reg.stealthMetaAddressOf(S.account, 1).catch(() => ZERO_META);
  S.registered = stored && stored !== ZERO_META ? stored.toLowerCase() : '';
  S.keyMismatch = !!(S.registered && S.keys && S.registered !== S.keys.metaBytes.toLowerCase());
}
// ===================================================================== COWL Names
const NM = () => CFG.names || { minHold: 100000, minLen: 3, maxLen: 20 };
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,18})[a-z0-9]$/;
async function fetchMyName() {
  try {
    const r = await fetch('/api/names?meta=' + encodeURIComponent(S.keys.metaAddress.toLowerCase()), { cache: 'no-store' });
    const j = await r.json();
    S.myName = j.names?.[0] || null;
  } catch { S.myName = null; }
}
async function nameHolding() {
  if (!LIVE.ca || !S.account) return null;
  try { return await new ethers.Contract(LIVE.ca, ABI.erc20, readProvider()).balanceOf(S.account); } catch { return null; }
}
const claimMessage = (b) => ['COWL Names · Claim', '', `Name: cowl.pro/${b.name}`, `Points to: ${b.meta}`, `Wallet: ${b.address}`, `Issued: ${b.issued}`, '', 'Signing is free. It sends nothing and moves nothing.'].join('\n');
const releaseMessage = (b) => ['COWL Names · Release', '', `Name: cowl.pro/${b.name}`, `Wallet: ${b.address}`, `Issued: ${b.issued}`, '', 'Signing is free. It sends nothing and moves nothing.'].join('\n');
async function signedPost(url, body, msgFn) {
  const msg = msgFn(body);
  body.signature = await S.wallet.provider.request({ method: 'personal_sign', params: [ethers.hexlify(ethers.toUtf8Bytes(msg)), S.account] });
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
async function claimName() {
  const name = S.nm.input;
  const out = await signedPost('/api/names/claim', { name, meta: S.keys.metaAddress.toLowerCase(), address: S.account, issued: new Date().toISOString() }, claimMessage);
  S.myName = out.name; S.nm = { input: '', status: null, busy: false, holding: S.nm.holding };
  toast(`cowl.pro/${out.name} is yours`);
  render();
}
async function releaseName() {
  if (!S.myName || !confirm(`Release cowl.pro/${S.myName}? Anyone holding $COWL could claim it after.`)) return;
  await signedPost('/api/names/release', { name: S.myName, address: S.account, issued: new Date().toISOString() }, releaseMessage);
  toast(`cowl.pro/${S.myName} released`);
  S.myName = null; render();
}
let nameTimer;
async function checkName() {
  const n = S.nm.input;
  const set = (status) => { S.nm.status = status; paintNameStatus(); };
  if (!n) return set(null);
  if (!NAME_RE.test(n) || n.includes('--')) return set({ ok: false, text: `Use ${NM().minLen}–${NM().maxLen} lowercase letters, numbers or hyphens.` });
  set({ ok: null, text: 'Checking…' });
  try {
    const r = await fetch('/api/names/' + encodeURIComponent(n), { cache: 'no-store' });
    const j = await r.json();
    if (n !== S.nm.input) return;
    if (r.ok) set({ ok: false, text: `cowl.pro/${n} is taken.` });
    else set(j.available ? { ok: true, text: `cowl.pro/${n} is available.` } : { ok: false, text: j.reason || 'Not available.' });
  } catch { set({ ok: false, text: 'Could not check right now.' }); }
}
function paintNameStatus() {
  const el = $('#nm-status'), btn = $('#nm-claim');
  if (!el) return;
  const st = S.nm.status;
  el.className = 'note ' + (st ? (st.ok ? 'ok' : st.ok === false ? 'warn' : '') : '');
  el.textContent = st ? st.text : '';
  const need = BigInt(NM().minHold) * 10n ** 18n;
  const enough = S.nm.holding != null && S.nm.holding >= need;
  if (btn) btn.disabled = !(st && st.ok && enough) || S.nm.busy;
}
function bindNames() {
  const inp = $('#nm-input');
  if (!inp) return;
  inp.addEventListener('input', () => { inp.value = inp.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, NM().maxLen); S.nm.input = inp.value; clearTimeout(nameTimer); nameTimer = setTimeout(checkName, 300); });
  if (S.nm.holding == null) nameHolding().then((b) => { S.nm.holding = b; const h = $('#nm-hold'); if (h) h.innerHTML = holdLine(); paintNameStatus(); });
  paintNameStatus();
}
function holdLine() {
  const min = Number(NM().minHold).toLocaleString('en-US');
  if (S.nm.holding == null) return `Claiming needs ${min} $COWL in this wallet · checking your balance…`;
  const have = Number(ethers.formatUnits(S.nm.holding, 18));
  const ok = S.nm.holding >= BigInt(NM().minHold) * 10n ** 18n;
  return `This wallet holds <b class="${ok ? 'ok' : 'warn'}">${have.toLocaleString('en-US', { maximumFractionDigits: 0 })} $COWL</b> · claiming needs ${min}`;
}
function namesCard() {
  if (S.myName) {
    return `
  <div class="card" id="nm-card">
    <span class="kicker">COWL Names</span>
    <h2 class="h2">Your name is live.</h2>
    <p class="lead">Anyone can pay this name. It points to your receive keys, never to your wallet.</p>
    <div class="link-box"><span class="url">cowl.pro/${esc(S.myName)}</span><button class="btn small primary" data-act="copy-name">Copy</button></div>
    <div class="link-actions"><button class="btn small" data-act="release-name">Release name</button></div>
    <p class="note">Your receive link, payment requests and Pay me privately button now use this name.</p>
  </div>`;
  }
  return `
  <div class="card" id="nm-card">
    <span class="kicker">COWL Names · for $COWL holders</span>
    <h2 class="h2">Claim a short name.</h2>
    <p class="lead">cowl.pro/yourname points to your receive keys, not your wallet. Payers never learn which wallet it is.</p>
    <div class="field">
      <label for="nm-input">Name</label>
      <div class="nm-field"><span>cowl.pro/</span><input class="input" id="nm-input" placeholder="yourname" value="${esc(S.nm.input)}" autocomplete="off" spellcheck="false" maxlength="${NM().maxLen}"></div>
      <div class="note" id="nm-status"></div>
    </div>
    <p class="note" id="nm-hold">${holdLine()}</p>
    <button class="btn primary block" id="nm-claim" data-act="claim-name" disabled>Claim name · free signature <span class="arrow">→</span></button>
    <p class="note">Names are public, so pick one that is not your real name if that matters. COWL's server keeps a salted hash of the claiming wallet so only that wallet can change or release the name; it is never published. Holding is checked once, when you claim. One name per wallet.</p>
  </div>`;
}

async function register() {
  const s = await signer();
  const reg = new ethers.Contract(CFG.registry, ABI.registry, s);
  const tx = await reg.registerKeys(1, S.keys.metaBytes);
  toast('Registering…');
  await tx.wait();
  await refreshRegistry();
  toast('Your link is live');
  render();
}
function receiveLink() {
  if (S.myName) return `${location.origin}/${S.myName}`;
  const tail = S.registered && !S.keyMismatch ? S.account : S.keys.metaAddress;
  return `${location.origin}/pay/${tail}`;
}

// link tagihan: link penerima + jumlah/aset/catatan sebagai parameter URL
function assetParam(a) {
  if (a.address === 'eth') return 'ETH';
  if (STOCKS.some((x) => x.address.toLowerCase() === a.address.toLowerCase()) || a.symbol === 'COWL') return a.symbol;
  return a.address;
}
function requestLink() {
  const r = S.request;
  const q = new URLSearchParams();
  if (r.amount) q.set('amount', r.amount);
  if (r.amount || r.asset.address !== 'eth') q.set('asset', assetParam(r.asset));
  if (r.memo.trim()) q.set('memo', r.memo.trim().slice(0, MEMO_MAX));
  const qs = q.toString();
  return receiveLink() + (qs ? '?' + qs : '');
}
// aset dari link tagihan: ETH, simbol (COWL / saham), atau alamat 0x
async function resolveAssetParam(v) {
  if (!v || v.toUpperCase() === 'ETH') return ETH;
  const hit = assetList().find((a) => a.symbol.toLowerCase() === v.toLowerCase() || (a.address !== 'eth' && a.address.toLowerCase() === v.toLowerCase()));
  if (hit) return hit;
  if (ethers.isAddress(v)) return tokenInfo(v);
  throw new Error('Unknown asset in this request');
}
function badgeUrl() { return `${location.origin}/assets/badge-${S.badge}.svg`; }
function badgeSnippets() {
  const link = receiveLink();
  return {
    html: `<a href="${link}" target="_blank" rel="noopener"><img src="${badgeUrl()}" alt="Pay me privately with COWL" width="232" height="48"></a>`,
    md: `[![Pay me privately with COWL](${badgeUrl()})](${link})`,
    bio: `Pay me privately: ${link.replace(/^https?:\/\//, '')}`,
  };
}

// ===================================================================== tampilan
function render() {
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === S.view));
  const wb = $('#wallet-btn');
  wb.textContent = S.account ? short(S.account) : 'Connect wallet';
  wb.classList.toggle('primary', !S.account);
  $('#cv-sender-addr').textContent = S.view === 'send' && S.account ? short(S.account, 6) + ' · public' : '0xSender… · public';
  const pane = $('#pane');
  if (S.view === 'receive') pane.innerHTML = viewReceive();
  else if (S.view === 'send') pane.innerHTML = viewSend();
  else if (S.view === 'verify') pane.innerHTML = viewVerify();
  else pane.innerHTML = viewInbox();
  bindPane();
}

const connectCard = (title, lead) => `
  <div class="card">
    <span class="kicker">${title}</span>
    <h1>${lead}</h1>
    <p class="lead">Connect the wallet you want to be paid in. COWL never asks for a transaction to look around.</p>
    <button class="btn primary" data-act="connect">Connect wallet <span class="arrow">→</span></button>
  </div>`;

const unlockCard = (title) => `
  <div class="card">
    <span class="kicker">${title}</span>
    <h1>Unlock your hood.</h1>
    <p class="lead">One free signature turns your wallet into two private keys: one to find payments, one to move them.</p>
    <ol class="steps">
      <li><b>1</b><span>Your wallet signs a fixed message. No gas, no transaction.</span></li>
      <li><b>2</b><span>Your browser derives the keys from that signature. They never leave this tab.</span></li>
      <li><b>3</b><span>Sign again on any device and the same keys come back.</span></li>
    </ol>
    <button class="btn primary" data-act="unlock">Sign to unlock <span class="arrow">→</span></button>
    <p class="note">Use a regular wallet (MetaMask, Rabby, Phantom). Smart-contract wallets may produce different signatures each time.</p>
  </div>`;

function viewReceive() {
  if (!S.account) return connectCard('Receive', 'Get paid without your wallet on-chain.');
  if (!S.keys) return unlockCard('Receive');
  const link = receiveLink();
  const reg = S.keyMismatch
    ? `<span class="pill warn">Different keys on record</span>`
    : S.registered ? `<span class="pill ok">● Registered</span>` : `<span class="pill">Not registered</span>`;
  return `
  <div class="card">
    <span class="kicker">Your private receive link</span>
    <h1>Share this. <span class="dim">Stay hooded.</span></h1>
    <p class="lead">Every payment to this link lands in a brand-new address that only you can open.</p>
    <div class="link-box"><span class="url" title="${esc(link)}">${esc(link.replace(/^https?:\/\//, ''))}</span>
      <button class="btn small primary" data-act="copy-link">Copy</button></div>
    <div class="link-actions">
      <button class="btn small" data-act="qr">QR code</button>
      ${navigator.share ? '<button class="btn small" data-act="share">Share</button>' : ''}
      <a class="btn small" href="/inbox" data-nav="inbox">Open Inbox →</a>
    </div>
    <div class="qr" id="qr"></div>
    ${!S.registered && !S.keyMismatch ? `<p class="note">This long link works right now. Register once to shorten it to your wallet address.</p>` : ''}
  </div>
  <div class="card">
    <div class="row"><span class="k">Short link (ERC-6538 registry)</span><span class="v">${reg}</span></div>
    ${S.keyMismatch ? `<p class="note warn">This wallet registered different keys earlier, so senders using your address would pay keys you cannot open here. Re-register to point your address at the keys you just unlocked.</p>` : ''}
    ${!S.registered || S.keyMismatch ? `<button class="btn block" data-act="register">${S.keyMismatch ? 'Re-register these keys' : 'Register short link · one transaction'}</button>
      <p class="note">Publishes your public receive keys so anyone can pay <span class="mono">${short(S.account)}</span> privately. Incoming payments stay unlinkable on-chain, but the short link itself shows your wallet address to whoever you give it to. Share the long link if that matters.</p>` : ''}
    <details class="meta"><summary>Stealth meta-address</summary><div class="meta-text">${esc(S.keys.metaAddress)}</div></details>
  </div>
  ${namesCard()}
  ${requestCard()}
  ${badgeCard()}`;
}

function requestCard() {
  const r = S.request;
  return `
  <div class="card" id="req-card">
    <span class="kicker">Payment request</span>
    <h2 class="h2">Ask for an exact amount.</h2>
    <p class="lead">Set the amount, the asset and a note. The payer opens the link and everything is filled in.</p>
    <div class="field">
      <div class="lab"><span>Amount</span><span>optional</span></div>
      <div class="amount-wrap">
        <input class="input" id="req-amount" inputmode="decimal" placeholder="0.00" value="${esc(r.amount)}">
        <button type="button" class="asset-btn" data-act="req-asset">${assetIcon(r.asset)}<span>${esc(r.asset.symbol)}</span><span aria-hidden="true">▾</span></button>
      </div>
    </div>
    <div class="field">
      <div class="lab"><label for="req-memo">Note</label><span id="req-count">${r.memo.length}/${MEMO_MAX}</span></div>
      <input class="input" id="req-memo" maxlength="${MEMO_MAX}" placeholder="Invoice #12 · design work" value="${esc(r.memo)}">
    </div>
    <div class="link-box"><span class="url" id="req-url">${esc(requestLink().replace(/^https?:\/\//, ''))}</span>
      <button class="btn small primary" data-act="copy-req">Copy</button></div>
    <div class="link-actions">
      <button class="btn small" data-act="req-qr">QR code</button>
      ${navigator.share ? '<button class="btn small" data-act="share-req">Share</button>' : ''}
    </div>
    <div class="qr" id="req-qr"></div>
    <p class="note">The note lives only in the link. It is never written on-chain. Amounts are public once paid, like any transfer.</p>
  </div>`;
}

function badgeCard() {
  const sn = badgeSnippets();
  const longLink = !S.registered || S.keyMismatch;
  return `
  <div class="card">
    <span class="kicker">Pay me privately button</span>
    <h2 class="h2">Put it on your site or profile.</h2>
    <p class="lead">Anyone who clicks it pays a one-time address. Your wallet never appears in the payment on-chain.</p>
    <div class="badge-preview ${S.badge}"><a href="${esc(receiveLink())}" target="_blank" rel="noopener"><img src="/assets/badge-${S.badge}.svg" alt="Pay me privately with COWL" width="232" height="48"></a></div>
    <div class="seg" role="group" aria-label="Button style">
      <button type="button" data-act="badge-style" data-style="dark" aria-pressed="${S.badge === 'dark'}">Dark</button>
      <button type="button" data-act="badge-style" data-style="light" aria-pressed="${S.badge === 'light'}">Light</button>
    </div>
    ${[['html', 'Website (HTML)'], ['md', 'GitHub / Markdown'], ['bio', 'X or Telegram bio']].map(([k, label]) => `
    <div class="snip"><div class="snip-head"><span>${label}</span><button type="button" class="btn small" data-act="copy-snip" data-k="${k}">Copy</button></div>
      <pre class="snip-code">${esc(sn[k])}</pre></div>`).join('')}
    ${longLink ? '<p class="note warn">Your link is long until you register the short link above. Register first for a bio-friendly link.</p>' : ''}
  </div>`;
}

function assetIcon(a) {
  if (a.address === 'eth') return `<span class="tok eth">ETH</span>`;
  if (LIVE.ca && a.address?.toLowerCase() === LIVE.ca.toLowerCase()) return `<span class="tok cowl"><img src="/assets/cowl-mark.svg" alt=""></span>`;
  return `<span class="tok">${esc(a.symbol.slice(0, 4))}</span>`;
}

function modeToggle() {
  if (!CFG.batch) return '';
  return `<div class="seg mode-seg" role="group" aria-label="Payment type">
    <button type="button" data-act="mode" data-mode="one" aria-pressed="${S.mode === 'one'}">One person</button>
    <button type="button" data-act="mode" data-mode="many" aria-pressed="${S.mode === 'many'}">Many people</button></div>`;
}
function viewSend() {
  if (S.mode === 'many' && CFG.batch) return viewMany();
  const s = S.send;
  const routerReady = !!CFG.router;
  const isToken = s.asset.address !== 'eth';
  const steps = isToken ? `<div class="stepper"><span class="${s.step === 1 ? 'on' : s.step > 1 ? 'done' : ''}"><b>1</b>Approve</span><i></i><span class="${s.step === 2 ? 'on' : s.step > 2 ? 'done' : ''}"><b>2</b>Send privately</span></div>` : '';
  if (s.result) {
    return `
    <div class="card">
      <span class="kicker">Sent privately</span>
      <h1>Delivered under the hood.</h1>
      <p class="lead">${esc(s.result.amount)} ${esc(s.result.symbol)} landed in a one-time address. Only the recipient can find it.</p>
      <div class="summary">
        <div class="row"><span class="k">One-time address</span><a class="v mono" href="${addrUrl(s.result.stealth)}" target="_blank" rel="noopener">${short(s.result.stealth, 6)} ↗</a></div>
        <div class="row"><span class="k">Transaction</span><a class="v mono" href="${txUrl(s.result.tx)}" target="_blank" rel="noopener">${short(s.result.tx, 6)} ↗</a></div>
      </div>
      <div class="link-actions"><button class="btn small primary" data-act="send-receipt">Download receipt</button><button class="btn small" data-act="send-again">Send another</button></div>
    </div>`;
  }
  return `
  <div class="card">
    ${modeToggle()}
    <span class="kicker">Send privately</span>
    <h1>Pay a link, <span class="dim">not a wallet.</span></h1>
    <p class="lead">Paste a COWL link or the recipient's wallet address. A fresh one-time address is made for this payment only.</p>
    ${s.req ? `<div class="req-banner"><span class="kicker">Payment request</span>
      ${s.req.memo ? `<b>${esc(s.req.memo)}</b>` : ''}
      ${s.req.amount ? `<span class="mono">Requested ${esc(s.req.amount)} ${esc(s.asset.symbol)}</span>` : ''}
      <small>The note comes from the link you opened. It is not written on-chain.</small></div>` : ''}
    <form id="send-form" autocomplete="off">
      <div class="field">
        <div class="lab"><label for="to">Recipient</label><button type="button" class="max" data-act="scan">Scan QR</button></div>
        <input class="input mono" id="to" placeholder="cowl.pro/name, cowl.pro/pay/… or 0x…" value="${esc(s.to)}" spellcheck="false">
        <div class="resolve" id="resolve">${s.resolved}</div>
      </div>
      <div class="field">
        <div class="lab"><span>Amount</span><span id="bal-line"></span></div>
        <div class="amount-wrap">
          <input class="input" id="amount" inputmode="decimal" placeholder="0.00" value="${esc(s.amount)}">
          <button type="button" class="asset-btn" data-act="asset">${assetIcon(s.asset)}<span>${esc(s.asset.symbol)}</span><span aria-hidden="true">▾</span></button>
        </div>
      </div>
      <div class="summary">
        <div class="row"><span class="k">Recipient wallet on-chain</span><span class="v" style="color:var(--good)">Hidden</span></div>
        <div class="row"><span class="k">You pay to</span><span class="v mono">new one-time address</span></div>
        ${isToken ? `<div class="row"><span class="k">Withdraw gas for recipient</span><span class="v num">${CFG.gasTipEth} ETH</span></div>` : ''}
        <div class="row"><span class="k">COWL fee</span><span class="v">None</span></div>
      </div>
      ${steps}
      <button class="btn primary block" type="submit" ${!routerReady || s.busy ? 'disabled' : ''}>${!routerReady ? 'Sending opens at launch' : !S.account ? 'Connect wallet' : s.busy ? 'Confirm in wallet…' : isToken && s.step <= 1 ? `Approve & send ${esc(s.asset.symbol)}` : 'Send privately'} <span class="arrow">→</span></button>
      <p class="note" id="send-note">Amounts and your wallet stay public. Only the link between this payment and the recipient is hidden.</p>
    </form>
  </div>`;
}

// ===================================================================== private payroll (CowlBatch)
const MAX_BATCH = 100;
function viewMany() {
  const m = S.many, a = S.send.asset, isToken = a.address !== 'eth';
  if (m.result) {
    return `
    <div class="card">
      <span class="kicker">Private payroll · sent</span>
      <h1>${m.result.count} people paid. <span class="dim">One transaction.</span></h1>
      <p class="lead">${esc(m.result.total)} ${esc(m.result.symbol)} went out to ${m.result.count} one-time addresses. None of them points to a recipient's wallet.</p>
      <div class="summary"><div class="row"><span class="k">Transaction</span><a class="v mono" href="${txUrl(m.result.tx)}" target="_blank" rel="noopener">${short(m.result.tx, 6)} ↗</a></div></div>
      <div class="link-actions"><button class="btn small primary" data-act="many-receipts">Download receipts (CSV)</button><button class="btn small" data-act="many-again">New payroll</button></div>
    </div>`;
  }
  const ok = m.rows.filter((r) => r.meta && r.amount > 0n);
  const total = ok.reduce((t, r) => t + r.amount, 0n);
  const bad = m.rows.filter((r) => r.error);
  const rows = m.rows.length ? `<div class="pr-list">${m.rows.map((r, i) => `
      <div class="pr-row ${r.error ? 'bad' : r.meta ? 'ok' : ''}"><span class="mono">${i + 1}</span><span class="pr-who">${esc(r.label || r.raw)}</span>
      <span class="num">${r.amount > 0n ? fmtAmount(r.amount, a.decimals) : '—'}</span><span class="pr-st">${r.error ? esc(r.error) : r.meta ? '✓' : '…'}</span></div>`).join('')}</div>` : '';
  return `
  <div class="card">
    ${modeToggle()}
    <span class="kicker">Private payroll</span>
    <h1>Pay many people, <span class="dim">one transaction.</span></h1>
    <p class="lead">One line per person: a COWL name, link or registered 0x address, then the amount. Each person gets a fresh one-time address.</p>
    <div class="field">
      <div class="lab"><label for="pr-text">Recipients</label><span>up to ${MAX_BATCH} · <button type="button" class="max" data-act="pr-csv">Import CSV</button></span></div>
      <textarea class="input mono pr-text" id="pr-text" rows="7" spellcheck="false" placeholder="maya, 0.05&#10;cowl.pro/jon, 0.02&#10;0x8f3c…e21a, 0.01">${esc(m.text)}</textarea>
      <input type="file" id="pr-file" accept=".csv,text/csv,text/plain" hidden>
    </div>
    <div class="field"><div class="lab"><span>Asset</span><span id="bal-line"></span></div>
      <button type="button" class="asset-btn" data-act="asset">${assetIcon(a)}<span>${esc(a.symbol)}</span><span aria-hidden="true">▾</span></button></div>
    <button class="btn block" data-act="pr-check" ${m.checking ? 'disabled' : ''}>${m.checking ? 'Checking recipients…' : 'Check recipients'}</button>
    ${rows}
    ${m.rows.length ? `<div class="summary">
      <div class="row"><span class="k">Ready to pay</span><span class="v">${ok.length} of ${m.rows.length}${bad.length ? ` · <span style="color:var(--warn)">${bad.length} need fixing</span>` : ''}</span></div>
      <div class="row"><span class="k">Total</span><span class="v num">${fmtAmount(total, a.decimals)} ${esc(a.symbol)}</span></div>
      ${isToken ? `<div class="row"><span class="k">Withdraw gas for recipients</span><span class="v num">${CFG.gasTipEth} ETH × ${ok.length}</span></div>` : ''}
      <div class="row"><span class="k">Recipient wallets on-chain</span><span class="v" style="color:var(--good)">Hidden</span></div>
      <div class="row"><span class="k">COWL fee</span><span class="v">None</span></div>
    </div>
    ${isToken ? `<div class="stepper"><span class="${m.step === 1 ? 'on' : m.step > 1 ? 'done' : ''}"><b>1</b>Approve</span><i></i><span class="${m.step === 2 ? 'on' : m.step > 2 ? 'done' : ''}"><b>2</b>Pay everyone</span></div>` : ''}
    <button class="btn primary block" data-act="pr-send" ${!ok.length || bad.length || m.busy ? 'disabled' : ''}>${!S.account ? 'Connect wallet' : m.busy ? 'Confirm in wallet…' : `Pay ${ok.length} ${ok.length === 1 ? 'person' : 'people'} privately`} <span class="arrow">→</span></button>
    <p class="note">Fix or remove any line marked in orange first. Amounts and your wallet stay public, as with any payment.</p>` : ''}
  </div>`;
}
// "maya, 0.05" / "cowl.pro/jon 0.02" / "0x…;0.01" → { raw, amountText }
function parseLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^recipient\b/i.test(l)).map((l) => {
    const m = l.match(/^(.+?)[\s,;\t]+([0-9]+(?:[.,][0-9]+)?)$/);
    return m ? { raw: m[1].trim().replace(/,$/, ''), amountText: m[2].replace(',', '.') } : { raw: l, amountText: '' };
  });
}
// satu penerima → meta-address (nama COWL, link /pay/, st:eth:, alamat 0x terdaftar)
async function resolveOne(input) {
  let raw = input.trim();
  const pm = raw.match(/\/pay\/([^/?#\s]+)/);
  if (pm) raw = decodeURIComponent(pm[1]);
  if (/^st:|^0x[0-9a-fA-F]{132}$/.test(raw)) return { meta: parseMetaAddress(raw), label: short(raw.replace(/^st:eth:/, ''), 6) + ' (link)' };
  if (ethers.isAddress(raw)) {
    const reg = new ethers.Contract(CFG.registry, ABI.registry, readProvider());
    const stored = await reg.stealthMetaAddressOf(raw, 1);
    if (!stored || stored === ZERO_META) throw new Error('No COWL link for this wallet');
    return { meta: parseMetaAddress(stored), label: short(ethers.getAddress(raw)) };
  }
  const nm = raw.match(/^(?:https?:\/\/)?(?:www\.)?cowl\.pro\/([a-z0-9-]{3,20})\/?$/i) || raw.match(/^@?([a-z0-9-]{3,20})$/i);
  if (nm) {
    const n = nm[1].toLowerCase();
    const r = await fetch('/api/names/' + encodeURIComponent(n), { cache: 'no-store' });
    if (!r.ok) throw new Error('Name not claimed');
    return { meta: parseMetaAddress((await r.json()).meta), label: 'cowl.pro/' + n };
  }
  throw new Error('Not a COWL name, link or address');
}
async function checkMany() {
  const m = S.many, a = S.send.asset;
  const lines = parseLines(m.text);
  if (!lines.length) return toast('Add at least one line');
  if (lines.length > MAX_BATCH) return toast(`Up to ${MAX_BATCH} people per transaction`);
  m.checking = true;
  m.rows = lines.map((l) => ({ ...l, amount: 0n, meta: null, error: null, label: '' }));
  render();
  let i = 0;
  const worker = async () => {
    while (i < m.rows.length) {
      const r = m.rows[i++];
      try { r.amount = ethers.parseUnits(r.amountText || '0', a.decimals); } catch { r.amount = 0n; }
      if (r.amount <= 0n) { r.error = 'Missing amount'; continue; }
      try { const out = await resolveOne(r.raw); r.meta = out.meta; r.label = out.label; } catch (e) { r.error = niceError(e); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  m.checking = false; render();
}
async function sendMany() {
  const m = S.many, a = S.send.asset;
  if (!S.account) return openWalletModal();
  const rows = m.rows.filter((r) => r.meta && r.amount > 0n);
  if (!rows.length) return;
  m.busy = true; render();
  try {
    const sg = await signer();
    const batch = new ethers.Contract(CFG.batch, ABI.batch, sg);
    // alamat sekali pakai dibuat di browser, satu per orang
    const pays = rows.map((r) => { const st = generateStealth(r.meta); r.stealth = st.stealthAddress; return [st.stealthAddress, st.ephemeralPubKey, ethers.toBeHex(st.viewTag, 1), r.amount]; });
    const total = rows.reduce((t, r) => t + r.amount, 0n);
    let tx;
    if (a.address === 'eth') {
      tx = await batch.sendEthBatch(pays, { value: total });
    } else {
      const tip = ethers.parseEther(CFG.gasTipEth);
      const token = new ethers.Contract(a.address, ABI.erc20, sg);
      if ((await token.allowance(S.account, CFG.batch)) < total) {
        m.step = 1; render();
        const ap = await token.approve(CFG.batch, total); // jumlah pas, tidak pernah tak terbatas
        toast('Approving…'); await ap.wait();
      }
      m.step = 2; render();
      tx = await batch.sendTokenBatch(a.address, pays, tip, { value: tip * BigInt(rows.length) });
    }
    toast('Paying everyone privately…');
    await tx.wait();
    m.result = { tx: tx.hash, count: rows.length, total: fmtAmount(total, a.decimals), symbol: a.symbol, rows: rows.map((r) => ({ who: r.label, amount: fmtAmount(r.amount, a.decimals), stealth: r.stealth })) };
    m.step = 3;
  } catch (e) { toast(niceError(e)); }
  finally { m.busy = false; render(); }
}
function downloadFile(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function bindMany() {
  const t = $('#pr-text'); if (!t) return;
  t.addEventListener('input', () => { S.many.text = t.value; if (S.many.rows.length) { S.many.rows = []; render(); $('#pr-text').focus(); } });
  const f = $('#pr-file');
  f.addEventListener('change', async () => { const file = f.files[0]; if (!file) return; S.many.text = (await file.text()).slice(0, 20000); S.many.rows = []; render(); });
  updateBalance();
}

function viewInbox() {
  if (!S.account) return connectCard('Inbox', 'Find what was sent to your hood.');
  if (!S.keys) return unlockCard('Inbox');
  const ib = S.inbox;
  const items = [...ib.mine.values()].sort((a, b) => b.t - a.t);
  const pct = ib.total ? Math.round((ib.scanned / ib.total) * 100) : ib.syncing ? 5 : 100;
  const scanLine = ib.err ? `<span class="note bad">${esc(ib.err)}</span>`
    : `<span>${ib.syncing ? 'Scanning' : 'Scanned'} ${ib.scanned.toLocaleString('en-US')} announcements on Robinhood Chain · ${items.length} yours</span>`;
  return `
  <div class="card">
    <span class="kicker">Inbox</span>
    <h1>Only you can see this list.</h1>
    <p class="lead">Your browser downloads every public announcement and checks each one with your viewing key. The server never learns which are yours.</p>
    <div class="scan"><div class="bar"><i style="width:${pct}%"></i></div></div>
    <div class="scan" style="margin-top:-8px">${scanLine}</div>
    <div class="inbox-list">
      ${items.length ? items.map(inboxRow).join('') : `<div class="empty"><img src="/assets/cowl-mark.svg" alt=""><br>${ib.syncing ? 'Looking under every hood…' : 'Nothing yet. Share your link from Receive.'}</div>`}
    </div>
  </div>`;
}
function inboxRow(it) {
  const tok = it.token;
  const dust = 2000000000000n; // ±0,000002 ETH: di bawah ini tak sebanding ongkos sapu
  const has = it.balance > 0n || it.eth > dust;
  const leftoverOnly = it.kind === 'token' && it.balance === 0n && has;
  const amt = it.kind === 'eth' || leftoverOnly ? it.eth : it.balance;
  const sym = leftoverOnly ? 'ETH left for gas' : tok.symbol;
  const shown = it.loaded ? fmtAmount(has ? amt : it.amount, leftoverOnly ? 18 : tok.decimals) : '…';
  return `
  <div class="inbox-item ${it.loaded && !has ? 'empty-bal' : ''}">
    ${assetIcon(tok)}
    <div><div class="amt">${shown} <span style="color:var(--muted);font-weight:500">${esc(sym)}</span></div>
    <div class="sub">${timeAgo(it.t)} · <a href="${addrUrl(it.addr)}" target="_blank" rel="noopener" class="mono">${short(it.addr)}</a>${it.loaded && !has ? ' · withdrawn' : ''}</div></div>
    <span class="ib-acts">${it.loaded ? `<button class="btn small" data-act="prove" data-addr="${it.addr}">Prove</button>` : ''}${it.loaded && has ? `<button class="btn small primary" data-act="withdraw" data-addr="${it.addr}">Withdraw</button>` : ''}</span>
  </div>`;
}

// ===================================================================== interaksi
function bindPane() {
  const pane = $('#pane');
  pane.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', onAct));
  pane.querySelectorAll('[data-nav]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); go(el.dataset.nav); }));
  if (S.view === 'send' && S.mode === 'many' && CFG.batch) bindMany();
  else if (S.view === 'send' && !S.send.result) bindSend();
  if (S.view === 'receive' && $('#req-card')) bindRequest();
  if (S.view === 'receive' && $('#nm-input')) bindNames();
  if (S.view === 'inbox' && S.keys) syncInbox();
}

async function onAct(e) {
  const act = e.currentTarget.dataset.act;
  const btn = e.currentTarget;
  try {
    if (act === 'connect') return openWalletModal();
    if (act === 'unlock') { btn.disabled = true; btn.textContent = 'Check your wallet…'; await unlock(); return; }
    if (act === 'copy-link') return copy(receiveLink(), 'Link copied');
    if (act === 'share') return navigator.share({ title: 'Pay me privately with COWL', url: receiveLink() }).catch(() => {});
    if (act === 'qr') return toggleQr('#qr', receiveLink());
    if (act === 'register') { btn.disabled = true; btn.textContent = 'Confirm in wallet…'; await register(); return; }
    if (act === 'asset') return openAssetModal();
    if (act === 'scan') return openScanner();
    if (act === 'mode') { S.mode = btn.dataset.mode; return render(); }
    if (act === 'pr-check') return checkMany();
    if (act === 'pr-send') return sendMany();
    if (act === 'pr-csv') return $('#pr-file').click();
    if (act === 'many-again') { S.many = { text: '', rows: [], checking: false, busy: false, step: 0, result: null }; return render(); }
    if (act === 'many-receipts') {
      const r = S.many.result;
      const csv = ['recipient,amount,asset,one_time_address,transaction'].concat(r.rows.map((x) => [x.who, x.amount, r.symbol, x.stealth, r.tx].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))).join('\n');
      return downloadFile(`cowl-payroll-${r.tx.slice(2, 10)}.csv`, csv);
    }
    if (act === 'claim-name') { btn.disabled = true; btn.textContent = 'Check your wallet…'; S.nm.busy = true; try { await claimName(); } finally { S.nm.busy = false; } return; }
    if (act === 'release-name') return releaseName();
    if (act === 'copy-name') return copy(receiveLink(), 'Name link copied');
    if (act === 'req-asset') return openAssetModal((a) => { S.request.asset = a; render(); });
    if (act === 'copy-req') return copy(requestLink(), 'Request link copied');
    if (act === 'share-req') return navigator.share({ title: 'Payment request · COWL', url: requestLink() }).catch(() => {});
    if (act === 'req-qr') return toggleQr('#req-qr', requestLink());
    if (act === 'badge-style') { S.badge = btn.dataset.style; return render(); }
    if (act === 'copy-snip') return copy(badgeSnippets()[btn.dataset.k], 'Copied');
    if (act === 'send-again') { S.send = { ...S.send, amount: '', result: null, step: 0 }; return render(); }
    if (act === 'withdraw') return openWithdraw(btn.dataset.addr);
    if (act === 'prove') return openProve(btn.dataset.addr);
    if (act === 'verify-go') return verifyProof();
    if (act === 'send-receipt') {
      const r = S.send.result;
      const text = ['COWL payment receipt', '', `Paid: ${r.amount} ${r.symbol}`, `To: ${r.to}`, `One-time address: ${r.stealth}`, `Transaction: ${r.tx}`, `From: ${r.from}`, ...(r.memo ? [`Note: ${r.memo}`] : []), `Time: ${r.at}`, '', `Check on Blockscout: ${txUrl(r.tx)}`].join('\n');
      return downloadFile(`cowl-receipt-${r.tx.slice(2, 10)}.txt`, text, 'text/plain');
    }
  } catch (err) {
    toast(niceError(err));
    render();
  }
}

function toggleQr(sel, data) {
  const box = $(sel);
  if (box.classList.toggle('show')) {
    const q = qrcode(0, 'M');
    q.addData(data);
    q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
}

function bindRequest() {
  const upd = () => {
    $('#req-url').textContent = requestLink().replace(/^https?:\/\//, '');
    $('#req-count').textContent = `${S.request.memo.length}/${MEMO_MAX}`;
    const qr = $('#req-qr'); if (qr.classList.contains('show')) { qr.classList.remove('show'); toggleQr('#req-qr', requestLink()); }
  };
  $('#req-amount').addEventListener('input', (e) => { const v = e.target.value.replace(',', '.'); S.request.amount = /^\d*\.?\d*$/.test(v) ? v : S.request.amount; upd(); });
  $('#req-memo').addEventListener('input', (e) => { S.request.memo = e.target.value.slice(0, MEMO_MAX); upd(); });
}

// ---------- kirim ----------
let resolveTimer;
function bindSend() {
  const to = $('#to'), amount = $('#amount');
  to.addEventListener('input', () => { S.send.to = to.value; clearTimeout(resolveTimer); resolveTimer = setTimeout(resolveRecipient, 350); });
  amount.addEventListener('input', () => { S.send.amount = amount.value.replace(',', '.'); });
  $('#send-form').addEventListener('submit', (e) => { e.preventDefault(); doSend(); });
  if (S.send.to && !S.send.meta) resolveRecipient();
  updateBalance();
}
function setResolve(html) { S.send.resolved = html; const el = $('#resolve'); if (el) el.innerHTML = html; }
async function resolveRecipient() {
  let raw = S.send.to.trim();
  S.send.meta = null;
  if (!raw) return setResolve('');
  const m = raw.match(/\/pay\/([^/?#\s]+)/);
  if (m) raw = decodeURIComponent(m[1]);
  // nama COWL: "maya", "@maya", "cowl.pro/maya"
  const nmm = !m && (raw.match(/^(?:https?:\/\/)?(?:www\.)?cowl\.pro\/([a-z0-9-]{3,20})\/?(?:[?#].*)?$/i) || raw.match(/^@?([a-z0-9-]{3,20})$/i));
  if (nmm && !/^0x/i.test(nmm[1])) {
    const n = nmm[1].toLowerCase();
    setResolve('<span class="note">Looking up this COWL name…</span>');
    try {
      const r = await fetch('/api/names/' + encodeURIComponent(n), { cache: 'no-store' });
      if (!r.ok) return setResolve(`<span class="note warn">No one has claimed cowl.pro/${esc(n)} yet.</span>`);
      const j = await r.json();
      S.send.meta = parseMetaAddress(j.meta);
      return setResolve(`<span class="note ok">✓ cowl.pro/${esc(n)} found. Their wallet will not appear in this payment.</span>`);
    } catch (e) { return setResolve(`<span class="note bad">${esc(niceError(e))}</span>`); }
  }
  try {
    if (/^st:|^0x[0-9a-fA-F]{132}$/.test(raw)) {
      S.send.meta = parseMetaAddress(raw);
      return setResolve('<span class="note ok">✓ Private receive keys found. A one-time address will be made on send.</span>');
    }
    if (ethers.isAddress(raw)) {
      setResolve('<span class="note">Looking up this wallet\'s COWL link…</span>');
      const reg = new ethers.Contract(CFG.registry, ABI.registry, readProvider());
      const stored = await reg.stealthMetaAddressOf(raw, 1);
      if (!stored || stored === ZERO_META) {
        return setResolve('<span class="note warn">This wallet has no COWL link yet. Ask them to open cowl.pro → Receive and register.</span>');
      }
      S.send.meta = parseMetaAddress(stored);
      return setResolve(`<span class="note ok">✓ ${short(ethers.getAddress(raw))} has a private link. Their wallet will not appear in this payment.</span>`);
    }
    setResolve('<span class="note warn">Paste a COWL link, a stealth meta-address, or a 0x wallet address.</span>');
  } catch (e) {
    setResolve(`<span class="note bad">${esc(niceError(e))}</span>`);
  }
}
async function balanceOf(asset, who) {
  if (asset.address === 'eth') return readProvider().getBalance(who);
  return new ethers.Contract(asset.address, ABI.erc20, readProvider()).balanceOf(who);
}
async function updateBalance() {
  const line = $('#bal-line');
  if (!line || !S.account) return;
  try {
    const b = await balanceOf(S.send.asset, S.account);
    S.send.balance = b;
    line.innerHTML = `Balance <span class="num">${fmtAmount(b, S.send.asset.decimals)}</span> · <button type="button" class="max" id="max">Max</button>`;
    $('#max').addEventListener('click', () => {
      let v = b;
      if (S.send.asset.address === 'eth') v = b > ethers.parseEther('0.0002') ? b - ethers.parseEther('0.0002') : 0n; // sisakan gas
      S.send.amount = ethers.formatUnits(v, S.send.asset.decimals);
      $('#amount').value = S.send.amount;
    });
  } catch { line.textContent = ''; }
}

function assetList() {
  const list = [ETH];
  if (LIVE.ca) list.push({ symbol: 'COWL', name: 'COWL', address: ethers.getAddress(LIVE.ca), decimals: 18 });
  return list.concat(STOCKS);
}
function openAssetModal(onPick) {
  const list = assetList();
  modal(`
    <h3>Choose an asset</h3>
    <p>ETH, Robinhood stock tokens, or any ERC-20 by address.</p>
    <input class="input asset-search" id="asset-q" placeholder="Search NVDA, Tesla… or paste 0x token address" spellcheck="false">
    <div class="asset-list" id="asset-list"></div>`);
  const draw = (q = '') => {
    const ql = q.trim().toLowerCase();
    const hits = list.filter((a) => !ql || a.symbol.toLowerCase().includes(ql) || a.name.toLowerCase().includes(ql) || a.address.toLowerCase() === ql);
    let html = hits.slice(0, 80).map((a) => `<button class="asset-item" data-addr="${a.address}">${assetIcon(a)}<span class="nm"><b>${esc(a.symbol)}</b><small>${esc(a.name)}</small></span></button>`).join('');
    if (!hits.length && ethers.isAddress(q.trim())) html = `<button class="asset-item" data-addr="${q.trim()}"><span class="tok">?</span><span class="nm"><b>Custom token</b><small class="mono">${short(q.trim(), 6)}</small></span></button>`;
    $('#asset-list').innerHTML = html || '<div class="empty">No match.</div>';
    $('#asset-list').querySelectorAll('.asset-item').forEach((b) => b.addEventListener('click', async () => {
      try {
        const a = b.dataset.addr === 'eth' ? ETH : await tokenInfo(b.dataset.addr);
        closeModal();
        if (onPick) return onPick(a);
        S.send.asset = a;
        S.send.step = 0;
        render();
      } catch (e) { toast(niceError(e)); }
    }));
  };
  draw();
  $('#asset-q').addEventListener('input', (e) => draw(e.target.value));
  setTimeout(() => $('#asset-q')?.focus(), 50);
}

async function doSend() {
  const s = S.send;
  if (!S.account) return openWalletModal();
  if (!s.meta) { await resolveRecipient(); if (!s.meta) return toast('Add a valid recipient first'); }
  let amount;
  try { amount = ethers.parseUnits(String(s.amount || '0'), s.asset.decimals); } catch { return toast('Enter a valid amount'); }
  if (amount <= 0n) return toast('Enter an amount');
  const note = $('#send-note');
  s.busy = true; render();
  try {
    const sg = await signer();
    const router = new ethers.Contract(CFG.router, ABI.router, sg);
    const st = generateStealth(s.meta);
    $('#cv-stealth-addr').textContent = short(st.stealthAddress, 6) + ' · new';
    const tag = ethers.toBeHex(st.viewTag, 1);
    let tx;
    if (s.asset.address === 'eth') {
      tx = await router.sendEth(st.stealthAddress, st.ephemeralPubKey, tag, { value: amount });
    } else {
      const tip = ethers.parseEther(CFG.gasTipEth);
      const token = new ethers.Contract(s.asset.address, ABI.erc20, sg);
      const allowance = await token.allowance(S.account, CFG.router);
      if (allowance < amount) {
        s.step = 1; render();
        const ap = await token.approve(CFG.router, amount); // jumlah pas, tidak pernah tak terbatas
        toast('Approving…');
        await ap.wait();
      }
      s.step = 2; render();
      tx = await router.sendToken(s.asset.address, amount, st.stealthAddress, st.ephemeralPubKey, tag, { value: tip });
    }
    toast('Sending privately…');
    await tx.wait();
    s.result = { tx: tx.hash, stealth: st.stealthAddress, amount: fmtAmount(amount, s.asset.decimals), symbol: s.asset.symbol, to: s.to, from: S.account, at: new Date().toISOString(), memo: s.req?.memo || '' };
    s.step = 3;
  } catch (e) {
    toast(niceError(e));
    if (note) note.textContent = niceError(e);
  } finally {
    s.busy = false; render();
  }
}

// ---------- inbox ----------
let inboxTimer;
async function syncInbox() {
  const ib = S.inbox;
  if (ib.syncing || !S.keys) return;
  ib.syncing = true;
  const keysAtStart = S.keys;
  try {
    for (;;) {
      const r = await fetch(`/api/announcements?since=${ib.since}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('Inbox server unavailable, retrying…');
      const d = await r.json();
      ib.total = d.total;
      for (const a of d.items) {
        const meta = parseMetadata(a.m) || {};
        const priv = checkAnnouncement({ stealthAddress: a.s, ephemeralPubKey: a.e, viewTag: meta.viewTag }, keysAtStart);
        if (priv && !ib.mine.has(a.s)) {
          ib.mine.set(a.s, { addr: a.s, priv, t: a.t, tx: a.x, kind: meta.kind, amount: meta.amount ?? 0n, tokenAddr: meta.kind === 'token' ? meta.token : 'eth', loaded: false, balance: 0n, eth: 0n, token: ETH });
        }
      }
      ib.since += d.items.length;
      ib.scanned = ib.since;
      if (S.keys !== keysAtStart) return;
      if (S.view === 'inbox') render();
      if (ib.since >= d.total || !d.items.length) break;
    }
    ib.err = '';
    await loadBalances();
  } catch (e) {
    ib.err = niceError(e);
  } finally {
    ib.syncing = false;
    updateBadge();
    if (S.view === 'inbox') { const p = $('#pane'); const y = scrollY; p.innerHTML = viewInbox(); p.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', onAct)); scrollTo(0, y); }
    clearTimeout(inboxTimer);
    inboxTimer = setTimeout(() => { if (S.view === 'inbox') syncInbox(); }, 15000);
  }
}
async function loadBalances() {
  const rp = readProvider();
  await Promise.all([...S.inbox.mine.values()].map(async (it) => {
    it.token = await tokenInfo(it.tokenAddr).catch(() => ({ symbol: 'TOKEN', decimals: 18, address: it.tokenAddr, name: '' }));
    it.eth = await rp.getBalance(it.addr);
    it.balance = it.kind === 'token' ? await new ethers.Contract(it.tokenAddr, ABI.erc20, rp).balanceOf(it.addr) : it.eth;
    it.loaded = true;
  }));
}
function updateBadge() {
  const n = [...S.inbox.mine.values()].filter((i) => i.loaded && (i.balance > 0n)).length;
  const b = $('#inbox-badge');
  b.hidden = !n; b.textContent = n;
}

// ===================================================================== pindai QR (kamera)
let scanStream = null;
function stopScan() { scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null; }
async function openScanner() {
  modal(`<h3>Scan a COWL QR</h3><p>Point the camera at a COWL link or payment request. The picture never leaves this device.</p>
    <div class="scan-box"><video id="scan-v" playsinline muted></video><i></i></div><div class="note" id="scan-note">Starting camera…</div>`);
  const dlg = $('#modal'); dlg.addEventListener('close', stopScan, { once: true });
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch { $('#scan-note').textContent = 'Camera not available. Allow camera access, or paste the link instead.'; return; }
  const v = $('#scan-v'); v.srcObject = scanStream; await v.play();
  $('#scan-note').textContent = 'Looking for a QR code…';
  const c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (!scanStream) return;
    if (v.videoWidth) {
      c.width = v.videoWidth; c.height = v.videoHeight; g.drawImage(v, 0, 0);
      const code = jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
      if (code?.data) return onScanned(code.data.trim());
    }
    setTimeout(tick, 180);
  };
  tick();
}
function onScanned(text) {
  stopScan(); closeModal();
  // link cowl.pro (termasuk tagihan dengan jumlah & catatan) → buka langsung supaya semuanya terisi
  try {
    const u = new URL(text);
    if (/(^|\.)cowl\.pro$/i.test(u.hostname) || u.origin === location.origin) { location.assign(location.origin + u.pathname + u.search); return; }
  } catch {}
  S.view = 'send'; S.mode = 'one'; S.send.to = text; S.send.meta = null; S.send.resolved = ''; render();
  toast('QR scanned');
}

// ===================================================================== bukti pembayaran
const PROOF_HEAD = 'COWL payment proof';
function proofMessage(o) {
  return [PROOF_HEAD, '', `One-time address: ${o.addr}`, `Transaction: ${o.tx}`, ...(o.note ? [`Note: ${o.note}`] : []), `Issued: ${o.issued}`].join('\n');
}
function openProve(addr) {
  const it = S.inbox.mine.get(addr);
  if (!it) return;
  modal(`
    <h3>Prove you received this</h3>
    <p>Signs a short statement with this payment's one-time key, in this browser. Anyone can check it at cowl.pro/verify. It does not reveal your main wallet and moves nothing.</p>
    <div class="field"><label for="pf-note">Note (optional)</label><input class="input" id="pf-note" maxlength="80" placeholder="Invoice #12"></div>
    <button class="btn primary block" id="pf-go">Create proof <span class="arrow">→</span></button>
    <div id="pf-out" hidden><pre class="meta-text pf-pre" id="pf-text"></pre>
      <div class="link-actions"><button class="btn small primary" id="pf-copy">Copy</button><button class="btn small" id="pf-dl">Download</button></div></div>`);
  $('#pf-go').addEventListener('click', async () => {
    const msg = proofMessage({ addr: ethers.getAddress(it.addr), tx: it.tx, note: $('#pf-note').value.trim().replace(/\n/g, ' '), issued: new Date().toISOString() });
    const sig = await new ethers.Wallet(it.priv).signMessage(msg); // kunci sekali pakai tidak pernah keluar dari tab
    const text = msg + '\nSignature: ' + sig;
    $('#pf-text').textContent = text; $('#pf-out').hidden = false; $('#pf-go').hidden = true;
    $('#pf-copy').addEventListener('click', () => copy(text, 'Proof copied'));
    $('#pf-dl').addEventListener('click', () => downloadFile(`cowl-proof-${it.addr.slice(2, 10)}.txt`, text, 'text/plain'));
  });
}
const ANN_TOPIC = '0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7';
function viewVerify() {
  return `
  <div class="card">
    <span class="kicker">Verify a COWL proof</span>
    <h1>Check a payment proof.</h1>
    <p class="lead">Paste a proof made in a COWL Inbox. This page checks the signature and the transaction on Robinhood Chain. Nothing is sent to a server.</p>
    <div class="field"><label for="vf-text">Proof</label><textarea class="input mono pr-text" id="vf-text" rows="8" spellcheck="false" placeholder="COWL payment proof&#10;&#10;One-time address: 0x…&#10;Transaction: 0x…&#10;Issued: …&#10;Signature: 0x…"></textarea></div>
    <button class="btn primary block" data-act="verify-go">Verify <span class="arrow">→</span></button>
    <div id="vf-out"></div>
  </div>`;
}
async function verifyProof() {
  const out = $('#vf-out'), text = $('#vf-text').value.trim();
  const show = (ok, rows, title) => { out.innerHTML = `<div class="vf-res ${ok ? 'ok' : 'bad'}"><b>${title}</b>${rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}</div>`; };
  try {
    const m = text.match(/^([\s\S]*?)\nSignature: (0x[0-9a-fA-F]{130})\s*$/);
    if (!m || !m[1].startsWith(PROOF_HEAD)) throw new Error('This does not look like a COWL proof.');
    const msg = m[1];
    const addr = (msg.match(/One-time address: (0x[0-9a-fA-F]{40})/) || [])[1];
    const txh = (msg.match(/Transaction: (0x[0-9a-fA-F]{64})/) || [])[1];
    if (!addr || !txh) throw new Error('The proof is missing the address or the transaction.');
    const signer = ethers.verifyMessage(msg, m[2]);
    if (signer.toLowerCase() !== addr.toLowerCase()) return show(false, [['Signed by', short(signer, 6)], ['Claims', short(addr, 6)]], 'Not valid: the signature does not match the address.');
    const rc = await readProvider().getTransactionReceipt(txh);
    if (!rc) throw new Error('Transaction not found on Robinhood Chain.');
    const iface = new ethers.Interface(['event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)']);
    const log = rc.logs.find((l) => l.topics[0] === ANN_TOPIC && ethers.getAddress('0x' + l.topics[2].slice(26)) === ethers.getAddress(addr));
    if (!log) return show(false, [['Transaction', `<a class="mono" href="${txUrl(txh)}" target="_blank" rel="noopener">${short(txh, 6)} ↗</a>`]], 'Not valid: this transaction did not pay that address.');
    const meta = parseMetadata(iface.parseLog(log).args.metadata) || {};
    const tok = meta.kind === 'token' ? await tokenInfo(meta.token).catch(() => ({ symbol: 'TOKEN', decimals: 18 })) : ETH;
    const blk = await readProvider().getBlock(rc.blockNumber);
    const note = (msg.match(/Note: (.*)/) || [])[1];
    show(true, [
      ['Received', meta.amount != null ? `${fmtAmount(meta.amount, tok.decimals)} ${esc(tok.symbol)}` : '—'],
      ['One-time address', `<a class="mono" href="${addrUrl(addr)}" target="_blank" rel="noopener">${short(addr, 6)} ↗</a>`],
      ['Transaction', `<a class="mono" href="${txUrl(txh)}" target="_blank" rel="noopener">${short(txh, 6)} ↗</a>`],
      ['Paid at', blk ? new Date(blk.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—'],
      ...(note ? [['Note', esc(note)]] : []),
    ], '✓ Valid. Whoever shared this controls the address that received this payment.');
  } catch (e) { show(false, [], esc(niceError(e))); }
}

function openWithdraw(addr) {
  const it = S.inbox.mine.get(addr);
  if (!it) return;
  const amt = it.kind === 'eth' ? it.eth : it.balance;
  modal(`
    <h3>Withdraw ${fmtAmount(amt, it.token.decimals)} ${esc(it.token.symbol)}</h3>
    <p>Signed in this browser with the one-time key. Network fee is paid from the ETH inside this address.</p>
    <div class="field"><label for="dest">Send to</label><input class="input mono" id="dest" placeholder="0x… (a fresh wallet keeps you hidden)" spellcheck="false"></div>
    <div id="dest-note" class="note" style="margin:-6px 0 16px">Tip: withdrawing to your public wallet links this payment back to you.</div>
    <ul class="prog" id="prog" hidden></ul>
    <button class="btn primary block" id="wd-go">Withdraw <span class="arrow">→</span></button>`);
  const dest = $('#dest'), note = $('#dest-note');
  dest.addEventListener('input', () => {
    const v = dest.value.trim();
    if (S.account && v.toLowerCase() === S.account.toLowerCase()) { note.className = 'note warn'; note.textContent = 'This is your connected public wallet. The withdrawal will link this payment to it. Use a fresh wallet to stay hidden.'; }
    else { note.className = 'note'; note.textContent = 'Tip: withdrawing to your public wallet links this payment back to you.'; }
  });
  $('#wd-go').addEventListener('click', () => withdraw(it, dest.value.trim()));
}

async function withdraw(it, to) {
  if (!ethers.isAddress(to)) return toast('Enter a valid 0x address');
  to = ethers.getAddress(to);
  const go = $('#wd-go'), prog = $('#prog');
  go.disabled = true; go.textContent = 'Withdrawing…';
  const steps = it.kind === 'token' ? [`Send ${it.token.symbol}`, 'Sweep leftover ETH'] : ['Send ETH'];
  prog.hidden = false;
  prog.innerHTML = steps.map((s) => `<li>${esc(s)}</li>`).join('');
  const mark = (i, cls) => { prog.children[i].className = cls; };
  try {
    const bp = broadcastProvider();
    const w = new ethers.Wallet(it.priv, bp);
    const gp = await safeGasPrice(bp);
    // nonce dihitung sendiri: sebagian RPC terlambat memperbarui hitungan 'pending' setelah tx pertama
    let nonce = await bp.getTransactionCount(w.address, 'latest');
    // sisa ETH dihitung dari struk, bukan dibaca ulang: RPC bisa memberi saldo basi tepat setelah tx
    let ethLeft = await bp.getBalance(w.address);
    let i = 0;
    if (it.kind === 'token') {
      mark(0, 'on');
      const c = new ethers.Contract(it.tokenAddr, ABI.erc20, w);
      const bal = await c.balanceOf(w.address);
      if (bal > 0n) {
        const gas = await c.transfer.estimateGas(to, bal);
        const limit = (gas * 13n) / 10n;
        const eth = await bp.getBalance(w.address);
        if (eth < limit * gp) throw new Error(`This address needs ${ethers.formatEther(limit * gp - eth)} more ETH for the network fee.`);
        const tx = await c.transfer(to, bal, { gasPrice: gp, gasLimit: limit, type: 0, nonce: nonce++ });
        const rc = await tx.wait();
        ethLeft -= rc.fee;
      }
      mark(0, 'done');
      i = 1;
    }
    mark(i, 'on');
    const fresh = await bp.getBalance(w.address);
    const eth = fresh < ethLeft ? fresh : ethLeft;
    const gl = await bp.estimateGas({ from: w.address, to, value: 1n });
    const limit = (gl * 13n) / 10n;
    const value = eth - limit * gp;
    if (value > 0n) {
      const tx = await w.sendTransaction({ to, value, gasLimit: limit, gasPrice: gp, type: 0, nonce: nonce++ });
      await tx.wait();
    }
    mark(i, 'done');
    go.textContent = 'Done';
    toast('Withdrawn');
    it.loaded = false;
    await loadBalances();
    updateBadge();
    setTimeout(() => { closeModal(); render(); }, 900);
  } catch (e) {
    go.disabled = false; go.textContent = 'Try again';
    toast(niceError(e));
    const n = $('#dest-note'); if (n) { n.className = 'note bad'; n.textContent = niceError(e); }
  }
}

// ===================================================================== modal
function modal(html) {
  const d = $('#modal');
  $('#modal-body').innerHTML = `<button class="icon-btn modal-close" aria-label="Close" data-close>✕</button>` + html;
  $('#modal-body [data-close]').addEventListener('click', closeModal);
  if (!d.open) d.showModal();
}
function closeModal() { const d = $('#modal'); if (d.open) d.close(); }

// ===================================================================== mulai
async function main() {
  discoverWallets();
  await loadConfig();
  routeFromPath();
  // link tagihan: pilih aset yang diminta (ETH, simbol, atau alamat token)
  if (S.send.req?.asset) {
    try { S.send.asset = await resolveAssetParam(S.send.req.asset); } catch (e) { toast(niceError(e)); }
  }
  // tautan sosial + CA dari satu sumber
  document.querySelectorAll('[data-social]').forEach((a) => { a.href = CFG[a.dataset.social]; });
  if (LIVE.ca) {
    $('#ca-chip').hidden = false;
    $('#ca-short').textContent = short(LIVE.ca);
    $('#ca-copy').addEventListener('click', () => copy(LIVE.ca, 'Contract address copied'));
  }
  if (CFG.router) $('#foot-router').innerHTML = `Router <a class="mono" href="${addrUrl(CFG.router)}" target="_blank" rel="noopener">${short(CFG.router)}</a>`;
  document.querySelectorAll('.tabs a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.view); }));
  $('#wallet-btn').addEventListener('click', () => (S.account ? copy(S.account, 'Address copied') : openWalletModal()));
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  addEventListener('popstate', () => { routeFromPath(); render(); });
  render();
  autoReconnect();
  // bisa dipasang di layar HP (PWA); service worker sengaja tanpa cache
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
main();
