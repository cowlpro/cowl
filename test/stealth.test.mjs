// Tes unit kriptografi ERC-5564 (tanpa jaringan): node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  SIGN_MESSAGE, keysFromSignature, generateStealth, checkAnnouncement, parseMetadata, parseMetaAddress,
} from '../app/src/stealth.js';

const wallet = ethers.Wallet.createRandom();
const keys = keysFromSignature(await wallet.signMessage(SIGN_MESSAGE));

test('kunci dari tanda tangan bersifat deterministik', async () => {
  const again = keysFromSignature(await wallet.signMessage(SIGN_MESSAGE));
  assert.equal(again.metaAddress, keys.metaAddress);
});

test('byte v tanda tangan diabaikan (27/28 vs 0/1)', async () => {
  const sig = ethers.Signature.from(await wallet.signMessage(SIGN_MESSAGE));
  const v01 = sig.r + sig.s.slice(2) + (sig.v - 27).toString(16).padStart(2, '0');
  assert.equal(keysFromSignature(v01).metaAddress, keys.metaAddress);
});

test('meta-address bisa dibaca bolak-balik', () => {
  const m = parseMetaAddress(keys.metaAddress);
  assert.equal(m.metaBytes, keys.metaBytes);
  assert.throws(() => parseMetaAddress('st:eth:0x1234'));
});

test('penerima menemukan pembayaran dan kunci privatnya mengendalikan alamat sekali pakai', () => {
  for (let i = 0; i < 20; i++) {
    const s = generateStealth(keys.metaAddress);
    const priv = checkAnnouncement(s, keys);
    assert.ok(priv, 'pembayaran harus ditemukan');
    assert.equal(new ethers.Wallet(priv).address.toLowerCase(), s.stealthAddress);
  }
});

test('setiap pembayaran memakai alamat baru', () => {
  const set = new Set(Array.from({ length: 50 }, () => generateStealth(keys.metaAddress).stealthAddress));
  assert.equal(set.size, 50);
});

test('kunci orang lain tidak bisa menemukan pembayaran', async () => {
  const other = keysFromSignature(await ethers.Wallet.createRandom().signMessage(SIGN_MESSAGE));
  for (let i = 0; i < 20; i++) assert.equal(checkAnnouncement(generateStealth(keys.metaAddress), other), null);
});

test('metadata Router terbaca (ETH dan token)', () => {
  const amt = 123456789n, tip = 20000000000000n;
  const ethMeta = '0x7f' + 'eeeeeeee' + 'ee'.repeat(20) + amt.toString(16).padStart(64, '0');
  assert.deepEqual(parseMetadata(ethMeta), { viewTag: 0x7f, kind: 'eth', token: '0x' + 'ee'.repeat(20), amount: amt });
  const token = 'd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
  const tokMeta = '0x01' + 'a9059cbb' + token + amt.toString(16).padStart(64, '0') + tip.toString(16).padStart(64, '0');
  assert.deepEqual(parseMetadata(tokMeta), { viewTag: 1, kind: 'token', token: '0x' + token, amount: amt, gasTip: tip });
});
