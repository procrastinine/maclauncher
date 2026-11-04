import fs from "node:fs";
import { stageReShadeEffects } from "./stage-reshade-effects.mjs";
if (process.argv[2] !== "--effects-only" || process.argv.length !== 3)
  throw new Error("Usage: node scripts/stage-reshade.mjs --effects-only. Native packages are built by MacLauncher Builds.");
const effectSources = JSON.parse(fs.readFileSync(new URL("../src/modules/shared/reshade/effect-sources.json", import.meta.url), "utf8"));
console.log(JSON.stringify(stageReShadeEffects({ effectSources })));
