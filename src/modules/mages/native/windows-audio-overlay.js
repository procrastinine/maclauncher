const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const { replacement } = require("./windows-ui-overlay");

const ABI = "windows-sc3-voice-v1";
const ORIGINALS = Object.freeze({
  "CMakeLists.txt": "67009ad7a9d1d32128bc2f29d879ab6ead6cbcc3e6ee08d1f78252160655dc3f",
  "src/vm/vm.cpp": "f6547538840c90cad81c60adc13385e9cf16b8fbd36e444fe76798d410d4d1de",
  "src/profile/vm.h": "b95b7a6284571a9990734dae3b3c22a5b66dc6fee61f9fc0b9e60aabe212096a",
  "src/profile/vm.cpp": "0a6b4c0bda1a843a43723bfd08839839ca314d4b5a5e5c19c275ae936868f102"
});
const COPIES = Object.freeze({
  "src/vm/windows-audio.h": "windows-audio.h",
  "src/vm/windows-audio.cpp": "windows-audio.cpp"
});

function applyWindowsAudioOverlay(sourceRoot) {
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
      throw new Error("Impacto Windows audio source checksum changed: " + file);
    changes.push({ path: file, originalSha256: checksum, text: fs.readFileSync(target, "utf8") });
  }
  for (const file of Object.keys(COPIES)) {
    if (fs.existsSync(path.join(root, file))) throw new Error("Impacto Windows audio source already exists.");
    const parent = path.dirname(path.join(root, file));
    if (fs.realpathSync(parent) !== parent) throw new Error("Impacto Windows audio output parent is linked.");
  }
  for (const row of changes) {
    if (row.path === "CMakeLists.txt") row.text = replacement(row.text,
      "    src/vm/windows-input.cpp\n", "    src/vm/windows-input.cpp\n    src/vm/windows-audio.cpp\n");
    if (row.path === "src/vm/vm.cpp") {
      row.text = replacement(row.text, '#include "inst_system.h"\n',
        '#include "inst_system.h"\n#include "windows-audio.h"\n');
      row.text = replacement(row.text, "      if (!proc || proc == InstDummy) {\n",
        "      if (Profile::Vm::WindowsVoiceOpcodeExtensions && opcodeGrp1 == 0) {\n" +
        "        if (opcode == 0x37) proc = InstWindowsVoicePlay;\n" +
        "        if (opcode == 0x38) proc = InstWindowsVoiceStop;\n" +
        "        if (opcode == 0x39) proc = InstWindowsVoiceWait;\n" +
        "      }\n      if (!proc || proc == InstDummy) {\n");
    }
    if (row.path === "src/profile/vm.h") row.text = replacement(row.text,
      "inline bool WindowsOpcodeExtensions = false;\n",
      "inline bool WindowsOpcodeExtensions = false;\ninline bool WindowsVoiceOpcodeExtensions = false;\n");
    if (row.path === "src/profile/vm.cpp") {
      row.text = replacement(row.text, '#include "../vm/windows-input.h"\n',
        '#include "../vm/windows-input.h"\n#include <stdexcept>\n');
      row.text = replacement(row.text,
        '  TryGetMember<bool>("WindowsOpcodeExtensions", WindowsOpcodeExtensions);\n',
        '  TryGetMember<bool>("WindowsOpcodeExtensions", WindowsOpcodeExtensions);\n' +
        '  TryGetMember<bool>("WindowsVoiceOpcodeExtensions", WindowsVoiceOpcodeExtensions);\n' +
        '  if (WindowsVoiceOpcodeExtensions && (!WindowsOpcodeExtensions ||\n' +
        '      GameInstructionSet != Impacto::Vm::InstructionSet::SGPS3))\n' +
        '    throw std::runtime_error("Windows SC3 voice opcodes require the matching instruction set.");\n');
    }
  }
  for (const row of changes) fs.writeFileSync(path.join(root, row.path), row.text);
  for (const [file, source] of Object.entries(COPIES)) {
    const target = path.join(root, file);
    fs.writeFileSync(target, fs.readFileSync(path.join(__dirname, source)), { flag: "wx" });
    changes.push({ path: file, originalSha256: null });
  }
  return { abi: ABI, opcodes: [0x37, 0x38, 0x39],
    files: changes.map(row => ({ path: row.path, originalSha256: row.originalSha256,
      adaptedSha256: Native.hashFile(path.join(root, row.path)) })) };
}

module.exports = { ABI, ORIGINALS, COPIES, applyWindowsAudioOverlay };
