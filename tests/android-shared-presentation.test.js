const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { inspectMachOExports } = require("../src/modules/shared/runtime/macho-exports");

test("the default shared graphics payload supplies the ART presenter's complete imported ABI", async t => {
  const root = require("../src/modules/shared/reshade").runtimeRoot();
  const library = path.join(root, "libreshade-macos.dylib");
  if (!fs.existsSync(library)) return t.skip("Requires the staged shared graphics payload");
  const client = fs.readFileSync(path.resolve(__dirname, "../src/modules/android/art/native/window-host.mm"), "utf8");
  const imports = new Set([...client.matchAll(/dlsym\([^,\n]+,\s*"(rs\w+)"\)/g)].map(match => match[1]));
  assert.ok(imports.has("rsSubmitFramePresenterAtTimeObserved"));
  for (const arch of ["arm64", "x64"]) {
    const exported = new Set(await inspectMachOExports(library, { arch }));
    for (const name of imports) assert.ok(exported.has(name), `${arch} shared graphics payload is missing ${name}`);
  }
});
