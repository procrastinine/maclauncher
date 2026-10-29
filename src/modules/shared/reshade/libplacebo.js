const fs = require("node:fs"), path = require("node:path");
const Bundle = require("./shader-bundle");
function sourceFormat(file) { return typeof file === "string" && /\.(glsl|hook|cube|plfilter)$/i.test(file) ? "libplacebo" : null; }
function input(file) {
  if (!path.isAbsolute(file || "") || /[\0\r\n]/.test(file)) throw new Error("Choose an existing MPV shader or libplacebo filter.");
  const canonical = fs.realpathSync(file), stat = fs.statSync(canonical);
  if (!sourceFormat(canonical) || !stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("The prepared libplacebo shader exceeds 16 MiB.");
  return canonical;
}
function metadata(value, {nativeVideo = false} = {}) {
  if (value?.schema !== 1 || !Array.isArray(value.parameters) || value.parameters.length > 4096)
    throw new Error("The libplacebo shader parameter metadata is invalid.");
  if (value.rgbCompatible === false && !nativeVideo)
    throw new Error("This shader has no RGB-compatible hook. Choose an RGB MPV/libplacebo shader.");
  const names = new Set(), parameters = value.parameters.map(parameter => {
    if (!parameter || typeof parameter.name !== "string" || !parameter.name || Buffer.byteLength(parameter.name) > 4096 ||
        /[\x00-\x1f\x7f]/.test(parameter.name) || ["__proto__", "prototype", "constructor"].includes(parameter.name) || names.has(parameter.name) ||
        !["float", "int", "bool"].includes(parameter.type) || !Array.isArray(parameter.default) || parameter.default.length < 1 || parameter.default.length > 4 ||
        parameter.default.some(value => !Number.isFinite(value)) ||
        [parameter.min, parameter.max, parameter.step].some(value => value !== undefined && !Number.isFinite(value)) ||
        parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max || parameter.step < 0)
      throw new Error("The libplacebo shader parameter metadata is invalid.");
    names.add(parameter.name);
    let options;
    if (parameter.options !== undefined) {
      if (!Array.isArray(parameter.options) || parameter.options.length > 4096 || parameter.options.some(option =>
        !Number.isFinite(option?.value) || typeof option.label !== "string" || option.label.length > 1024) ||
        new Set(parameter.options.map(option => option.value)).size !== parameter.options.length)
        throw new Error("The libplacebo shader choices are invalid.");
      options = parameter.options.map(({ value, label }) => ({ value, label }));
    }
    return { ...parameter, label: typeof parameter.label === "string" ? parameter.label.slice(0, 1024) : parameter.name, default: [...parameter.default], ...(options ? { options } : {}) };
  });
  return { ...value, parameters };
}
const provider = { id: "libplacebo", helper: "libplacebo-prepare", input, parseMetadata: metadata, entryFile: "effect.hook", label: "libplacebo" };
function preparedInput(file, options) {
  file=/\.cube$/i.test(file)?require("./cube-lut").prepare(file,options.userDataDir):input(file);
  const source=fs.readFileSync(file,"utf8");
  if(!/^\s*\/\/!\s*(?:SCENE_INPUT|INPUT_POLICY)\b/m.test(source))return file;
  require("./shader-scene-bindings").parse(source);require("./shader-input-policy").declared(source);
  // These owned declarations describe the shared boundary. Original mpv
  // parsers reject unknown directives; retain them as ordinary GLSL comments.
  const normalized=source.replace(/^(\s*\/\/)!(\s*(?:SCENE_INPUT|INPUT_POLICY)\b[^\r\n]*)/gm,"$1 $2");
  const digest=require("node:crypto").createHash("sha256").update(normalized).digest("hex"),Writable=require("../writable-input");
  const directory=path.join(options.userDataDir,"graphics","shaders","libplacebo-inputs",digest),target=path.join(directory,"effect.hook");
  Writable.assertOwnDirectory(options.userDataDir,directory);
  if(fs.existsSync(target)){const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||fs.readFileSync(target,"utf8")!==normalized)throw Error("The normalized shader source changed. Recreate its prepared resources.");}
  else Writable.atomicWrite(target,normalized,{root:options.userDataDir});
  return target;
}
async function inspect(file, { root, execute, signal, nativeVideo = false, userDataDir }) {
  file = preparedInput(file, {userDataDir});
  const result = await execute(path.join(root, provider.helper), ["--inspect", input(file)],
    { env: Bundle.environment(), signal, timeout: 30000, maxBuffer: Bundle.LIMITS.metadata });
  return metadata(JSON.parse(result.stdout), {nativeVideo});
}
module.exports = { sourceFormat, input, metadata, inspect, preparedInput, sourceAvailability:require("./libplacebo-filter").sourceAvailability,
  verifyBundle: directory => Bundle.verify(directory, provider), prepare: (file, options) => Bundle.prepare(preparedInput(file, options), options, provider) };
