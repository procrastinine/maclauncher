// Copyright (c) MacLauncher contributors. MIT license.
// Depth Anything V2 Small: original Apache-2.0 model and graph. The result is
// inferred relative inverse depth, never renderer depth or physical distance.
const ARCHITECTURE = 'depth-anything-v2.vits.relative.v1';
const METHOD = 'depth-anything-v2-small';
function shapes() {
  const result = {}, pair = (name, shape) => {
    result[name + '.weight'] = shape;
    result[name + '.bias'] = [shape[0]];
  };
  result['backbone.embeddings.cls_token'] = [1, 1, 384];
  result['backbone.embeddings.mask_token'] = [1, 384];
  pair('backbone.embeddings.patch_embeddings.projection', [384, 3, 14, 14]);
  result['backbone.embeddings.position_embeddings'] = [1, 1370, 384];
  for (let index = 0; index < 12; index++) {
    const prefix = `backbone.encoder.layer.${index}`;
    for (const name of ['query', 'key', 'value']) pair(prefix + '.attention.attention.' + name, [384, 384]);
    pair(prefix + '.attention.output.dense', [384, 384]);
    for (const name of ['layer_scale1', 'layer_scale2']) result[prefix + '.' + name + '.lambda1'] = [384];
    pair(prefix + '.mlp.fc1', [1536, 384]);pair(prefix + '.mlp.fc2', [384, 1536]);
    pair(prefix + '.norm1', [384]);pair(prefix + '.norm2', [384]);
  }
  pair('backbone.layernorm', [384]);
  for (const [index, channels] of [48, 96, 192, 384].entries()) {
    const prefix = `neck.reassemble_stage.layers.${index}`;
    pair(prefix + '.projection', [channels, 384, 1, 1]);
    if (index !== 2) pair(prefix + '.resize', [channels, channels, index === 0 ? 4 : index === 1 ? 2 : 3, index === 0 ? 4 : index === 1 ? 2 : 3]);
    result[`neck.convs.${index}.weight`] = [64, channels, 3, 3];
    const fusion = `neck.fusion_stage.layers.${index}`;
    pair(fusion + '.projection', [64, 64, 1, 1]);
    for (const residual of [1, 2]) for (const convolution of [1, 2])
      pair(fusion + `.residual_layer${residual}.convolution${convolution}`, [64, 64, 3, 3]);
  }
  pair('head.conv1', [32, 64, 3, 3]);pair('head.conv2', [32, 32, 3, 3]);pair('head.conv3', [1, 32, 1, 1]);
  return result;
}
const SHAPES = Object.freeze(shapes());
function matches(architecture, tensors) {
  if (architecture !== ARCHITECTURE || !Array.isArray(tensors) || tensors.length !== Object.keys(SHAPES).length) return false;
  const entries = new Map(tensors.map(row => [row.name, row]));
  return entries.size === tensors.length && Object.entries(SHAPES).every(([name, shape]) => {
    const row = entries.get(name);
    return row && ['float16', 'float32'].includes(row.dataType) && JSON.stringify(row.shape) === JSON.stringify(shape);
  });
}
function contract(manifest) {
  const input = manifest?.inputs?.[0], output = manifest?.outputs?.[0];
  const tensor = (value, name, channels) => value?.name === name && value.dataType === 'float32' && value.layout === 'nhwc' &&
    JSON.stringify(value.shape) === JSON.stringify([1, 'height', 'width', channels]);
  return manifest?.architecture === ARCHITECTURE && manifest.inputs?.length === 1 && manifest.outputs?.length === 1 &&
    tensor(input, 'color', 3) && tensor(output, 'relativeInverseDepth', 1) && manifest.state?.kind === 'stateless';
}
module.exports = {ARCHITECTURE, METHOD, SHAPES, shapes, matches, contract};
