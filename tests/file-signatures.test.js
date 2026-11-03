const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const Signature = require("../src/modules/shared/file-signature");

// Exercise the actual identity functions with a different mount's stat facts;
// private helpers are exposed only in this test's CommonJS wrapper.
function load(relative, file, state, expose = "") {
  const filename = path.resolve(__dirname, "..", relative), requireHere = createRequire(filename);
  const stats = options => {
    const big = options?.bigint, number = value => big ? BigInt(value) : value;
    return { dev: number(state.dev), ino: number(42), size: number(64), mode: number(0o100644),
      mtimeMs: number(state.mtime), mtimeNs: big ? BigInt(state.mtime) * 1000000n : undefined,
      ctimeMs: number(state.ctime), ctimeNs: big ? BigInt(state.ctime) * 1000000n : undefined,
      isFile: () => true, isSymbolicLink: () => false };
  };
  const fake = { ...fs, statSync: (_file, options) => stats(options), lstatSync: (_file, options) => stats(options), realpathSync: value => value };
  const module = { exports: {} };
  const wrapper = new vm.Script(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(filename, "utf8")}\n${expose}\n})`, { filename }).runInThisContext();
  wrapper(name => name === "node:fs" ? fake : requireHere(name), module, module.exports, filename, path.dirname(filename));
  return module.exports;
}

test("file identities ignore reconnect device numbers, accept legacy facts and detect mtime changes", () => {
  const file = path.resolve(os.tmpdir(), "identity-input"), state = { dev: 4, mtime: 100, ctime: 200 };
  const cases = [
    ["MAGES archive", "src/modules/mages/archive.js", "identity"],
    ["LÖVE source export", "src/modules/love/tools/source.js", "identity"],
    ["BGI source export", "src/modules/bgi/tools.js", "identity"],
    ["LÖVE archive", "src/modules/love/archive.js", "identity"]
  ];
  for (const [label, source, name] of cases) {
    const mod = load(source, file, state, `module.exports.readIdentity=${name};`);
    const read = () => label === "MAGES archive" || label === "BGI source export"
      ? mod.readIdentity({ size: 64, ino: 42, dev: state.dev, mtimeMs: state.mtime, ctimeMs: state.ctime })
      : mod.readIdentity(file);
    state.dev = 4; state.mtime = 100; state.ctime = 200;
    const before = read();
    state.dev = 9; state.ctime = 300;
    const after = read();
    assert.deepEqual(after, before, label + " survives reconnect without changing its stored basis");
    const signature = Array.isArray(after) ? after[1] : after;
    const mtime = label === "LÖVE archive" ? "100000000" : "100";
    assert.equal(Signature.same(`4:42:64:${mtime}:200`, signature), true, label + " accepts old device-bearing facts");
    state.mtime = 101;
    assert.notDeepEqual(read(), before, label + " notices a modified source");
  }

  state.dev = 4; state.mtime = 100;
  const observations = load("src/core/file-observations.js", file, state), before = observations.identity(file);
  assert.deepEqual(before, ["64:100:42", 0o100644, null, state.ctime], "fine timestamps retain read-change evidence without content hashing");
  state.dev = 9;
  assert.deepEqual(observations.identity(file), before);
  assert.equal(observations.unchanged([[file, before]]), true, "current read observations survive a device-number change");
  assert.equal(observations.unchanged([[file, [4, 42, 0o100644, 64, 100, 200, null]]]), false, "legacy observations without current change evidence require fresh analysis");
  state.ctime++;
  assert.equal(observations.unchanged([[file, before]]), false, "a changed ctime invalidates cached observed reads");
  state.ctime--;
  state.mtime = 101;
  assert.equal(observations.unchanged([[file, before]]), false);

  state.dev = 4; state.mtime = 100;
  const lua = load("src/modules/love/runtime/luasteam-consumer.js", file, state, "module.exports.readIdentity=identity;module.exports.sameIdentity=sameSignature;");
  const current = () => JSON.stringify([file, lua.readIdentity(file), path.dirname(file)]);
  const legacy = JSON.stringify([file, "4:42:64:100000000:200000000:33188", path.dirname(file)]);
  state.dev = 9;
  assert.equal(lua.sameIdentity(legacy, current()), true, "LuaSteam accepts the legacy stat fields");
  state.mtime = 101;
  assert.equal(lua.sameIdentity(legacy, current()), false, "LuaSteam invalidates a modified source");
});
