const MAX_EFFECTS = 4;
const DEFAULT_EFFECTS = Object.freeze(["cas", "crt"]);
const ENTRIES = Object.freeze({
  crt: ["FullscreenVS", "CRT"], grayscale: ["FullscreenVS", "Grayscale"],
  vibrance: ["FullscreenVS", "Colour"], sharpen: ["FullscreenVS", "Sharpen"],
  cas: ["PostProcessVS", "CASPass"]
});
const TECHNIQUE = "MacLauncherChain";

function valid(value) {
  return Array.isArray(value) && value.length >= 2 && value.length <= MAX_EFFECTS &&
    Array.from(value).every(id => typeof id === "string" && Object.hasOwn(ENTRIES, id));
}
function source(effects) {
  if (!valid(effects)) throw new Error("Choose two to four included effects.");
  // Separate namespaces preserve each preset's functions, uniforms and default
  // values, including repeated presets. ReShade's shared header is global.
  const stages = effects.map((id, index) => `namespace MLStage${index} {\n#include "${id}.fx"\n}\n#undef pixel\n#undef tex2Doffset\n`);
  const passes = effects.map((id, index) => {
    const [vertex, pixel] = ENTRIES[id], namespace = `MLStage${index}::`;
    return `pass { VertexShader = ${vertex === "PostProcessVS" ? vertex : namespace + vertex}; PixelShader = ${namespace + pixel}; }`;
  });
  return `// Ordered included effects. Shader notices remain in the included files.\n#include "ReShade.fxh"\n${stages.join("")}technique ${TECHNIQUE} {\n${passes.join("\n")}\n}\n`;
}
module.exports = { MAX_EFFECTS, DEFAULT_EFFECTS, TECHNIQUE, valid, source };
