// Valve publishes one macOS SteamCMD manifest at a fixed URL. It names the
// current package version and its parts; each part file is content addressed
// (its SHA-1 ends the file name) and carries a SHA-256. Valve lists only its
// current version, so a new version replaces the earlier one in the list.
const crypto = require("node:crypto");
const Source = require("../../src/modules/shared/reshade/steamcmd-source");

const sha1 = text => crypto.createHash("sha1").update(text).digest("hex");
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
// A part is its name and the bytes it holds; `bootstrap` marks the one
// executable package. `extra` adds fields inside the part's block.
function part(name, content, { bootstrap = false, extra = "" } = {}) {
  return `\t"${name}"\n\t{\n\t\t"file"\t\t"${name}.zip.${sha1(content)}"\n\t\t"size"\t\t"${Buffer.byteLength(content)}"\n` +
    `\t\t"sha2"\t\t"${sha256(content)}"\n\t\t"zipvz"\t\t"${name}.zip.vz.${sha1("vz " + content)}"\n` +
    `\t\t"sha2vz"\t\t"${sha256("vz " + content)}"\n${bootstrap ? '\t\t"IsBootstrapperPackage"\t\t"1"\n' : ""}${extra}\t}\n`;
}
function manifest(version, parts, extra = "") {
  return `"osx"\n{\n\t"version"\t\t"${version}"\n${extra}${parts.join("")}}\n`;
}
const current = "1794537082", next = "1794537083";
const bootstrap = version => part("steamcmd_osx", "steamcmd bootstrap " + version, { bootstrap: true });
const parts = version => [bootstrap(version), part("steamcmd_bins_osx", "steamcmd libraries " + version),
  part("steamcmd_public_all", "steamcmd public files " + version)];
const routes = text => ({ [Source.location]: text });

module.exports = {
  managers: ["steamcmd"],
  current: routes(manifest(current, parts(current))),
  scenarios: {
    newVersion: { routes: routes(manifest(next, parts(next))), version: next, usable: true, deleted: current },
    // Another part beside the earlier ones, such as a new CPU's binaries.
    addedPart: { routes: routes(manifest(next, [...parts(next), part("steamcmd_bins_osx_arm64", "arm64 libraries " + next)])),
      version: next, usable: true, deleted: current },
    // A part renamed with another word; the bootstrap package stays marked.
    renamedPart: { routes: routes(manifest(next, [bootstrap(next), part("steamcmd_binaries_osx_universal", "steamcmd libraries " + next),
      part("steamcmd_public_all", "steamcmd public files " + next)])), version: next, usable: true, deleted: current },
    // The same version with a rebuilt bootstrap: a new content address and SHA-256.
    replacedFile: { routes: routes(manifest(current, [part("steamcmd_osx", "rebuilt steamcmd bootstrap " + current, { bootstrap: true }),
      ...parts(current).slice(1)])), version: current, usable: true, digests: [sha256("rebuilt steamcmd bootstrap " + current)] },
    // Keys and blocks no released MacLauncher knows, at the top level and inside parts.
    unknownKeys: { routes: routes(manifest(current, [part("steamcmd_osx", "steamcmd bootstrap " + current,
      { bootstrap: true, extra: '\t\t"IsDeltaPackage"\t\t"0"\n\t\t"futurefield"\t\t"enabled"\n' }), ...parts(current).slice(1)],
    '\t"futureflag"\t\t"1"\n\t"rollout"\n\t{\n\t\t"percent"\t\t"50"\n\t}\n')), version: current, usable: true }
  }
};
