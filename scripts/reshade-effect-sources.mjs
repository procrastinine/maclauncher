import fs from "node:fs";
import Supplementals from "./native-supplementals.cjs";

// An adapted effect names the bundled shader pack it was taken from and the file
// within it; the pack declares the upstream repository and revision once.
export function resolveEffectSources(
    sources = JSON.parse(fs.readFileSync(new URL("../src/modules/shared/reshade/effect-sources.json", import.meta.url), "utf8")),
    packs = JSON.parse(fs.readFileSync(new URL("../src/modules/shared/reshade/shader-packs.json", import.meta.url), "utf8")).packs) {
  return sources.map(({pack, file, ...row}) => {
    const source = packs.find(entry => entry.id === pack);
    if (!source?.revision || !source.sourceUrl) throw new Error("An adapted effect names an unknown shader pack: " + pack);
    return {name: row.name, license: row.license, path: row.path, sourceUrl: source.sourceUrl + "/blob/" + source.revision + "/" + file,
      revision: source.revision, sourceSha256: row.sourceSha256, sha256: row.sha256, adaptation: row.adaptation};
  });
}

// Third-party presets carry their complete source and notice in the effect file.
// Their identities are independent of the unchanged native compiler sources.
export function validateEffectSources(sources, files) {
  if (!Array.isArray(sources)) throw new Error("Invalid ReShade effect sources.");
  const paths = new Set();
  const keys = ["name", "path", "sourceUrl", "revision", "sourceSha256", "sha256", "adaptation"];
  for (const source of sources) {
    if (!source || Object.keys(source).some(key => !keys.includes(key) && key !== "license") ||
        keys.some(key => typeof source[key] !== "string" || !source[key].trim() || source[key].length > 1024) ||
        !/^effects\/[A-Za-z0-9_-]+\.fxh?$/.test(source.path) || paths.has(source.path) ||
        !/^https:\/\//.test(source.sourceUrl) || !/^[a-f0-9]{40}$/.test(source.revision) ||
        !/^[a-f0-9]{64}$/.test(source.sourceSha256) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
        files.find(file => file.path === source.path)?.sha256 !== source.sha256) {
      throw new Error("ReShade effect source identity does not match its packaged file.");
    }
    paths.add(source.path);
  }
  Supplementals.validatePublicMetadata(sources);
}
