const fs = require("node:fs"), path = require("node:path");
const Native = require("../runtime/bundled-native");
const {SCENE_INPUTS,SCENE_AOV_INPUTS,sceneInputRequirements}=require("../effects/operation-contracts.mjs");
function flags(value) {
  if (!value || Array.isArray(value) || typeof value.depth !== "boolean" || typeof value.motion !== "boolean" ||
      SCENE_INPUTS.some(name=>Object.hasOwn(value,name)&&typeof value[name]!=="boolean")||
      value.sceneAovs!==undefined&&(!Array.isArray(value.sceneAovs)||value.sceneAovs.length>SCENE_AOV_INPUTS.length||
        new Set(value.sceneAovs).size!==value.sceneAovs.length||value.sceneAovs.some(name=>!SCENE_AOV_INPUTS.includes(name)))) throw new Error("Invalid shader input requirements.");
  return sceneInputRequirements(value);
}
function read(directory, technique) {
  const file = path.join(directory, "requirements.json");
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(Native.readRegular(file, 1024 * 1024).bytes);
  const requirements = technique ? record.techniques && Object.hasOwn(record.techniques, technique) ? flags(record.techniques[technique]) : null : flags(record);
  if (technique && !requirements) throw new Error("The selected shader technique is unavailable.");
  return requirements;
}
module.exports = { read, flags };
