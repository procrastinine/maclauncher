#pragma once
#include "effect_module.hpp"
#include <map>
#include <string>
#include <vector>

namespace macfx {
struct Shader {
    reshadefx::shader_type type;
    std::string glsl, msl;
    std::map<std::string, unsigned> textures;
    std::map<std::string, std::string> uniformNames;
    std::string mslEntry;
    unsigned mslUniformBuffer = ~0u;
    unsigned colorComponents = 4;
    std::map<unsigned, unsigned> mslTextures, mslSamplers;
    std::map<unsigned, unsigned> mslStorageTextures;
    unsigned mslThreads[3] = {};
};
struct Effect {
    reshadefx::effect_module module;
    std::map<std::string, Shader> shaders;
    std::vector<unsigned char> uniforms;
};
Effect compile(const std::string &file, unsigned width, unsigned height,
               unsigned glslVersion, const std::vector<std::string> &includes);
std::vector<std::string> includePaths();
std::string prepare(const std::string &file, const std::vector<std::string> &includes);
void loadPrepared(const std::string &file, const std::string &preparedFile);
}
