import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const Requirements = require("../src/modules/shared/runtime/feature-requirements.js");
const declarations = require("../src/modules/shared/reshade/distribution-supplementals.json");
export const documentFile = path.join(root, "docs/runtimes/SYSTEM_REQUIREMENTS.md");
const version = value => String(value).replace(/(?:\.0)+$/, "");
const maximum = values => values.filter(Boolean).reduce((a, b) => Requirements.versionAtLeast(a, b) ? a : b);

// Names describe the feature in the app; version and processor requirements
// come directly from the declarations used by its capability gates.
export function platformFeatures(requirements = Requirements) {
  return [
    ...Object.values(requirements.METALFX), requirements.METALFX_EXTRA_INPUTS,
    requirements.METAL4, requirements.NEURAL, requirements.FSR4,
    ...Object.values(requirements.WINE_BACKENDS), ...Object.values(requirements.TEMPLATE_RENDERERS),
    {...requirements.WINE_TEMPORAL, label: "Temporal upscaling in Windows games"},
    {...requirements.WINE_MODERN_VULKAN, label: "Vulkan renderers for Windows games"}
  ];
}

const groups = [
  ["Shared graphics effects", row => row.path === "libreshade-macos.dylib"],
  ["libplacebo filters and shader compilation", row => row.path.startsWith("libplacebo/") ||
    ["libmacfx-libplacebo.dylib", "libplacebo-prepare"].includes(row.path)],
  ["ISF shaders", row => row.path.startsWith("isf/")],
  ["Video export", row => row.path === "maclauncher-graphics-video"],
  ["MLX neural processing", row => row.path.startsWith("neural/") && row.path !== "neural/maclauncher-neural-video"],
  ["Neural video decoding and encoding", row => row.path === "neural/maclauncher-neural-video"]
];

// The public package declarations retain the measured processor slices and
// optional-load minima. Ordinary generation needs no installed app or binaries.
// --resources additionally verifies those declarations against the sealed bytes.
export function graphicsRows({packages = declarations, resources} = {}) {
  const rows = [];
  for (const declaration of packages) {
    let folder;
    if (resources) {
      folder = path.join(resources, "native-runtimes", declaration.directoryRelative);
      const bytes = fs.readFileSync(path.join(folder, declaration.manifestRelative));
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== declaration.manifestSha256)
        throw new Error("The selected graphics manifest differs from the app declaration.");
    }
    for (const [label, select] of groups) {
      const minima = new Map();
      for (const row of declaration.files.filter(row => row.architectures?.length && select(row))) {
        const declaredMinimum = maximum([declaration.minimumMacOS, row.minimumMacOS, row.optionalLoad?.minimumMacOS]);
        let slices = row.architectures.map(architecture => ({architecture, minimumMacOS: declaredMinimum}));
        if (folder) {
          const binary = path.join(folder, row.path);
          if (crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex") !== row.sha256)
            throw new Error("The selected binary differs from its manifest: " + row.path);
          const {readMachOLoadCommands} = require("../src/modules/shared/runtime/macho-load-commands.js");
          slices = readMachOLoadCommands(binary).slices;
          if (slices.length !== row.architectures.length || slices.some(slice => !row.architectures.includes(slice.architecture)))
            throw new Error("The declared processor slices differ from the binary: " + row.path);
          if (slices.some(slice => !Requirements.versionAtLeast(declaredMinimum, slice.minimumMacOS)))
            throw new Error("The declared macOS minimum is below the binary requirement: " + row.path);
        }
        for (const slice of slices) {
          const architecture = slice.architecture === "x64" ? "x86_64" : slice.architecture;
          minima.set(architecture, maximum([minima.get(architecture), declaredMinimum, slice.minimumMacOS]));
        }
      }
      if (!minima.size) continue;
      const arm = minima.get("arm64"), intel = minima.get("x86_64");
      const minimum = new Set([...minima.values()].map(version)).size === 1 ? version([...minima.values()][0]) :
        [arm && "Apple Silicon " + version(arm), intel && "Intel " + version(intel)].filter(Boolean).join("; ");
      rows.push(`| ${label} | ${declaration.version} | ${arm && intel ? "Apple Silicon and Intel" : arm ? "Apple Silicon" : "Intel"} | ${minimum} |`);
    }
  }
  return rows;
}

function replaceTable(text, marker, table) {
  const start = `<!-- ${marker}:start -->`, end = `<!-- ${marker}:end -->`;
  const before = text.indexOf(start), after = text.indexOf(end);
  if (before < 0 || after < before || text.indexOf(start, before + 1) !== -1 || text.indexOf(end, after + 1) !== -1)
    throw new Error("Missing or duplicate documentation boundary: " + marker);
  return text.slice(0, before + start.length) + "\n" + table.join("\n") + "\n" + text.slice(after);
}

export function generateSystemRequirements(text, {requirements = Requirements, packages = declarations, resources,
  appMinimum = require("../package.json").build.mac.minimumSystemVersion} = {}) {
  text = replaceTable(text, "platform-requirements", [
    "| Feature | Minimum macOS | Processor and device |", "| --- | --- | --- |",
    ...platformFeatures(requirements).map(row => `| ${row.label} | ${version(row.minimumMacOS)} | ${
      row.hardwareArchitectures?.join() === "arm64" ? "Apple Silicon" : "Support queried per Metal device"} |`)
  ]);
  text = replaceTable(text, "selected-graphics-requirements", [
    "| Included component | Package version | Processor | Effective minimum macOS |", "| --- | --- | --- | --- |",
    ...graphicsRows({packages, resources})
  ]);
  const intro = /^(MacLauncher requires macOS )(\d+(?:\.\d+)*)( or later\.)/m;
  if (!intro.test(text)) throw new Error("The app requirements introduction is missing.");
  return text.replace(intro, (_match, prefix, _minimum, suffix) => prefix + version(appMinimum) + suffix);
}

export function checkSystemRequirements(text, options) {
  if (text !== generateSystemRequirements(text, options))
    throw new Error("System requirements differ from their source. Run node scripts/generate-system-requirements.mjs.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let check = false, resources;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (args[i] === "--write") check = false;
    else if (args[i] === "--resources" && args[i + 1] && !args[i + 1].startsWith("--")) resources = path.resolve(args[++i]);
    else throw new Error("Usage: node scripts/generate-system-requirements.mjs [--check] [--resources DIRECTORY]");
  }
  const text = fs.readFileSync(documentFile, "utf8");
  if (check) checkSystemRequirements(text, {resources});
  else fs.writeFileSync(documentFile, generateSystemRequirements(text, {resources}));
  console.log(check ? "System requirements match their sources." : "System requirements generated.");
}
