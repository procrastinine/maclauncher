const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const ChildProcess = require("node:child_process");
const { copyFileExclusive } = require("../src/modules/shared/copy-file");

test("a synchronous OS denial of the optional clone worker uses real copies without repeated probes", { skip: process.platform !== "darwin" }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "copy-worker-unavailable-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), first = path.join(root, "first"), second = path.join(root, "second");
  const bytes = Buffer.alloc(64 * 1024, 90);
  fs.writeFileSync(source, bytes, { mode: 0o640 });
  fs.utimesSync(source, 1700000000.125, 1700000000.125);
  const facts = file => {
    const stat = fs.statSync(file, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs];
  };
  const before = facts(source), spawn = ChildProcess.spawn;
  let probes = 0, fallbackProcesses = 0;
  t.mock.method(ChildProcess, "spawn", (command, args, options) => {
    if (command === "/usr/bin/osascript") {
      probes++;
      assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
      assert.match(args[3], /clonefile/);
      throw Object.assign(new Error("spawn EPERM"), { code: "EPERM", errno: -1, syscall: "spawn" });
    }
    fallbackProcesses++;
    return spawn(command, args, options);
  });
  for (const target of [first, second]) {
    await copyFileExclusive(source, target);
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    assert.equal(fs.statSync(target, { bigint: true }).mtimeNs, before[4]);
    assert.notEqual(fs.statSync(target, { bigint: true }).ino, before[1]);
  }
  assert.equal(probes, 1, "The unavailable optional worker is not retried by the next copy");
  assert.ok(fallbackProcesses >= 2, "Both copies use the real existing copy fallback");
  const occupied = path.join(root, "occupied");fs.writeFileSync(occupied, "existing destination");
  await assert.rejects(copyFileExclusive(source, occupied), { code: "EEXIST" });
  assert.equal(fs.readFileSync(occupied, "utf8"), "existing destination");
  assert.equal(probes, 1);
  assert.deepEqual(fs.readFileSync(source), bytes);
  assert.deepEqual(facts(source), before, "Copying and a failed exclusive publication leave the source unchanged");
  assert.deepEqual(fs.readdirSync(root).sort(), ["first", "occupied", "second", "source"]);
});
