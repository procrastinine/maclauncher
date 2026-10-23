const Plan = require("./plan.mjs");

// Pure settings analysis: no filesystem, provider discovery, model inspection,
// shader parsing or GPU work belongs in this calculation.
function analyze(entry = {}, { sourceSupport, diagnostics = false, activation = false } = {}) {
  const plan = entry.effects == null ? null : Plan.normalize(entry.effects), graphics = entry.graphics || {};
  const rows = plan ? plan.video.filter(row => row.enabled) : [];
  const selected = (kind, key) => plan ? rows.filter(row => row.kind === kind).map(row => row.method) :
    typeof graphics[key] === "string" && graphics[key] !== "off" ? [graphics[key]] : [];
  const methods = { spatial: selected("spatial", "spatialMethod"), temporal: selected("temporal", "temporalMethod"),
    neural: selected("neural", "neuralMethod"), generation: selected("frame-generation", "frameGeneration") };
  const spatialShader = !plan && graphics.spatialShader?.enabled === true;
  const shaders = plan ? rows.filter(row => row.kind === "shader").map(row => row.shader) :
    [...(entry.reshade?.enabled === true ? [entry.reshade] : []), ...(spatialShader ? [graphics.spatialShader] : [])];
  const source = plan ? plan.renderResolution || null : (methods.spatial.length || spatialShader) && graphics.spatialMultiplier != null ? {multiplier: graphics.spatialMultiplier} : null;
  const sourceChange = Boolean(source && (source.height !== undefined || source.multiplier !== 1));
  const needed = { activation: activation === true, shaders: shaders.length > 0, spatial: methods.spatial.length > 0, temporal: methods.temporal.length > 0,
    neural: methods.neural.length > 0, generation: methods.generation.length > 0, sourceResolution: sourceChange,
    virtualWindow: sourceChange && sourceSupport?.control === "virtual",
    losslessModel: methods.spatial.includes("ls1") || methods.generation.includes("lsfg"),
    fsr: methods.temporal.some(method => ["fsr2", "fsr3"].includes(method)), fsr4: methods.temporal.includes("fsr4"),
    diagnostics: diagnostics === true };
  needed.processor = needed.shaders || needed.spatial || needed.temporal || needed.neural || needed.generation || needed.sourceResolution || needed.diagnostics;
  needed.ordered = Boolean((plan || spatialShader) && needed.processor);
  needed.presentation = needed.ordered || needed.spatial || needed.temporal || needed.neural || needed.generation || needed.virtualWindow;
  const causes = { activation: "Dormant controls are needed for supported live changes", shaders: "Enabled shader rows", spatial: "Selected spatial filters; equal-size automatic stages bypass at frame time",
    temporal: "Selected temporal filters and their scene inputs", neural: "Enabled neural rendering rows", generation: "Enabled frame generation",
    sourceResolution: "A requested source size differs from the original allocation", virtualWindow: "Source sizing requires virtual presentation",
    losslessModel: "LS1 or LSFG is selected", fsr: "FSR 2 or FSR 3 is selected", fsr4: "FSR 4 is selected",
    diagnostics: "Explicit graphics diagnostics", processor: "At least one graphics component is needed",
    ordered: "An active ordered plan", presentation: "Processed output needs independent presentation" };
  return { mode: needed.processor ? "processing" : needed.activation ? "activation" : "none", needed, methods, shaders, source,
    components: Object.entries(needed).map(([id, required]) => ({id, needed: required, reason: required ? causes[id] : null})) };
}

module.exports = { analyze };
