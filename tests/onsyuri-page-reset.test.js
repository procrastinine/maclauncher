const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const Base = require("../src/modules/shared/onsyuri/runtime/portable-build");
const Page = require("../src/modules/shared/onsyuri/runtime/portable-page-reset");
const Build = require("../src/modules/shared/onsyuri/runtime/portable-build-v3");
const ORIGINAL = path.resolve(__dirname, "../src/external/onscripter-yuri/src/onsyuri/ONScripter.cpp");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-yuri-page-reset-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Yuri V3 applies only the pinned page reset to a disposable source tree", t => {
  const original = fs.readFileSync(ORIGINAL), root = temporary(t), staged = path.join(root, Page.FILE);
  fs.mkdirSync(path.dirname(staged), { recursive: true }); fs.writeFileSync(staged, original);
  const result = Page.apply(root, path.dirname(ORIGINAL));
  assert.equal(result.files[0].sourceSha256, Build.PIN.sourceGuards[Page.FILE]);
  assert.notEqual(result.files[0].sourceSha256, result.files[0].adaptedSourceSha256);
  assert.deepEqual(fs.readFileSync(ORIGINAL), original);
  assert.deepEqual(fs.readFileSync(staged), Page.adaptSource(original));
  assert.throws(() => Page.apply(root), /source differs from its pinned version/);
  fs.writeFileSync(staged, Buffer.concat([original, Buffer.from("\n")]));
  assert.throws(() => Page.apply(root), /source differs from its pinned version/);
  assert.throws(() => Page.apply(path.dirname(ORIGINAL)), /cannot change source checkouts/);
});

test("the actual adapted C++ page method resets empty selections and retains history semantics", t => {
  const compiler = process.platform === "darwin" ? "/usr/bin/clang++" : "c++";
  const available = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") return t.skip("C++ compiler unavailable");
  assert.equal(available.status, 0);
  const root = temporary(t);
  const prefix = `#include <iostream>
struct Page { int text_count; Page *next; };
class ONScripter { public:
 Page *current_page, *start_page;
 int page_enter_status=9, cursor=12, clear_calls=0;
 bool internal_saveon_flag=false;
 struct { int pos=0; } sentence_font_info;
 void clearCurrentPage() { ++clear_calls; current_page->text_count=0; cursor=0; internal_saveon_flag=true; }
 int refreshMode() { return 0; }
 void flush(int, int*) {}
 void newPage();
};
`;
  const suffix = `
int main() {
 Page a{0,nullptr}, b{0,nullptr}, c{0,nullptr}; a.next=&b; b.next=&c; c.next=&a;
 ONScripter empty; empty.current_page=&a; empty.start_page=&a; empty.newPage();
 std::cout << empty.clear_calls << " " << empty.cursor << " " << empty.internal_saveon_flag << " " << (empty.current_page==&a) << " " << (empty.start_page==&a) << " " << empty.page_enter_status << "\\n";
 a.text_count=8;
 ONScripter full; full.current_page=&a; full.start_page=&b; full.newPage();
 std::cout << full.clear_calls << " " << full.cursor << " " << full.internal_saveon_flag << " " << (full.current_page==&b) << " " << (full.start_page==&c) << " " << full.page_enter_status << "\\n";
}
`;
  const observed = {};
  for (const [id, method] of [["original", Page.ORIGINAL], ["adapted", Page.ADAPTED]]) {
    const source = path.join(root, id + ".cpp"), binary = path.join(root, id);
    fs.writeFileSync(source, prefix + method + suffix);
    const result = spawnSync(compiler, ["-std=c++17", ...(process.platform === "darwin" ? ["-mmacosx-version-min=13.0"] : []), source, "-o", binary], { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 1000 });
    assert.equal(run.status, 0, run.stderr); observed[id] = run.stdout.trim().split("\n");
  }
  assert.deepEqual(observed.original, ["0 12 0 1 1 0", "1 0 1 1 1 0"]);
  assert.deepEqual(observed.adapted, ["1 0 1 1 1 0", "1 0 1 1 1 0"]);
});

test("Yuri V3 keeps the exact base recipe and rejects incomplete or changed dependency profiles", () => {
  assert.equal(Base.VERSION, Build.PIN.base.version);
  assert.equal(Base.overlayIdentity(), Build.PIN.base.overlaySha256);
  Build.validateBase();
  for (const stack of [undefined, {}, { receipt: { complete: true, version: "0.7.7beta-macos-v1" } },
    { receipt: { complete: false, version: Build.PIN.base.version } }]) {
    assert.throws(() => Build.validateCompleteStack(stack), /complete pinned base recipe/);
  }
  assert.notEqual(Build.VERSION, Base.VERSION);
  assert.equal(Build.REVISION, Base.REVISION);
});

test("cancelled V3 builds produce no output and preserve old source recipe bytes", async t => {
  const root = temporary(t), output = path.join(root, "build"), before = Base.overlayIdentity();
  await assert.rejects(Build.buildPortableYuri({ workRoot: output, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(fs.existsSync(output), false); assert.equal(Base.overlayIdentity(), before);
});
