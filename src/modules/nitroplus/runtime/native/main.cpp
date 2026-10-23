// Generic unencrypted NPA v1/NSS host for the pinned LGPL libnpengine library.
// No game assets or scripts are patched or extracted for normal play.
#include "Window.hpp"
#include "NSBInterpreter.hpp"
#include "ResourceMgr.hpp"
#include "scriptfile.hpp"
#include "npafile.hpp"
#include "Text.hpp"
#include <filesystem>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <algorithm>
#include <iostream>
#include <cstdlib>
#include <cstring>
#include <zlib.h>

namespace disk = std::filesystem;
static std::string lower(std::string value) {
    for (char& c : value) { if (c == '\\') c = '/'; if (c >= 'A' && c <= 'Z') c += 'a' - 'A'; }
    return value;
}
static bool safe(const std::string& name) {
    if (name.empty() || name.front() == '/' || name.find(':') != std::string::npos || name.find('\0') != std::string::npos) return false;
    for (const auto& part : disk::path(name)) if (part == ".." || part == ".") return false;
    return true;
}
static uint32_t u32(const char* bytes) {
    const auto b = reinterpret_cast<const unsigned char*>(bytes);
    return uint32_t(b[0]) | uint32_t(b[1]) << 8 | uint32_t(b[2]) << 16 | uint32_t(b[3]) << 24;
}
class Archive final : public INpaFile {
    struct Record : Entry { uint32_t packed; bool directory; };
    uint32_t dataStart;
    bool compressed;
public:
    const std::string prefix;
    Archive(const std::string& name) : INpaFile(name), prefix(lower(disk::path(name).stem().string())) {
        std::ifstream file(name, std::ios::binary); char header[41];
        if (!file.read(header, 41) || std::memcmp(header, "NPA\1\0\0\0", 7)) throw std::runtime_error("Invalid NPA v1 archive");
        if (header[16]) throw std::runtime_error("Encrypted NPA payload has no reviewed native profile");
        compressed = header[15];
        uint32_t count = u32(header + 17), size = u32(header + 37);
        if (!count || count > 16384 || size > 2 * 1024 * 1024 || size < count * 22) throw std::runtime_error("NPA index exceeds its limit");
        std::vector<char> table(size);
        if (!file.read(table.data(), size)) throw std::runtime_error("Truncated NPA index");
        dataStart = 41 + size;
        file.seekg(0, std::ios::end); auto total = file.tellg();
        uint32_t product = u32(header + 7) * u32(header + 11);
        uint32_t sum = (product & 255) + ((product >> 8) & 255) + ((product >> 16) & 255) + (product >> 24);
        size_t cursor = 0;
        for (uint32_t i = 0; i < count; i++) {
            if (cursor + 4 > size) throw std::runtime_error("Invalid NPA index range");
            uint32_t length = u32(table.data() + cursor); cursor += 4;
            if (!length || length > 1024 || cursor + length + 17 > size) throw std::runtime_error("Invalid NPA filename");
            std::string encoded(table.data() + cursor, length); cursor += length;
            uint32_t fileSum = (i & 255) + ((i >> 8) & 255) + ((i >> 16) & 255) + (i >> 24);
            for (uint32_t x = 0; x < length; x++) encoded[x] = static_cast<unsigned char>(encoded[x]) + 0xfc * x - sum - fileSum;
            auto key = lower(NpaFile::ToUtf8(encoded));
            if (!safe(key) || Registry.count(key)) throw std::runtime_error("Unsafe or ambiguous NPA filename");
            auto record = std::make_unique<Record>();
            record->directory = table[cursor] == 1;
            if (table[cursor] != 1 && table[cursor] != 2) throw std::runtime_error("Invalid NPA entry type");
            record->Offset = u32(table.data() + cursor + 5); record->packed = u32(table.data() + cursor + 9);
            record->Size = u32(table.data() + cursor + 13); cursor += 17;
            if (uint64_t(dataStart) + record->Offset + record->packed > uint64_t(total) || (!compressed && record->packed != record->Size)) throw std::runtime_error("NPA entry escapes its archive");
            Registry[key] = record.release();
        }
        if (cursor != size) throw std::runtime_error("NPA index has unconsumed bytes");
    }
    bool IsDirectory(NpaIterator item) override { return static_cast<Record*>(item->second)->directory; }
    char* ReadFile(NpaIterator item) override { return ReadData(item, 0, static_cast<Record*>(item->second)->Size); }
    char* ReadData(NpaIterator item, uint32_t offset, uint32_t size, void* (*allocate)(size_t) = DefaultAlloc) override {
        const auto record = static_cast<Record*>(item->second);
        if (record->directory || offset > record->Size || size > record->Size - offset || size > 32 * 1024 * 1024 || (compressed && offset)) return nullptr;
        std::ifstream file(Name, std::ios::binary);
        file.seekg(uint64_t(dataStart) + record->Offset + (compressed ? 0 : offset));
        auto result = static_cast<char*>(allocate(size));
        if (compressed) {
            if (record->packed > 32 * 1024 * 1024 || size != record->Size) throw std::runtime_error("Compressed NPA partial reads are unsupported");
            std::vector<unsigned char> packed(record->packed); uLongf actual = size;
            if (!file.read(reinterpret_cast<char*>(packed.data()), packed.size()) || uncompress(reinterpret_cast<Bytef*>(result), &actual, packed.data(), packed.size()) != Z_OK || actual != size) throw std::runtime_error("Invalid compressed NPA entry");
        } else if (!file.read(result, size)) throw std::runtime_error("Truncated NPA payload");
        return result;
    }
};

class Resources final : public ResourceMgr {
    std::vector<Archive*> archiveList;
    std::pair<Archive*, INpaFile::NpaIterator> find(std::string name) {
        name = lower(name); const auto slash = name.find('/');
        auto visit = [&](bool prefixed) -> std::pair<Archive*, INpaFile::NpaIterator> {
            for (auto archive : archiveList) {
                const bool matches = slash != std::string::npos && name.substr(0, slash) == archive->prefix;
                if (matches != prefixed) continue;
                const auto relative = matches ? name.substr(slash + 1) : name;
                auto item = archive->FindFile(relative);
                if (item != archive->End() && !archive->IsDirectory(item)) return {archive, item};
            }
            return {nullptr, archiveList.front()->End()};
        };
        auto result = visit(true); return result.first ? result : visit(false);
    }
protected:
    ScriptFile* ReadScriptFile(const std::string& path) override {
        uint32_t size = 0; std::unique_ptr<char[]> data(Read(path, size));
        if (!data || size > 4 * 1024 * 1024) throw std::runtime_error("Missing or oversized NSS script: " + path);
        std::string source = NpaFile::ToUtf8(data.get(), size);
        std::cout << "Compile " << path << std::endl;
        return new ScriptFile(path, source.c_str(), source.size());
    }
public:
    explicit Resources(const disk::path& root) {
        std::vector<disk::path> files;
        for (const auto& entry : disk::directory_iterator(root)) {
            if (entry.is_regular_file() && !entry.is_symlink() && lower(entry.path().extension().string()) == ".npa") files.push_back(entry.path());
        }
        std::sort(files.begin(), files.end());
        if (files.empty() || files.size() > 64) throw std::runtime_error("Nitroplus needs a bounded NPA archive collection");
        for (const auto& file : files) {
            auto archive = new Archive(file.string()); Archives.push_back(archive); archiveList.push_back(archive);
        }
    }
    char* Read(std::string name, uint32_t& size) override {
        auto found = find(name); if (!found.first) { size = 0; return nullptr; }
        size = found.first->GetFileSize(found.second); return found.first->ReadFile(found.second);
    }
    Resource GetResource(std::string name) override {
        auto found = find(name); return Resource(found.first, found.second);
    }
    void checkScripts() {
        uint32_t count = 0;
        for (auto archive : archiveList) for (auto item = archive->Begin(); item != archive->End(); ++item) {
            if (!archive->IsDirectory(item) && lower(disk::path(item->first).extension().string()) == ".nss") { GetScriptFile(archive->prefix + "/" + item->first); count++; }
        }
        std::cout << "Checked " << count << " NSS scripts with libnpengine 0.5.3 Mac v7" << std::endl;
    }
};

struct Defaults {
    int bgm = 700, sound = 700, voice = 1000, fontSize = 18, fontWeight = 500;
    std::string fontFace = "sans-serif";
};
class GameInterpreter final : public NSBInterpreter {
public:
    GameInterpreter(Window* window, const Defaults& values) : NSBInterpreter(window) {
        SetString("#SYSTEM_save_path", std::getenv("MACLAUNCHER_NPENGINE_SAVE_DIR"));
        for (const auto& volume : std::vector<std::pair<std::string, int>>{{"bgm", values.bgm}, {"se", values.sound}, {"voice", values.voice}}) {
            SetInt("#SYSTEM_sound_volume_" + volume.first, volume.second);
            SetInt("#SYSTEM_sound_volume_" + volume.first + "_default", volume.second);
        }
        Text::dFont = values.fontFace; Text::dSize = values.fontSize; Text::dWeight = values.fontWeight;
        Text::dInColor = 0xffffff; Text::dOutColor = 0;
    }
};
class GameWindow final : public Window {
public:
    GameWindow(const char* title, int width, int height, const std::string& boot, const Defaults& values) : Window(title, width, height) {
        pInterpreter = new GameInterpreter(this, values); pInterpreter->ExecuteScript(boot);
    }
};

int main(int argc, char** argv) {
    try {
        std::string root, saves, boot = "nss/boot.nss", title = "Nitroplus"; int width = 800, height = 600; bool check = false, checkBoot = false; Defaults values;
        for (int i = 1; i < argc; i++) {
            const std::string option = argv[i];
            if (option == "--version") { std::cout << "libnpengine 0.5.3 Mac v7 / da1a175e6b497c37f9714b77510cb47c0930cd42 / libnpa 5bdf666155d828d9ef4003fd9dc39e154aa4b0f1" << std::endl; return 0; }
            if (option == "--check-scripts") { check = true; continue; }
            if (option == "--check-bootstrap") { checkBoot = true; continue; }
            if (i + 1 >= argc) throw std::runtime_error("Missing Nitroplus option value");
            const std::string value = argv[++i];
            if (option == "--game-root") root = value; else if (option == "--save-dir") saves = value;
            else if (option == "--boot") boot = value; else if (option == "--title") title = value;
            else if (option == "--width") width = std::stoi(value); else if (option == "--height") height = std::stoi(value);
            else if (option == "--bgm-volume") values.bgm = std::stoi(value); else if (option == "--sound-volume") values.sound = std::stoi(value);
            else if (option == "--voice-volume") values.voice = std::stoi(value); else if (option == "--font-size") values.fontSize = std::stoi(value);
            else if (option == "--font-weight") values.fontWeight = std::stoi(value); else if (option == "--font-face") values.fontFace = value;
            else throw std::runtime_error("Unknown Nitroplus option " + option);
        }
        if (!disk::path(root).is_absolute() || !disk::path(saves).is_absolute() || !safe(boot) || width < 320 || width > 3840 || height < 240 || height > 2160) throw std::runtime_error("Choose absolute Nitroplus game/save paths and a valid NSS boot script");
        for (auto volume : {values.bgm, values.sound, values.voice}) if (volume < 0 || volume > 1000) throw std::runtime_error("Nitroplus volume must be between 0 and 1000");
        if (values.fontSize < 8 || values.fontSize > 128 || values.fontWeight < 100 || values.fontWeight > 1000) throw std::runtime_error("Invalid Nitroplus font metrics");
        disk::create_directories(saves); setenv("MACLAUNCHER_NPENGINE_SAVE_DIR", saves.c_str(), 1);
        NpaFile::SetLocale("ja_JP.CP932");
        auto resources = std::make_unique<Resources>(disk::canonical(root)); sResourceMgr = resources.get();
        if (check) { resources->checkScripts(); return 0; }
        if (checkBoot) { resources->GetScriptFile(boot); std::cout << "Checked native NSS bootstrap and its include graph" << std::endl; return 0; }
        GameWindow window(title.c_str(), width, height, boot, values); window.Run(); sResourceMgr = nullptr;
        return 0;
    } catch (const std::exception& error) { std::cerr << "Nitroplus: " << error.what() << std::endl; return 1; }
}
