// Owned implementations of the published KIF byte formats. CatSystem2 uses
// the 1999 MT integer seed recurrence, not the common 2002 recurrence.
function mt1999First(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid CatSystem2 seed.");
  const state = new Uint32Array(398);
  for (let i = 0; i < state.length; i++) {
    const high = seed & 0xffff0000;
    seed = (Math.imul(seed, 69069) + 1) >>> 0;
    state[i] = high | (seed >>> 16);
    seed = (Math.imul(seed, 69069) + 1) >>> 0;
  }
  const combined = (state[0] & 0x80000000) | (state[1] & 0x7fffffff);
  let value = state[397] ^ (combined >>> 1) ^ (combined & 1 ? 0x9908b0df : 0);
  value ^= value >>> 11;
  value ^= (value << 7) & 0x9d2c5680;
  value ^= (value << 15) & 0xefc60000;
  return (value ^ (value >>> 18)) >>> 0;
}

function tocSeed(code) {
  if (!Buffer.isBuffer(code) || !code.length || code.length > 256) throw new Error("Invalid CatSystem2 code length.");
  let seed = 0xffffffff;
  for (const byte of code) {
    if (byte === 0) break;
    seed ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) seed = (seed << 1) ^ (seed & 0x80000000 ? 0x04c11db7 : 0);
    seed = ~seed;
  }
  return seed >>> 0;
}

// Beaufort is reciprocal: the same byte transform decodes and encodes names.
function transformName(bytes, seed) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 64) throw new Error("KIF filenames require 64 bytes.");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", random = mt1999First(seed);
  let shift = ((random >>> 24) + (random >>> 16) + (random >>> 8) + random) & 0xff;
  const output = Buffer.from(bytes);
  for (let i = 0; i < output.length; i++, shift++) {
    const position = alphabet.indexOf(String.fromCharCode(output[i]));
    if (position >= 0) output[i] = alphabet.charCodeAt(((51 - position - shift) % 52 + 52) % 52);
  }
  return output;
}

module.exports = { mt1999First, tocSeed, transformName };
