const { githubRoutes, githubRelease, githubScenarios, publisherScenarios } = require("../helpers/future-upstream.cjs");
const path = require("node:path"), fs = require("node:fs");
const { peFixture } = require("../helpers/pe-fixture");

// DXMT comes from 3Shain/dxmt's builtin packages and from the dxmt folder of
// Sikarugir Template releases.
const upstream = "3Shain/dxmt", template = "Sikarugir-App/Template";
const upstreamReleases = ["0.72", "0.71"].map(version => githubRelease(upstream, `v${version}`, [`dxmt-v${version}-builtin.tar.gz`, `dxmt-v${version}.tar.gz`]));
const templateReleases = ["1.0.24", "1.0.21"].map(version => githubRelease(template, `v${version}`, [`Template-${version}.tar.xz`]));
const { current, scenarios } = publisherScenarios([
  { name: "DXMT", current: githubRoutes(upstream, upstreamReleases), scenarios: githubScenarios(upstream, upstreamReleases), listed: version => `upstream-dxmt-v${version}-builtin` },
  { name: "Template", current: githubRoutes(template, templateReleases), scenarios: githubScenarios(template, templateReleases), listed: version => `template-Template-${version}` }
]);

// A Template app whose renderer folder holds DXMT's Wine builtin modules.
function builtin() {
  const fixture = peFixture({ is64: true }); fixture.bytes.writeUInt16LE(0x2002, fixture.peOffset + 22);
  fixture.bytes.write("Wine builtin DLL\0", 64); return fixture.bytes;
}
function writeTemplate(root) {
  const dxmt = path.join(root, "Template-1.0.24.app", "Contents", "Frameworks", "renderer", "dxmt");
  fs.mkdirSync(path.join(dxmt, "wine", "x86_64-windows"), { recursive: true });
  fs.writeFileSync(path.join(dxmt, "wine", "x86_64-windows", "d3d11.dll"), builtin());
  fs.writeFileSync(path.join(dxmt, "version"), "v0.80-244-g7c8dee1\n");
  return path.relative(root, dxmt);
}

module.exports = {
  managers: ["sikarugir-graphics-bridge"], current, scenarios,
  layout: { write: writeTemplate, resolve: root => require("../../src/modules/shared/runtime/component-runtime").componentRoot(root, { names: ["dxmt"] }) }
};
