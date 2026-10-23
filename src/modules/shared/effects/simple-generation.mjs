// Pure Simple-only composition policy. Work values are pixel/pass estimates,
// not elapsed times. A shipping policy is enabled only after GPU/quality
// qualification; Advanced plans never use this automatic placement contract.
export const SOURCE_POLICY = "source-cost-v1";
export const SCALER_PASSES = Object.freeze({nearest: 1, bilinear: 1, bicubic: 1, metalfx: 1, fsr1: 2, mako: 1});
// The pinned LSFG graph has one shared source-copy/mipmap/alpha/beta phase and
// one gamma/delta/generate/resolve phase per generated output. These count
// dispatch groups, whose pyramid levels and GPU costs differ. They estimate
// relative image work without claiming measured milliseconds or a speedup.
export const GENERATION_PASSES = Object.freeze({sharedFull: 1, sharedFlow: 17, generatedFull: 2, generatedFlow: 20});
const size = value => value && [value.width, value.height].every(number => Number.isInteger(number) && number >= 1 && number <= 16384)
  ? {width: value.width, height: value.height} : null;

export function candidate(nodes = []) {
  const active = nodes.filter(node => node.enabled === true), generations = active.filter(node => node.kind === "frame-generation");
  if (generations.length !== 1 || generations[0].method !== "lsfg") return null;
  const generation = generations[0], position = active.indexOf(generation), scaler = active[position - 1];
  if (!scaler || scaler.kind !== "spatial" || !Object.hasOwn(SCALER_PASSES, scaler.method) || scaler.outputSize ||
      scaler.presentationScale != null || scaler.resolutionAuto === true || scaler.settings?.spatialMultiplier != null) return null;
  // The selected scaler must be the final geometry boundary before generation.
  // Moving a later reconstruction or scene-input stage would change its input
  // semantics; those plans retain their existing explicit order.
  if (active.slice(position + 1).some(node => node.kind !== "shader" || node.requirements?.depth || node.requirements?.motion ||
      node.outputScale || node.outputExtent)) return null;
  return {generationId: generation.id, spatialNodeId: scaler.id, method: scaler.method, scalerPasses: SCALER_PASSES[scaler.method]};
}

export function choose({source, output, multiplier = 2, method, maximumGenerationPixels, flowScale = 1, allowSource = false} = {}) {
  const input = size(source), target = size(output), passes = SCALER_PASSES[method];
  const base = {placement: "output", policy: SOURCE_POLICY, source: input, output: target};
  if (!input || !target || !passes || !Number.isInteger(multiplier) || multiplier < 2 || multiplier > 5 ||
      !Number.isFinite(flowScale) || flowScale < .25 || flowScale > 1 ||
      maximumGenerationPixels !== undefined && (!Number.isSafeInteger(maximumGenerationPixels) || maximumGenerationPixels < 1))
    return {...base, reason: "The generation or scaler input contract is unavailable."};
  const sourcePixels = input.width * input.height, outputPixels = target.width * target.height, generated = multiplier - 1;
  const flowArea = flowScale * flowScale;
  const generationPasses = GENERATION_PASSES.sharedFull + GENERATION_PASSES.sharedFlow * flowArea +
    generated * (GENERATION_PASSES.generatedFull + GENERATION_PASSES.generatedFlow * flowArea);
  const work = {sourcePixels, outputPixels, generated, flowScale, generationPasses, scalerPasses: passes,
    outputGeneration: outputPixels * generationPasses, sourceGeneration: sourcePixels * generationPasses,
    outputScaling: outputPixels * passes, sourceScaling: outputPixels * passes * multiplier};
  work.outputTotal = work.outputGeneration + work.outputScaling;
  work.sourceTotal = work.sourceGeneration + work.sourceScaling;
  const estimated = {...base, work};
  if (!allowSource) return {...estimated, reason: "Output-size generation retains the qualified placement."};
  if (input.width > target.width || input.height > target.height || sourcePixels >= outputPixels)
    return {...estimated, reason: "The completed generation source is not smaller than the presentation."};
  // A one-pixel rounding difference can arise when the fitted extent is odd.
  if (Math.abs(input.width * target.height - input.height * target.width) > Math.max(input.width, input.height, target.width, target.height))
    return {...estimated, reason: "The source and presentation geometry do not share a fitted aspect ratio."};
  if (maximumGenerationPixels !== undefined && sourcePixels > maximumGenerationPixels)
    return {...estimated, reason: "The source generation extent exceeds the supplied pixel budget."};
  if (work.sourceTotal >= work.outputTotal)
    return {...estimated, reason: "Scaling every delivered frame does not reduce estimated image work."};
  return {...estimated, placement: "source", reason: maximumGenerationPixels !== undefined && outputPixels > maximumGenerationPixels
    ? "Source-size generation fits the supplied pixel budget and reduces estimated image work."
    : "Source-size generation reduces estimated image work after accounting for scaling every delivered frame."};
}

export function applyHint(nodes, {api = 0, qualified = false, policy} = {}) {
  const eligible = candidate(nodes);
  if (!eligible || api !== 1 || !(qualified === true || policy === SOURCE_POLICY)) return null;
  const generation = nodes.find(node => node.id === eligible.generationId);
  generation.settings = {...generation.settings, simpleGenerationPlacement: SOURCE_POLICY, simpleSpatialNodeId: eligible.spatialNodeId};
  return {...eligible, policy: SOURCE_POLICY};
}
