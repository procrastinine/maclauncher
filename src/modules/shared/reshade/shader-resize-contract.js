// Target allocation and an authored image resize are separate contracts.
// Ordinary comments keep this declaration valid in the original providers.
const directions = Object.freeze(["downsample", "upscale"]);
function scaleDirections(scale) {
  if (typeof scale === "number") scale = {x: scale, y: scale};
  if (!scale || !Number.isFinite(scale.x) || !Number.isFinite(scale.y)) return null;
  if (scale.x <= 1 && scale.y <= 1 && (scale.x < 1 || scale.y < 1)) return ["downsample"];
  if (scale.x >= 1 && scale.y >= 1 && (scale.x > 1 || scale.y > 1)) return ["upscale"];
  return [];
}
function declared(text) {
  let result;
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\/\/\s*@OUTPUT_RESIZE\b/.test(line)) continue;
    const match = /^\s*\/\/\s*@OUTPUT_RESIZE\s+(none|downsample|upscale|both)\s*$/.exec(line);
    if (!match) throw Error("A shader resize declaration must select none, downsample, upscale or both.");
    const value = match[1] === "none" ? [] : match[1] === "both" ? [...directions] : [match[1]];
    if (result && result.join() !== value.join()) throw Error("A shader cannot declare different output resize directions.");
    result = value;
  }
  return result;
}
function forTraits(traits = {}) {
  if(directions.includes(traits.resizeContext))return [traits.resizeContext];
  const fixed = scaleDirections(traits.outputScale);
  if (fixed) return fixed;
  if (traits.preservesSize === true) return [];
  if (Array.isArray(traits.targetResizeDirections)) return directions.filter(value=>traits.targetResizeDirections.includes(value));
  if (Array.isArray(traits.possibleResizeDirections)) return directions.filter(value=>traits.possibleResizeDirections.includes(value));
  if (Array.isArray(traits.resizeDirections)) return directions.filter(value => traits.resizeDirections.includes(value));
  return traits.requestedResize === true || traits.authoredResize === true && traits.geometryKnown === true && traits.requestedOutputExtent === true ? [...directions] : [];
}
function apply(text, traits) {
  const selected = declared(text);
  if(selected?.length&&traits.defaultPreservesSize){const {preservesSize,...rest}=traits;traits=rest;}
  const fixed = scaleDirections(traits.outputScale)||
    (directions.includes(traits.resizeContext)?[traits.resizeContext]:null)||traits.possibleResizeDirections;
  if (selected && (fixed || traits.preservesSize === true) && selected.join() !== (fixed || []).join())
    throw Error("The shader resize declaration conflicts with its authored output size.");
  if (selected?.length && traits.outputExtentEditable === false && !fixed?.length)
    throw Error("The shader has no selectable resize output.");
  const result = {...traits, ...(selected ? {resizeDirections: selected, outputResize:selected.length===2?"both":selected[0]||"none"} : {})};
  return {...result, resizeDirections: forTraits(result)};
}
module.exports = {apply, forTraits};
