// Module-owned private filesystem adapter. Assets are read in their original
// directory. Engine writes and deletions are confined to private saves.
#include "fscommon.hpp"
#include <filesystem>
#include <fstream>
#include <cstring>
#include <stdexcept>
#include <cstdlib>
namespace disk = std::filesystem;

static disk::path confined(const disk::path& root, disk::path name) {
    if (!root.is_absolute()) throw std::runtime_error("Nitroplus requires an absolute private directory");
    if (!name.is_absolute()) name = root / name;
    auto relative = name.lexically_normal().lexically_relative(root.lexically_normal());
    if (relative.empty() || relative.is_absolute()) throw std::runtime_error("Invalid Nitroplus file path");
    for (const auto& component : relative) if (component == "..") throw std::runtime_error("Nitroplus file escapes its private directory");
    disk::path cursor = root;
    for (const auto& component : relative) {
        cursor /= component;
        if (disk::is_symlink(disk::symlink_status(cursor))) throw std::runtime_error("Nitroplus private files cannot follow symbolic links");
    }
    return name.lexically_normal();
}

static disk::path privatePath(const std::string& value) {
    const char* directory = std::getenv("MACLAUNCHER_NPENGINE_SAVE_DIR");
    if (!directory) throw std::runtime_error("Nitroplus private save directory is missing");
    std::string normalized = value;
    for (char& c : normalized) if (c == '\\') c = '/';
    if (normalized.find(':') != std::string::npos) throw std::runtime_error("Unsupported Nitroplus drive path");
    return confined(disk::path(directory), disk::path(normalized));
}

void* DefaultAlloc(size_t Size) { return new char[Size]; }
namespace fs {
uint32_t FileSize(std::ifstream& File) {
    File.seekg(0, std::ios::end); auto size = File.tellg(); File.seekg(0, std::ios::beg);
    if (size < 0 || size > 0xffffffffLL) throw std::runtime_error("Nitroplus file size exceeds its limit");
    return static_cast<uint32_t>(size);
}
uint32_t FileSize(const string& Filename) { std::ifstream file(Filename, std::ios::binary); return file ? FileSize(file) : 0; }
char* ReadFile(const string& Filename, uint32_t& Size) {
    const auto name = privatePath(Filename); Size = 0;
    std::ifstream file(name, std::ios::binary); if (!file) return nullptr;
    Size = FileSize(file); if (Size > 32 * 1024 * 1024) throw std::runtime_error("Nitroplus save exceeds its limit");
    char* data = new char[Size];
    if (!file.read(data, Size)) { delete[] data; throw std::runtime_error("Truncated Nitroplus save"); }
    return data;
}
void WriteFile(const string& Filename, const char* pData, uint32_t Size) {
    const auto name = privatePath(Filename); disk::create_directories(name.parent_path());
    std::ofstream file(name, std::ios::binary | std::ios::trunc);
    if (!file || !file.write(pData, Size)) throw std::runtime_error("Could not write Nitroplus private file");
}
void WriteFileDirectory(const string& Filename, const char* pData, uint32_t Size) { WriteFile(Filename, pData, Size); }
bool Exists(const string& Path) { return disk::exists(privatePath(Path)); }
void CreateDirectory(const string& Path) { disk::create_directories(privatePath(Path)); }
void DeleteFile(const string& Path) { disk::remove(privatePath(Path)); }
void DeleteDirectory(const string& Path) { disk::remove_all(privatePath(Path)); }
}
