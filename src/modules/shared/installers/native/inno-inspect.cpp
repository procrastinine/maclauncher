// MacLauncher's bounded JSON reader for the pinned Zlib-licensed innoextract.
// It reads installer data; it never runs installer code or writes game files.
#include "loader/offsets.hpp"
#include "setup/info.hpp"
#include "setup/file.hpp"
#include "setup/data.hpp"
#include "setup/filename.hpp"
#include "stream/slice.hpp"
#include "util/fstream.hpp"
#include "cli/goggalaxy.hpp"
#include <algorithm>
#include <iostream>
#include <set>
#include <sstream>
#include <stdexcept>
#include <boost/filesystem/path.hpp>
#include <boost/version.hpp>

static_assert(BOOST_VERSION == 109200, "Use the pinned Boost 1.92 source/header profile");
namespace {
const char* Profile = "1.10-dev-6e9e34ed-macos-v1";
const char* Revision = "6e9e34ed0876014fdb46e684103ef8c3605e382e";
std::string quoted(const std::string& value) {
    std::string out = "\"";
    const char* hex = "0123456789abcdef";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
        else if (c < 32) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
        else out += char(c);
    }
    return out + '"';
}
std::string storedBase(std::string value) {
    std::replace(value.begin(), value.end(), '/', '_');
    std::replace(value.begin(), value.end(), '\\', '_');
    return value;
}
void inspect(const boost::filesystem::path& input) {
    util::ifstream inputStream(input, std::ios::in | std::ios::binary);
    if (!inputStream.is_open()) throw std::runtime_error("Could not read the installer");
    loader::offsets offsets; offsets.load(inputStream);
    inputStream.seekg(offsets.header_offset);
    setup::info info;
    info.load(inputStream, setup::info::Files | setup::info::Directories | setup::info::DataEntries | setup::info::NoUnknownVersion);
    gog::parse_galaxy_files(info, true);
    if (info.files.size() > 100000 || info.data_entries.size() > 100000) throw std::runtime_error("Installer entry limit exceeded");
    std::set<unsigned> slices;
    if (!offsets.data_offset) {
        if (!info.header.slices_per_disk || info.header.slices_per_disk > 256) throw std::runtime_error("Invalid installer slice layout");
        for (const auto& item : info.data_entries) {
            if (item.chunk.last_slice < item.chunk.first_slice || item.chunk.last_slice - item.chunk.first_slice > 512) throw std::runtime_error("Installer slice limit exceeded");
            for (unsigned n = item.chunk.first_slice; n <= item.chunk.last_slice; ++n) {
                slices.insert(n);
                if (slices.size() > 512 || n == 0xffffffffu) throw std::runtime_error("Installer slice limit exceeded");
            }
        }
    }
    std::string first = input.stem().string(), second = storedBase(info.header.base_filename);
    if (info.version < INNO_VERSION(4, 1, 7) && !second.empty()) std::swap(first, second);
    std::ostringstream version; version << info.version;
    std::cout << "{\"schemaVersion\":1,\"helperVersion\":" << quoted(Profile) << ",\"sourceRevision\":" << quoted(Revision)
      << ",\"format\":\"inno\",\"formatVersion\":" << quoted(version.str())
      << ",\"title\":" << quoted(info.header.app_name) << ",\"productVersion\":" << quoted(info.header.app_version)
      << ",\"headerOffset\":" << offsets.header_offset << ",\"dataOffset\":" << offsets.data_offset
      << ",\"externalData\":" << (offsets.data_offset ? "false" : "true")
      << ",\"encrypted\":" << ((info.header.options & setup::header::EncryptionUsed) ? "true" : "false")
      << ",\"requiredSlices\":[";
    bool comma = false;
    for (const auto slice : slices) {
        if (comma) std::cout << ','; comma = true;
        const auto filename = stream::slice_reader::slice_filename(first, slice, info.header.slices_per_disk);
        const auto alternate = second.empty() ? std::string() : stream::slice_reader::slice_filename(second, slice, info.header.slices_per_disk);
        std::cout << "{\"index\":" << slice << ",\"names\":[" << quoted(filename);
        if (!alternate.empty() && alternate != filename) std::cout << ',' << quoted(alternate);
        std::cout << "]}";
    }
    std::cout << "],\"files\":[";
    setup::filename_map filenames; filenames.set_expand(true);
    comma = false;
    for (const auto& file : info.files) {
        if (file.destination.empty() || file.type != setup::file_entry::UserFile || (file.options & setup::file_entry::DontCopy)) continue;
        if (file.location >= info.data_entries.size()) throw std::runtime_error("Installer file references missing data");
        const auto& data = info.data_entries[file.location];
        if (comma) std::cout << ','; comma = true;
        std::cout << "{\"path\":" << quoted(filenames.convert(file.destination)) << ",\"authoredPath\":" << quoted(file.destination)
          << ",\"size\":" << (file.additional_locations.empty() ? data.uncompressed_size : file.size) << ",\"location\":" << file.location << "}";
    }
    std::cout << "]}" << std::endl;
}
}
int main(int argc, char** argv) {
    try {
        if (argc == 2 && std::string(argv[1]) == "--version") { std::cout << "MacLauncher innoextract " << Profile << " / " << Revision << std::endl; return 0; }
        if (argc != 3 || std::string(argv[1]) != "--inspect-json") throw std::runtime_error("Use --inspect-json with one installer file");
        inspect(boost::filesystem::path(argv[2])); return 0;
    } catch (const std::exception& error) { std::cerr << "Installer: " << error.what() << std::endl; return 1; }
}
