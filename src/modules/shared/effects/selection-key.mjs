// Source/model metadata belongs to one exact implementation selection. Enabled
// state, parameters and processing size remain independent editable fields.
export function effectSelectionKey(node) {
  return JSON.stringify(node?.kind === 'shader'
    ? [node.kind,node.shader?.preset,node.shader?.effectPath||null,node.shader?.effects||null,node.settings?.modelPath||null]
    : [node?.kind,node?.method,node?.settings?.modelPath||null]);
}
