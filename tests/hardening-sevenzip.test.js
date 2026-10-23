const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const SevenZip = require("../src/modules/shared/runtime/sevenzip");

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function extractorFixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-hardening-sevenzip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "extractor.js");
  const binary = path.join(root, "extractor");
  fs.writeFileSync(script, source);
  fs.writeFileSync(binary, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o700 });
  return { root, binary };
}

test("7-Zip extraction completes after an extractor writes 8 MiB to stdout", { skip: process.platform === "win32" }, async t => {
  const { root, binary } = extractorFixture(t, `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const [command, overwrite, output, archive] = process.argv.slice(2);
    assert.equal(command, "x");
    assert.equal(overwrite, "-y");
    assert.ok(output.startsWith("-o"));
    assert.equal(path.basename(archive), "game archive.7z");
    const bytes = Buffer.alloc(8 * 1024 * 1024, 65);
    // A broken parent must fail and reap this child instead of hanging the suite.
    const watchdog = setTimeout(() => {
      process.stderr.write("Extractor blocked flushing stdout");
      process.exit(73);
    }, 2000);
    process.stdout.write(bytes, () => {
      clearTimeout(watchdog);
      fs.mkdirSync(output.slice(2), { recursive: true });
      fs.writeFileSync(path.join(output.slice(2), "extracted.txt"), String(bytes.length));
    });
  `);
  const destination = path.join(root, "extracted game");
  assert.equal(await SevenZip.extractArchive(path.join(root, "game archive.7z"), destination, binary), true);
  assert.equal(fs.readFileSync(path.join(destination, "extracted.txt"), "utf8"), String(8 * 1024 * 1024));
});

test("7-Zip extraction still reports nonzero exit codes and stderr", { skip: process.platform === "win32" }, async t => {
  const { root, binary } = extractorFixture(t, 'process.stderr.write("Archive data is corrupt"); process.exitCode = 2;');
  await assert.rejects(SevenZip.extractArchive(path.join(root, "game.7z"), path.join(root, "extract"), binary), error => {
    assert.match(error.message, /failed \(2\)/);
    assert.equal(error.stderr, "Archive data is corrupt");
    return true;
  });
});

test("noisy extraction failures retain only the useful bounded stderr tail", { skip: process.platform === "win32" }, async t => {
  const { root, binary } = extractorFixture(t,
    'process.stderr.write("x".repeat(8 * 1024 * 1024) + "\\nArchive data is corrupt"); process.exitCode = 2;');
  await assert.rejects(SevenZip.extractArchive(path.join(root, "game.7z"), path.join(root, "extract"), binary), error => {
    assert.equal(error.stderr.length, 32768);
    assert.match(error.stderr, /Archive data is corrupt$/);
    return true;
  });
});
