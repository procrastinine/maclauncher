const fs = require("node:fs");
const path = require("node:path");
const { readPeExports } = require("../shared/runtime/pe-exports");

const LIMITS = Object.freeze({ candidates: 16, strings: 128 * 1024 });
const UNSUPPORTED = "Windows Haxe C++ code cannot run natively on macOS. A macOS, Flash, HTML5 or HashLink export is needed.";

function detectGame(context, helpers = context.detection) {
  if (context.isAppBundle || context.stat?.isFile() && !/\.exe$/i.test(context.inputPath)) return null;
  const entries = () => helpers?.readdir ? helpers.readdir(context.rootDir) : fs.readdirSync(context.rootDir, { withFileTypes: true });
  const memo = (key, read) => helpers?.memo ? helpers.memo("haxe-native", key, read) : read();
  try {
    // A native companion is only a cheap gate, not an engine classification.
    const names = entries(), limeNames = names.filter(row => row.name.toLowerCase() === "lime.ndll" && row.isFile());
    if (limeNames.length !== 1) return null;
    const candidates = context.stat?.isFile() ? [context.inputPath]
      : names.filter(row => row.isFile() && /\.exe$/i.test(row.name)).map(row => path.join(context.rootDir, row.name));
    if (!candidates.length || candidates.length > LIMITS.candidates) return null;
    const limePath = path.join(context.rootDir, limeNames[0].name);
    if (fs.lstatSync(limePath).isSymbolicLink()) return null;
    const lime = memo(limePath, () => readPeExports(limePath, { detection: helpers }));
    const codeExport = (image, name) => image?.exports.get(name)?.executable === true;
    if (!lime?.isDll || !codeExport(lime, "hx_set_loader") ||
        !["lime_application_create__0", "lime_application_create__prime"].some(name => codeExport(lime, name)) ||
        !["lime_window_create__0", "lime_window_create__prime"].some(name => codeExport(lime, name))) return null;
    const matches = [];
    for (const file of candidates) {
      const image = memo(file, () => readPeExports(file, { detection: helpers }));
      // hx_cffi is the native hxcpp host API. Shared NDLLs can also contain
      // HashLink/Neko entry points; those do not establish a portable program.
      if (!image || image.isDll || image.architecture !== lime.architecture || !codeExport(image, "hx_cffi")) continue;
      function strings(file, image) {
        const section = image.sections.find(row => row.name === ".rdata" && !row.executable);
        if (!section) return "";
        return memo(file + ":strings", () => {
          const length = Math.min(LIMITS.strings, section.size);
          if (helpers?.readBytes) return helpers.readBytes(file, section.offset, length)?.toString("latin1") || "";
          const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), bytes = Buffer.alloc(length);
          try { return fs.readSync(fd, bytes, 0, length, section.offset) === length ? bytes.toString("latin1") : ""; }
          finally { fs.closeSync(fd); }
        });
      }
      const framework = /\bopenfl\.(?:display|events|utils)\./.test(strings(file, image)) ? "OpenFL / Lime" : "Lime";
      const metadata = strings(limePath, lime);
      const build = /\bhxcpp[\\/](\d{1,3}(?:[.,]\d{1,3}){2,3})[\\/]include[\\/]hx[\\/]CFFI(?:Neko)?Loader\.h\b/.exec(metadata);
      const hxcppVersion = build?.[1].replace(/,/g, ".") || null;
      const moduleData = { compileTarget: "Windows C++ (hxcpp)", framework,
        architecture: image.architecture, nativePlatform: "windows", hxcppVersion,
        compatibility: UNSUPPORTED, originalRunnerPath: file, nativeLibraries: [limePath],
        ...(hxcppVersion ? { detectedVersion: `hxcpp ${hxcppVersion}`, detectedVersionSource: "C++ support-library build metadata",
          detectedVersionConfidence: "reported", versionKind: "C++ support library" } : {}) };
      matches.push({ moduleId: "haxe", engine: "haxe", gamePath: file, contentRootDir: context.rootDir,
        name: path.basename(file, path.extname(file)), runtimeId: "inspection", moduleData,
        detectionEvidence: [{ type: "selected-artifact", path: file },
          { type: "native-code-export", path: file, symbol: "hx_cffi", architecture: image.architecture },
          { type: "native-cffi-library", path: limePath, symbols: ["hx_set_loader", "lime_application_create", "lime_window_create"] }] });
    }
    return matches.length === 1 ? matches[0] : null;
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  }
}

module.exports = { LIMITS, UNSUPPORTED, detectGame };
