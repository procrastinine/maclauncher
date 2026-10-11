const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const VERSION = "goldberg-mac-1.0.0-ml1-universal";
const SOURCE_REVISION = "6aab9c6ff879ceae24891b7930a222829573bddf";
const DEPENDENCIES_REVISION = "92a4a130262083c4e887155cbe6bcab99baf36ea";
const ABSEIL_REVISION = "76bb24329e8bf5f39704eb10d21b9a80befa7c81";
const ORIGINAL_SHA256 = Object.freeze({
  "goldberg_emulator/dll/local_storage.cpp": "bbf14fae90b107d1e0ba10b43c518145459b2d114d441b122817924477dda162",
  "build_mac/deps/CMakeLists.txt": "a786309f92038cce799b62382bc530a1c0e674e657488967c714520719f62e78",
  "build_mac/CMakeLists.txt": "23d7e208361ab45a4d848c473f256b5cce200068935b977571edd62f8dd94651"
});
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

function replaceOnce(text, before, after) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw new Error("Steam API overlay source differs from its reviewed input.");
  return text.slice(0, at) + after + text.slice(at + before.length);
}

/** Apply only to an owned export of the pinned, read-only source checkout. */
function applySourceOverlay(sourceRoot) {
  if (!path.isAbsolute(sourceRoot || "") || path.resolve(sourceRoot).includes(`${path.sep}src${path.sep}external${path.sep}`)) {
    throw new Error("Steam API overlays require a separate owned source export.");
  }
  const transformed = [];
  for (const [relative, expected] of Object.entries(ORIGINAL_SHA256)) {
    const file = path.join(sourceRoot, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Steam API overlay input is not a bounded regular source file.");
    const original = fs.readFileSync(file);
    if (sha256(original) !== expected) throw new Error(`Steam API overlay input changed: ${relative}`);
    let text = original.toString("utf8");
    if (relative.endsWith("local_storage.cpp")) {
      text = replaceOnce(text,
        "std::string Local_Storage::get_game_settings_path()\n{\n    return get_program_path().append(game_settings_folder).append(PATH_SEPARATOR);\n}",
        "std::string Local_Storage::get_game_settings_path()\n{\n    // MacLauncher supplies only its owned per-game configuration directory.\n    // The variable is scoped to the child process, never the launcher or source.\n    const char *owned_settings = std::getenv(\"MACLAUNCHER_STEAM_SETTINGS\");\n    if (owned_settings && owned_settings[0] == '/') {\n        std::string settings(owned_settings);\n        if (settings.back() != *PATH_SEPARATOR) settings.append(PATH_SEPARATOR);\n        return settings;\n    }\n    return get_program_path().append(game_settings_folder).append(PATH_SEPARATOR);\n}");
    } else if (relative === "build_mac/deps/CMakeLists.txt") {
      text = replaceOnce(text, "set(common_cmake_args", "string(REPLACE \";\" \"|\" ARCHS_EP \"${ARCHS}\")\n\nset(common_cmake_args");
      // ExternalProject otherwise splits the universal architecture list into
      // two command arguments and silently compiles arm64 alone.
      text = text.replaceAll("-DCMAKE_OSX_ARCHITECTURES=${ARCHS}", "-DCMAKE_OSX_ARCHITECTURES=${ARCHS_EP}");
      text = replaceOnce(text, "ExternalProject_Add(${name}\n", "ExternalProject_Add(${name}\n        LIST_SEPARATOR |\n        BUILD_COMMAND ${CMAKE_COMMAND} --build <BINARY_DIR> --parallel 2\n        INSTALL_COMMAND ${CMAKE_COMMAND} --install <BINARY_DIR>\n");
      text = replaceOnce(text, "ExternalProject_Add(abseil\n", "ExternalProject_Add(abseil\n    LIST_SEPARATOR |\n    BUILD_COMMAND ${CMAKE_COMMAND} --build <BINARY_DIR> --parallel 2\n    INSTALL_COMMAND ${CMAKE_COMMAND} --install <BINARY_DIR>\n");
      text = replaceOnce(text,
        "    GIT_REPOSITORY  https://github.com/abseil/abseil-cpp.git\n    GIT_TAG         20250512.1",
        "    SOURCE_DIR      ${MACLAUNCHER_ABSEIL_SOURCE_DIR}");
      text = replaceOnce(text, "ExternalProject_Add(abseil\n",
        "if(NOT IS_DIRECTORY \"${MACLAUNCHER_ABSEIL_SOURCE_DIR}\")\n    message(FATAL_ERROR \"Provide an exported, pinned Abseil source directory; builds do not fetch dependencies.\")\nendif()\n\nExternalProject_Add(abseil\n");
      text = text.replaceAll("-DCMAKE_BUILD_TYPE=Release\n", "-DCMAKE_BUILD_TYPE=Release\n    -DCMAKE_C_FLAGS=${CMAKE_C_FLAGS}\n    -DCMAKE_CXX_FLAGS=${CMAKE_CXX_FLAGS}\n");
    } else {
      text = replaceOnce(text, "EMU_BUILD_STRING=\"goldberg-mac-2026.08\"", `EMU_BUILD_STRING=\"${VERSION}\"`);
    }
    transformed.push({ relative, file, bytes: Buffer.from(text), beforeSha256: expected, afterSha256: sha256(text) });
  }
  // Validate all inputs before changing any file in the disposable export.
  for (const file of transformed) fs.writeFileSync(file.file, file.bytes);
  return { version: VERSION, sourceRevision: SOURCE_REVISION, dependenciesRevision: DEPENDENCIES_REVISION,
    abseilRevision: ABSEIL_REVISION,
    files: transformed.map(({ relative, beforeSha256, afterSha256 }) => ({ path: relative, beforeSha256, afterSha256 })) };
}

module.exports = { VERSION, SOURCE_REVISION, DEPENDENCIES_REVISION, ABSEIL_REVISION, ORIGINAL_SHA256, applySourceOverlay };
