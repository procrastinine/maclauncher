import { stageReShadeEffects } from "./stage-reshade-effects.mjs";
import { resolveEffectSources } from "./reshade-effect-sources.mjs";
if (process.argv[2] !== "--effects-only" || process.argv.length !== 3)
  throw new Error("Usage: node scripts/stage-reshade.mjs --effects-only. Native packages are built by MacLauncher Builds.");
const effectSources = resolveEffectSources();
console.log(JSON.stringify(stageReShadeEffects({ effectSources })));
