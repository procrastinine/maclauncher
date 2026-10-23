const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Build = require("../../shared/runtime/pinned-native-build");
const Native = require("../../shared/runtime/local-native");

// A diagnostic development port, not yet a registered/distributable runtime.
// Upstream has no core license and includes game-specific UI art; the owned
// port removes that embedded art, but cannot establish redistribution rights.
const VERSION = "snapshot-ce7aeaf-macos-v1";
const REVISION = "ce7aeafd7cc6e65763832f7414e4d69d2c9ba48d";
const sourcePath = path.resolve(__dirname, "../../../external/FelineSystem2");

function replace(root, relative, before, after) {
  const file = path.join(root, relative), text = fs.readFileSync(file, "utf8");
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Pinned Feline overlay differs in ${relative}.`);
  fs.writeFileSync(file, text.replace(before, after));
}

function adaptSource(root) {
  for (const relative of ["src/main.cpp"]) {
    const file = path.join(root, relative); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
  }
  replace(root, "include/asmodean/asmodean.h", '#define ASMODEAN_API extern "C" __declspec(dllexport)',
    '#include <cstdint>\n#define ASMODEAN_API extern "C" __attribute__((visibility("default")))');
  replace(root, "include/asmodean/asmodean.h", "typedef   signed long       int32;", "typedef std::int32_t        int32;");
  replace(root, "include/asmodean/asmodean.h", "typedef unsigned long      uint32;", "typedef std::uint32_t       uint32;");
  replace(root, "include/file.hpp", "#define fseek64 _fseeki64\n#define ftell64 _ftelli64", "#define fseek64 fseeko\n#define ftell64 ftello");
  replace(root, "include/file.hpp", '#define KIF_DB ASSETS "kif.fs2"', '#define KIF_DB maclauncher_feline_path("MACLAUNCHER_CATSYSTEM2_INDEX")');
  replace(root, "include/utils.hpp", '#define SAVEDATA_FILENAME "savedata.json"', '#define SAVEDATA_FILENAME maclauncher_feline_save()');
  replace(root, "include/imgtypes.hpp", '#define FONT_PATH ASSETS "font.ttf"', '#define FONT_PATH maclauncher_feline_font()');
  replace(root, "src/utils.cpp", "auto res = uncompress(dest.data(), &destLen, source, sourceLen);",
    "uLongf actualLength = destLen;\n        auto res = uncompress(dest.data(), &actualLength, source, sourceLen);\n        if (actualLength != destLen) return {};");
  replace(root, "src/utils.cpp", "std::vector<byte> dest(destLen);", "if (destLen > 64 * 1024 * 1024) throw std::runtime_error(\"CatSystem2 decompressed resource exceeds its limit.\");\n        std::vector<byte> dest(destLen);");
  replace(root, "src/window.cpp", "    setWindowIcon(window);", "    // Do not compile upstream's embedded game artwork as the window icon.");
  const window = path.join(root, "src/window.cpp"), windowText = fs.readFileSync(window, "utf8");
  const begin = windowText.indexOf("void WindowManager::setWindowIcon("), end = windowText.indexOf("void WindowManager::toggleFullscreen()", begin);
  if (begin < 0 || end < begin) throw new Error("Pinned Feline window icon overlay differs.");
  fs.writeFileSync(window, windowText.slice(0, begin) + "void WindowManager::setWindowIcon(SDL_Window *) {}\n\n" + windowText.slice(end));
  replace(root, "src/window.cpp", "    if (renderer == NULL)\n    {\n        throw std::runtime_error(\"Could not create SDL renderer\");\n    }",
    '    if (renderer == NULL) renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);\n    if (renderer == NULL) throw std::runtime_error(std::string("Could not create SDL renderer: ") + SDL_GetError());');
  replace(root, "src/image.cpp", "#include <sys_mwnd.h>\n#include <sys_sel.h>\n", "");
  replace(root, "src/imgtypes.cpp", "SDL_Rect DestR{xPos, yPos, static_cast<int>(stdinfo.Width), static_cast<int>(stdinfo.Height)};",
    "SDL_Rect DestR{static_cast<int>(xPos), static_cast<int>(yPos), static_cast<int>(stdinfo.Width), static_cast<int>(stdinfo.Height)};");
  replace(root, "src/image.cpp", `    // Decode and cache choice selection asset
    processImage(sys_sel, sizeof(sys_sel), {SEL, 2});

    // Decode and cache message window assets
    processImage(sys_mwnd, sizeof(sys_mwnd), {MWND, 43});
    processImage(sys_mwnd, sizeof(sys_mwnd), {MWND_DECO, 42});`,
    `    // Generic owned rectangles replace upstream's embedded game UI art.
    createSolid(SEL, SEL_WIDTH, SEL_HEIGHT, 0xffffffff);
    createSolid(MWND, 887, 154, 0xff202020);
    createSolid(MWND_DECO, 887, 154, 0x00000000);`);
  replace(root, "src/scene.cpp", "    setScript(SCRIPT_ENTRYPOINT);",
    '    const auto entrypoint = maclauncher_feline_entrypoint();\n    if (!fileManager.inDB(entrypoint + SCRIPT_EXT)) throw std::runtime_error("This CatSystem2 layout requires a startup format not implemented by FelineSystem2.");\n    setScript(entrypoint);');
  replace(root, "src/scene.cpp", "    CSTHeader *scriptHeader = reinterpret_cast<CSTHeader *>(buf);",
    '    if (sz < sizeof(CSTHeader)) throw std::runtime_error("Truncated CatScene header.");\n    CSTHeader *scriptHeader = reinterpret_cast<CSTHeader *>(buf);\n    const size_t stored = scriptHeader->CompressedSize ? scriptHeader->CompressedSize : scriptHeader->DecompressedSize;\n    if (stored > sz - sizeof(CSTHeader) || scriptHeader->DecompressedSize > 16 * 1024 * 1024) throw std::runtime_error("CatScene payload exceeds its range.");');
  const file = path.join(root, "src/file.cpp"), fileText = fs.readFileSync(file, "utf8");
  const parseStart = fileText.indexOf("void FileManager::parseKifDb("), parseEnd = fileText.indexOf("// Read a local file", parseStart);
  if (parseStart < 0 || parseEnd < parseStart) throw new Error("Pinned Feline index parser overlay differs.");
  fs.writeFileSync(file, fileText.slice(0, parseStart) + `void FileManager::parseKifDb(byte *buf, size_t sz, SceneManager *sceneManager)
{
    if (sz > 16 * 1024 * 1024) throw std::runtime_error("CatSystem2 index exceeds its limit.");
    size_t at = 0;
    auto bytes = [&](size_t count) {
        if (count > sz - at) throw std::runtime_error("Truncated CatSystem2 index.");
        const byte *result = buf + at; at += count; return result;
    };
    auto string = [&]() {
        const auto begin = at;
        while (at < sz && buf[at] && at - begin <= 512) at++;
        if (at >= sz || at - begin > 512) throw std::runtime_error("Invalid CatSystem2 index name.");
        std::string value(reinterpret_cast<const char *>(buf + begin), at - begin); at++;
        return value;
    };
    auto integer = [&]() { uint32 result; memcpy(&result, bytes(4), 4); return result; };
    std::vector<uint32> counts;
    uint64_t total = 0;
    for (;;) {
        const auto name = string();
        if (name.empty()) break;
        if (name.find_first_of("/\\\\") != std::string::npos || name == "." || name == ".." || counts.size() >= 255)
            throw std::runtime_error("Invalid CatSystem2 archive name.");
        const auto count = integer();
        if (count > 100000 || (total += count) > 100000) throw std::runtime_error("CatSystem2 index count exceeds its limit.");
        const auto encrypted = *bytes(1);
        if (encrypted > 1) throw std::runtime_error("Invalid CatSystem2 encryption flag.");
        KifTableEntry table{name, encrypted};
        if (encrypted) memcpy(table.FileKey, bytes(4), 4);
        kifTable.push_back(table); counts.push_back(count);
    }
    for (size_t archive = 0; archive < counts.size(); archive++) {
        for (uint32 entry = 0; entry < counts[archive]; entry++) {
            auto name = string();
            if (name.empty()) throw std::runtime_error("Empty CatSystem2 asset name.");
            const auto offset = integer(), length = integer();
            Utils::lowercase(name);
            kifDb[name] = KifDbEntry{offset, length, static_cast<unsigned char>(archive)};
        }
    }
    if (at != sz) throw std::runtime_error("Trailing CatSystem2 index data.");
    LOG << "Parsed " << kifDb.size() << " KIF entries";
    sceneManager->start();
}

` + fileText.slice(parseEnd));
  replace(root, "src/file.cpp", "    // Seek to starting offset (default 0)",
    '    if (length > 64 * 1024 * 1024) { fclose(fp); throw std::runtime_error("CatSystem2 asset exceeds its read limit."); }\n    fseek64(fp, 0, SEEK_END);\n    const auto fileLength = ftell64(fp);\n    if (fileLength < 0 || offset > static_cast<uint64_t>(fileLength) || length > static_cast<uint64_t>(fileLength) - offset) { fclose(fp); throw std::runtime_error("CatSystem2 asset escapes its original archive."); }\n\n    // Seek to starting offset (default 0)');
  replace(root, "src/file.cpp", "    fread(buf.data(), 1, length, fp);", '    if (fread(buf.data(), 1, length, fp) != length) { fclose(fp); throw std::runtime_error("Truncated original CatSystem2 asset."); }');
  const main = path.join(root, "src/main.cpp");
  let mainText = fs.readFileSync(main, "utf8");
  const managersStart = mainText.indexOf("static FileManager fileManager;"), managersEnd = mainText.indexOf("void main_loop()", managersStart);
  if (managersStart < 0 || managersEnd < managersStart) throw new Error("Pinned Feline initialization overlay differs.");
  mainText = mainText.slice(0, managersStart) + `#include <memory>
static std::unique_ptr<FileManager> fileManager;
static std::unique_ptr<WindowManager> windowManager;
static std::unique_ptr<AudioManager> audioManager;
static std::unique_ptr<ImageManager> imageManager;
static std::unique_ptr<SceneManager> sceneManager;

` + mainText.slice(managersEnd);
  for (const variable of ["sceneManager", "imageManager", "windowManager"]) mainText = mainText.replaceAll(`${variable}.`, `${variable}->`);
  mainText = mainText.replace("int main(int argc, char **argv)\n{", `int main(int argc, char **argv)
{
    if (argc == 2 && std::string(argv[1]) == "--version") { std::cout << "FelineSystem2 ${VERSION} ${REVISION}" << std::endl; return 0; }
    try {
    fileManager = std::make_unique<FileManager>();
    windowManager = std::make_unique<WindowManager>();
    audioManager = std::make_unique<AudioManager>(*fileManager);
    imageManager = std::make_unique<ImageManager>(*fileManager, windowManager->getRenderer(), currChoices);
    sceneManager = std::make_unique<SceneManager>(*audioManager, *imageManager, *fileManager, currChoices);`);
  mainText = mainText.replace("    return 0;\n}", '    return 0;\n    } catch (const std::exception &error) { std::cerr << "CatSystem2 native diagnostic: " << error.what() << std::endl; SDL_Quit(); return 2; }\n}');
  fs.writeFileSync(main, mainText);
  fs.copyFileSync(path.join(__dirname, "macos-paths.h"), path.join(root, "maclauncher-paths.h"));
}

async function buildDiagnostic({ sourceDir = sourcePath, outputDir, signal } = {}) {
  if (process.platform !== "darwin") throw new Error("Feline native diagnostic builds require macOS.");
  if (!path.isAbsolute(outputDir || "") || sourceDir === outputDir || outputDir.startsWith(sourceDir + path.sep) || sourceDir.startsWith(outputDir + path.sep))
    throw new Error("A separate absolute diagnostic output directory is required.");
  const source = await Build.validatePinnedSource(sourceDir, REVISION, { signal });
  const staged = path.join(outputDir, "build-source");
  if (fs.existsSync(staged)) throw new Error("Choose a fresh diagnostic output directory.");
  fs.mkdirSync(outputDir, { recursive: true });
  const sourceTreeSha256 = Build.stagePinnedFiles(sourceDir, source.files, staged); adaptSource(staged);
  const overlaySha256 = crypto.createHash("sha256").update(fs.readFileSync(__filename)).update(fs.readFileSync(path.join(__dirname, "macos-paths.h"))).digest("hex");
  const pkgConfig = Build.findBuildTool("pkg-config"), clang = "/usr/bin/clang++";
  const flags = execFileSync(pkgConfig, ["--cflags", "--libs", "sdl2", "SDL2_mixer", "SDL2_ttf", "zlib"], { encoding: "utf8" }).trim().split(/\s+/);
  if (flags.some(flag => !/^[-\w./+=:,]+$/.test(flag))) throw new Error("Unsupported native dependency build flags.");
  const files = source.files.filter(file => /^src\/(?:asmodean\/)?[^/]+\.cpp$/.test(file)).map(file => path.join(staged, file));
  const executablePath = path.join(outputDir, "feline-system2"), logPath = path.join(outputDir, "build.log");
  fs.writeFileSync(logPath, `Diagnostic ${VERSION}\nPinned source ${REVISION}\nSource tree ${sourceTreeSha256}\nOverlay ${overlaySha256}\n`);
  const args = ["-std=c++17", "-O2", "-mmacosx-version-min=13.0", "-I" + path.join(staged, "include"), "-I" + path.join(staged, "include/asmodean"), "-include", path.join(staged, "maclauncher-paths.h"), ...files, ...flags, "-o", executablePath];
  await Build.runBuildCommand(clang, args, { cwd: outputDir, logPath, env: process.env, signal });
  await Build.validatePinnedSource(sourceDir, REVISION, { signal });
  const result = { version: VERSION, sourceRevision: REVISION, sourceTreeSha256, overlaySha256, hostArch: process.arch,
    executablePath, executableSha256: Native.hashFile(executablePath), dependencyFlags: flags, logPath,
    diagnosticOnly: true, redistributable: false, reason: "Core license and complete modern FES/KCS/E-mote startup support remain unresolved." };
  fs.writeFileSync(path.join(outputDir, "build-proof.json"), JSON.stringify(result, null, 2) + "\n"); return result;
}

module.exports = { VERSION, REVISION, sourcePath, adaptSource, buildDiagnostic };
