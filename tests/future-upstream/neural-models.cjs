// Neural checkpoints that publishers commit to GitHub repositories: each
// listed commit's Git tree gives every declared file's size and blob SHA-1, and
// a file stored in Git LFS is a small committed pointer whose blob carries the
// checkpoint's SHA-256 and size. DLSSMac publishes prepared model archives as
// GitHub release assets.
const crypto = require("node:crypto");
const { githubRelease, githubRoutes } = require("../helpers/future-upstream.cjs");
const Static = require("../../src/modules/shared/reshade/neural/model-source.json");
const API = "https://api.github.com/repos/";
const RAW = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([a-f0-9]{40})\/(.+)$/;
const sha1 = text => crypto.createHash("sha1").update(text).digest("hex");
const blobSha = bytes => crypto.createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
// The repositories whose checkpoint files are read per commit, with the paths
// and sizes the declared sources name. NVIDIA keeps its DLL in Git LFS.
const LFS = new Set(["NVIDIA/DLSS"]);
const repositories = new Map();
for (const source of Static.sources) for (const file of source.files || []) {
  const match = RAW.exec(file.url);
  if (!match || file.transport || source.files.some(item => item.transport) || !source.repository.endsWith("/" + match[1])) continue;
  if (!repositories.has(match[1])) repositories.set(match[1], new Map());
  repositories.get(match[1]).set(match[3], file.bytes);
}
const profiles = repository => Static.sources.filter(source => source.repository === "https://github.com/" + repository && !source.files.some(file => file.transport));
// One commit's tree and blobs. `changed` gives a file different content; `moved` drops it.
function commit(repository, label, { changed = [], moved = [] } = {}) {
  const sha = sha1(repository + label), tree = [], blobs = {};
  for (const [relative, bytes] of repositories.get(repository)) {
    if (moved.includes(relative)) continue;
    const content = `${repository} ${relative} ${changed.includes(relative) ? label : "original"}`;
    if (LFS.has(repository) && bytes > 1024) {
      const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${crypto.createHash("sha256").update(content).digest("hex")}\nsize ${bytes}\n`);
      const blob = blobSha(pointer);
      tree.push({ path: relative, mode: "100644", type: "blob", sha: blob, size: pointer.length, url: `${API}${repository}/git/blobs/${blob}` });
      blobs[`${API}${repository}/git/blobs/${blob}`] = { sha: blob, size: pointer.length, encoding: "base64", content: pointer.toString("base64") };
    } else tree.push({ path: relative, mode: "100644", type: "blob", sha: sha1(content), size: bytes, url: `${API}${repository}/git/blobs/${sha1(content)}` });
  }
  return { sha, label, routes: { [`${API}${repository}/git/trees/${sha}`]: { sha, url: `${API}${repository}/git/trees/${sha}`, tree, truncated: false }, ...blobs } };
}
function routes(state) {
  const result = {};
  for (const [repository, commits] of Object.entries(state.commits)) {
    result[`${API}${repository}/commits`] = commits.map(item => ({ sha: item.sha, node_id: "C_" + item.sha.slice(0, 8),
      commit: { message: `Update ${item.label}\n\nDetails`, committer: { name: "publisher", date: "2026-01-01T00:00:00Z" }, author: { name: "publisher", date: "2026-01-01T00:00:00Z" } },
      html_url: `https://github.com/${repository}/commit/${item.sha}`, parents: [] }));
    for (const item of commits) Object.assign(result, item.routes);
  }
  return { ...result, ...githubRoutes("Mappsnet7/DLSSMac", state.dlssmac) };
}
const versions = (repository, item) => profiles(repository).map(profile => `${profile.version}-git-${item.sha}`);
const dlssmac = tag => githubRelease("Mappsnet7/DLSSMac", tag, [`DLSSMac-${tag.replace(/^v/, "")}-macos.zip`, `DLSSMac-${tag.replace(/^v/, "")}-source.tar.gz`]);
const base = Object.fromEntries([...repositories.keys()].map(repository => [repository, [commit(repository, "second"), commit(repository, "first")]]));
const current = { commits: base, dlssmac: [dlssmac("v0.1.6"), dlssmac("v0.1.5")] };
const [ESRGAN, RIFE, DLSS] = ["xocialize/realesrgan-mlx-swift", "nihui/rife-ncnn-vulkan", "NVIDIA/DLSS"];
const weights = repository => [...repositories.get(repository)].sort((a, b) => b[1] - a[1])[0][0];
const later = (repository, options) => commit(repository, "third", options);
module.exports = { managers: ["graphics-neural-models"], current: routes(current),
  scenarios: {
    newVersion: { routes: routes({ ...current, commits: { ...base, [ESRGAN]: [later(ESRGAN, { changed: [weights(ESRGAN)] }), ...base[ESRGAN]] } }),
      version: versions(ESRGAN, later(ESRGAN, { changed: [weights(ESRGAN)] }))[0], usable: true },
    // A new LFS checkpoint behind the same path: its pointer supplies the new SHA-256.
    replacedFile: { routes: routes({ ...current, commits: { ...base, [DLSS]: [later(DLSS, { changed: [weights(DLSS)] }), ...base[DLSS]] } }),
      version: versions(DLSS, later(DLSS, { changed: [weights(DLSS)] }))[0], usable: true },
    // A commit that moved a declared checkpoint file has no listed version.
    renamedAsset: { routes: routes({ ...current, commits: { ...base, [RIFE]: [later(RIFE, { moved: [weights(RIFE)] }), ...base[RIFE]] } }),
      version: versions(RIFE, later(RIFE, { moved: [weights(RIFE)] }))[0], usable: "either" },
    newRelease: { routes: routes({ ...current, dlssmac: [dlssmac("v0.2.0"), ...current.dlssmac] }), version: "dlssmac-release-v0.2.0", usable: true },
    deletedRelease: { routes: routes({ ...current, commits: { ...base, [ESRGAN]: base[ESRGAN].slice(0, 1) } }),
      version: versions(ESRGAN, base[ESRGAN][0])[0], usable: true, deleted: versions(ESRGAN, base[ESRGAN][1]) }
  } };
