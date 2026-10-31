// Godot lists releases on its archive page, grouped by version. Each
// version's page links the editor downloads.
const Godot = () => require("../../src/modules/godot/runtime/godot-runtime");
const ARCHIVE = "https://godotengine.org/download/archive/";
const group = (base, flavor, slugs, { group = "archive-group", link = "archive-version" } = {}) => `<div class="${group}">
  <h3 id="${base}">${base}</h3><span class="archive-version-flavor">${flavor}</span>
  <div class="archive-releases">${slugs.map(slug => `<a class="${link}" href="/download/archive/${slug}/">${slug}</a>`).join("")}</div>
</div>`;
const page = groups => ({ [ARCHIVE]: `<!doctype html><html><body><main>${groups.join("\n")}</main></body></html>` });
const current = [group("4.5", "stable", ["4.5-stable", "4.5-rc2"]), group("4.4.1", "stable", ["4.4.1-stable"]), group("3.6", "stable", ["3.6-stable"])];
const downloads = (version, names) => `<html><body>${names.map(name => `<a href="https://downloads.godotengine.org/?version=${version}&amp;flavor=stable&amp;slug=${name}&amp;platform=${
  /macos|osx/.test(name) ? "macos.universal" : "linux.x86_64"}">${name}</a>`).join("")}</body></html>`;
module.exports = { managers: ["godot"], current: page(current), scenarios: {
  newVersion: { routes: page([group("4.6", "stable", ["4.6-stable"]), ...current]), version: "4.6-stable", usable: true },
  // A redesigned page drops the archive classes.
  renamedAsset: { routes: page([group("4.6", "stable", ["4.6-stable"], { group: "release-group", link: "release-link" }),
    ...current.map(markup => markup.replace(/archive-group|archive-version(?!-)/g, "release"))]), version: "4.6-stable", usable: true },
  deletedRelease: { routes: page(current.slice(0, 2)), version: "4.5-stable", usable: true, deleted: "3.6-stable" }
},
// The installer's app search finds the editor when the archive wraps it in a folder.
layout: {
  write(root) {
    const fs = require("node:fs"), path = require("node:path"), app = path.join(root, "Godot_mono.app", "Contents", "MacOS");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "Godot"), "");
    return "Godot_mono.app";
  },
  resolve: root => Godot().__test.findAppBundle(root, "mono")
},
checks: {
  "Godot follows a Mac editor download that changes name or archive format": async (t, Harness) => {
    const assert = require("node:assert/strict"), { resolveDownloadUrl } = Godot();
    const route = names => ({ [`${ARCHIVE}4.6-stable/`]: downloads("4.6-stable", names) });
    Harness.network.routes = route(["Godot_v4.6-stable_linux.x86_64.zip", "Godot_v4.6-stable_macos.universal.zip", "Godot_v4.6-stable_mono_macos.universal.zip"]);
    assert.match((await resolveDownloadUrl({ version: "4.6-stable", variant: "standard" })).name, /^Godot_v4\.6-stable_macos\.universal\.zip$/);
    Harness.network.routes = route(["Godot_v4.6-stable_macos.universal.tar.xz", "Godot_v4.6-stable_mono_macos.arm64.dmg"]);
    assert.equal((await resolveDownloadUrl({ version: "4.6-stable", variant: "standard" })).name, "Godot_v4.6-stable_macos.universal.tar.xz");
    assert.equal((await resolveDownloadUrl({ version: "4.6-stable", variant: "mono" })).name, "Godot_v4.6-stable_mono_macos.arm64.dmg");
    // Direct links to the publisher's release files.
    Harness.network.routes = { [`${ARCHIVE}4.6-stable/`]: `<a href="https://github.com/godotengine/godot-builds/releases/download/4.6-stable/Godot_v4.6-stable_macos.universal.zip">macOS</a>` };
    assert.equal((await resolveDownloadUrl({ version: "4.6-stable", variant: "standard" })).url,
      "https://github.com/godotengine/godot-builds/releases/download/4.6-stable/Godot_v4.6-stable_macos.universal.zip");
  }
} };
