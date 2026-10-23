import Supplementals from "./native-supplementals.cjs";

// Third-party presets carry their complete source and notice in the effect file.
// Their identities are independent of the unchanged native compiler sources.
export function validateEffectSources(sources, files) {
  if (!Array.isArray(sources) || sources.length > 64) throw new Error("Invalid ReShade effect sources.");
  const paths = new Set();
  const keys = ["name", "license", "path", "sourceUrl", "revision", "sourceSha256", "sha256", "adaptation"];
  for (const source of sources) {
    if (!source || Object.keys(source).length !== keys.length || Object.keys(source).some(key => !keys.includes(key)) ||
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
  return sources.map(({ name, license, path, sourceUrl }) => ({ name, license, path, sourceUrl }));
}
