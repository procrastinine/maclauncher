// Packed NR resource decoding derived from MLX-DLSS (Apache-2.0),
// commit 7870371e8bf6c03967213f1a5d40db6c5a3bee38. Vendor code is never executed.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {setImmediate: yieldTurn} = require('node:timers/promises');
const NR = require('./nr-models');
const MAXIMUM = 512 * 1024 * 1024;
const RESOURCES = ['WEIGHTS_CC_SMALL_FP8', 'WEIGHTS_HT'];
const STANDARD = {32: [0x50c0, 0x58c0, 0x5900], 64: [0xf140, 0x11130, 0x111a0], 128: [0x30240, 0x38230, 0x38320], 256: [0xa8450, 0xc8440, 0xc8630]};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
function checkedRange(bytes, offset, length) {
  if (![offset, length].every(Number.isSafeInteger) || offset < 0 || length < 0 || offset > bytes.length - length)
    throw new Error('The NR library contains a truncated resource or tensor.');
}
function slice(bytes, offset, length) {
  checkedRange(bytes, offset, length);
  return bytes.read ? bytes.read(offset, length) : bytes.subarray(offset, offset + length);
}
const u16 = (bytes, at) => slice(bytes, at, 2).readUInt16LE();
const u32 = (bytes, at) => slice(bytes, at, 4).readUInt32LE();
function u64(bytes, at) { const value = Number(slice(bytes, at, 8).readBigUInt64LE());if (!Number.isSafeInteger(value)) throw new Error('The NR resource exceeds its size limit.');return value; }
function peResources(bytes) {
  if (slice(bytes, 0, 2).toString() !== 'MZ') throw new Error('Choose an original NR PE library.');
  const pe = u32(bytes, 0x3c), coff = pe + 4, optional = coff + 20;
  if (slice(bytes, pe, 4).toString() !== 'PE\0\0' || u16(bytes, optional) !== 0x20b || u16(bytes, coff + 16) < 136)
    throw new Error('The NR resource requires a PE32+ library.');
  const sectionCount = u16(bytes, coff + 2), sections = [], sectionStart = optional + u16(bytes, coff + 16);
  if (sectionCount > 96) throw new Error('The NR PE section table is invalid.');
  for (let i = 0; i < sectionCount; i++) { const at = sectionStart + i * 40;slice(bytes, at, 40);sections.push({virtual: u32(bytes, at + 12), span: Math.max(u32(bytes, at + 8), u32(bytes, at + 16)), size: u32(bytes, at + 16), offset: u32(bytes, at + 20)}); }
  const rva = (address, size) => {
    const matches = sections.filter(row => address >= row.virtual && address - row.virtual <= row.span && address - row.virtual <= row.size - size);
    if (matches.length !== 1) throw new Error('The NR resource address is outside one file-backed PE section.');
    const offset = matches[0].offset + address - matches[0].virtual;checkedRange(bytes, offset, size);return offset;
  };
  const resourceSize = u32(bytes, optional + 132), base = rva(u32(bytes, optional + 128), resourceSize);
  const resource = (offset, size) => { if (offset < 0 || size < 0 || offset > resourceSize - size) throw new Error('The NR resource directory is incomplete.');checkedRange(bytes, base + offset, size);return base + offset; };
  const entries = offset => { const at = resource(offset, 16), count = u16(bytes, at + 12) + u16(bytes, at + 14);if (count > 4096) throw new Error('The NR resource directory has too many entries.');const start = resource(offset + 16, count * 8);return Array.from({length: count}, (_, i) => [u32(bytes, start + i * 8), u32(bytes, start + i * 8 + 4)]); };
  const name = value => { if (!(value & 0x80000000)) return null;const at = value & 0x7fffffff, length = u16(bytes, resource(at, 2));if (length > 4096) throw new Error('The NR resource name is too long.');return slice(bytes, resource(at + 2, length * 2), length * 2).toString('utf16le'); };
  const type = entries(0).find(([id]) => !(id & 0x80000000) && (id & 0xffff) === 10);
  if (!type || !(type[1] & 0x80000000)) throw new Error('The NR library has no weight resource directory.');
  const result = new Map();
  for (const [id, target] of entries(type[1] & 0x7fffffff)) {
    const label = name(id);if (!RESOURCES.includes(label)) continue;
    if (!(target & 0x80000000) || result.has(label)) throw new Error('The NR library contains ambiguous weight resources.');
    const languages = entries(target & 0x7fffffff);
    if (languages.length !== 1 || languages[0][1] & 0x80000000) throw new Error('The NR weight resource has an ambiguous language.');
    const at = resource(languages[0][1], 16), size = u32(bytes, at + 4);
    result.set(label, {offset: rva(u32(bytes, at), size), size});
  }
  if (!result.size) throw new Error('Choose an NR library containing WEIGHTS_HT or WEIGHTS_CC_SMALL_FP8.');
  return result;
}
function parseWeightMap(bytes) {
  if (u64(bytes, 0) !== bytes.length) throw new Error('The NR serialized weight resource size is invalid.');
  const result = new Map();let at = 8;
  while (at < bytes.length) {
    const length = u64(bytes, at);at += 8;
    if (!length || length > 4096 || result.size >= 2048) throw new Error('The NR serialized tensor table exceeds its limit.');
    const name = new TextDecoder('utf-8', {fatal: true}).decode(slice(bytes, at, length));at += length;
    if (!/^block\d+\.layer\d+\.(layer|blend_scale)$/.test(name) || result.has(name)) throw new Error('The NR resource contains an unsupported or duplicate tensor.');
    const outer = u64(bytes, at);at += 8;const end = at + outer;
    if (outer < 40 || u64(bytes, at) !== outer) throw new Error('The NR serialized tensor record is invalid.');
    slice(bytes, at, outer);const count = u64(bytes, at + 8), dtype = u32(bytes, at + 16);at += 20;
    if (dtype !== 1 || count > end - at - 16) throw new Error('The NR serialized tensor precision or length is invalid.');
    const payload = slice(bytes, at, count);at += count;
    const dimensions = u64(bytes, at + 8);if (!dimensions || dimensions > 16 || end - at - 16 !== dimensions * 4) throw new Error('The NR serialized tensor dimensions are invalid.');
    let elements = 1;for (let i = 0; i < dimensions; i++) { const size = u32(bytes, at + 16 + i * 4);if (!size) throw new Error('The NR tensor has an empty dimension.');elements *= size; }
    if (elements * 2 !== count) throw new Error('The NR serialized tensor byte count differs from its dimensions.');
    result.set(name, payload);at = end;
  }
  if (at !== bytes.length || !result.size) throw new Error('The NR tensor resource is incomplete.');
  return result;
}
function packedTopology(values) {
  const layers = new Map();
  for (const [name, bytes] of values) { const match = /^block(\d+)\.layer(\d+)\.layer$/.exec(name);if (!match) continue;const block = +match[1], layer = +match[2];if (block > 255) throw new Error('The NR block index exceeds its limit.');if (!layers.has(block)) layers.set(block, new Map());layers.get(block).set(layer, bytes.length); }
  const count = Math.max(...layers.keys()) + 1;
  return NR.infer(Array.from({length: count}, (_, block) => {
    const sizes = layers.get(block), first = sizes?.get(0);if (!sizes) return null;
    if (first === 512 * 512 * 2 && [0, 1, 2, 3].every(i => sizes.has(i))) return {family: sizes.has(4) ? 'split_transition' : 'split', channels: 512};
    if (first === 1024 * 4096 + 16 && sizes.size === 5) return {family: 'global', channels: 1024};
    if (first === 1024 * 512 + 1024 && sizes.size === 1) return {family: 'bridge', channels: 1024};
    if (sizes.size !== 1) return null;
    if (first === 0x54c0 && block === 0) return {family: 'pre', channels: 32};
    if (first === 0x5530) return {family: 'post', channels: 32};
    for (const [channels, amounts] of Object.entries(STANDARD)) { const i = amounts.indexOf(first);if (i >= 0) return {family: ['window', 'downsample', 'upsample'][i], channels: +channels}; }
    return null;
  }));
}
const FRAGMENT = [0, 1, 4, 5, 8, 9, 12, 13, 2, 3, 6, 7, 10, 11, 14, 15];
// E4M3 values are exactly representable as binary16, including subnormals.
const FP8 = Array.from({length: 256}, (_, value) => {
  const sign = (value & 128) << 8, exponent = value >> 3 & 15, mantissa = value & 7;
  if (exponent === 15 && mantissa === 7) return null;
  if (exponent) return sign | (exponent + 8) << 10 | mantissa << 7;
  if (!mantissa) return sign;
  const power = Math.floor(Math.log2(mantissa));return sign | (power + 6) << 10 | (mantissa - 2 ** power) * 2 ** (10 - power);
});
function matrix(raw, offset, input, output, order = 'k-major') {
  const source = slice(raw, offset, input * output), result = Buffer.alloc(input * output * 2), nk = input / 32, nn = output / 32;
  if (!Number.isInteger(nk) || !Number.isInteger(nn) || order === 'n128-major' && nn % 4) throw new Error('The NR matrix tile dimensions are invalid.');
  for (let k = 0; k < nk; k++) for (let n = 0; n < nn; n++) {
    const tile = order === 'n128-major' ? (Math.floor(n / 4) * nk + k) * 4 + n % 4 : k * nn + n;
    for (let i = 0; i < 1024; i++) {
      const element = i % 8, fragment = Math.floor(i / 8) % 2, lane = Math.floor(i / 16) % 32, group = Math.floor(i / 512);
      const physicalK = lane % 4 * 4 + (element & 3) + (element >= 4 ? 16 : 0), physicalN = (group * 2 + fragment) * 8 + Math.floor(lane / 4);
      const logicalK = k * 32 + Math.floor(physicalK / 16) * 16 + FRAGMENT.indexOf(physicalK % 16), bits = FP8[source[tile * 1024 + i]];
      if (bits == null) throw new Error('The NR matrix contains a nonfinite E4M3 parameter.');
      result.writeUInt16LE(bits, (logicalK * output + n * 32 + physicalN) * 2);
    }
  }
  return result;
}
function hmma(raw) {
  if (raw.length % 512) throw new Error('The NR HMMA matrix length is invalid.');
  const output = raw.length / 32, result = Buffer.alloc(raw.length);
  for (let tile = 0; tile < output / 16; tile++) for (let i = 0; i < 256; i++) {
    const element = i % 8, lane = Math.floor(i / 8), e = element % 4;
    const k = lane % 4 * 2 + (e & 1) + (e >= 2 ? 8 : 0), n = Math.floor(lane / 4) + (element >= 4 ? 8 : 0);
    result.writeUInt16LE(raw.readUInt16LE((tile * 256 + i) * 2), (k * output + tile * 16 + n) * 2);
  }return result;
}
function attentionBias(raw, heads) {
  const result = Buffer.alloc(raw.length), permutation = [];
  for (const y of [0, 4]) for (const x of [0, 4]) for (let yy = y; yy < y + 4; yy++) for (let xx = x; xx < x + 4; xx++) permutation.push(yy * 8 + xx);
  for (let h = 0; h < heads; h++) for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) for (let lane = 0; lane < 32; lane++) for (let e = 0; e < 8; e++) {
    const row = Math.floor(lane / 4) + (e % 4 >= 2 ? 8 : 0), column = Math.floor(e / 4) * 8 + lane % 4 * 2 + (e & 1);
    result.writeUInt16LE(raw.readUInt16LE(((((h * 4 + ty) * 4 + tx) * 32 + lane) * 8 + e) * 2), ((h * 64 + permutation[ty * 16 + row]) * 64 + permutation[tx * 16 + column]) * 2);
  }return result;
}
function qkv(raw, channels, heads) {
  const result = Buffer.alloc(raw.length), perHead = channels / heads;
  for (let k = 0; k < channels; k++) for (let h = 0; h < heads; h++) for (let q = 0; q < 3; q++)
    slice(raw, (k * channels * 3 + (h * 3 + q) * perHead) * 2, perHead * 2).copy(result, (k * channels * 3 + q * channels + h * perHead) * 2);
  return result;
}
function zero(raw, start, end) { if (slice(raw, start, end - start).some(value => value !== 0)) throw new Error('The NR tensor has nonzero alignment or padded channels.'); }
function decodeTensor(name, raw, model) {
  const expected = NR.shapes(model), result = new Map(), match = /^block(\d+)\.layer(\d+)\.(layer|blend_scale)$/.exec(name);
  if (!match) throw new Error('The NR packed tensor name is unsupported.');
  const block = +match[1], layer = +match[2], role = model.blocks[block], prefix = `block${block}.layer${layer}`;
  if (!role) throw new Error('The NR tensor is outside the model topology.');
  const add = (suffix, bytes) => { const key = prefix + '.' + suffix, spec = expected[key];if (!spec || bytes.length !== spec.shape.reduce((a, b) => a * b, spec.dataType === 'float32' ? 4 : 2)) throw new Error('The decoded NR tensor size differs from its graph.');result.set(key, {bytes, ...spec}); };
  const f16 = (suffix, offset, count) => add(suffix, slice(raw, offset, count * 2));
  const f32 = (suffix, offset, count) => add(suffix, slice(raw, offset, count * 4));
  const mat = (suffix, offset, input, output) => add(suffix, matrix(raw, offset, input, output));
  const size = bytes => { if (raw.length !== bytes) throw new Error('The NR packed tensor size differs from its graph.'); };
  const {family, channels: c, heads, hidden} = role;
  if (match[3] === 'blend_scale') { if (block !== model.blocks.length - 1 || layer !== 0) throw new Error('The NR blend scale is outside the output stage.');size(2);f16('blend_scale', 0, 1);return result; }
  if (['pre', 'window', 'downsample', 'upsample', 'post'].includes(family) && layer === 0) {
    const pre = family === 'pre', post = family === 'post', up = family === 'upsample', down = family === 'downsample';
    size(pre ? 0x54c0 : post ? 0x5530 : STANDARD[c][down ? 1 : up ? 2 : 0]);let offset = 0;
    if (c >= 64) {
      const groups = c / 32, columns = 4 * c + 128, grouped = matrix(raw, offset, c, columns, 'n128-major');
      const expand = Buffer.alloc(groups * 4 * groups * 32 * 32 * 2), project = Buffer.alloc(groups * 4 * 32 * 32 * 2);
      for (let out = 0; out < groups; out++) for (let branch = 0; branch < 4; branch++) {
        for (let input = 0; input < groups; input++) for (let k = 0; k < 32; k++) slice(grouped, ((input * 32 + k) * columns + (out * 4 + branch) * 32) * 2, 64).copy(expand, ((((out * 4 + branch) * groups + input) * 32 + k) * 32) * 2);
        for (let k = 0; k < 32; k++) slice(grouped, ((out * 32 + k) * columns + (4 * groups + branch) * 32) * 2, 64).copy(project, (((out * 4 + branch) * 32 + k) * 32) * 2);
      }
      add('ffn_expand_weight', expand);add('ffn_branch_projection_weight', project);offset += c * columns;mat('ffn_output_projection_weight', offset, c, c);offset += c * c;
    } else { mat('weight1', offset, c, hidden);offset += c * hidden;mat('weight2', offset, hidden, c);offset += hidden * c; }
    if (up) { mat('weight0', offset, 2 * c, c);offset += 2 * c * c; }
    if (!up || c === 32) { zero(raw, offset, offset + 16);offset += 16; }
    if (pre) { add('input_adapter_weight', hmma(slice(raw, offset, 16 * c * 2)));offset += 16 * c * 2; }
    f16('ffn_cos_skip', offset, c);offset += c * 2;
    if (pre) { zero(raw, offset, offset + 16);offset += 16; }
    else if (up) { if (c === 32) { zero(raw, offset, offset + 16);offset += 16; }f16('sin', offset, c);offset += c * 2; }
    else if (post) { f16('inp_merge_sin', offset, c);f16('inp_merge_cos', offset + c * 2, c);offset += c * 4; }
    else { zero(raw, offset, offset + 16);offset += 16; }
    const weight = matrix(raw, offset, c, c * 3);add('qkv_weight', c >= 64 ? qkv(weight, c, heads) : weight);offset += 3 * c * c;
    const bias = slice(raw, offset, heads * 64 * 64 * 2);add('attn_bias', c >= 64 ? attentionBias(bias, heads) : bias);offset += bias.length;
    f32('attn_scale', offset, heads);offset += heads * 4;const aligned = Math.ceil(offset / 16) * 16;zero(raw, offset, aligned);offset = aligned;
    mat('projection_weight', offset, c, c);offset += c * c;f16('attn_cos_skip', offset, c);offset += c * 2;
    if (down) { mat('weight0', offset, c, 2 * c);offset += 2 * c * c;zero(raw, offset, raw.length);offset = raw.length; }
    else if (post) { zero(raw, offset, offset + 16);offset += 16;for (const suffix of ['out_gain', 'out_conv_weight']) { const padded = hmma(slice(raw, offset, 512)), output = Buffer.alloc(128);for (let k = 0; k < 16; k++) { zero(padded, (k * 16 + 4) * 2, (k + 1) * 32);slice(padded, k * 32, 8).copy(output, k * 8); }add(suffix, output);offset += 512; } }
    else { zero(raw, offset, offset + 16);offset += 16; }
    if (offset !== raw.length) throw new Error('The NR tensor has unconsumed payload bytes.');
  } else if (family === 'split' || family === 'split_transition') {
    if (layer === 0) { size(512 * 512 * 2);mat('first_projection_weight', 0, 512, 512);for (const [suffix, base, input, output] of [['group_expand_weight', 512 * 512, 64, 256], ['group_project_weight', 512 * 512 + 8 * 64 * 256, 256, 64]]) add(suffix, Buffer.concat(Array.from({length: 8}, (_, i) => matrix(raw, base + i * input * output, input, output)))); }
    else if (layer === 1) { size(512 * 512 + 1024);mat('weight3', 0, 512, 512);f16('ffn_cos_skip', 512 * 512, 512); }
    else if (layer === 2) { size(512 * 1536 + 16 * 64 * 64 * 2 + 64);add('qkv_weight', qkv(matrix(raw, 0, 512, 1536), 512, 16));f16('attn_bias', 512 * 1536, 16 * 64 * 64);f32('attn_scale', 512 * 1536 + 16 * 64 * 64 * 2, 16); }
    else if (layer === 3) { size(512 * 512 + 1024);mat('projection_weight', 0, 512, 512);f16('attn_cos_skip', 512 * 512, 512); }
    else if (layer === 4 && family === 'split_transition') { size(512 * 1024 + 16);zero(raw, 512 * 1024, raw.length);mat('weight', 0, 512, 1024); }
  } else if (family === 'global') {
    if (layer === 0) { size(1024 * 4096 + 16);zero(raw, 1024 * 4096, raw.length);mat('weight', 0, 1024, 4096); }
    else if (layer === 1) { size(4096 * 1024 + 2048);mat('weight', 0, 4096, 1024);f16('ffn_cos_skip', 4096 * 1024, 1024); }
    else if (layer === 2) { size(128 + 1024 * 3072);f32('attn_scale', 0, 32);add('qkv_weight', qkv(matrix(raw, 128, 1024, 3072), 1024, 32)); }
    else if (layer === 3) { size(2);f16('attention_scalar', 0, 1); }
    else if (layer === 4) { size(1024 * 1024 + 2048);mat('projection_weight', 0, 1024, 1024);f16('attn_cos_skip', 1024 * 1024, 1024); }
  } else if (family === 'bridge' && layer === 0) { size(1024 * 512 + 1024);mat('conv_weight', 0, 1024, 512);f16('inp_upsample_sin', 1024 * 512, 512); }
  if (!result.size) throw new Error('The NR resource contains an unsupported packed tensor family.');
  return result;
}
function inspect(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > MAXIMUM) throw new Error('Choose an original NR model library.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = {length: stat.size, read(offset, length) {
      if (length > 32768) throw new Error('The NR metadata record exceeds its size limit.');
      const result = Buffer.alloc(length);if (fs.readSync(fd, result, 0, length, offset) !== length) throw new Error('The NR metadata is incomplete.');return result;
    }};
    const resources = peResources(bytes);
    if (!unchanged(stat, fs.fstatSync(fd))) throw new Error('The NR library changed during inspection.');
    return {file: fs.realpathSync(file), stat, architecture: NR.ARCHITECTURE, operation: 'mlx-dlss',
      resources: RESOURCES.filter(name => resources.has(name)), adapter: 'nvidia-nr-resource-v18'};
  } finally { fs.closeSync(fd); }
}
async function convert(source, directory, {signal} = {}) {
  signal?.throwIfAborted();const fd = await fs.promises.open(source.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);let bytes;
  try { if (!unchanged(source.stat, await fd.stat())) throw new Error('The NR library changed before conversion.');bytes = await fd.readFile();if (!unchanged(source.stat, await fd.stat())) throw new Error('The NR library changed during conversion.'); } finally { await fd.close(); }
  const resources = peResources(bytes), sourceHash = digest(bytes), outputs = [];
  for (const resource of RESOURCES.filter(name => resources.has(name))) {
    const entry = resources.get(resource), payload = slice(bytes, entry.offset, entry.size), packed = parseWeightMap(payload), model = packedTopology(packed), decoded = new Map();
    for (const [name, raw] of packed) { signal?.throwIfAborted();for (const [key, row] of decodeTensor(name, raw, model)) { if (decoded.has(key)) throw new Error('The NR resource decodes duplicate tensors.');decoded.set(key, row); }await yieldTurn(); }
    NR.logicalTopology([...decoded.values()]);
    const header = {}, parts = [];let at = 0;
    for (const [name, row] of [...decoded].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      const stride = row.dataType === 'float32' ? 4 : 2;
      for (let i = 0; i < row.bytes.length; i += stride) if (stride === 4 ? !Number.isFinite(row.bytes.readFloatLE(i)) : (row.bytes.readUInt16LE(i) & 0x7c00) === 0x7c00) throw new Error('The NR model contains nonfinite logical parameters.');
      header[name] = {dtype: stride === 4 ? 'F32' : 'F16', shape: row.shape, data_offsets: [at, at + row.bytes.length]};parts.push(row.bytes);at += row.bytes.length;
    }
    header.__metadata__ = {format: 'dlssnr-logical-v18', topology: model.spec, source_sha256: sourceHash, resource_sha256: digest(payload), source_resource: resource,
      fully_logical: 'true', opaque_output_tensor_count: '0', unsupported_source_tensors: '[]', matrix_contract: 'K-by-N; output = input @ weight'};
    const json = Buffer.from(JSON.stringify(header)), length = Buffer.alloc(8);length.writeBigUInt64LE(BigInt(json.length));
    const output = Buffer.concat([length, json, ...parts]), file = path.join(directory, model.name + '-logical.safetensors');
    signal?.throwIfAborted();await fs.promises.writeFile(file, output, {flag: 'wx'});
    outputs.push({file, name: model.name, topology: model.spec, architecture: NR.ARCHITECTURE, operation: 'mlx-dlss', sha256: digest(output),
      sourceFiles: [{file: path.basename(source.file), sha256: sourceHash, resource, resourceSHA256: digest(payload), adapter: source.adapter,
        extractorRepository: 'https://github.com/iamwavecut/MLX-DLSS', extractorCommit: '7870371e8bf6c03967213f1a5d40db6c5a3bee38'}]});
  }
  if (!unchanged(source.stat, await fs.promises.lstat(source.file))) throw new Error('The NR library changed during conversion.');
  return outputs;
}
module.exports = {inspect, convert, peResources, parseWeightMap, packedTopology, decodeTensor, matrix, hmma, attentionBias};
