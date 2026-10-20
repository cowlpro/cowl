// Tes end-to-end di fork lokal Robinhood Chain (anvil port 8645):
// daftar kunci → kirim ETH + NVDA lewat Router → pindai pengumuman → turunkan kunci stealth → tarik dana.
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import {
  SIGN_MESSAGE, keysFromSignature, generateStealth, checkAnnouncement, parseMetadata, parseMetaAddress,
} from '../app/src/stealth.js';

const RPC = process.env.RPC || 'http://127.0.0.1:8645';
const ANNOUNCER = '0x55649E01B5Df198D18D95b5cc5051630cfD45564';
const REGISTRY = '0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const NVDA_WHALE = '0x8366a39CC670B4001A1121B8F6A443A643e40951'; // PoolManager Uniswap V4, hanya di fork

const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
// akun bawaan anvil
const receiver = ethers.Wallet.createRandom().connect(provider);
const senderWallet = ethers.Wallet.createRandom().connect(provider);
const sender = new ethers.NonceManager(senderWallet); // anvil kadang telat melaporkan nonce 'pending'
sender.address = senderWallet.address;
const dest = ethers.Wallet.createRandom().address;

const ok = (cond, msg) => { if (!cond) { console.error('GAGAL:', msg); process.exit(1); } console.log('  ✓', msg); };
const art = JSON.parse(readFileSync(new URL('../contracts/out/CowlRouter.sol/CowlRouter.json', import.meta.url)));
const erc20 = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const registryAbi = ['function registerKeys(uint256 schemeId, bytes stealthMetaAddress)', 'function stealthMetaAddressOf(address registrant, uint256 schemeId) view returns (bytes)'];
const annIface = new ethers.Interface(['event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)']);

for (const w of [receiver, senderWallet]) await provider.send('anvil_setBalance', [w.address, '0x8AC7230489E80000']);
console.log('1. Kunci dari tanda tangan');
const sig1 = await receiver.signMessage(SIGN_MESSAGE);
const sig2 = await receiver.signMessage(SIGN_MESSAGE);
const keys = keysFromSignature(sig1);
ok(keysFromSignature(sig2).metaAddress === keys.metaAddress, 'tanda tangan ulang menghasilkan kunci yang sama');
ok(parseMetaAddress(keys.metaAddress).metaBytes === keys.metaBytes, 'meta-address bisa dibaca ulang');

console.log('2. Pasang Router + daftar registry');
const startBlock = await provider.getBlockNumber();
const router = await new ethers.ContractFactory(art.abi, art.bytecode.object, sender).deploy();
await router.waitForDeployment();
const routerAddr = await router.getAddress();
ok(true, 'Router terpasang di ' + routerAddr);
const registry = new ethers.Contract(REGISTRY, registryAbi, receiver);
await (await registry.registerKeys(1, keys.metaBytes)).wait();
const stored = await registry.stealthMetaAddressOf(receiver.address, 1);
ok(stored.toLowerCase() === keys.metaBytes.toLowerCase(), 'registry mengembalikan meta-address yang sama');

console.log('3. Kirim ETH');
const s1 = generateStealth(stored);
const r = router.connect(sender);
await (await r.sendEth(s1.stealthAddress, s1.ephemeralPubKey, ethers.toBeHex(s1.viewTag, 1), { value: ethers.parseEther('0.05') })).wait();
ok((await provider.getBalance(s1.stealthAddress)) === ethers.parseEther('0.05'), '0.05 ETH mendarat di alamat stealth');

console.log('4. Kirim token saham NVDA + ongkos tarik');
await provider.send('anvil_impersonateAccount', [NVDA_WHALE]);
await provider.send('anvil_setBalance', [NVDA_WHALE, '0xDE0B6B3A7640000']);
const whale = await provider.getSigner(NVDA_WHALE);
await (await new ethers.Contract(NVDA, erc20, whale).transfer(sender.address, ethers.parseEther('3'))).wait();
const nvda = new ethers.Contract(NVDA, erc20, sender);
await (await nvda.approve(routerAddr, ethers.parseEther('2'))).wait();
const s2 = generateStealth(stored);
const tip = ethers.parseEther('0.00005');
const sendTx = await (await r.sendToken(NVDA, ethers.parseEther('2'), s2.stealthAddress, s2.ephemeralPubKey, ethers.toBeHex(s2.viewTag, 1), { value: tip })).wait();
ok((await nvda.balanceOf(s2.stealthAddress)) === ethers.parseEther('2'), '2 NVDA mendarat di alamat stealth');
console.log('    gas sendToken:', sendTx.gasUsed.toString());

console.log('5. Pengumuman orang lain (harus diabaikan)');
const stranger = keysFromSignature(await ethers.Wallet.createRandom().signMessage(SIGN_MESSAGE));
const s3 = generateStealth(stranger.metaAddress);
await (await r.sendEth(s3.stealthAddress, s3.ephemeralPubKey, ethers.toBeHex(s3.viewTag, 1), { value: 1000n })).wait();

console.log('6. Pindai');
const logs = await provider.getLogs({ address: ANNOUNCER, fromBlock: startBlock, toBlock: 'latest' });
const found = [];
for (const log of logs) {
  const ev = annIface.parseLog(log);
  const meta = parseMetadata(ev.args.metadata);
  const priv = checkAnnouncement({ stealthAddress: ev.args.stealthAddress, ephemeralPubKey: ev.args.ephemeralPubKey, viewTag: meta.viewTag }, keys);
  if (priv) found.push({ addr: ev.args.stealthAddress, priv, meta });
}
ok(logs.length === 3, '3 pengumuman tercatat');
ok(found.length === 2, 'penerima menemukan tepat 2 miliknya');
for (const f of found) ok(new ethers.Wallet(f.priv).address === ethers.getAddress(f.addr), 'kunci turunan cocok dengan ' + f.addr.slice(0, 10));
ok(found[1].meta.kind === 'token' && found[1].meta.amount === ethers.parseEther('2') && found[1].meta.gasTip === tip, 'metadata token terbaca benar');

console.log('7. Tarik dana');
const w2 = new ethers.Wallet(found.find((f) => f.meta.kind === 'token').priv, provider);
// biaya diatur sendiri: Arbitrum mengabaikan tip, jadi pakai transaksi legacy dengan gasPrice jaringan
const gp = (await provider.getBlock('latest')).baseFeePerGas * 2n; // tagihan nyata = baseFee × gas terpakai
const t = await (await new ethers.Contract(NVDA, erc20, w2).transfer(dest, ethers.parseEther('2'), { gasPrice: gp, type: 0 })).wait();
console.log('    gas tarik NVDA:', t.gasUsed.toString(), 'biaya', ethers.formatEther(t.gasUsed * t.gasPrice), 'ETH');
ok((await nvda.balanceOf(dest)) === ethers.parseEther('2'), 'NVDA sampai di alamat tujuan');
const w1 = new ethers.Wallet(found.find((f) => f.meta.kind === 'eth').priv, provider);
const bal = await provider.getBalance(w1.address);
const gasPrice = gp;
const gasLimit = await provider.estimateGas({ from: w1.address, to: dest, value: 1n });
await (await w1.sendTransaction({ to: dest, value: bal - gasLimit * gasPrice, gasLimit, gasPrice, type: 0 })).wait();
const left = await provider.getBalance(w1.address);
ok(left < ethers.parseEther('0.000001'), 'ETH disapu, sisa debu ' + ethers.formatEther(left));
console.log('\nSEMUA LULUS');
