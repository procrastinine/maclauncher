#pragma once
#include <cstdlib>
#include <stdexcept>
#include <string>

// These paths are supplied before native manager initialization. The source
// game is always read-only; the index, font and mutable state have separate roots.
static inline std::string maclauncher_feline_path(const char *key) {
    const char *value = std::getenv(key);
    if (!value || value[0] != '/') throw std::runtime_error(std::string("Missing absolute ") + key);
    return value;
}
static inline std::string maclauncher_feline_assets() {
    std::string root = maclauncher_feline_path("MACLAUNCHER_CATSYSTEM2_ASSETS");
    if (root.back() != '/') root += '/';
    return root;
}
static inline const char *maclauncher_feline_save() {
    static const std::string value = maclauncher_feline_path("MACLAUNCHER_CATSYSTEM2_SAVE");
    return value.c_str();
}
static inline const char *maclauncher_feline_font() {
    static const std::string value = maclauncher_feline_path("MACLAUNCHER_CATSYSTEM2_FONT");
    return value.c_str();
}
static inline std::string maclauncher_feline_entrypoint() {
    const char *value = std::getenv("MACLAUNCHER_CATSYSTEM2_SCRIPT");
    const std::string script = value && *value ? value : "start";
    if (script.size() > 128 || script.find_first_of("/\\") != std::string::npos || script == "." || script == "..")
        throw std::runtime_error("Invalid native CatScene entrypoint.");
    return script;
}

#define ASSETS maclauncher_feline_assets()
