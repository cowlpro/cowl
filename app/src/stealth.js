// Kriptografi stealth address ERC-5564 skema 1 (secp256k1 + view tag).
// Dipakai bersama oleh browser (app) dan Node (tes end-to-end).
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

const Point = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;

// Pesan yang ditandatangani dompet. JANGAN diubah setelah launch:
// mengubah satu huruf = semua pengguna mendapat kunci baru dan kehilangan Inbox lamanya.
export const SIGN_MESSAGE = [
  'COWL · Unlock your private receive keys',
  '',
  'Signing is free. It sends nothing and moves nothing.',
  'This signature stays in your browser.',
  '',
  'Network: Robinhood Chain (4663)',
  'Key version: 1',
].join('\n');

const strip0x = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const toHex = (b) => '0x' + bytesToHex(b);

function scalarFrom(bytes) {
  const x = BigInt('0x' + bytesToHex(bytes)) % N;
  if (x === 0n) throw new Error('Invalid scalar');
  return x;
}

function scalarToBytes(x) {
  return hexToBytes(x.toString(16).padStart(64, '0'));
}

/** Alamat EVM (huruf kecil) dari titik secp256k1. */
export function pointToAddress(point) {
  const raw = point.toRawBytes(false).slice(1); // 64 byte tanpa awalan 0x04
  return '0x' + bytesToHex(keccak_256(raw).slice(-20));
}

/**
 * Menurunkan kunci spending + viewing dari tanda tangan dompet atas SIGN_MESSAGE.
 * Hanya r||s yang dipakai (byte v diabaikan) supaya dompet yang menulis v=0/1 atau 27/28 hasilnya sama.
 */
export function keysFromSignature(signatureHex) {
  const sig = hexToBytes(strip0x(signatureHex));
  if (sig.length < 64) throw new Error('Signature too short');
  const rs = sig.slice(0, 64);
  const spendPriv = scalarFrom(keccak_256(concatBytes(utf8ToBytes('cowl/spend/v1'), rs)));
  const viewPriv = scalarFrom(keccak_256(concatBytes(utf8ToBytes('cowl/view/v1'), rs)));
  return keysFromPrivates(spendPriv, viewPriv);
}

export function keysFromPrivates(spendPriv, viewPriv) {
  const spendPub = Point.BASE.multiply(spendPriv).toRawBytes(true);
  const viewPub = Point.BASE.multiply(viewPriv).toRawBytes(true);
  return {
    spendPriv,
    viewPriv,
    spendPub,
    viewPub,
    // bentuk mentah 66 byte untuk registry ERC-6538
    metaBytes: toHex(concatBytes(spendPub, viewPub)),
    // bentuk teks untuk dibagikan
    metaAddress: 'st:eth:' + toHex(concatBytes(spendPub, viewPub)),
  };
}

/** Membaca meta-address dari teks "st:eth:0x..." atau hex 66 byte. */
export function parseMetaAddress(input) {
  let s = String(input || '').trim();
  const m = s.match(/^st:[a-z0-9]+:(0x[0-9a-fA-F]+)$/);
  if (m) s = m[1];
  const bytes = hexToBytes(strip0x(s));
  if (bytes.length !== 66) throw new Error('Not a stealth meta-address');
  const spendPub = bytes.slice(0, 33);
  const viewPub = bytes.slice(33);
  // validasi: dua-duanya harus titik sah di kurva
  Point.fromHex(spendPub);
  Point.fromHex(viewPub);
  return { spendPub, viewPub, metaBytes: toHex(bytes) };
}

/**
 * Sisi pengirim: membuat alamat sekali pakai untuk penerima.
 * @returns {{stealthAddress:string, ephemeralPubKey:string, viewTag:number}}
 */
export function generateStealth(meta, ephPrivOverride) {
  const { spendPub, viewPub } = typeof meta === 'string' ? parseMetaAddress(meta) : meta;
  const ephPriv = ephPrivOverride ?? secp256k1.utils.randomPrivateKey();
  const ephemeralPubKey = secp256k1.getPublicKey(ephPriv, true);
  const shared = secp256k1.getSharedSecret(ephPriv, viewPub, true);
  const hashed = keccak_256(shared);
  const h = scalarFrom(hashed);
  const stealthPoint = Point.fromHex(spendPub).add(Point.BASE.multiply(h));
  return {
    stealthAddress: pointToAddress(stealthPoint),
    ephemeralPubKey: toHex(ephemeralPubKey),
    viewTag: hashed[0],
  };
}

/**
 * Sisi penerima: memeriksa satu pengumuman. Mengembalikan kunci privat alamat stealth bila milik kita, kalau tidak null.
 * Pemeriksaan view tag membuang ±255/256 pengumuman orang lain dengan satu perkalian titik saja.
 */
export function checkAnnouncement({ stealthAddress, ephemeralPubKey, viewTag }, keys) {
  let shared;
  try {
    shared = secp256k1.getSharedSecret(scalarToBytes(keys.viewPriv), hexToBytes(strip0x(ephemeralPubKey)), true);
  } catch {
    return null; // kunci efemeral rusak / bukan titik sah
  }
  const hashed = keccak_256(shared);
  if (viewTag !== undefined && viewTag !== null && hashed[0] !== viewTag) return null;
  const h = scalarFrom(hashed);
  const point = Point.fromHex(keys.spendPub).add(Point.BASE.multiply(h));
  if (pointToAddress(point) !== stealthAddress.toLowerCase()) return null;
  const priv = (keys.spendPriv + h) % N;
  return '0x' + priv.toString(16).padStart(64, '0');
}

/**
 * Membaca metadata pengumuman (lihat CowlRouter):
 *  ETH   : viewTag | eeeeeeee | 0xEeee…EeE | amount
 *  ERC20 : viewTag | a9059cbb | token     | amount | gasTip
 */
export function parseMetadata(metaHex) {
  const b = hexToBytes(strip0x(metaHex || ''));
  if (b.length < 1) return null;
  const out = { viewTag: b[0] };
  if (b.length >= 57) {
    const sel = bytesToHex(b.slice(1, 5));
    out.kind = sel === 'eeeeeeee' ? 'eth' : sel === 'a9059cbb' ? 'token' : 'other';
    out.token = '0x' + bytesToHex(b.slice(5, 25));
    out.amount = BigInt('0x' + bytesToHex(b.slice(25, 57)));
    if (b.length >= 89) out.gasTip = BigInt('0x' + bytesToHex(b.slice(57, 89)));
  }
  return out;
}
