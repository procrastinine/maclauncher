const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const VERSION = "gemrb-cli-macos13-v5";
const SOURCE_HASHES = Object.freeze({
  "gemrb/CMakeLists.txt": "a1fe88e30038a71d616c163ea981369c5161d942050641b097b10810b76d23ef",
  "platforms/apple/CocoaWrapper/mac/CocoaWrapper.mm": "7907d001fe99218ca9a35d013e4ec76e70103cf128e9e15d9e1c3466cb355872",
  "gemrb/plugins/SDLVideo/SDLSurfaceSprite2D.cpp": "e46a5c4aacccd7db7d09a8e5f483ab6d3cfac86da68724ba1aba0b1254a9434f"
});
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function replace(text, before, after) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error("GemRB source differs from the selected Mac adapter.");
  return text.replace(before, after);
}
function adapt(relative, bytes) {
  if (!Object.hasOwn(SOURCE_HASHES, relative) || hash(bytes) !== SOURCE_HASHES[relative]) throw new Error("GemRB source checksum differs from the selected version.");
  let text = bytes.toString("utf8");
  if (relative === "gemrb/CMakeLists.txt") {
    const start = text.indexOf('\tget_filename_component(SDL_BASENAME "${SDL2_LIBDIR}" NAME)');
    const end = text.indexOf('\n\tSET(BUNDLE_LOADER ', start);
    if (start < 0 || end < 0) throw new Error("GemRB SDL bundle adapter no longer matches its source.");
    // Libraries are collected by the runtime packager. Upstream's copy step
    // changes the source SDL install name and must not touch shared dependencies.
    text = text.slice(0, start) + "\t# Runtime packaging collects SDL and its exact native dependencies.\n" + text.slice(end);
    const nib = /  # compile nib\n  ADD_CUSTOM_COMMAND \(TARGET gemrb POST_BUILD[^]*?COMMENT "Compiling GemRB\.xib"\)\n/;
    if (!nib.test(text)) throw new Error("GemRB CLI entry adapter no longer matches its source.");
    text = text.replace(nib, "  # The CLI entry uses per-game configuration directly.\n");
  } else if (relative.endsWith("CocoaWrapper.mm")) {
    text = replace(text, '#import "Logging/Logging.h"', '#import "Logging/Logging.h"\n#import "Logging/Loggers/Stdio.h"');
    text = replace(text, 'int main (int __unused argc, char ** __unused argv)\n{', `int main (int argc, char ** argv)
{
  if (argc > 1) {
    @autoreleasepool {
      NSApplication* app = [NSApplication sharedApplication];
      CocoaWrapper* delegate = [[CocoaWrapper alloc] init];
      [app setDelegate:delegate];
      [app setActivationPolicy:NSApplicationActivationPolicyRegular];
      try {
        auto settings = LoadFromArgs(argc, argv);
        ToggleLogging(settings.Logging);
        AddLogWriter(createStdioLogWriter());
        SanityCheck();
        Interface engine(std::move(settings));
        engine.Main();
      } catch (CoreInitializationException& error) {
        Log(FATAL, "GemRB", "{}", error);
        [delegate release];
        return 1;
      }
      [delegate release];
      return 0;
    }
  }`);
  } else if (relative.endsWith("SDLSurfaceSprite2D.cpp")) {
    // True-color sprites have no palette. Indexed copies retain upstream's
    // shaded-palette synchronization before SDL blits their pixel indices.
    text = replace(text, "\tUpdatePalettesState(true, true);",
      "\tif (format.palette) {\n\t\tUpdatePalettesState(true, true);\n\t}");
  }
  return Buffer.from(text);
}
function apply(sourceRoot, { sourceDir = path.resolve(__dirname, "../../../external/gemrb") } = {}) {
  if (!path.isAbsolute(sourceRoot || "") || !path.isAbsolute(sourceDir || "")) throw new Error("GemRB source directories must be absolute.");
  const output = fs.realpathSync(sourceRoot), original = fs.realpathSync(sourceDir);
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) throw new Error("GemRB adapters require a separate writable source copy.");
  const changes = [];
  for (const relative of Object.keys(SOURCE_HASHES)) {
    const file = path.join(output, relative);
    if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(output + path.sep)) throw new Error("GemRB adapter inputs must be contained regular files.");
    const bytes = adapt(relative, fs.readFileSync(file));
    changes.push({ file, relative, bytes, sourceSha256: SOURCE_HASHES[relative], adaptedSourceSha256: hash(bytes) });
  }
  for (const change of changes) fs.writeFileSync(change.file, change.bytes);
  return { version: VERSION, files: changes.map(({ relative, sourceSha256, adaptedSourceSha256 }) => ({ path: relative, sourceSha256, adaptedSourceSha256 })) };
}
module.exports = { VERSION, SOURCE_HASHES, adapt, apply };
