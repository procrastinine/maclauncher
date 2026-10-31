const crypto = require("node:crypto");

// downloads.scummvm.org lists one folder per version; each folder lists its
// files, and each Mac download has a published `.sha256` file beside it.
const hex = text => crypto.createHash("sha256").update(text).digest("hex");
const index = names => `<html><body><h1>Index of /frs/</h1><a href="../">../</a>${names.map(name => `<a href="${name}">${name}</a> 2026-01-01 00:00 4.0M<br>`).join("")}</body></html>`;
function publisher({ folder, prefix }) {
  const filename = version => `${prefix}-${version}-macosx.dmg`;
  const files = version => [filename(version), `${prefix}-${version}-macosx-i386.dmg`, `${prefix}-${version}-macosx-ppc.dmg`, `${prefix}-${version}-win32-x86_64.zip`, `${prefix}-${version}.tar.xz`];
  function routes(versions, changed = {}) {
    const result = { [folder]: index(versions.map(version => version + "/").concat(["2.2.0/", "old/", "daily/"])) };
    for (const version of versions) {
      const names = changed[version] || files(version);
      result[`${folder}${version}/`] = index(names.flatMap(name => [name, `${name}.sha256`]));
      for (const name of names) result[`${folder}${version}/${name}.sha256`] = `${hex(prefix + name)}  ${name}\n`;
    }
    return result;
  }
  const renamed = `${prefix}-2027.1.0-macos-universal.tar.xz`;
  const replaced = routes(["2026.4.0", "2.9.1"]);
  replaced[`${folder}2026.4.0/${filename("2026.4.0")}.sha256`] = `${hex("replaced")}  ${filename("2026.4.0")}\n`;
  return { current: routes(["2026.4.0", "2.9.1"]), scenarios: {
    newVersion: { routes: routes(["2027.1.0", "2026.4.0", "2.9.1"]), version: "2027.1.0", usable: true },
    renamedAsset: { routes: routes(["2027.1.0", "2026.4.0", "2.9.1"], { "2027.1.0": [renamed, `${prefix}-2027.1.0-win32-x86_64.zip`,
      `${prefix}-2027.1.0-linux-x86_64.tar.xz`, `${prefix}-2027.1.0.tar.xz`] }), version: "2027.1.0", usable: true },
    addedAsset: { routes: routes(["2027.1.0", "2026.4.0", "2.9.1"], { "2027.1.0": [...files("2027.1.0"), `${prefix}-2027.1.0-macosx-riscv64.dmg`,
      `${prefix}-2027.1.0-macosx-debug-symbols.zip`, `${prefix}-2027.1.0-linux-aarch64.AppImage`] }), version: "2027.1.0", usable: true },
    replacedFile: { routes: replaced, version: "2026.4.0", usable: true, digests: [hex("replaced")] },
    deletedRelease: { routes: routes(["2026.4.0"]), version: "2026.4.0", usable: true, deleted: "2.9.1" }
  } };
}
module.exports = { managers: ["scummvm"], publisher, ...publisher({ folder: "https://downloads.scummvm.org/frs/scummvm/", prefix: "scummvm" }) };
