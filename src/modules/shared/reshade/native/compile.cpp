#include "lossless.hpp"
#include "effect.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <cmath>
#include <cstring>
#include <string_view>
#include <spirv_msl.hpp>
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
        if(u.type.components()==1&&!u.type.is_boolean())for(const auto&a:u.annotations)if(a.name=="ui_items"){
            out<<",\"options\":[";size_t start=0;unsigned index=0;bool first=true;
            while(start<a.value.string_data.size()){
                const auto end=a.value.string_data.find('\0',start);const auto label=a.value.string_data.substr(start,end==std::string::npos?std::string::npos:end-start);
                if(index>=4096)throw std::runtime_error("Shader choice metadata exceeds 4096 entries");
                if(!first)out<<',';first=false;out<<"{\"value\":"<<index<<",\"label\":"<<json(label.empty()?std::to_string(index):label)<<'}';++index;
                if(end==std::string::npos)break;start=end+1;
            }out<<']';break;
        }
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
static void spirvToMetal(const std::filesystem::path &input,const std::filesystem::path &directory){
    std::ifstream file(input,std::ios::binary|std::ios::ate);const auto size=file.tellg();
    if(!file||size<20||size>64*1024*1024||size%4)throw std::runtime_error("Choose a SPIR-V module from 20 bytes to 64 MiB.");
    std::vector<uint32_t> words(size_t(size)/4);file.seekg(0);file.read(reinterpret_cast<char*>(words.data()),size);
    if(!file||words.front()!=0x07230203u)throw std::runtime_error("The SPIR-V module header is invalid.");
    spirv_cross::CompilerMSL compiler(std::move(words));const auto entries=compiler.get_entry_points_and_stages();
    if(entries.size()!=1)throw std::runtime_error("The shader module must contain one entry point.");
    const auto &entry=entries.front();compiler.set_entry_point(entry.name,entry.execution_model);
    auto options=compiler.get_msl_options();options.platform=spirv_cross::CompilerMSL::Options::macOS;options.msl_version=23000;compiler.set_msl_options(options);
    const auto resources=compiler.get_shader_resources();unsigned texture=0,sampler=0,buffer=0;bool comma=false;
    std::ostringstream bindings;
    const auto bind=[&](const spirv_cross::Resource &resource,const char *kind,bool image,bool sampling,bool constants){
        spirv_cross::MSLResourceBinding binding{};binding.stage=entry.execution_model;
        const bool push=std::string_view(kind)=="push-constant";
        binding.desc_set=push?spirv_cross::kPushConstDescSet:compiler.get_decoration(resource.id,spv::DecorationDescriptorSet);
        binding.binding=push?spirv_cross::kPushConstBinding:compiler.get_decoration(resource.id,spv::DecorationBinding);
        if(image)binding.msl_texture=texture++;if(sampling)binding.msl_sampler=sampler++;if(constants)binding.msl_buffer=buffer++;
        compiler.add_msl_resource_binding(binding);if(comma)bindings<<',';comma=true;
        const auto name=resource.name.empty()?compiler.get_name(resource.id):resource.name;
        bindings<<"{\"name\":"<<json(name)<<",\"kind\":"<<json(kind)<<",\"set\":"<<binding.desc_set<<",\"binding\":"<<binding.binding;
        if(image)bindings<<",\"texture\":"<<binding.msl_texture;
        if(sampling)bindings<<",\"sampler\":"<<binding.msl_sampler;
        if(constants){
            const auto &type=compiler.get_type(resource.base_type_id);bindings<<",\"buffer\":"<<binding.msl_buffer<<",\"size\":"<<compiler.get_declared_struct_size(type)<<",\"members\":[";
            for(unsigned i=0;i<type.member_types.size();++i){const auto &member=compiler.get_type(type.member_types[i]);if(i)bindings<<',';
                const char *base=member.basetype==spirv_cross::SPIRType::Float||member.basetype==spirv_cross::SPIRType::Half?"float":member.basetype==spirv_cross::SPIRType::UInt?"uint":member.basetype==spirv_cross::SPIRType::Boolean?"bool":"int";
                bindings<<"{\"name\":"<<json(compiler.get_member_name(type.self,i))<<",\"type\":"<<json(base)<<",\"offset\":"<<compiler.type_struct_member_offset(type,i)
                    <<",\"size\":"<<compiler.get_declared_struct_member_size(type,i)<<",\"width\":"<<member.width<<",\"rows\":"<<member.vecsize<<",\"columns\":"<<member.columns;
                if(member.columns>1)bindings<<",\"matrixStride\":"<<compiler.type_struct_member_matrix_stride(type,i)<<",\"rowMajor\":"<<(compiler.has_member_decoration(type.self,i,spv::DecorationRowMajor)?"true":"false");
                bindings<<'}';
            }bindings<<']';
        }bindings<<'}';
    };
    for(const auto &value:resources.separate_images)bind(value,"image",true,false,false);
    for(const auto &value:resources.storage_images)bind(value,"storage-image",true,false,false);
    for(const auto &value:resources.separate_samplers)bind(value,"sampler",false,true,false);
    for(const auto &value:resources.sampled_images)bind(value,"sampled-image",true,true,false);
    for(const auto &value:resources.uniform_buffers)bind(value,"uniform-buffer",false,false,true);
    for(const auto &value:resources.storage_buffers)bind(value,"storage-buffer",false,false,true);
    for(const auto &value:resources.push_constant_buffers)bind(value,"push-constant",false,false,true);
    const auto source=compiler.compile();std::filesystem::create_directories(directory);
    std::ofstream metal(directory/"shader.metal");metal<<source;if(!metal)throw std::runtime_error("Cannot write Metal shader source.");
    const char *stage=entry.execution_model==spv::ExecutionModelGLCompute?"compute":entry.execution_model==spv::ExecutionModelFragment?"fragment":entry.execution_model==spv::ExecutionModelVertex?"vertex":"other";
    std::ofstream reflection(directory/"reflection.json");reflection<<"{\"schema\":1,\"entry\":"<<json(compiler.get_cleansed_entry_point_name(entry.name,entry.execution_model))<<",\"stage\":"<<json(stage)<<",\"resources\":["<<bindings.str()<<']';
    if(entry.execution_model==spv::ExecutionModelGLCompute)reflection<<",\"threads\":["<<compiler.get_execution_mode_argument(spv::ExecutionModeLocalSize,0)<<','<<compiler.get_execution_mode_argument(spv::ExecutionModeLocalSize,1)<<','<<compiler.get_execution_mode_argument(spv::ExecutionModeLocalSize,2)<<']';
    reflection<<"}\n";if(!reflection)throw std::runtime_error("Cannot write shader resource reflection.");
}
int main(int argc, char **argv) {
    if(argc==3 && std::string(argv[1])=="--inspect-lossless") return macfx::inspectLossless(argv[2],std::cout);
    try {
        if(argc==4&&std::string(argv[1])=="--spirv-to-msl"){spirvToMetal(argv[2],argv[3]);return 0;}
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
