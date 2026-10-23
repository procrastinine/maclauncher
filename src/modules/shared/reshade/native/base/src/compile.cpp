#include "lossless.hpp"
#include "effect.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
int main(int argc, char **argv) {
    if(argc==3 && std::string(argv[1])=="--inspect-lossless") return macfx::inspectLossless(argv[2],std::cout);
    try {
        if(argc==4 && std::string(argv[1])=="--prepare") {
            const auto source=macfx::prepare(argv[2],macfx::includePaths());
            std::ofstream output(argv[3]); output<<source;
            if(!output) throw std::runtime_error("Cannot write the prepared effect");
            return 0;
        }
        if (argc < 3) { std::cerr << "Usage: fx-compile EFFECT.fx OUTPUT_DIRECTORY [GLSL_VERSION]\n"; return 2; }
        const auto effect = macfx::compile(argv[1], 1280, 720, argc > 3 ? std::stoi(argv[3]) : 410, macfx::includePaths());
        std::filesystem::create_directories(argv[2]);
        for (const auto &entry : effect.shaders) {
            std::ofstream(std::filesystem::path(argv[2]) / (entry.first + ".glsl")) << entry.second.glsl;
            std::ofstream(std::filesystem::path(argv[2]) / (entry.first + ".metal")) << entry.second.msl;
        }
        for (const auto &technique : effect.module.techniques) {
            std::cout << technique.name << ": " << technique.passes.size() << " passes\n";
            for (const auto &pass : technique.passes)
                std::cout << "  " << pass.vs_entry_point << " + " << pass.ps_entry_point << " -> "
                          << (pass.render_target_names[0].empty() ? "COLOR" : pass.render_target_names[0]) << '\n';
            for(const auto &pass:technique.passes) for(const auto &binding:pass.texture_bindings)
                std::cout<<"  texture binding "<<binding.entry_point_binding<<" sampler "<<binding.index<<'\n';
        }
        std::cout << effect.module.uniforms.size() << " uniforms, " << effect.shaders.size() << " entry points\n";
        for(const auto &entry:effect.shaders) {
            std::cout<<entry.first<<'\n';
            for(const auto &binding:entry.second.textures) std::cout<<"  GLSL "<<binding.first<<" binding "<<binding.second<<'\n';
            for(const auto &binding:entry.second.mslTextures) std::cout<<"  MSL texture "<<binding.first<<" -> "<<binding.second<<'\n';
            for(const auto &binding:entry.second.mslSamplers) std::cout<<"  MSL sampler "<<binding.first<<" -> "<<binding.second<<'\n';
        }
        return 0;
    } catch (const std::exception &error) { std::cerr << error.what() << '\n'; return 1; }
}
