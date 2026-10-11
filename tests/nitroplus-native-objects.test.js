const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Build = require("../src/modules/nitroplus/runtime/build");

const boost = ["/opt/homebrew/include", "/usr/local/include"].find(root => fs.existsSync(path.join(root, "boost/locale.hpp")));
const initialized = fs.existsSync(path.join(Build.sourcePath, "src/Choice.cpp")) && fs.existsSync(path.join(Build.npaSourcePath, "include/inpafile.hpp"));

test("native NSS choice callback namespaces, missing reads and alias cycles are safe", {
  skip: process.platform !== "darwin" || !boost || !initialized
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroplus-objects-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, "engine"), originalFiles = [path.join(Build.sourcePath, "include/Object.hpp"), path.join(Build.sourcePath, "src/Choice.cpp")];
  const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const before = originalFiles.map(hash);
  fs.cpSync(path.join(Build.sourcePath, "include"), path.join(engine, "include"), { recursive: true });
  fs.mkdirSync(path.join(engine, "src"));
  fs.copyFileSync(originalFiles[1], path.join(engine, "src/Choice.cpp"));
  Build.adaptObjectSources(engine);
  const source = path.join(root, "fixture.cpp"), executable = path.join(root, "fixture");
  fs.writeFileSync(source, `#include "Choice.hpp"
#include "Window.hpp"
#include <cassert>
#include <iostream>
Window* Object::pWindow = nullptr;
// Rendering is outside this constructor/namespace regression. Each unused
// graphics hook fails if the actual choice/object code unexpectedly calls it.
GLTexture::GLTexture() { assert(false); }
GLTexture::~GLTexture() {}
Texture::Texture() { assert(false); }
Texture::~Texture() {}
void Texture::Request(int32_t) { assert(false); }
void Texture::Draw(uint32_t) { assert(false); }
void Texture::Fade(int32_t, int, int32_t) { assert(false); }
void Window::PushMoveCursorEvent(int, int) { assert(false); }
int main() {
  ObjectHolder_t holder;
  holder.Write("button", new Choice);
  assert(holder.Read("button/MouseOver"));
  assert(holder.Read("button/MouseLeave"));
  auto callback = new Object;
  holder.Write("button/MouseLeave/prs", callback);
  assert(holder.Read("button/MouseLeave/prs") == callback);
  assert(!holder.Read("missing/path"));
  assert(!holder.Read("button/missing/path"));
  assert(!holder.Read("@unknown/path"));
  holder.WriteAlias("button", "alias");
  assert(holder.Read("@alias/MouseLeave/prs") == callback);
  holder.Execute("", [](Object**) { assert(false); });
  auto invalid = new Object;
  try { holder.Write("missing/path", invalid); assert(false); }
  catch (const std::runtime_error&) { delete invalid; }
  holder.WriteAlias("@cycle", "cycle");
  try { holder.Read("@cycle"); assert(false); }
  catch (const std::runtime_error&) {}
  holder.Delete("button/MouseLeave/prs");
  assert(!holder.Read("button/MouseLeave/prs"));
  std::cout << "NSS object regression passed";
}
`);
  // No window or codec is started. The fixture executes the actual constructor
  // and object namespace implementation from the pinned sources.
  execFileSync("/usr/bin/clang++", ["-std=c++17", "-I", path.join(engine, "include"), "-I", path.join(Build.npaSourcePath, "include"),
    "-I", boost, source, path.join(engine, "src/Choice.cpp"), "-o", executable],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  assert.equal(execFileSync(executable, [], { encoding: "utf8", timeout: 5000 }), "NSS object regression passed");
  assert.deepEqual(originalFiles.map(hash), before);
});
