// Aplikasi COWL: Receive (buat link), Send (kirim ke link), Inbox (temukan & tarik dana).
// Kunci privat hanya hidup di memori tab ini. Tidak ada yang dikirim ke server.
import qrcode from 'qrcode-generator';
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
  inbox: { since: 0, scanned: 0, mine: new Map(), syncing: false, total: 0, err: '' },
};

// ===================================================================== rute
function routeFromPath() {
  const p = location.pathname;
  const m = p.match(/^\/pay\/([^/]+)/);
  if (m) {
    S.view = 'send'; S.send.to = decodeURIComponent(m[1]);
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
  if (p.startsWith('/send')) S.view = 'send';
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
  render();
}
async function refreshRegistry() {
  const reg = new ethers.Contract(CFG.registry, ABI.registry, readProvider());
  const stored = await reg.stealthMetaAddressOf(S.account, 1).catch(() => ZERO_META);
  S.registered = stored && stored !== ZERO_META ? stored.toLowerCase() : '';
  S.keyMismatch = !!(S.registered && S.keys && S.registered !== S.keys.metaBytes.toLowerCase());
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
  if (!S.account) return connectCard('Receive', 'Get paid without showing your wallet.');
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
      <p class="note">Publishes your public receive keys so anyone can pay <span class="mono">${short(S.account)}</span> privately. Incoming payments stay unlinkable.</p>` : ''}
    <details class="meta"><summary>Stealth meta-address</summary><div class="meta-text">${esc(S.keys.metaAddress)}</div></details>
  </div>
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
    <p class="lead">Anyone who clicks it pays your link. Your wallet stays out of every payment.</p>
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

function viewSend() {
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
      <button class="btn" data-act="send-again">Send another</button>
    </div>`;
  }
  return `
  <div class="card">
    <span class="kicker">Send privately</span>
    <h1>Pay a link, <span class="dim">not a wallet.</span></h1>
    <p class="lead">Paste a COWL link or the recipient's wallet address. A fresh one-time address is made for this payment only.</p>
    ${s.req ? `<div class="req-banner"><span class="kicker">Payment request</span>
      ${s.req.memo ? `<b>${esc(s.req.memo)}</b>` : ''}
      ${s.req.amount ? `<span class="mono">Requested ${esc(s.req.amount)} ${esc(s.asset.symbol)}</span>` : ''}
      <small>The note comes from the link you opened. It is not written on-chain.</small></div>` : ''}
    <form id="send-form" autocomplete="off">
      <div class="field">
        <label for="to">Recipient</label>
        <input class="input mono" id="to" placeholder="cowl.pro/pay/0x… or 0x…" value="${esc(s.to)}" spellcheck="false">
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
    ${it.loaded && has ? `<button class="btn small primary" data-act="withdraw" data-addr="${it.addr}">Withdraw</button>` : '<span></span>'}
  </div>`;
}

// ===================================================================== interaksi
function bindPane() {
  const pane = $('#pane');
  pane.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', onAct));
  pane.querySelectorAll('[data-nav]').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); go(el.dataset.nav); }));
  if (S.view === 'send' && !S.send.result) bindSend();
  if (S.view === 'receive' && $('#req-card')) bindRequest();
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
    if (act === 'req-asset') return openAssetModal((a) => { S.request.asset = a; render(); });
    if (act === 'copy-req') return copy(requestLink(), 'Request link copied');
    if (act === 'share-req') return navigator.share({ title: 'Payment request · COWL', url: requestLink() }).catch(() => {});
    if (act === 'req-qr') return toggleQr('#req-qr', requestLink());
    if (act === 'badge-style') { S.badge = btn.dataset.style; return render(); }
    if (act === 'copy-snip') return copy(badgeSnippets()[btn.dataset.k], 'Copied');
    if (act === 'send-again') { S.send = { ...S.send, amount: '', result: null, step: 0 }; return render(); }
    if (act === 'withdraw') return openWithdraw(btn.dataset.addr);
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
    s.result = { tx: tx.hash, stealth: st.stealthAddress, amount: fmtAmount(amount, s.asset.decimals), symbol: s.asset.symbol };
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
}
main();
