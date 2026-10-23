const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const Build = require("../src/modules/nitroplus/runtime/build");
const Pinned = require("../src/modules/shared/runtime/pinned-native-build");

const compiler = "/usr/bin/clang++";
const available = fs.existsSync(compiler) && fs.existsSync(path.join(Build.sourcePath, "include/TextParser.hpp"));

test("native NSS text parsing preserves words, punctuation, click lines and voice fields", { skip: !available }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroplus-text-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "fixture.cpp"), binary = path.join(root, "fixture");
  fs.writeFileSync(source, `#include "text-markup.hpp"
#include <cassert>
#include <iostream>
#include <stdexcept>
std::string text(const TextParser::Line& line) {
  std::string out;
  for (auto i = line.StringSegs.rbegin(); i != line.StringSegs.rend(); ++i) out += i->Segment;
  return out;
}
int main() {
  auto first = NativeText::parse("<PRE @box>\\r\\n[label]\\r\\n<I></I>Alpha, beta&.\\r\\nContinue here&.\\r\\n\\r\\n</PRE>");
  assert(first.Lines.size() == 1);
  assert(text(first.Lines[0]) == "Alpha, beta. Continue here.");
  auto clicked = NativeText::parse("<PRE box>[label]First&.<K><voice src=\\\"voice/2/0001\\\" name=\\\"Alice\\\" class=\\\"speaker\\\">Second&!<k>Third</PRE>");
  assert(clicked.Lines.size() == 3);
  assert(text(clicked.Lines[0]) == "First.");
  assert(text(clicked.Lines[1]) == "Second!");
  assert(text(clicked.Lines[2]) == "Third");
  assert(clicked.Lines[1].VoiceAttrs[TextParser::ATTR_SRC] == "voice/2/0001");
  assert(clicked.Lines[1].VoiceAttrs[TextParser::ATTR_NAME] == "Alice");
  auto japanese = NativeText::parse("<PRE box>[label]日本\\n語。<K>次の文。</PRE>");
  assert(text(japanese.Lines[0]) == "日本語。");
  auto literal = NativeText::parse("<PRE box>[label]Noise &X8 words & tail&.<K>Ends &</PRE>");
  assert(text(literal.Lines[0]) == "Noise &X8 words & tail.");
  assert(text(literal.Lines[1]) == "Ends &");
  auto styled = NativeText::parse("<PRE box>[label]Before <FONT color=\\\"#ff0000\\\" outcolor=\\\"#000000\\\">red <RUBY text=\\\"よみ\\\">語</RUBY></FONT> after.</PRE>");
  assert(text(styled.Lines[0]) == "Before red 語 after.");
  bool hasRuby = false, hasColor = false;
  for (const auto& segment : styled.Lines[0].StringSegs) { hasRuby |= segment.Ruby == "よみ"; hasColor |= segment.InColor == "#ff0000"; }
  assert(hasRuby && hasColor);
  for (const auto& input : {"<PRE box>[x]unfinished", "<PRE box>[x]<unknown>text</unknown></PRE>",
       "<PRE box>[x]<voice name=\\\"Alice\\\">text</PRE>", "<PRE box>[x]<I>unreviewed</I></PRE>",
       "<PRE box>[x]<FONT color=\\\"bad\\\">text</FONT></PRE>"}) {
    bool rejected = false;
    try { NativeText::parse(input); } catch (const std::runtime_error& e) { rejected = std::string(e.what()).find("NSS text markup") != std::string::npos; }
    assert(rejected);
  }
  std::cout << "native NSS text regression passed";
}
`);
  execFileSync(compiler, ["-std=c++17", "-I" + path.join(Build.sourcePath, "include"), "-I" + path.join(__dirname, "../src/modules/nitroplus/runtime/native"),
    source, path.join(__dirname, "../src/modules/nitroplus/runtime/native/text-markup.cpp"), "-o", binary], { timeout: 30000, stdio: "pipe" });
  assert.equal(execFileSync(binary, [], { timeout: 5000, encoding: "utf8" }), "native NSS text regression passed");
});

const prefix = ["/opt/homebrew", "/usr/local"].find(root => fs.existsSync(path.join(root, "include/boost/locale.hpp")));
const pkg = prefix && path.join(prefix, "bin/pkg-config");
const renderAvailable = process.platform === "darwin" && available && prefix && fs.existsSync(pkg) &&
  spawnSync(pkg, ["--exists", "sdl2", "glew", "pangocairo", "libpng", "libjpeg", "gstreamer-app-1.0"], { timeout: 5000 }).status === 0;

const bundle = path.resolve(__dirname, "../src/resources/native-runtimes/npengine", Build.VERSION, process.arch);
const nativeLibrary = path.join(bundle, "files/lib/libnpengine.dylib");
test("the shipped NSS interpreter retains PRE box context for authored text-load branches", {
  skip: renderAvailable && fs.existsSync(nativeLibrary) ? false : "Requires the matching bundled Mac native profile and local development headers"
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroplus-text-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "fixture.cpp"), binary = path.join(root, "fixture");
  fs.writeFileSync(source, `#include "NSBInterpreter.hpp"
#include "scriptfile.hpp"
#include "npafile.hpp"
#include "Text.hpp"
#include <cassert>
#include <iostream>
class Scripts : public ResourceMgr {
public:
 ScriptFile* ReadScriptFile(const std::string& name) override {
  const std::string script="chapter main { CreateWindow(\\"box\\",10,0,0,640,400,true); SetAlias(\\"box\\",\\"box\\"); <PRE @box>[first]Hello&.</PRE> $branch=0; if(\\"$SYSTEM_present_preprocess\\"==\\"@box\\"){ $branch=1; } WaitKey(1000); }";
  return new ScriptFile(name,script.data(),script.size());
 }
};
class Probe : public NSBInterpreter {
public:
 Probe() : NSBInterpreter(nullptr) {}
 std::string value(const std::string& name) { auto p=VariableHolder.Read(name);return p?p->ToString():"absent"; }
 bool textExists() { return Get<Text>("@box/first")!=nullptr; }
};
int main() {
 NpaFile::SetLocale("ja_JP.CP932");
 // No Window constructor or GPU upload executes. Process-lifetime fixtures
 // avoid Texture destruction, which requires a native Window instance.
 sResourceMgr=new Scripts;auto probe=new Probe;probe->ExecuteScript("fixture.nss");probe->Run(20);
 assert(probe->textExists());assert(probe->value("$SYSTEM_present_text")=="@box/first");
 assert(probe->value("$SYSTEM_present_preprocess")=="@box");assert(probe->value("$branch")=="1");
 std::cout<<"native PRE box context passed";
}
`);
  const flags = execFileSync(pkg, ["--cflags", "sdl2"], { encoding: "utf8" }).trim().split(/\s+/);
  execFileSync(compiler, ["-std=c++17", ...flags,
    ...[path.join(Build.sourcePath, "include"), path.join(Build.npaSourcePath, "include"), path.join(prefix, "include")].map(root => "-I" + root),
    source, nativeLibrary, "-Wl,-rpath," + path.dirname(nativeLibrary), "-o", binary], { timeout: 30000, stdio: "pipe" });
  assert.equal(execFileSync(binary, [], { timeout: 10000, encoding: "utf8", env: { ...process.env,
    GST_PLUGIN_SYSTEM_PATH_1_0: "", GST_PLUGIN_PATH_1_0: "",
    GST_REGISTRY_1_0: path.join(root, "registry.bin"), GST_REGISTRY_FORK: "no" } }), "native PRE box context passed");
});

test("native JPEG rows and text pixels preserve RGBA channels without creating a game window", {
  skip: renderAvailable ? false : "Requires macOS and the local native rendering development dependencies"
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nitroplus-pixels-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "source");
  for (const [source, revision, relative] of [[Build.sourcePath, Build.REVISION, "libnpengine"], [Build.npaSourcePath, Build.NPA_REVISION, "libnpa"]]) {
    const verified = await Pinned.validatePinnedSource(source, revision);
    Pinned.stagePinnedFiles(source, verified.files, path.join(stage, relative));
  }
  Build.adaptSource(stage);
  const source = path.join(root, "fixture.cpp"), binary = path.join(root, "fixture");
  fs.writeFileSync(source, `#include "scriptfile.hpp"
#include "Image.hpp"
#include "Text.hpp"
#include "Playable.hpp"
#include "Window.hpp"
#include <jpeglib.h>
#include <cassert>
#include <cmath>
#include <cstring>
#include <iostream>
#include <vector>

// Capture only the GPU upload boundary. JPEG decoding, NSS parsing, Pango
// layout and Cairo rasterization below execute their actual native code.
std::vector<uint8_t> uploaded;
GLenum uploadedFormat = 0;
int uploadedWidth = 0, uploadedHeight = 0;
Window* Object::pWindow = nullptr;
GLTexture::GLTexture() : Width(0), Height(0), GLTextureID(0) {}
GLTexture::~GLTexture() {}
void GLTexture::Create(uint8_t* pixels, GLenum format, int width, int height) {
  uploaded.assign(pixels, pixels + width * height * 4);
  uploadedFormat = format; uploadedWidth = Width = width; uploadedHeight = Height = height;
}
Texture::Texture() {}
Texture::~Texture() {}
void Texture::Request(int32_t) { assert(false); }
void Texture::Draw(uint32_t) { assert(false); }
void Window::DrawTextures(uint32_t) { assert(false); }
Playable::Playable(Resource) { assert(false); }
Playable::~Playable() {}
void Playable::Play() { assert(false); }
void Playable::Request(int32_t) { assert(false); }
bool Playable::Action() { assert(false); return false; }
ResourceMgr::ResourceMgr() {}
ResourceMgr::~ResourceMgr() {}
Resource ResourceMgr::GetResource(string) { assert(false); return Resource(nullptr, {}); }
char* ResourceMgr::Read(string, uint32_t&) { assert(false); return nullptr; }
ScriptFile* ResourceMgr::GetScriptFile(const string&) { assert(false); return nullptr; }
ScriptFile* ResourceMgr::ResolveSymbol(const string&, uint32_t&) { assert(false); return nullptr; }
class MemoryResource : public ResourceMgr {
public:
  std::vector<uint8_t> jpeg;
  char* Read(string name, uint32_t& size) override {
    assert(name == "fixture.jpg"); size = jpeg.size();
    auto copy = new char[size]; memcpy(copy, jpeg.data(), size); return copy;
  }
  ScriptFile* ReadScriptFile(const string&) override { assert(false); return nullptr; }
} resources;
ResourceMgr* sResourceMgr = &resources;

std::vector<uint8_t> makeJpeg() {
  jpeg_compress_struct encoder{}; jpeg_error_mgr error{};
  encoder.err = jpeg_std_error(&error); jpeg_create_compress(&encoder);
  unsigned char* compressed = nullptr; unsigned long size = 0;
  jpeg_mem_dest(&encoder, &compressed, &size);
  encoder.image_width = 32; encoder.image_height = 16;
  encoder.input_components = 3; encoder.in_color_space = JCS_RGB;
  jpeg_set_defaults(&encoder);
  for (int i = 0; i < 3; ++i) encoder.comp_info[i].h_samp_factor = encoder.comp_info[i].v_samp_factor = 1;
  jpeg_set_quality(&encoder, 100, TRUE); jpeg_start_compress(&encoder, TRUE);
  uint8_t row[32 * 3];
  while (encoder.next_scanline < encoder.image_height) {
    for (int x = 0; x < 32; ++x) {
      row[x * 3] = x < 16 ? 240 : 24;
      row[x * 3 + 1] = encoder.next_scanline < 8 ? 48 : 208;
      row[x * 3 + 2] = x < 16 ? 32 : 224;
    }
    auto scanline = row; jpeg_write_scanlines(&encoder, &scanline, 1);
  }
  jpeg_finish_compress(&encoder);
  std::vector<uint8_t> output(compressed, compressed + size);
  free(compressed); jpeg_destroy_compress(&encoder); return output;
}

void checkJpeg() {
  resources.jpeg = makeJpeg(); Image image; image.LoadImage("fixture.jpg", false);
  assert(image.GetWidth() == 32 && image.GetHeight() == 16 && image.GetFormat() == GL_RGBA);
  const auto pixels = image.GetPixels(); assert(pixels != nullptr);
  for (int y = 0; y < 16; ++y) for (int x = 0; x < 32; ++x) {
    const auto pixel = pixels + (y * 32 + x) * 4;
    assert(std::abs(int(pixel[0]) - (x < 16 ? 240 : 24)) < 6);
    assert(std::abs(int(pixel[1]) - (y < 8 ? 48 : 208)) < 6);
    assert(std::abs(int(pixel[2]) - (x < 16 ? 32 : 224)) < 6);
    assert(pixel[3] == 255);
  }
}
void checkText() {
  Text::dFont = "Sans"; Text::dSize = 24; Text::dWeight = 400;
  Text::dInColor = 0x003040c0; Text text;
  text.CreateFromXML("<PRE box>[label]<I></I>First sentence&.<K>Next sentence&.</PRE>");
  assert(text.Advance()); assert(uploadedFormat == GL_BGRA);
  assert(uploadedWidth > 100 && uploadedHeight >= 20);
  size_t opaque = 0, transparent = 0;
  for (size_t i = 0; i < uploaded.size(); i += 4) {
    if (uploaded[i + 3] == 255) {
      ++opaque; assert(uploaded[i] == 0x30 && uploaded[i + 1] == 0x40 && uploaded[i + 2] == 0xc0);
    }
    if (uploaded[i + 3] == 0) ++transparent;
  }
  assert(opaque > 20 && transparent > 20);
  const auto first = uploaded; assert(text.Advance()); assert(first != uploaded); assert(!text.Advance());
  text.SetColor(0x0080a020); text.SetWrap(110);
  text.CreateFromString("Words must wrap across several lines.");
  assert(uploadedWidth <= 110 && uploadedHeight > 40);
  opaque = 0;
  for (size_t i = 0; i < uploaded.size(); i += 4) if (uploaded[i + 3] == 255) {
    ++opaque; assert(uploaded[i] == 0x80 && uploaded[i + 1] == 0xa0 && uploaded[i + 2] == 0x20);
  }
  assert(opaque > 20);
}
int main() { checkJpeg(); checkText(); std::cout << "native JPEG and text pixels passed"; }
`);
  const flags = execFileSync(pkg, ["--cflags", "--libs", "sdl2", "glew", "pangocairo", "libpng", "libjpeg", "gstreamer-app-1.0"], { encoding: "utf8" }).trim().split(/\s+/);
  execFileSync(compiler, ["-std=c++17", "-mmacosx-version-min=13.0",
    ...[stage, path.join(stage, "libnpengine/include"), path.join(stage, "libnpa/include"), path.join(prefix, "include")].map(root => "-I" + root),
    source, path.join(stage, "libnpengine/src/Image.cpp"), path.join(stage, "libnpengine/src/Text.cpp"), path.join(stage, "text-markup.cpp"),
    ...flags, "-framework", "OpenGL", "-o", binary], { timeout: 60000, stdio: "pipe" });
  assert.equal(execFileSync(binary, [], { timeout: 10000, encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: path.join(root, "cache") } }), "native JPEG and text pixels passed");
  for (const [source, revision] of [[Build.sourcePath, Build.REVISION], [Build.npaSourcePath, Build.NPA_REVISION]])
    await Pinned.validatePinnedSource(source, revision);
});
