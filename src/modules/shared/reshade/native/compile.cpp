#include "lossless.hpp"
#include "effect.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <cmath>
#include <cstring>
static std::string json(const std::string&s){std::string out="\"";for(unsigned char c:s){if(c=='"'||c=='\\'){out+='\\';out+=c;}else if(c<32){const char hex[]="0123456789abcdef";out+="\\u00";out+=hex[c>>4];out+=hex[c&15];}else out+=c;}return out+'"';}
static double number(const reshadefx::type&type,const void*data){if(type.is_floating_point()){float v;std::memcpy(&v,data,4);return std::isfinite(v)?v:0;}if(type.is_unsigned()||type.is_boolean()){uint32_t v;std::memcpy(&v,data,4);return v;}int32_t v;std::memcpy(&v,data,4);return v;}
static void parameters(const macfx::Effect&effect,const std::filesystem::path&file){
    std::ofstream out(file);out<<'[';unsigned count=0;
    for(const auto&u:effect.module.uniforms){
        if(u.type.array_length||u.type.cols!=1||!u.type.components()||u.type.components()>4||u.offset+u.type.components()*4>effect.uniforms.size())continue;
        bool source=false;for(const auto&a:u.annotations)if(a.name=="source")source=true;if(source||count>=4096)continue;
        if(count++)out<<',';
        out<<"{\"name\":"<<json(u.unique_name)<<",\"label\":"<<json(u.name)<<",\"type\":"<<json(u.type.is_boolean()?"bool":u.type.is_floating_point()?"float":"int")<<",\"default\":[";
        for(unsigned c=0;c<u.type.components();++c){if(c)out<<',';out<<number(u.type,effect.uniforms.data()+u.offset+c*4);}out<<']';
        for(const auto&a:u.annotations){if(a.name=="ui_label"||a.name=="ui_tooltip")out<<','<<json(a.name=="ui_label"?"label":"description")<<':'<<json(a.value.string_data);
            if(a.name=="ui_min"||a.name=="ui_max"||a.name=="ui_step")out<<','<<json(a.name.substr(3))<<':'<<number(a.type,a.value.as_uint);}
        out<<'}';
    }out<<"]\n";if(!out)throw std::runtime_error("Cannot write shader parameters");
}
static void requirements(const macfx::Effect &effect,const std::filesystem::path &file){
    std::vector<std::pair<std::string,bool>> techniques;
    for(const auto &technique:effect.module.techniques){bool depth=false;
        for(const auto &pass:technique.passes)for(const auto &binding:pass.texture_bindings){
            const auto &sampler=effect.module.samplers.at(binding.index);
            for(const auto &texture:effect.module.textures)if(texture.unique_name==sampler.texture_name&&texture.semantic=="DEPTH")depth=true;
        }
        techniques.emplace_back(technique.name,depth);
    }
    std::ofstream out(file);out<<"{\"depth\":"<<(!techniques.empty()&&techniques.front().second?"true":"false")<<",\"motion\":false,\"techniques\":{";
    bool comma=false;for(const auto &[name,depth]:techniques){if(comma)out<<',';comma=true;out<<json(name)<<":{\"depth\":"<<(depth?"true":"false")<<",\"motion\":false}";}
    out<<"}}\n";if(!out)throw std::runtime_error("Cannot write shader input requirements");
}
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
        parameters(effect,std::filesystem::path(argv[2])/"uniforms.json");
        requirements(effect,std::filesystem::path(argv[2])/"requirements.json");
        {std::ofstream textures(std::filesystem::path(argv[2])/"textures.json");textures<<'[';bool comma=false;
            for(const auto&t:effect.module.textures)for(const auto&a:t.annotations)if(a.name=="source"){
                if(comma)textures<<',';textures<<json(a.value.string_data);comma=true;
            }textures<<"]\n";if(!textures)throw std::runtime_error("Cannot write shader image inputs");}
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
