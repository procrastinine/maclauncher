const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Native = require("../../shared/runtime/local-native");

const ORIGINALS = Object.freeze({
  "CMakeLists.txt": "c988d9cc9f257dcbe77d1b3b64ff35979d9e0dea365a0587bee1ee14b48c536c",
  "src/vm/inst_misc.cpp": "e9b0c6a9f578bc6f959b7a0ef837ddd37cbb43318106b04fec6fcb609fbd09b5",
  "src/vm/interface/input.cpp": "f8e3bd61298a24879dc8817131106a447b32c2de6b5eefc5fb8e3e5d58d74822",
  "src/profile/dialogue.cpp": "76391394e41a4501a03f47132f6b633bf3c7ef418d01109bd646473103b63a3b",
  "src/profile/vm.cpp": "cff64bb64065e72c2d4340fcb12d2d44a1ce90538e1081f0482811c441eddc36"
});
const COPIES = Object.freeze({ "src/vm/windows-input.h": "windows-input.h",
  "src/vm/windows-input.cpp": "windows-input.cpp", "src/vm/windows-input-state.h": "windows-input-state.h" });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function replacement(text, before, after) {
  if (text.indexOf(before) < 0 || text.indexOf(before) !== text.lastIndexOf(before))
    throw new Error("Impacto Windows input source structure changed.");
  return text.replace(before, after);
}

function applyWindowsUiOverlay(sourceRoot) {
  const external = fs.realpathSync(path.resolve(__dirname, "../../../external"));
  if (!path.isAbsolute(sourceRoot || "") || fs.lstatSync(sourceRoot).isSymbolicLink() ||
      !fs.lstatSync(sourceRoot).isDirectory() || fs.existsSync(path.join(sourceRoot, ".git")))
    throw new Error("Impacto source adapters require a separate source export.");
  const root = fs.realpathSync(sourceRoot);
  if (root === external || root.startsWith(external + path.sep))
    throw new Error("Impacto source adapters cannot change external checkouts.");
  const changes = [];
  for (const [file, checksum] of Object.entries(ORIGINALS)) {
    const target = path.join(root, file), stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target || stat.nlink !== 1 || Native.hashFile(target) !== checksum)
      throw new Error("Impacto Windows input source checksum changed: " + file);
    changes.push({ path: file, originalSha256: checksum, text: fs.readFileSync(target, "utf8") });
  }
  for (const file of Object.keys(COPIES)) if (fs.existsSync(path.join(root, file)))
    throw new Error("Impacto Windows input source already exists.");
  for (const file of Object.keys(COPIES)) {
    const parent = path.dirname(path.join(root, file));
    if (fs.realpathSync(parent) !== parent) throw new Error("Impacto Windows input output parent is linked.");
  }
  for (const row of changes) {
    if (row.path === "CMakeLists.txt") row.text = replacement(row.text,
      "    src/vm/interface/input.cpp\n", "    src/vm/interface/input.cpp\n    src/vm/windows-input.cpp\n");
    if (row.path === "src/vm/inst_misc.cpp") {
      row.text = replacement(row.text, '#include "../ui/scriptspritemenu.h"\n', '#include "../ui/scriptspritemenu.h"\n#include "windows-input.h"\n');
      row.text = replacement(row.text, '  if (mode != 0) throw std::runtime_error(fmt::format("Unsupported Windows SC3 UI mode {}", mode));\n',
        '  if (mode == 13 || mode == 14) { WindowsInput::Apply(mode); return; }\n  if (mode != 0) throw std::runtime_error(fmt::format("Unsupported Windows SC3 UI mode {}", mode));\n  WindowsInput::Reset();\n');
    }
    if (row.path === "src/vm/interface/input.cpp") {
      row.text = replacement(row.text, '#include "input.h"\n', '#include "input.h"\n#include "../windows-input.h"\n');
      row.text = replacement(row.text,
        "  }\n}\n\n// TODO: Make this configurable per game\n", "  }\n  WindowsInput::PollMouse();\n}\n\n// TODO: Make this configurable per game\n");
    }
    if (row.path === "src/profile/dialogue.cpp") row.text = replacement(row.text,
      "    default:\n      ImpLog(LogLevel::Warning, LogChannel::General,\n             \"Dialogue box is not implemented for the current profile yet!\\n\");\n",
      "    case DialogueBoxType::Plain:\n      break;\n    default:\n      ImpLog(LogLevel::Warning, LogChannel::General,\n             \"Dialogue box is not implemented for the current profile yet!\\n\");\n");
    if (row.path === "src/profile/vm.cpp") {
      row.text = replacement(row.text, '#include "game.h"\n', '#include "game.h"\n#include "../vm/windows-input.h"\n');
      row.text = replacement(row.text,
        '  TryGetMember<bool>("WindowsOpcodeExtensions", WindowsOpcodeExtensions);\n',
        '  TryGetMember<bool>("WindowsOpcodeExtensions", WindowsOpcodeExtensions);\n  if (WindowsOpcodeExtensions) Impacto::Vm::WindowsInput::Configure();\n');
    }
  }
  for (const row of changes) fs.writeFileSync(path.join(root, row.path), row.text);
  for (const [file, source] of Object.entries(COPIES)) {
    const target = path.join(root, file), parent = path.dirname(target);
    if (fs.realpathSync(parent) !== parent) throw new Error("Impacto Windows input output parent is linked.");
    fs.writeFileSync(target, fs.readFileSync(path.join(__dirname, source)), { flag: "wx" });
    changes.push({ path: file, originalSha256: null });
  }
  return { abi: "windows-sc3-input-v1", modes: [13, 14],
    files: changes.map(row => ({ path: row.path, originalSha256: row.originalSha256, adaptedSha256: Native.hashFile(path.join(root, row.path)) })) };
}

module.exports = { ORIGINALS, COPIES, replacement, applyWindowsUiOverlay };
