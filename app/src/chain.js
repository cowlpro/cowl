// Konfigurasi jaringan, dompet (EIP-6963), RPC baca, dan utilitas format. Dipakai app + landing.
import { ethers } from 'ethers';
import STOCKS from './stocks.json';

export { ethers, STOCKS };

export let CFG = null;
export let LIVE = { ca: '', launchAt: '2026-10-19T13:00:00Z' };

export async function loadConfig() {
  const [c, l] = await Promise.all([
    fetch('/config.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('/live.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => LIVE),
  ]);
  CFG = c;
  LIVE = l;
  return { CFG, LIVE };
}

// ---------- RPC baca (bukan lewat dompet, supaya cepat & tidak memunculkan popup) ----------
let _read = null;
export function readProvider() {
  if (_read) return _read;
  const net = new ethers.Network(CFG.chainName, CFG.chainId);
  const list = CFG.rpcs.map((u) => new ethers.JsonRpcProvider(u, net, { staticNetwork: net, batchMaxCount: 20 }));
  _read = list.length > 1
    ? new ethers.FallbackProvider(list.map((p, i) => ({ provider: p, priority: i + 1, weight: 1, stallTimeout: 2500 })), net, { quorum: 1 })
    : list[0];
  return _read;
}
/** Penyiar transaksi stealth: RPC tunggal pertama (FallbackProvider tidak bisa broadcast dengan andal). */
let _bcast = null;
export function broadcastProvider() {
  if (_bcast) return _bcast;
  const net = new ethers.Network(CFG.chainName, CFG.chainId);
  _bcast = new ethers.JsonRpcProvider(CFG.rpcs[0], net, { staticNetwork: net });
  return _bcast;
}

/** Harga gas yang aman: Arbitrum menagih baseFee × gas terpakai, tip diabaikan. */
export async function safeGasPrice(provider = broadcastProvider()) {
  const b = await provider.getBlock('latest');
  const base = b?.baseFeePerGas ?? (await provider.getFeeData()).gasPrice;
  return base * 2n;
}

// ---------- dompet (EIP-6963 + window.ethereum) ----------
const wallets = new Map(); // rdns → {info, provider}
export function discoverWallets() {
  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = e.detail; // jangan dimutasi (dibekukan oleh spesifikasi)
    if (d?.info?.rdns && d.provider) wallets.set(d.info.rdns, d);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
export function listWallets() {
  const out = [...wallets.values()];
  if (!out.length && window.ethereum) out.push({ info: { name: 'Browser wallet', rdns: 'injected', icon: '' }, provider: window.ethereum });
  return out;
}

export async function ensureChain(eip) {
  const hex = '0x' + CFG.chainId.toString(16);
  const cur = await eip.request({ method: 'eth_chainId' });
  if (cur?.toLowerCase() === hex) return;
  try {
    await eip.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (e?.code === 4001) throw new Error('Network switch was rejected.');
    try {
      await eip.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hex, chainName: CFG.chainName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [CFG.walletRpc, CFG.rpcs[0]], blockExplorerUrls: [CFG.explorer],
        }],
      });
    } catch (e2) {
      if (eip.isPhantom) throw new Error('In Phantom, enable Robinhood Chain: Settings → Active Networks.');
      throw new Error('Please add Robinhood Chain to your wallet.');
    }
  }
}

// ---------- ABI ----------
export const ABI = {
  erc20: [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function transfer(address,uint256) returns (bool)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function name() view returns (string)',
  ],
  registry: [
    'function registerKeys(uint256 schemeId, bytes stealthMetaAddress)',
    'function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)',
  ],
  router: [
    'function sendEth(address stealth, bytes ephemeralPubKey, bytes1 viewTag) payable',
    'function sendToken(address token, uint256 amount, address stealth, bytes ephemeralPubKey, bytes1 viewTag) payable',
  ],
};

// ---------- metadata token ----------
const tokenCache = new Map();
export const ETH = { symbol: 'ETH', name: 'Ether', address: 'eth', decimals: 18 };
export async function tokenInfo(address) {
  if (!address || address === 'eth' || /^0xe{40}$/i.test(address)) return ETH;
  const key = address.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key);
  const known = STOCKS.find((s) => s.address.toLowerCase() === key);
  if (known) { tokenCache.set(key, known); return known; }
  const c = new ethers.Contract(address, ABI.erc20, readProvider());
  const [symbol, decimals, name] = await Promise.all([c.symbol().catch(() => 'TOKEN'), c.decimals().catch(() => 18), c.name().catch(() => '')]);
  const info = { symbol, decimals: Number(decimals), name, address: ethers.getAddress(address) };
  tokenCache.set(key, info);
  return info;
}

// ---------- format ----------
export const short = (a, n = 4) => (a ? a.slice(0, 2 + n) + '…' + a.slice(-n) : '');
export function fmtAmount(v, decimals = 18, max = 6) {
  const s = ethers.formatUnits(v, decimals);
  const [i, f = ''] = s.split('.');
  const ff = f.replace(/0+$/, '').slice(0, max);
  return Number(i).toLocaleString('en-US') + (ff ? '.' + ff : '');
}
export function timeAgo(ts) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
export const txUrl = (h) => `${CFG.explorer}/tx/${h}`;
export const addrUrl = (a) => `${CFG.explorer}/address/${a}`;

export function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

export async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('Copy failed — select and copy manually'); }
}

/** Pesan galat yang ramah dari error ethers / dompet. */
export function niceError(e) {
  const m = e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  if (e?.code === 'ACTION_REJECTED' || e?.code === 4001 || /rejected|denied/i.test(m)) return 'Request rejected in wallet.';
  if (/insufficient funds/i.test(m)) return 'Not enough ETH for this transaction.';
  return m.length > 140 ? m.slice(0, 140) + '…' : m;
}
