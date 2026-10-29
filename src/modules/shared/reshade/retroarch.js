const fs = require("node:fs"), path = require("node:path");
const Bundle = require("./shader-bundle");

const LIMITS = Object.freeze({ files: 4096, bytes: 256 * 1024 * 1024, metadata: 4 * 1024 * 1024, parameters: 4096 });
function sourceFormat(file) { return typeof file === "string" && /\.(slangp|slang)$/i.exec(file)?.[1].toLowerCase() || null; }
function metadata(value) {
  if (value?.schema !== 1 || !Array.isArray(value.parameters) || value.parameters.length > LIMITS.parameters)
    throw new Error("The RetroArch shader parameter metadata is invalid.");
  const names = new Set();
  const parameters = value.parameters.map(parameter => {
    if (!parameter || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name || "") || parameter.name.length > 4096 || names.has(parameter.name) ||
        parameter.type !== "float" || !Array.isArray(parameter.default) || parameter.default.length !== 1 ||
        ![parameter.default[0], parameter.min, parameter.max, parameter.step].every(Number.isFinite) ||
        parameter.min > parameter.max || parameter.default[0] < parameter.min || parameter.default[0] > parameter.max || parameter.step < 0)
      throw new Error("The RetroArch shader parameter metadata is invalid.");
    names.add(parameter.name);
    return { name: parameter.name, label: typeof parameter.label === "string" ? parameter.label.slice(0, 1024) : parameter.name,
      type: "float", default: [...parameter.default], min: parameter.min, max: parameter.max, step: parameter.step };
  });
  return { ...value, parameters };
}
function input(file) {
  if (!path.isAbsolute(file || "") || /[\0\r\n]/.test(file)) throw new Error("Choose an existing RetroArch Slang shader or preset.");
  const canonical = fs.realpathSync(file);
  if (!sourceFormat(canonical) || !fs.statSync(canonical).isFile()) throw new Error("Choose a .slangp preset or .slang shader.");
  return canonical;
}
async function inspect(file, { root, execute, signal }) {
  return normalizedInput(file,async source=>{
    const result = await execute(path.join(root, "retroarch-prepare"), ["--inspect", source],
      { env: Bundle.environment(), signal, timeout: 30000, maxBuffer: LIMITS.metadata });
    return metadata(JSON.parse(result.stdout));
  });
}
async function normalizedInput(file,action){
  const source=input(file);
  if(sourceFormat(source)!=="slang"||path.extname(source)===".slang")return action(source);
  // The original helper distinguishes a standalone pass by a case-sensitive
  // extension. An owned alias keeps its original canonical include directory.
  const directory=await fs.promises.mkdtemp(path.join(require("node:os").tmpdir(),"maclauncher-slang-")),alias=path.join(directory,"effect.slang");
  try{await fs.promises.symlink(source,alias);return await action(alias);}finally{await fs.promises.rm(directory,{recursive:true,force:true});}
}
const provider = { id: "retroarch", helper: "retroarch-prepare", input, parseMetadata: metadata, entryFile: "effect.slangp", label: "RetroArch" };
function verifyBundle(directory) { return Bundle.verify(directory, provider); }
function prepare(file, options) { return normalizedInput(file,source=>Bundle.prepare(source,options,{...provider,input:()=>source})); }
module.exports = { LIMITS, sourceFormat, metadata, input, inspect, verifyBundle, prepare };
