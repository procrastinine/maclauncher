const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Overlay = require("../src/modules/mages/native/windows-backlog-overlay");
const Build = require("../src/modules/mages/native/portable-backlog-build");
const Base = require("../src/modules/mages/native/portable-checkpoint-build");

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const upstream = path.resolve(__dirname, "../src/external/impacto/src/ui/backlogmenu.cpp");

test("the backlog profile has a distinct version and preserves all checkpoint profile bytes", () => {
  assert.equal(Build.VERSION, "0.10.8.810-windows-v8");
  assert.equal(Build.PROFILE, "windows-mpk2-sc3-backlog-macos13-v8");
  assert.equal(Overlay.ABI, "backlog-zero-capacity-v1");
  assert.equal(hash(fs.readFileSync(Build.PROFILE_SOURCE)), Build.PROFILE_SHA256);
  assert.deepEqual(fs.readFileSync(Build.PROFILE_SOURCE), fs.readFileSync(path.join(path.dirname(Build.PROFILE_SOURCE), "windows-game-v7.lua")));
  assert.equal(Base.overlayIdentity(), Build.BASE_RECIPE_SHA256);
  assert.equal(Build.RECIPE_FILES.length, Base.RECIPE_FILES.length + 3);
});

test("the backlog adapter changes only the bounded empty-capacity guard and rejects unsafe exports", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-backlog-overlay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), target = path.join(source, Overlay.FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "wrong source");
  assert.throws(() => Overlay.applyWindowsBacklogOverlay(source), /checksum/);
  assert.equal(fs.readFileSync(target, "utf8"), "wrong source");
  fs.copyFileSync(upstream, target);
  const before = fs.readFileSync(target, "utf8"), result = Overlay.applyWindowsBacklogOverlay(source);
  assert.equal(result.disabledCapacity, 0);
  assert.equal(result.files[0].originalSha256, Overlay.ORIGINAL_SHA256);
  assert.equal(fs.readFileSync(target, "utf8").replace("Entries.capacity() == 0 || ", ""), before);
  assert.throws(() => Overlay.applyWindowsBacklogOverlay(source), /checksum/);
  const linked = path.join(root, "linked"); fs.symlinkSync(source, linked);
  assert.throws(() => Overlay.applyWindowsBacklogOverlay(linked), /separate source export/);
  assert.throws(() => Overlay.applyWindowsBacklogOverlay(path.resolve(__dirname, "../src/external")), /external checkouts/);
});

test("compiled backlog guard skips zero-capacity storage and preserves enabled append and eviction behavior",
  { skip: process.platform !== "darwin" }, t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mages-backlog-native-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "source"), target = path.join(source, Overlay.FILE);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(upstream, target);
    const original = fs.readFileSync(target, "utf8");
    Overlay.applyWindowsBacklogOverlay(source);
    const expression = /template <typename EntryType>\nvoid BacklogMenu<EntryType>::AddMessage\([\s\S]*?\n\}/;
    const adapted = fs.readFileSync(target, "utf8").match(expression)?.[0];
    const legacy = original.match(expression)?.[0].replace("::AddMessage(", "::AddMessageLegacy(");
    assert.ok(adapted && legacy);
    const fixture = path.join(root, "fixture.cpp"), executable = path.join(root, "fixture");
    fs.writeFileSync(fixture, `#include <vector>
#include <optional>
#include <functional>
#include <cassert>
#include <stdexcept>
#include <iostream>
namespace glm { struct vec2 { float x = 0, y = 0; vec2() = default; vec2(float x, float y) : x(x), y(y) {} }; }
namespace Vm { struct BufferOffsetContext { int ScriptBufferId, IpOffset; }; }
struct Rect { float Y = 0, Height = 0; float Bottom() const { return Y + Height; } };
inline constexpr int SF_REVADDDISABLE = 0, FDIR_UP = 0, FDIR_DOWN = 1;
inline bool Disabled = false;
bool GetFlag(int) { return Disabled; }
inline glm::vec2 EntriesStart{10,20};
inline float EntryYPadding = 2;
inline Rect RenderingBounds{0,15};
struct Entry {
  int Id; Rect Bounds; struct Glyph { Rect DestRect; }; struct PageType { std::vector<Glyph> Glyphs; } Page;
  std::function<void(Entry*)> OnClickHandler; Entry* Up = nullptr; Entry* Down = nullptr;
  Entry(Vm::BufferOffsetContext context, std::optional<int>, int, glm::vec2 pos)
    : Id(context.IpOffset), Bounds{pos.y,7}, Page{{Glyph{Bounds}}} {}
  void SetFocus(Entry* other, int direction) { (direction == FDIR_UP ? Up : Down) = other; }
};
template<class T> struct Buffer {
  size_t Capacity; std::vector<T> Items; unsigned Reads = 0, Pushes = 0;
  explicit Buffer(size_t capacity) : Capacity(capacity) { Items.reserve(capacity); }
  size_t capacity() const { return Capacity; }
  bool empty() const { return Items.empty(); }
  bool full() const { return Items.size() == Capacity; }
  T& front() { ++Reads; if(empty()) throw std::runtime_error("empty front"); return Items.front(); }
  T& back() { ++Reads; if(empty()) throw std::runtime_error("empty back"); return Items.back(); }
  void push_front(T item) { ++Pushes; if(!Capacity) return; if(full()) Items.pop_back(); Items.insert(Items.begin(),std::move(item)); }
};
template<typename EntryType> struct BacklogMenu {
  Buffer<EntryType> Entries; float ItemsHeight = 2, PageY = 0; unsigned Moves = 0;
  struct Scrollbar { float StartValue = 0, EndValue = 1; bool Enabled = false; } MainScrollbar;
  explicit BacklogMenu(size_t capacity) : Entries(capacity) {}
  void AddMessage(Vm::BufferOffsetContext,std::optional<int>,int);
  void AddMessageLegacy(Vm::BufferOffsetContext,std::optional<int>,int);
  void MenuButtonOnClick(EntryType*) {}
  void MoveEntriesBottomTo(float) { ++Moves; }
};
${adapted}
${legacy}
template<class F> void rejects(F action) { bool rejected = false; try { action(); } catch(const std::runtime_error&) { rejected = true; } assert(rejected); }
int main() {
  BacklogMenu<Entry> disabled(0);
  for(int i=0;i<3;i++) disabled.AddMessage({1,i},{},0);
  assert(disabled.Entries.empty() && disabled.Entries.Reads == 0 && disabled.Entries.Pushes == 0);
  assert(disabled.ItemsHeight == 2 && disabled.Moves == 0 && disabled.PageY == 0);
  BacklogMenu<Entry> oldDisabled(0); rejects([&] { oldDisabled.AddMessageLegacy({1,0},{},0); });
  for(size_t capacity : {1,2,3}) {
    BacklogMenu<Entry> current(capacity), old(capacity);
    for(int i=0;i<7;i++) {
      current.AddMessage({1,i},i,0); old.AddMessageLegacy({1,i},i,0);
      assert(current.Entries.Items.size() == old.Entries.Items.size());
      assert(current.ItemsHeight == old.ItemsHeight && current.PageY == old.PageY && current.Moves == old.Moves);
      assert(current.MainScrollbar.Enabled == old.MainScrollbar.Enabled);
      assert(current.MainScrollbar.StartValue == old.MainScrollbar.StartValue && current.MainScrollbar.EndValue == old.MainScrollbar.EndValue);
      assert(current.Entries.Reads == old.Entries.Reads && current.Entries.Pushes == old.Entries.Pushes);
      for(size_t j=0;j<current.Entries.Items.size();j++) {
        const auto& a=current.Entries.Items[j]; const auto& b=old.Entries.Items[j];
        assert(a.Id == b.Id && a.Bounds.Y == b.Bounds.Y && a.Bounds.Height == b.Bounds.Height);
      }
    }
    Disabled = true; const auto pushes = current.Entries.Pushes;
    current.AddMessage({1,99},{},0); old.AddMessageLegacy({1,99},{},0);
    assert(current.Entries.Pushes == pushes && current.Entries.Pushes == old.Entries.Pushes);
    Disabled = false;
  }
  std::cout << "Disabled and enabled backlog behavior pass\\n";
}
`);
    execFileSync("/usr/bin/clang++", ["-std=c++20", "-arch", "arm64", "-mmacosx-version-min=13.0", fixture, "-o", executable], { stdio: "pipe" });
    assert.equal(execFileSync(executable, [], { encoding: "utf8" }), "Disabled and enabled backlog behavior pass\n");
  });
