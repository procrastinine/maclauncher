// Copyright (c) MacLauncher contributors. MIT license.
// Packed-layout tables and decoding are derived from MLX-DLSS (Apache-2.0),
// pinned in nvidia-weight-spec.json. Extracted parameters retain vendor terms.
// This transforms local model data only; no vendor code is loaded or executed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {setImmediate: yieldTurn} = require('node:timers/promises');
const Spec = require('./nvidia-weight-spec.json');

const maximumBytes = 128 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);

function inspect(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > maximumBytes)
    throw new Error('Choose a supported local NVIDIA frame-generation or RTX VSR library.');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    bytes = Buffer.alloc(64);
    if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length || !unchanged(stat, fs.fstatSync(descriptor)))
      throw new Error('The selected model library changed during inspection.');
  } finally { fs.closeSync(descriptor); }
  // Inspection identifies a candidate format only. Conversion verifies the
  // complete source digest before any packed offset is admitted.
  const profile = bytes.subarray(0, 2).toString() === 'MZ' && stat.size === Spec.interpolation.sourceBytes
    ? 'interpolation' : bytes.readUInt32LE(0) === 0x464c457f ? 'vsr' : null;
  if (!profile) throw new Error('Choose the supported NVIDIA 310.9.16 frame-generation DLL or RTX VSR 1.8.2 library.');
  const model = Spec[profile];
  return {file: fs.realpathSync(file), stat, architecture: model.architecture, operation: model.operation,
    adapter: 'nvidia-packed-' + profile + '-v1', profile};
}

function checkedSlice(bytes, offset, count) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 0 || offset > bytes.length - count)
    throw new Error('The model library has an incomplete packed tensor.');
  return bytes.subarray(offset, offset + count);
}

async function convert(source, destination, {signal} = {}) {
  signal?.throwIfAborted();
  const model = Spec[source.profile];
  if (!model || source.architecture !== model.architecture || source.operation !== model.operation)
    throw new Error('Choose a supported NVIDIA model conversion.');
  const input = await fs.promises.open(source.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    if (!unchanged(source.stat, await input.stat())) throw new Error('The selected model library changed before conversion.');
    bytes = await input.readFile();
    if (!unchanged(source.stat, await input.stat())) throw new Error('The selected model library changed during conversion.');
  } finally { await input.close(); }
  signal?.throwIfAborted();
  const inputHash = sha256(bytes);
  if (inputHash !== model.sourceSHA256)
    throw new Error('The selected NVIDIA library differs from the exact supported model source.');
  let base = 0;
  if (source.profile === 'interpolation') {
    base = -1;
    for (let offset = 0; offset <= bytes.length - 256; offset += 16) {
      if (sha256(bytes.subarray(offset, offset + 256)) === model.weightImageSHA256) { base = offset; break; }
      if (!(offset % 262144)) { signal?.throwIfAborted(); await yieldTurn(); }
    }
    if (base < 0) throw new Error('The frame-generation library has no supported packed weight image.');
  }
  const header = {}, tensors = [], parts = [];
  let dataOffset = 0;
  const add = (name, shape, content) => {
    if (Object.hasOwn(header, name)) throw new Error('The model declares duplicate converted tensors.');
    // Exponent 31 in a binary16 value denotes infinity or NaN. No conversion
    // to JavaScript floating point changes the original parameter bytes.
    for (let at = 0; at < content.length; at += 2)
      if ((content.readUInt16LE(at) & 0x7c00) === 0x7c00) throw new Error('The model contains nonfinite parameters.');
    header[name] = {dtype: 'F16', shape, data_offsets: [dataOffset, dataOffset + content.length]};
    tensors.push({name, dataType: 'float16', shape}); parts.push(content); dataOffset += content.length;
  };
  const fragment = [0, 1, 4, 5, 8, 9, 12, 13, 2, 3, 6, 7, 10, 11, 14, 15];
  for (const [name, layer] of Object.entries(model.layers)) {
    signal?.throwIfAborted();
    const {output, input, kernel, kind} = layer, count = output * input * kernel * kernel;
    const heads = kind === 'custom3' ? 3 : 1;
    for (let head = 0; head < heads; head++) {
      const suffix = heads === 1 ? name : name + '.head' + head;
      const packed = checkedSlice(bytes, base + layer.weightOffset + head * count * 2, count * 2);
      const weight = Buffer.alloc(count * 2);
      for (let out = 0; out < output; out++) for (let channel = 0; channel < input; channel++)
        for (let y = 0; y < kernel; y++) for (let x = 0; x < kernel; x++) {
          const tap = y * kernel + x, logical = ((out * input + channel) * kernel * kernel + tap) * 2;
          let from;
          if (source.profile === 'vsr' || kind === 'plain') from = (out * kernel * kernel * input + tap * input + channel) * 2;
          else if (kind === 'custom' || kind === 'custom3')
            from = (((((Math.floor(out / 8) * 9 + tap) * (input / 8) + Math.floor(channel / 8)) * 8 + out % 8) * 8) + channel % 8) * 2;
          else if (kind === 'unet') {
            const k = tap * input + channel;
            from = (Math.floor(out / 8) * (kernel * kernel * input / 16) * 128 + Math.floor(k / 16) * 128 + out % 8 * 16 + fragment[k % 16]) * 2;
          } else throw new Error('The packed model tensor layout is unsupported.');
          weight.writeUInt16LE(packed.readUInt16LE(from), logical);
        }
      let bias;
      if (kind === 'unet') {
        const offset = base + layer.weightOffset + 4 * count;
        const packedBias = checkedSlice(bytes, offset, output / 8 * 128 * 2);
        bias = Buffer.alloc(output * 2);
        for (let out = 0; out < output; out++) bias.writeUInt16LE(packedBias.readUInt16LE((Math.floor(out / 8) * 128 + out % 8) * 2), out * 2);
      } else bias = layer.biasOffset == null ? Buffer.alloc(output * 2)
        : Buffer.from(checkedSlice(bytes, base + layer.biasOffset + head * output * 2, output * 2));
      add(suffix + '.weight', [output, input, kernel, kernel], weight);
      add(suffix + '.bias', [output], bias);
    }
    await yieldTurn();
  }
  header.__metadata__ = {source_sha256: inputHash, source: path.basename(source.file), layout: 'OIHW',
    adapter: source.adapter, extractor_repository: Spec.source.repository, extractor_commit: Spec.source.commit};
  const json = Buffer.from(JSON.stringify(header)), length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length));
  const output = Buffer.concat([length, json, ...parts]);
  signal?.throwIfAborted();
  if (!unchanged(source.stat, await fs.promises.lstat(source.file))) throw new Error('The selected model library changed during conversion.');
  await fs.promises.writeFile(destination, output, {flag: 'wx'});
  try {
    signal?.throwIfAborted();
    const verified = require('./models').inspectWeights(destination);
    if (verified.architecture !== source.architecture || verified.operation !== source.operation)
      throw new Error('The converted tensors differ from the neural operation contract.');
  } catch (error) { await fs.promises.unlink(destination); throw error; }
  return {architecture: source.architecture, operation: source.operation, tensors, sha256: sha256(output),
    sourceFiles: [{file: path.basename(source.file), sha256: inputHash, adapter: source.adapter,
      extractorRepository: Spec.source.repository, extractorCommit: Spec.source.commit}]};
}

module.exports = {inspect, convert};
