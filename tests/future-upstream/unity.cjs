// Unity's release API lists editor releases newest first; each lists its
// downloadable modules with the publisher's integrity digest.
const crypto = require("node:crypto");
const API = "https://services.api.unity.com/unity/editor/release/v1/releases";
const revision = version => crypto.createHash("sha1").update(version).digest("hex").slice(0, 12);
const sha = text => crypto.createHash("sha256").update(text).digest();
const release = (version, { name = `UnitySetup-Mac-Mono-Support-for-Editor-${version}.pkg`, content = name } = {}) => ({
  version, shortRevision: revision(version), releaseDate: "2026-09-01T00:00:00.000Z", stream: "LTS", recommended: true,
  label: null, releaseNotes: { url: `https://example.invalid/${version}.md` }, skuFamily: "CLASSIC",
  downloads: ["MAC_OS", "LINUX"].map(platform => ({ platform, architecture: platform === "MAC_OS" ? "ARM64" : "X86_64", type: "TEXT",
    url: `https://download.unity3d.com/download_unity/${revision(version)}/${platform}/Unity.pkg`, integrity: null, downloadSize: { value: 1, unit: "BYTE" },
    modules: [{ id: "mac-mono", slug: "mac-mono", name: "Mac Build Support (Mono)", type: "PKG", category: "PLATFORM",
      url: `https://download.unity3d.com/download_unity/${revision(version)}/MacEditorTargetInstaller/${name}`,
      integrity: "sha256-" + sha(content).toString("base64"), downloadSize: { value: 300000000, unit: "BYTE" } },
    { id: "mac-il2cpp", type: "PKG", url: `https://download.unity3d.com/download_unity/${revision(version)}/MacEditorTargetInstaller/UnitySetup-Mac-IL2CPP-Support-for-Editor-${version}.pkg`,
      integrity: "sha256-" + sha("il2cpp").toString("base64") }] })) });
const routes = (releases, extra = {}) => ({ [API]: url => {
  const offset = Number(new URL(url).searchParams.get("offset"));
  return { offset, limit: 25, total: releases.length, ...extra, results: releases.slice(offset, offset + 25) };
} });
const current = [release("6000.0.58f2"), release("2022.3.62f1")];
module.exports = { managers: ["unity"], current: routes(current), scenarios: {
  newVersion: { routes: routes([release("6000.0.59f1"), ...current]), version: "6000.0.59f1", usable: true },
  // A renamed installer for the same component.
  renamedAsset: { routes: routes([release("6000.0.59f1", { name: "UnitySetup-Mac-Mono-Support-for-Editor-6000.0.59f1-universal.pkg" }), ...current]),
    version: "6000.0.59f1", usable: true },
  // Unity republishes the installer behind the same URL with a new digest.
  replacedFile: { routes: routes([release("6000.0.58f2", { content: "replaced" }), current[1]]), version: "6000.0.58f2", usable: true,
    digests: [sha("replaced").toString("hex")] },
  // The API stops reporting a total and answers a smaller page.
  pageShape: { routes: routes(current, { total: undefined, limit: 10 }), version: "6000.0.58f2", usable: true },
  // A release without a readable module list leaves the others listed.
  unreadableRelease: { routes: routes([{ version: "6000.0.59f1", shortRevision: revision("6000.0.59f1"), downloads: [null, { modules: "none" }] }, ...current]),
    version: "6000.0.58f2", usable: true },
  deletedRelease: { routes: routes(current.slice(0, 1)), version: "6000.0.58f2", usable: true, deleted: "2022.3.62f1" }
} };
