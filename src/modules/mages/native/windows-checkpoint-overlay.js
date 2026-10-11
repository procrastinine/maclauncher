const fs = require("node:fs");
const path = require("node:path");
const Native = require("../../shared/runtime/local-native");
const { replacement } = require("./windows-ui-overlay");

const ABI = "windows-sc3-checkpoint-u16-v1";
const ORIGINALS = Object.freeze({
  "CMakeLists.txt": "57a744b7decd9e10a9e18079ca9cb8a8f083aba24023741a21f072cfc99dd8db",
  "src/vm/vm.cpp": "e00fb2d10766dfe65c9323c80721a4cefd75d1ef878f9fa18462607131fd85de",
  "src/profile/vm.h": "59cb056a2a7791c8d2b98ee3dfabd692351cfc862e52bd1f905ae1e90053a1a5",
  "src/profile/vm.cpp": "0aa5cb84076e2254889bcf6709959b8cf44ef42463e392f9627c8a5790eab168"
});
const COPIES = Object.freeze({
  "src/vm/windows-checkpoint.h": "windows-checkpoint.h",
  "src/vm/windows-checkpoint.cpp": "windows-checkpoint.cpp"
});

function applyWindowsCheckpointOverlay(sourceRoot) {
  const externalPath = path.resolve(__dirname, "../../../external");
  const external = fs.existsSync(externalPath) ? fs.realpathSync(externalPath) : externalPath;
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
      throw new Error("Impacto Windows checkpoint source checksum changed: " + file);
    changes.push({ path: file, originalSha256: checksum, text: fs.readFileSync(target, "utf8") });
  }
  for (const file of Object.keys(COPIES)) {
    if (fs.existsSync(path.join(root, file))) throw new Error("Impacto Windows checkpoint source already exists.");
    if (fs.realpathSync(path.dirname(path.join(root, file))) !== path.dirname(path.join(root, file)))
      throw new Error("Impacto Windows checkpoint output parent is linked.");
  }
  for (const row of changes) {
    if (row.path === "CMakeLists.txt") {
      row.text = replacement(row.text, "    src/vm/windows-audio.cpp\n",
        "    src/vm/windows-audio.cpp\n    src/vm/windows-checkpoint.cpp\n");
      row.text = replacement(row.text, "FetchContent_MakeAvailable(libatrac9)\n",
        "if(MACLAUNCHER_ATRAC9_LIBRARY)\n" +
        '    if(NOT APPLE OR NOT EXISTS "${MACLAUNCHER_ATRAC9_LIBRARY}" OR\n' +
        '       NOT EXISTS "${MACLAUNCHER_ATRAC9_INCLUDE}/libatrac9/libatrac9.h")\n' +
        '        message(FATAL_ERROR "The Atrac9 library and headers are required.")\n' +
        "    endif()\n    add_library(atrac9 SHARED IMPORTED GLOBAL)\n" +
        "    set_target_properties(atrac9 PROPERTIES\n" +
        '        IMPORTED_LOCATION "${MACLAUNCHER_ATRAC9_LIBRARY}"\n' +
        '        INTERFACE_INCLUDE_DIRECTORIES "${MACLAUNCHER_ATRAC9_INCLUDE}")\n' +
        "else()\n    FetchContent_MakeAvailable(libatrac9)\nendif()\n");
      row.text = replacement(row.text,
        "    install(TARGETS atrac9\n            LIBRARY DESTINATION Impacto.app/Contents/Frameworks\n    )\n",
        "    if(MACLAUNCHER_ATRAC9_LIBRARY)\n" +
        '        install(FILES "${MACLAUNCHER_ATRAC9_LIBRARY}"\n' +
        "                DESTINATION Impacto.app/Contents/Frameworks)\n" +
        "    else()\n        install(TARGETS atrac9\n" +
        "                LIBRARY DESTINATION Impacto.app/Contents/Frameworks)\n    endif()\n");
    }
    if (row.path === "src/vm/vm.cpp") {
      row.text = replacement(row.text, '#include "windows-audio.h"\n',
        '#include "windows-audio.h"\n#include "windows-checkpoint.h"\n');
      row.text = replacement(row.text, "      if (!proc || proc == InstDummy) {\n",
        "      if (Profile::Vm::WindowsCheckpointOpcodeExtensions &&\n" +
        "          opcodeGrp1 == 0x10 && opcode == 0x22)\n" +
        "        proc = InstWindowsAutoSave;\n      if (!proc || proc == InstDummy) {\n");
    }
    if (row.path === "src/profile/vm.h") row.text = replacement(row.text,
      "inline bool WindowsVoiceOpcodeExtensions = false;\n",
      "inline bool WindowsVoiceOpcodeExtensions = false;\ninline bool WindowsCheckpointOpcodeExtensions = false;\n");
    if (row.path === "src/profile/vm.cpp") row.text = replacement(row.text,
      '  TryGetMember<bool>("WindowsVoiceOpcodeExtensions", WindowsVoiceOpcodeExtensions);\n',
      '  TryGetMember<bool>("WindowsVoiceOpcodeExtensions", WindowsVoiceOpcodeExtensions);\n' +
      '  TryGetMember<bool>("WindowsCheckpointOpcodeExtensions", WindowsCheckpointOpcodeExtensions);\n' +
      '  if (WindowsCheckpointOpcodeExtensions && (!WindowsOpcodeExtensions ||\n' +
      '      GameInstructionSet != Impacto::Vm::InstructionSet::SGPS3))\n' +
      '    throw std::runtime_error("Windows SC3 checkpoints require the matching instruction set.");\n');
  }
  for (const row of changes) fs.writeFileSync(path.join(root, row.path), row.text);
  for (const [file, source] of Object.entries(COPIES)) {
    fs.writeFileSync(path.join(root, file), fs.readFileSync(path.join(__dirname, source)), { flag: "wx" });
    changes.push({ path: file, originalSha256: null });
  }
  return { abi: ABI, opcodeGroup: 0x10, opcode: 0x22, checkpointType: 10, checkpointBytes: 2,
    files: changes.map(row => ({ path: row.path, originalSha256: row.originalSha256,
      adaptedSha256: Native.hashFile(path.join(root, row.path)) })) };
}

module.exports = { ABI, ORIGINALS, COPIES, applyWindowsCheckpointOverlay };
