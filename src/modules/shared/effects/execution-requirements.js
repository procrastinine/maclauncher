const Plan = require("./plan.mjs");
const Providers = require("./providers");

// Pure settings analysis: no filesystem, provider discovery, model inspection,
// shader parsing or GPU work belongs in this calculation. Only the saved plan
// is read, row by row: an invalid row is left out (Plan.salvage), and only an
// unreadable plan envelope runs nothing.
function analyze(entry = {}, { sourceSupport, diagnostics = false, activation = false } = {}) {
  const plan = Plan.salvage(entry.effects).plan || null;
  const rows = plan && plan.enabled !== false ? plan.video.filter(row => row.enabled) : [];
  const selected = kind => rows.filter(row => row.kind === kind).map(row => row.method);
  const methods = { spatial: rows.filter(row => Plan.isResize(row) && !Providers.neural(row)).map(row => row.method), temporal: selected("temporal"),
    neural: rows.filter(row => Providers.neural(row)).map(row => row.method), generation: selected("frame-generation") };
  const shaders = rows.filter(row => row.kind === "shader").map(row => row.shader);
  const source = plan && plan.enabled !== false && (plan.renderResolution || (rows.some(row=>row.kind==="downsample"&&row.extent?.automatic===true)?{automatic:true}:null)) || null;
  const sourceChange = Boolean(source && (source.height !== undefined || source.multiplier !== 1));
  const needed = { activation: activation === true, shaders: shaders.length > 0, spatial: methods.spatial.length > 0, temporal: methods.temporal.length > 0,
    neural: methods.neural.length > 0 || rows.some(row=>row.kind==="shader"&&row.settings!==undefined), generation: methods.generation.length > 0, sourceResolution: sourceChange,
    virtualWindow: sourceChange && sourceSupport?.control === "virtual",
    losslessModel: methods.spatial.includes("ls1") || methods.generation.includes("lsfg"),
    fsr: methods.temporal.some(method => ["fsr2", "fsr3"].includes(method)), fsr4: methods.temporal.includes("fsr4"),
    comparison: Boolean(plan && plan.enabled !== false && plan.output?.comparison?.mode && plan.output.comparison.mode !== "off"),
    outputColor: Boolean(plan && plan.enabled !== false && plan.output?.toneMapping && plan.output.toneMapping !== "auto"),
    motionClarity: Boolean(plan && plan.enabled !== false && ["bfi","beam"].includes(plan.output?.motionClarity)), diagnostics: diagnostics === true };
  needed.processor = needed.shaders || needed.spatial || needed.temporal || needed.neural || needed.generation || needed.sourceResolution || needed.motionClarity || needed.comparison || needed.outputColor || needed.diagnostics;
  needed.ordered = Boolean(plan && needed.processor);
  needed.presentation = needed.ordered || needed.spatial || needed.temporal || needed.neural || needed.generation || needed.virtualWindow || needed.motionClarity || needed.comparison;
  const causes = { activation: "Dormant controls are needed for supported live changes", shaders: "Enabled shader rows", spatial: "Selected spatial filters; equal-size automatic stages bypass at frame time",
    temporal: "Selected temporal filters and their scene inputs", neural: "Enabled neural model inputs", generation: "Enabled frame generation",
    sourceResolution: "A requested source size differs from the original allocation", virtualWindow: "Source sizing requires virtual presentation",
    losslessModel: "LS1 or LSFG is selected", fsr: "FSR 2 or FSR 3 is selected", fsr4: "FSR 4 is selected",
    comparison: "Selected image comparison", outputColor: "Selected output tone mapping", motionClarity: "Selected display subframes", diagnostics: "Explicit graphics diagnostics", processor: "At least one graphics component is needed",
    ordered: "An active ordered plan", presentation: "Processed output needs independent presentation" };
  return { mode: needed.processor ? "processing" : needed.activation ? "activation" : "none", needed, methods, shaders, source,
    components: Object.entries(needed).map(([id, required]) => ({id, needed: required, reason: required ? causes[id] : null})) };
}

module.exports = { analyze };
