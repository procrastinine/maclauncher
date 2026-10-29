// Topology and tensor contracts derived from MLX-DLSS (Apache-2.0),
// commit 7870371e8bf6c03967213f1a5d40db6c5a3bee38.
const ARCHITECTURE = 'mlxdlss.neural-rendering-transformer.v1';
const CHANNELS = [32, 64, 128, 256];
const HEADS = {32: 1, 64: 2, 128: 4, 256: 8, 512: 16, 1024: 32};
const HIDDEN = {32: 128, 64: 224, 128: 384, 256: 704, 512: 512, 1024: 4096};
function topology(depths, globalBlocks = 8) {
  if (!Array.isArray(depths) || depths.length !== 5 || !depths.every(n => Number.isInteger(n) && n > 0) ||
      !Number.isInteger(globalBlocks) || globalBlocks < 1 || 3 + globalBlocks + 2 * depths.reduce((a, b) => a + b, 0) > 256)
    throw new Error('The neural rendering stage topology is invalid.');
  const blocks = [], add = (family, channels) => blocks.push({family, channels, heads: HEADS[channels], hidden: HIDDEN[channels]});
  add('pre', 32);
  CHANNELS.forEach((channels, stage) => { for (let i = 0; i < depths[stage]; i++) add(i === depths[stage] - 1 ? 'downsample' : 'window', channels); });
  for (let i = 0; i < depths[4]; i++) add(i === depths[4] - 1 ? 'split_transition' : 'split', 512);
  for (let i = 0; i < globalBlocks; i++) add('global', 1024);
  add('bridge', 1024);
  for (let i = 0; i < depths[4]; i++) add('split', 512);
  for (let stage = 3; stage >= 0; stage--) for (let i = 0; i < depths[stage]; i++) add(i === 0 ? 'upsample' : 'window', CHANNELS[stage]);
  add('post', 32);
  return {depths, globalBlocks, blocks, spec: depths.join(',') + (globalBlocks === 8 ? '' : '/' + globalBlocks),
    name: globalBlocks === 8 && depths.join(',') === '4,4,6,8,8' ? 'ht' : globalBlocks === 8 && depths.every(n => n === 2) ? 'small' : 'custom'};
}
function infer(families) {
  let at = 0;
  const take = (family, channels) => { const start = at;while (families[at]?.family === family && families[at]?.channels === channels) at++;return at - start; };
  if (take('pre', 32) !== 1) throw new Error('The neural rendering weights have no complete input stage.');
  const depths = CHANNELS.map(channels => { const count = take('window', channels);if (take('downsample', channels) !== 1) throw new Error('The neural rendering encoder stages are incomplete.');return count + 1; });
  const split = take('split', 512);if (take('split_transition', 512) !== 1) throw new Error('The neural rendering split stage is incomplete.');
  depths.push(split + 1);
  const globals = take('global', 1024), result = topology(depths, globals);
  if (result.blocks.length !== families.length || result.blocks.some((row, i) => row.family !== families[i]?.family || row.channels !== families[i]?.channels))
    throw new Error('The neural rendering decoder does not mirror its encoder.');
  return result;
}
function shapes(model) {
  const result = {}, add = (name, shape, dataType = 'float16') => { result[name] = {name, shape, dataType}; };
  model.blocks.forEach(({family, channels: c, heads}, block) => {
    const prefix = `block${block}.layer`, f = (layer, name, shape, type) => add(prefix + layer + '.' + name, shape, type);
    if (['pre', 'window', 'downsample', 'upsample', 'post'].includes(family)) {
      if (c >= 64) { const groups = c / 32;f(0, 'ffn_expand_weight', [groups, 4, groups, 32, 32]);f(0, 'ffn_branch_projection_weight', [groups, 4, 32, 32]);f(0, 'ffn_output_projection_weight', [c, c]); }
      else { f(0, 'weight1', [c, HIDDEN[c]]);f(0, 'weight2', [HIDDEN[c], c]); }
      f(0, 'ffn_cos_skip', [c]);f(0, 'qkv_weight', [c, 3 * c]);f(0, 'attn_bias', [heads, 64, 64]);
      f(0, 'attn_scale', [heads], 'float32');f(0, 'projection_weight', [c, c]);f(0, 'attn_cos_skip', [c]);
      if (family === 'pre') f(0, 'input_adapter_weight', [16, c]);
      if (family === 'downsample') f(0, 'weight0', [c, 2 * c]);
      if (family === 'upsample') { f(0, 'weight0', [2 * c, c]);f(0, 'sin', [c]); }
      if (family === 'post') { f(0, 'inp_merge_sin', [c]);f(0, 'inp_merge_cos', [c]);f(0, 'out_gain', [16, 4]);f(0, 'out_conv_weight', [16, 4]);f(0, 'blend_scale', [1]); }
    } else if (family === 'split' || family === 'split_transition') {
      f(0, 'first_projection_weight', [512, 512]);f(0, 'group_expand_weight', [8, 64, 256]);f(0, 'group_project_weight', [8, 256, 64]);
      f(1, 'weight3', [512, 512]);f(1, 'ffn_cos_skip', [512]);f(2, 'qkv_weight', [512, 1536]);f(2, 'attn_bias', [16, 64, 64]);f(2, 'attn_scale', [16], 'float32');
      f(3, 'projection_weight', [512, 512]);f(3, 'attn_cos_skip', [512]);if (family === 'split_transition') f(4, 'weight', [512, 1024]);
    } else if (family === 'global') {
      f(0, 'weight', [1024, 4096]);f(1, 'weight', [4096, 1024]);f(1, 'ffn_cos_skip', [1024]);
      f(2, 'attn_scale', [32], 'float32');f(2, 'qkv_weight', [1024, 3072]);f(3, 'attention_scalar', [1]);f(4, 'projection_weight', [1024, 1024]);f(4, 'attn_cos_skip', [1024]);
    } else if (family === 'bridge') { f(0, 'conv_weight', [1024, 512]);f(0, 'inp_upsample_sin', [512]); }
  });
  return result;
}
function logicalTopology(values) {
  const entries = new Map(values.map(row => [row.name, row])), indices = values.map(row => /^block(\d+)\./.exec(row.name)).filter(Boolean).map(row => Number(row[1]));
  if (!indices.length || Math.max(...indices) > 255) throw new Error('The neural rendering tensor names are invalid.');
  const families = Array.from({length: Math.max(...indices) + 1}, (_, block) => {
    const get = name => entries.get(`block${block}.layer0.${name}`)?.shape;
    if (get('first_projection_weight')) return {family: entries.has(`block${block}.layer4.weight`) ? 'split_transition' : 'split', channels: 512};
    if (JSON.stringify(get('weight')) === '[1024,4096]') return {family: 'global', channels: 1024};
    if (get('conv_weight')) return {family: 'bridge', channels: 1024};
    const c = get('qkv_weight')?.[0];
    return {channels: c, family: get('input_adapter_weight') ? 'pre' : get('inp_merge_sin') ? 'post' : get('sin') ? 'upsample' : JSON.stringify(get('weight0')) === JSON.stringify([c, 2 * c]) ? 'downsample' : 'window'};
  });
  const model = infer(families), expected = shapes(model);
  if (entries.size !== values.length || entries.size !== Object.keys(expected).length || Object.entries(expected).some(([name, spec]) =>
      entries.get(name)?.dataType !== spec.dataType || JSON.stringify(entries.get(name)?.shape) !== JSON.stringify(spec.shape)))
    throw new Error('The neural rendering tensor names, shapes or precision do not match its complete topology.');
  return model;
}
function matches(values) { try { logicalTopology(values);return true; } catch { return false; } }
function contract(value) {
  const tensor = (rows, channels) => Array.isArray(rows) && rows.length === 1 && rows[0]?.name === 'color' &&
    rows[0].dataType === 'float32' && rows[0].layout === 'nhwc' && JSON.stringify(rows[0].shape) === JSON.stringify([1, 'height', 'width', channels]);
  return tensor(value.inputs, 16) && tensor(value.outputs, 4);
}
module.exports = {ARCHITECTURE, topology, infer, shapes, logicalTopology, matches, contract};
