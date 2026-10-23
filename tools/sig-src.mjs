// Sumber untuk server/vendor-sig.mjs (dibundel oleh tools/build.mjs): pulihkan alamat dari personal_sign.
// Server COWL sengaja tanpa node_modules di VPS, jadi kriptografinya dibundel jadi satu berkas.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

export function recoverPersonal(message, signatureHex) {
  const msg = utf8ToBytes(message);
  const hash = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const sig = hexToBytes(signatureHex.replace(/^0x/, ''));
  if (sig.length !== 65) throw new Error('Bad signature length');
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('Bad recovery id');
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(hash).toRawBytes(false);
  return '0x' + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}
