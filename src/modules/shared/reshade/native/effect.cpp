#include "effect.hpp"
#include "effect_codegen.hpp"
#include "effect_parser.hpp"
#include "effect_preprocessor.hpp"
#include "spirv_glsl.hpp"
#include "spirv_msl.hpp"
#include "spirv-compat.hpp"
#include "live-controls.hpp"
#include <cstring>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <sstream>
#include <iomanip>
#include <fstream>
#include <stdexcept>

namespace macfx {
namespace {
std::map<std::string, std::string> &sources() { static auto *s=new std::map<std::string,std::string>; return *s; }
std::string preprocess(const std::string &file, const std::vector<std::string> &includes,
                       const std::map<std::string,std::string> &dimensions) {
    reshadefx::preprocessor pp;
    pp.add_include_path(std::filesystem::path(file).parent_path());
    for(const auto &path:includes) pp.add_include_path(path);
    for(const auto &pair:std::map<std::string,std::string>{{"__RESHADE__","60900"},{"__RENDERER__","0x10000"},
        {"__RESHADE_PERFORMANCE_MODE__","0"},{"BUFFER_COLOR_BIT_DEPTH","8"},{"RESHADE_DEPTH_INPUT_IS_REVERSED","0"}})
        pp.add_macro_definition(pair.first,pair.second);
    for(const auto &pair:dimensions) pp.add_macro_definition(pair.first,pair.second);
    // Legacy aliases from ReShade runtime.cpp; actual sampling stays in its intrinsic compiler.
    pp.append_string(
        "#define tex2Doffset(s, coords, offset) tex2D(s, coords, offset)\n"
        "#define tex2Dlodoffset(s, coords, offset) tex2Dlod(s, coords, offset)\n"
        "#define tex2Dgather(s, t, c) tex2Dgather##c(s, t)\n"
        "#define tex2Dgatheroffset(s, t, o, c) tex2Dgather##c(s, t, o)\n"
        "#define tex2Dgather0 tex2DgatherR\n"
        "#define tex2Dgather1 tex2DgatherG\n"
        "#define tex2Dgather2 tex2DgatherB\n"
        "#define tex2Dgather3 tex2DgatherA\n");
    if(!pp.append_file(file)) throw std::runtime_error(pp.errors());
    return pp.output();
}
std::string decimal(double value) { std::ostringstream s; s<<std::setprecision(17)<<value;return s.str(); }
bool preparedUnder(const std::string &file,const char *environment) {
    const auto value=std::getenv(environment);if(!value||!*value)return false;
    const auto root=std::filesystem::path(value).lexically_normal(),candidate=std::filesystem::path(file).lexically_normal();
    if(!root.is_absolute()||!candidate.is_absolute()||root==root.root_path()||candidate.filename()!="effect.prepared.fx")return false;
    const auto relative=candidate.lexically_relative(root);
    return !relative.empty()&&*relative.begin()!="..";
}
}
std::string prepare(const std::string &file,const std::vector<std::string> &includes) {
    return preprocess(file,includes,{{"BUFFER_WIDTH","MACFX_PRIVATE_BUFFER_WIDTH"},
        {"BUFFER_HEIGHT","MACFX_PRIVATE_BUFFER_HEIGHT"},{"BUFFER_RCP_WIDTH","MACFX_PRIVATE_BUFFER_RCP_WIDTH"},
        {"BUFFER_RCP_HEIGHT","MACFX_PRIVATE_BUFFER_RCP_HEIGHT"}});
}
void loadPrepared(const std::string &file,const std::string &preparedFile) {
    std::ifstream input(preparedFile);
    if(!input) throw std::runtime_error("Cannot open the prepared effect");
    sources()[file]=std::string(std::istreambuf_iterator<char>(input),{});
}
std::vector<std::string> includePaths() {
    std::vector<std::string> paths;
    if (const char *env = std::getenv("RESHADE_INCLUDE_PATH")) {
        std::stringstream stream(env); std::string item;
        while (std::getline(stream, item, ':')) if (!item.empty()) paths.push_back(item);
    }
    return paths;
}
Effect compile(const std::string &file, unsigned width, unsigned height,
               unsigned glslVersion, const std::vector<std::string> &includes) {
    const std::map<std::string,std::string> dimensions={{"BUFFER_WIDTH",std::to_string(width)},
        {"BUFFER_HEIGHT",std::to_string(height)},{"BUFFER_RCP_WIDTH",decimal(1.0/width)},{"BUFFER_RCP_HEIGHT",decimal(1.0/height)}};
    std::string source;
    auto cached=sources().find(file);
    const bool live=preparedUnder(file,"RESHADE_LIVE_EFFECTS")||preparedUnder(file,"RESHADE_EFFECT_PLAN_ROOT");
    if(cached==sources().end()&&!live) source=preprocess(file,includes,dimensions);
    else {
        if(live){std::ifstream input(file);if(!input)throw std::runtime_error("Cannot open the selected effect");
            if(std::filesystem::file_size(file)>8*1024*1024)throw std::runtime_error("Selected effect exceeds 8 MiB");
            source.assign(std::istreambuf_iterator<char>(input),{});
        }else source=cached->second;
        for(const auto &pair:dimensions) {
            const std::string marker="MACFX_PRIVATE_"+pair.first;
            size_t at=0;
            while((at=source.find(marker,at))!=std::string::npos) {source.replace(at,marker.size(),pair.second);at+=pair.second.size();}
        }
    }
    std::unique_ptr<reshadefx::codegen> cg(reshadefx::create_codegen_spirv(true, true, false));
    reshadefx::parser parser;
    if (!parser.parse(source, cg.get())) throw std::runtime_error(parser.errors());
    Effect result; result.module = cg->module();
    result.uniforms.resize(result.module.total_uniform_size);
    for (const auto &u : result.module.uniforms) {
        if (u.type.is_array() || u.type.is_matrix())
            throw std::runtime_error("Array and matrix uniforms are not supported yet: " + u.name);
        if (u.has_initializer_value)
            std::memcpy(result.uniforms.data() + u.offset, u.initializer_value.as_uint, u.type.components() * 4);
    }
    for (const auto &entry : result.module.entry_points) {
        std::string binary, assembly, errors;
        if (!cg->assemble_code_for_entry_point(entry.first, binary, assembly, errors))
            throw std::runtime_error(errors);
        std::vector<uint32_t> words(binary.size() / 4);
        std::memcpy(words.data(), binary.data(), binary.size());
        words=portableEffectSPIRV(words);
        spirv_cross::CompilerGLSL gl(words);
        gl.set_enabled_interface_variables(gl.get_active_interface_variables());
        auto options = gl.get_common_options();
        options.version = entry.second==reshadefx::shader_type::compute?450:glslVersion; options.es = false;
        options.enable_420pack_extension = false;
        options.emit_uniform_buffer_as_plain_uniforms = true;
        options.vertex.fixup_clipspace = true;
        options.vertex.flip_vert_y = true;
        gl.set_common_options(options);
        gl.build_combined_image_samplers();
        Shader shader; shader.type = entry.second;
        const auto resources = gl.get_shader_resources(gl.get_active_interface_variables());
        for (const auto &resource : resources.stage_inputs)
            gl.set_name(resource.id, "RSVarying" + std::to_string(gl.get_decoration(resource.id, spv::DecorationLocation)));
        for (const auto &resource : resources.stage_outputs)
            gl.set_name(resource.id, "RSVarying" + std::to_string(gl.get_decoration(resource.id, spv::DecorationLocation)));
        for (const auto &buffer : resources.uniform_buffers) {
            gl.set_name(buffer.id, "RSUniforms");
            const auto &type=gl.get_type(buffer.base_type_id);
            for(unsigned index=0;index<type.member_types.size();++index) {
                const std::string member="RSValue"+std::to_string(index);
                gl.set_member_name(buffer.base_type_id,index,member);
                const auto offset=gl.get_member_decoration(buffer.base_type_id,index,spv::DecorationOffset);
                for(const auto &uniform:result.module.uniforms) if(uniform.offset==offset)
                    shader.uniformNames[uniform.unique_name]="RSUniforms."+member;
            }
        }
        for (const auto &combined : gl.get_combined_image_samplers()) {
            const auto binding = gl.get_decoration(combined.image_id, spv::DecorationBinding);
            const std::string name = "RSTexture" + std::to_string(binding);
            gl.set_name(combined.combined_id, name); shader.textures[name] = binding;
        }
        for (const auto &resource : resources.sampled_images) {
            const auto binding = gl.get_decoration(resource.id, spv::DecorationBinding);
            const std::string name = "RSTexture" + std::to_string(binding);
            gl.set_name(resource.id, name); shader.textures[name] = binding;
        }
        shader.glsl = gl.compile();
        if (glslVersion < 130 && entry.second == reshadefx::shader_type::vertex) {
            size_t pos = 0;
            while ((pos = shader.glsl.find("gl_VertexID", pos)) != std::string::npos) {
                shader.glsl.replace(pos, 11, "int(RSVertexID)"); pos += 15;
            }
            const auto body = shader.glsl.find("\n\n");
            shader.glsl.insert(body + 2, "attribute float RSVertexID;\n");
        }
        EffectMSLCompiler metal(words);
        // Avoid collisions with Metal's standard-library function templates
        // (for example decay), while keeping public entry-point names intact.
        namespaceEffectFunctions(metal,words);
        metal.pruneInactiveWorkgroups();
        metal.set_enabled_interface_variables(metal.get_active_interface_variables());
        auto mslOptions = metal.get_msl_options();
        mslOptions.platform = spirv_cross::CompilerMSL::Options::macOS;
        mslOptions.pad_fragment_output_components = true;
        mslOptions.texture_1D_as_2D = true;
        mslOptions.set_msl_version(2, 1); metal.set_msl_options(mslOptions);
        shader.msl = metal.compile();
        const auto metalResources = metal.get_shader_resources(metal.get_active_interface_variables());
        if(entry.second == reshadefx::shader_type::pixel)
            for(const auto &output : metalResources.stage_outputs)
                if(metal.get_decoration(output.id, spv::DecorationLocation)==0)
                    shader.colorComponents = metal.get_type(output.type_id).vecsize;
        const auto executionModel = entry.second == reshadefx::shader_type::vertex ? spv::ExecutionModelVertex :
            entry.second == reshadefx::shader_type::pixel ? spv::ExecutionModelFragment : spv::ExecutionModelGLCompute;
        shader.mslEntry = metal.get_cleansed_entry_point_name(entry.first, executionModel);
        for (const auto &buffer : metalResources.uniform_buffers)
            shader.mslUniformBuffer = metal.get_automatic_msl_resource_binding(buffer.id);
        for (const auto &image : metalResources.separate_images)
            shader.mslTextures[metal.get_decoration(image.id, spv::DecorationBinding)] = metal.get_automatic_msl_resource_binding(image.id);
        for (const auto &image : metalResources.storage_images)
            shader.mslStorageTextures[metal.get_decoration(image.id, spv::DecorationBinding)] = metal.get_automatic_msl_resource_binding(image.id);
        if(entry.second==reshadefx::shader_type::compute)
            for(unsigned axis=0;axis<3;++axis)shader.mslThreads[axis]=metal.get_execution_mode_argument(spv::ExecutionModeLocalSize,axis);
        for (const auto &sampler : metalResources.separate_samplers)
            shader.mslSamplers[metal.get_decoration(sampler.id, spv::DecorationBinding)] = metal.get_automatic_msl_resource_binding(sampler.id);
        for (const auto &resource : metalResources.sampled_images) {
            const auto binding = metal.get_decoration(resource.id, spv::DecorationBinding);
            shader.mslTextures[binding] = metal.get_automatic_msl_resource_binding(resource.id);
            shader.mslSamplers[binding] = metal.get_automatic_msl_resource_binding_secondary(resource.id);
        }
        result.shaders.emplace(entry.first, std::move(shader));
    }
    return result;
}
}
