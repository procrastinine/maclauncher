const fs = require("node:fs"), path = require("node:path");

// The download page links each platform's file with a backslash path; the
// update feed announces every version.
const SITE = "https://dreamm.aarongiles.com/";
const page = names => `<html><body>${names.map(name => `<a href='releases\\${name}'>${name}</a>`).join("")}<a href='docs/v40/'>Docs</a></body></html>`;
const feed = versions => `<?xml version="1.0"?><feed><title>DREAMM Version Updates</title>${versions.map(version =>
  `<entry><title>DREAMM ${version}</title><link href="${SITE}" /><summary>Notes</summary></entry>`).join("")}</feed>`;
const files = version => [`dreamm-${version}-macos.dmg`, `dreamm-${version}-win32-x64.zip`, `dreamm-${version}-win32-arm64.zip`,
  `dreamm-${version}-linux-x64.tgz`, `dreamm-${version}-win32-setup.exe`];
function routes(versions, linked = files(versions[0])) {
  const result = { [SITE]: page(linked), [`${SITE}version.xml`]: feed(versions) };
  for (const version of versions) result[`${SITE}releases/dreamm-${version}-macos.dmg`] = "disk image";
  return result;
}
module.exports = { managers: ["dreamm"], current: routes(["4.0", "3.0.3"]), scenarios: {
  newVersion: { routes: routes(["4.1", "4.0", "3.0.3"]), version: "4.1", usable: true },
  renamedAsset: { routes: routes(["4.1", "4.0", "3.0.3"], ["DREAMM-4.1-macOS-universal.zip", "dreamm-4.1-win32-x64.zip"]), version: "4.1", usable: "either" },
  addedAsset: { routes: routes(["4.1", "4.0", "3.0.3"], [...files("4.1"), "dreamm-4.1-macos-debug-symbols.zip", "dreamm-4.1-linux-aarch64.AppImage"]),
    version: "4.1", usable: true },
  replacedFile: { routes: routes(["4.0", "3.0.3"]), version: "4.0", usable: true },
  deletedRelease: { routes: routes(["4.0"]), version: "4.0", usable: true, deleted: "3.0.3" }
}, layout: {
  write(root) {
    const executable = path.join(root, "DREAMM.app", "Contents", "MacOS", "dreamm");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "");
    fs.writeFileSync(path.join(path.dirname(path.dirname(executable)), "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${path.basename(executable)}</string></dict></plist>`);
    return path.join("DREAMM.app", "Contents", "MacOS", "dreamm");
  },
  resolve: root => require("../../src/modules/dreamm/runtime/manager").resolveExecutable(root)
} };
