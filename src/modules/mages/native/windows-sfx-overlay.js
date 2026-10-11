const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const { replacement } = require("./windows-ui-overlay");

const ABI = "windows-sc3-sfx-v1";
const ORIGINALS = Object.freeze({
  "CMakeLists.txt": "f890c89ef8d2dd7f753d6acc98a91b13dbf9d8fdd6bfd6f872555e6b1f40d358",
  "src/vm/vm.cpp": "189cbcac03004b02c5fe17c29e44dfd10065d99d85210197a921595963bd3450",
  "src/profile/vm.h": "b81f7ed9e0b00cbb259da377f06b030982475b2301fc06a924c8d3b108959971",
  "src/profile/vm.cpp": "5c7c6bc96a4d4b612436bf2af7a01c63b17d6fe728b183bdde3ac041981dd4c4"
});
const COPIES = Object.freeze({ "src/vm/windows-sfx.h": "windows-sfx.h",
  "src/vm/windows-sfx.cpp": "windows-sfx.cpp" });

function applyWindowsSoundEffectOverlay(sourceRoot) {
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
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target ||
        stat.nlink !== 1 || Native.hashFile(target) !== checksum)
      throw new Error("Impacto Windows sound-effect source checksum changed: " + file);
    changes.push({ path: file, originalSha256: checksum, text: fs.readFileSync(target, "utf8") });
  }
  for (const file of Object.keys(COPIES)) {
    if (fs.existsSync(path.join(root, file))) throw new Error("Impacto Windows sound-effect source already exists.");
    if (fs.realpathSync(path.dirname(path.join(root, file))) !== path.dirname(path.join(root, file)))
      throw new Error("Impacto Windows sound-effect output parent is linked.");
  }
  for (const row of changes) {
    if (row.path === "CMakeLists.txt") row.text = replacement(row.text,
      "    src/vm/windows-audio.cpp\n", "    src/vm/windows-audio.cpp\n    src/vm/windows-sfx.cpp\n");
    if (row.path === "src/vm/vm.cpp") {
      row.text = replacement(row.text, '#include "windows-audio.h"\n',
        '#include "windows-audio.h"\n#include "windows-sfx.h"\n');
      row.text = replacement(row.text, "      if (!proc || proc == InstDummy) {\n",
        "      if (Profile::Vm::WindowsSoundEffectOpcodeExtensions && opcodeGrp1 == 0 && opcode == 0x23)\n" +
        "        proc = InstWindowsSePlay;\n      if (!proc || proc == InstDummy) {\n");
    }
    if (row.path === "src/profile/vm.h") row.text = replacement(row.text,
      "inline bool WindowsCheckpointOpcodeExtensions = false;\n",
      "inline bool WindowsCheckpointOpcodeExtensions = false;\ninline bool WindowsSoundEffectOpcodeExtensions = false;\n");
    if (row.path === "src/profile/vm.cpp") row.text = replacement(row.text,
      '  TryGetMember<bool>("WindowsCheckpointOpcodeExtensions", WindowsCheckpointOpcodeExtensions);\n',
      '  TryGetMember<bool>("WindowsSoundEffectOpcodeExtensions", WindowsSoundEffectOpcodeExtensions);\n' +
      '  if (WindowsSoundEffectOpcodeExtensions && (!WindowsOpcodeExtensions ||\n' +
      '      GameInstructionSet != Impacto::Vm::InstructionSet::SGPS3))\n' +
      '    throw std::runtime_error("Windows SC3 sound-effect opcodes require the matching instruction set.");\n' +
      '  TryGetMember<bool>("WindowsCheckpointOpcodeExtensions", WindowsCheckpointOpcodeExtensions);\n');
  }
  for (const row of changes) fs.writeFileSync(path.join(root, row.path), row.text);
  for (const [file, source] of Object.entries(COPIES)) {
    fs.writeFileSync(path.join(root, file), fs.readFileSync(path.join(__dirname, source)), { flag: "wx" });
    changes.push({ path: file, originalSha256: null });
  }
  return { abi: ABI, opcodes: [0x23], channels: [0, 1, 2], types: [0, 1, 2],
    files: changes.map(row => ({ path: row.path, originalSha256: row.originalSha256,
      adaptedSha256: Native.hashFile(path.join(root, row.path)) })) };
}

module.exports = { ABI, ORIGINALS, COPIES, applyWindowsSoundEffectOverlay };
