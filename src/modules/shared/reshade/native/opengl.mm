#include "runtime-status.hpp"
#include "effects-execution.hpp"
#include "image-admission.hpp"
#include "live-controls.hpp"
#include "log.hpp"
#include "native-config.hpp"
#include "effect.hpp"
#include "source-texture.hpp"
#include "uniform-sources.hpp"
#include "window.hpp"
#include "diagnostics.hpp"
#include "opengl-timing.hpp"
#include "opengl-interop.hpp"
#include "effects-plan.hpp"
#include "view-presentation.hpp"
#include "frame-depth.hpp"
#include "graphics.hpp"
#include "resolution-scale.hpp"
#include "virtual-window.hpp"
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/CGLRenderers.h>
#include <OpenGL/gl3.h>
#include <OpenGL/CGLIOSurface.h>
#import <IOSurface/IOSurface.h>
#include <dlfcn.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>

extern "C" IOSurfaceRef rsFilterOpenGLSurface(void *,IOSurfaceRef);
extern "C" void glGenVertexArraysAPPLE(GLsizei, GLuint *);
extern "C" void glBindVertexArrayAPPLE(GLuint);
extern "C" void glDeleteVertexArraysAPPLE(GLsizei, const GLuint *);
namespace {
void log(const std::string &message) {macfx::nativeLog(message);}
bool accelerated(GLint current) {
    GLint count=0;CGLRendererInfoObj info=nullptr;
    if(CGLQueryRendererInfo(~0u,&info,&count)!=kCGLNoError) return false;
    bool result=false;
    for(GLint i=0;i<count;++i) {
        GLint renderer=0,gpu=0;
        CGLDescribeRenderer(info,i,kCGLRPRendererID,&renderer);
        CGLDescribeRenderer(info,i,kCGLRPAccelerated,&gpu);
        if((renderer&kCGLRendererIDMatchingMask)==(current&kCGLRendererIDMatchingMask)) result=gpu!=0;
    }
    CGLDestroyRendererInfo(info);return result;
}
struct State {
    GLint program, vao, buffer, readFbo, drawFbo, readBuffer, drawBuffer, activeTexture;
    GLint viewport[4], polygon[2]; GLboolean mask[4];
    const GLenum capabilities[8] = {GL_BLEND, GL_DEPTH_TEST, GL_STENCIL_TEST, GL_SCISSOR_TEST,
        GL_CULL_FACE, GL_FRAMEBUFFER_SRGB, GL_RASTERIZER_DISCARD, GL_DITHER};
    GLboolean enabled[8]; GLint textures[16], samplers[16]; bool core; unsigned textureUnits;
    // Transfer-only paths bind unit zero. Actual GL effects retain the full
    // sampler range because shader bindings are selected by the effect.
    State(bool c,unsigned units=16) : core(c),textureUnits(units) {
        macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLState);
        glGetIntegerv(GL_CURRENT_PROGRAM, &program); glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao);
        glGetIntegerv(GL_ARRAY_BUFFER_BINDING, &buffer);
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &readFbo); glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &drawFbo);
        glGetIntegerv(GL_READ_BUFFER, &readBuffer); glGetIntegerv(GL_DRAW_BUFFER0, &drawBuffer);
        glGetIntegerv(GL_ACTIVE_TEXTURE, &activeTexture); glGetIntegerv(GL_VIEWPORT, viewport);
        glGetIntegerv(GL_POLYGON_MODE, polygon); glGetBooleanv(GL_COLOR_WRITEMASK, mask);
        for (int i=0; i<8; ++i) enabled[i] = (!core && capabilities[i]==GL_RASTERIZER_DISCARD) ? GL_FALSE : glIsEnabled(capabilities[i]);
        for (unsigned i=0; i<textureUnits; ++i) { glActiveTexture(GL_TEXTURE0+i); glGetIntegerv(GL_TEXTURE_BINDING_2D, &textures[i]);
            if (core) glGetIntegerv(GL_SAMPLER_BINDING, &samplers[i]); }
    }
    ~State() {
        glUseProgram(program); if (core) glBindVertexArray(vao); else glBindVertexArrayAPPLE(vao);
        glBindBuffer(GL_ARRAY_BUFFER, buffer);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, readFbo); glReadBuffer(readBuffer);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, drawFbo);
        if (!drawFbo) glDrawBuffer(drawBuffer);
        glViewport(viewport[0],viewport[1],viewport[2],viewport[3]);
        if(core) glPolygonMode(GL_FRONT_AND_BACK,polygon[0]);
        else {glPolygonMode(GL_FRONT,polygon[0]);glPolygonMode(GL_BACK,polygon[1]);}
        glColorMask(mask[0],mask[1],mask[2],mask[3]);
        for (int i=0; i<8; ++i) { if(!core && capabilities[i]==GL_RASTERIZER_DISCARD) continue; if (enabled[i]) glEnable(capabilities[i]); else glDisable(capabilities[i]); }
        for (unsigned i=0; i<textureUnits; ++i) { glActiveTexture(GL_TEXTURE0+i); glBindTexture(GL_TEXTURE_2D,textures[i]);
            if (core) glBindSampler(i,samplers[i]); }
        glActiveTexture(activeTexture);
    }
};
GLuint shader(GLenum stage, const std::string &source) {
    GLuint id=glCreateShader(stage); const char *text=source.c_str(); glShaderSource(id,1,&text,nullptr); glCompileShader(id);
    GLint ok=0; glGetShaderiv(id,GL_COMPILE_STATUS,&ok);
    if (!ok) { char error[8192]={}; glGetShaderInfoLog(id,sizeof(error),nullptr,error); glDeleteShader(id); throw std::runtime_error(error); }
    return id;
}
struct Texture { GLuint id=0, fbo=0; unsigned w=0,h=0; };
struct RequiresMetal : std::runtime_error {using std::runtime_error::runtime_error;};
Texture makeTexture(unsigned w,unsigned h, reshadefx::texture_format format=reshadefx::texture_format::rgba8) {
    GLint internal=GL_RGBA8; GLenum external=GL_RGBA, type=GL_UNSIGNED_BYTE;
    using F=reshadefx::texture_format;
    switch(format) {
        case F::rgba8: case F::unknown: break;
        case F::r8: internal=GL_R8; external=GL_RED; break;
        case F::rg8: internal=GL_RG8; external=GL_RG; break;
        case F::rgba16f: internal=GL_RGBA16F; type=GL_FLOAT; break;
        case F::rgba32f: internal=GL_RGBA32F; type=GL_FLOAT; break;
        case F::r16f: internal=GL_R16F; external=GL_RED; type=GL_FLOAT; break;
        case F::r32f: internal=GL_R32F; external=GL_RED; type=GL_FLOAT; break;
        default: throw std::runtime_error("Unsupported texture format");
    }
    Texture t; t.w=w; t.h=h; glGenTextures(1,&t.id); glBindTexture(GL_TEXTURE_2D,t.id);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_LINEAR); glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
    GLint unpackBuffer=0;glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING,&unpackBuffer);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,0);
    glTexImage2D(GL_TEXTURE_2D,0,internal,w,h,0,external,type,nullptr);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,unpackBuffer);
    glGenFramebuffers(1,&t.fbo); glBindFramebuffer(GL_FRAMEBUFFER,t.fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,t.id,0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE) throw std::runtime_error("Effect framebuffer is incomplete");
    return t;
}
void destroy(Texture &t) { glDeleteTextures(1,&t.id); glDeleteFramebuffers(1,&t.fbo); t={}; }
GLenum address(reshadefx::texture_address_mode value) {
    using A=reshadefx::texture_address_mode;
    return value==A::wrap?GL_REPEAT:value==A::mirror?GL_MIRRORED_REPEAT:value==A::border?GL_CLAMP_TO_BORDER:GL_CLAMP_TO_EDGE;
}
struct Runtime {
    macfx::Effect effect; unsigned w=0,h=0; bool core=false, failed=false,metalEffect=false; uint64_t frames=0;
    uint64_t failedPlan=0,failedControls=0;unsigned sourceWidth=0,sourceHeight=0,failedWidth=0,failedHeight=0;
    macfx::UniformSources uniformSources;
    macfx::EffectSelection selection;std::string rejectedRevision;
    bool profileKnown=false,rendererKnown=false;GLint renderer=0;
    macfx::OpenGLGpuTimer gpuTimer;
    std::unique_ptr<macfx::OpenGLInterop> interop;
    GLuint vao=0,vbo=0; Texture colors[2]; std::map<std::string,Texture> textures;
    std::vector<GLuint> programs; std::vector<reshadefx::pass> passes;
    std::chrono::steady_clock::time_point started=std::chrono::steady_clock::now(),lastFrame=started;
    bool validate(CGLContextObj context) {
        // A context's GL profile is immutable. Its renderer can change when
        // moving between GPUs, so retain the cheap ID check and rediscover
        // acceleration only after an actual renderer change.
        if(!profileKnown) {
            const auto *version=reinterpret_cast<const char*>(glGetString(GL_VERSION));
            if(!version)return false;
            core=version[0]>='3';profileKnown=true;
        }
        GLint current=0;
        if(CGLGetParameter(context,kCGLCPCurrentRendererID,&current)!=kCGLNoError)
            throw std::runtime_error("Cannot inspect the OpenGL renderer");
        if(!rendererKnown||renderer!=current) {
            if(!accelerated(current))throw std::runtime_error("A hardware-accelerated OpenGL renderer is required");
            renderer=current;rendererKnown=true;
        }
        return true;
    }
    void clear() {
        interop.reset();
        gpuTimer.clear();
        for (GLuint p:programs) glDeleteProgram(p); programs.clear(); passes.clear();
        for (auto &t:textures) destroy(t.second); textures.clear();
        destroy(colors[0]); destroy(colors[1]);
        if (vao) { if(core) glDeleteVertexArrays(1,&vao); else glDeleteVertexArraysAPPLE(1,&vao); vao=0; }
        glDeleteBuffers(1,&vbo); vbo=0;
    }
    void abandon() noexcept {
        if(interop)interop->abandon();
        // The original CGL destruction reclaims GL objects. The timer's
        // destructor makes no GL calls; the host/CV/Metal owners still retire.
    }
    void init(unsigned width,unsigned height) {
        clear(); w=width; h=height;
        selection=macfx::effectSelection();const char *fx=selection.file.c_str();if(selection.file.empty())throw std::runtime_error("No effect is selected");
        if(std::string(fx).size()>=7&&std::string(fx).compare(std::string(fx).size()-7,7,".slangp")==0)
            throw RequiresMetal("RetroArch presets use the shared Metal processor");
        effect=macfx::compile(fx,w,h,core?410:120,macfx::includePaths());
        uniformSources.configure(effect,selection.key);
        colors[0]=makeTexture(w,h); colors[1]=makeTexture(w,h);
        size_t imageBytes=0;
        for (const auto &t:effect.module.textures) if(t.semantic.empty()) {
            if(t.type!=reshadefx::texture_type::texture_2d || t.levels!=1 || t.storage_access)
                throw std::runtime_error("Only single-level 2D textures are supported");
            textures[t.unique_name]=makeTexture(t.width,t.height,t.format);
            if(!macfx::textureSource(t).empty()) {
                const auto image=macfx::loadSourceTexture(t,fx,imageBytes);
                GLint unpack=0,row=0,pixels=0,rows=0,buffer=0;glGetIntegerv(GL_UNPACK_ALIGNMENT,&unpack);glGetIntegerv(GL_UNPACK_ROW_LENGTH,&row);glGetIntegerv(GL_UNPACK_SKIP_PIXELS,&pixels);glGetIntegerv(GL_UNPACK_SKIP_ROWS,&rows);glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING,&buffer);
                glBindBuffer(GL_PIXEL_UNPACK_BUFFER,0);glPixelStorei(GL_UNPACK_ALIGNMENT,1);glPixelStorei(GL_UNPACK_ROW_LENGTH,0);glPixelStorei(GL_UNPACK_SKIP_PIXELS,0);glPixelStorei(GL_UNPACK_SKIP_ROWS,0);
                glTexSubImage2D(GL_TEXTURE_2D,0,0,0,image.width,image.height,image.channels==1?GL_RED:image.channels==2?GL_RG:GL_RGBA,GL_UNSIGNED_BYTE,image.pixels.data());
                glPixelStorei(GL_UNPACK_ALIGNMENT,unpack);glPixelStorei(GL_UNPACK_ROW_LENGTH,row);glPixelStorei(GL_UNPACK_SKIP_PIXELS,pixels);glPixelStorei(GL_UNPACK_SKIP_ROWS,rows);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,buffer);
            }
        }
        const char *selected=selection.technique.empty()?nullptr:selection.technique.c_str();
        for(const auto &tech:effect.module.techniques) {
            if(selected && tech.name!=selected) continue;
            if(!selected && !passes.empty()) break;
            for(const auto &p:tech.passes) {
                if(!p.cs_entry_point.empty() || p.stencil_enable || p.blend_enable[0] || p.srgb_write_enable || !p.render_target_names[1].empty()
                    || p.topology!=reshadefx::primitive_topology::triangle_list)
                    throw RequiresMetal("This effect requires the shared Metal processor");
                for(const auto &binding:p.texture_bindings) {
                    if(binding.entry_point_binding>=16 || binding.srgb) throw RequiresMetal("This effect requires the shared Metal sampler support");
                    const auto &s=effect.module.samplers.at(binding.index);
                    for(const auto &t:effect.module.textures) if(t.unique_name==s.texture_name && t.semantic=="DEPTH")
                        throw RequiresMetal("This effect requires shared scene-depth processing");
                }
                const auto vs=shader(GL_VERTEX_SHADER,effect.shaders.at(p.vs_entry_point).glsl);
                GLuint ps=0,program=0;
                try { ps=shader(GL_FRAGMENT_SHADER,effect.shaders.at(p.ps_entry_point).glsl); program=glCreateProgram();
                    glAttachShader(program,vs); glAttachShader(program,ps); glBindAttribLocation(program,0,"RSVertexID"); glLinkProgram(program);
                    GLint ok=0; glGetProgramiv(program,GL_LINK_STATUS,&ok);
                    if(!ok) { char error[8192]={}; glGetProgramInfoLog(program,sizeof(error),nullptr,error); throw std::runtime_error(error); }
                } catch (...) { glDeleteShader(vs); glDeleteShader(ps); glDeleteProgram(program); throw; }
                glDeleteShader(vs); glDeleteShader(ps); programs.push_back(program); passes.push_back(p);
            }
        }
        if(passes.empty()) throw std::runtime_error("No matching graphics technique");
        if(core) glGenVertexArrays(1,&vao); else glGenVertexArraysAPPLE(1,&vao);
        if(core) glBindVertexArray(vao); else glBindVertexArrayAPPLE(vao);
        const float ids[3]={0,1,2}; glGenBuffers(1,&vbo); glBindBuffer(GL_ARRAY_BUFFER,vbo); glBufferData(GL_ARRAY_BUFFER,sizeof(ids),ids,GL_STATIC_DRAW);
        if(!core) { glEnableVertexAttribArray(0); glVertexAttribPointer(0,1,GL_FLOAT,GL_FALSE,0,nullptr); }
        log("OpenGL effect ready: "+std::string(fx)+" "+std::to_string(w)+"x"+std::to_string(h)+" passes="+std::to_string(passes.size())+" GLSL="+(core?"410":"120"));
    }
    void render(unsigned width,unsigned height) {
        State restore(core);
        const auto &desired=macfx::effectSelection();const bool resized=w!=width||h!=height;
        if(resized||(selection.revision!=desired.revision&&rejectedRevision!=desired.revision)){
            Runtime next;next.core=core;
            try{next.init(width,height);
                using std::swap;swap(effect,next.effect);swap(selection,next.selection);swap(uniformSources,next.uniformSources);
                swap(w,next.w);swap(h,next.h);swap(colors,next.colors);swap(textures,next.textures);swap(programs,next.programs);
                swap(passes,next.passes);swap(vao,next.vao);swap(vbo,next.vbo);rejectedRevision.clear();next.clear();
            }catch(const RequiresMetal&){next.clear();throw;}
            catch(const std::exception&e){next.clear();rejectedRevision=desired.revision;if(resized)throw;log("Selected effect unavailable; previous effect retained: "+std::string(e.what()));}
        }
        if(frames==0) {
            GLint swap=0;CGLGetParameter(CGLGetCurrentContext(),kCGLCPSwapInterval,&swap);
            log("OpenGL presentation swap-interval="+std::to_string(swap)+" drawable="+std::to_string(w)+"x"+std::to_string(h));
        }
        const auto &diagnostics=macfx::nativeConfig().diagnostics;const auto &passthrough=diagnostics.openGLPassthrough;
        const bool setupOnly=diagnostics.enabled && passthrough=="setup";
        if(diagnostics.enabled && passthrough=="1") {
            if(frames++==0)log("OpenGL diagnostics passthrough: effect initialized, copies and draws disabled");
            return;
        }
        gpuTimer.begin(width,height);
        struct EndGpuTiming {macfx::OpenGLGpuTimer &timer;~EndGpuTiming(){timer.end();}} endGpuTiming{gpuTimer};
        for(GLenum cap:restore.capabilities) glDisable(cap);
        glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE); glPolygonMode(GL_FRONT_AND_BACK,GL_FILL);
        if(core) glBindVertexArray(vao); else glBindVertexArrayAPPLE(vao);
        glBindFramebuffer(GL_READ_FRAMEBUFFER,0); glReadBuffer(GL_BACK);
        // A single non-MSAA back-buffer pass can draw into the existing game
        // surface after snapshotting its input. Untouched pixels and RGB-only
        // alpha stay in place, avoiding two preservation/output blits.
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,0);
        GLint sampleBuffers=0;glGetIntegerv(GL_SAMPLE_BUFFERS,&sampleBuffers);
        const bool direct=passes.size()==1 && passes[0].render_target_names[0].empty() && sampleBuffers==0;
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,colors[0].fbo); glDrawBuffer(GL_COLOR_ATTACHMENT0);
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLSourceCopy,0,w,h);
            glBlitFramebuffer(0,0,w,h,0,0,w,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);}
        if(diagnostics.enabled && passthrough=="copy") {
            if(frames++==0)log("OpenGL diagnostics passthrough: source copied, effect draws disabled");
            return;
        }
        const auto now=std::chrono::steady_clock::now();
        const float frameTime=frames?std::chrono::duration<float,std::milli>(now-lastFrame).count():16.666667f;lastFrame=now;
        if(!setupOnly)uniformSources.update(effect,std::chrono::duration<double,std::milli>(now-started).count(),frameTime,frames);
        unsigned current=0;
        for(size_t i=0;i<passes.size();++i) {
            const auto &p=passes[i]; const GLuint program=programs[i]; glUseProgram(program);
            const bool back=p.render_target_names[0].empty();
            const auto &target=back?colors[1-current]:textures.at(p.render_target_names[0]);
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER,direct?0:target.fbo); glDrawBuffer(direct?GL_BACK:GL_COLOR_ATTACHMENT0);
            if(back && !direct) {
                glBindFramebuffer(GL_READ_FRAMEBUFFER,colors[current].fbo);glReadBuffer(GL_COLOR_ATTACHMENT0);
                glBlitFramebuffer(0,0,w,h,0,0,w,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);
            }
            const bool alpha=effect.shaders.at(p.ps_entry_point).colorComponents>=4;
            glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,alpha?GL_TRUE:GL_FALSE);
            glViewport(0,0,p.viewport_width?p.viewport_width:target.w,p.viewport_height?p.viewport_height:target.h);
            if(p.srgb_write_enable) glEnable(GL_FRAMEBUFFER_SRGB); else glDisable(GL_FRAMEBUFFER_SRGB);
            if(p.clear_render_targets && !setupOnly) { const GLfloat zero[4]={}; glClearBufferfv(GL_COLOR,0,zero); }
            for(const auto &entry:{p.vs_entry_point,p.ps_entry_point}) {
                const auto &stage=effect.shaders.at(entry);
                for(const auto &u:effect.module.uniforms) {
                    auto name=stage.uniformNames.find(u.unique_name);if(name==stage.uniformNames.end())continue;
                    GLint location=glGetUniformLocation(program,name->second.c_str());
                    if(location<0) continue;
                    unsigned char value[16]={}; std::memcpy(value,effect.uniforms.data()+u.offset,u.type.components()*4);
                    auto *f=reinterpret_cast<const GLfloat*>(value); auto *n=reinterpret_cast<const GLint*>(value);
                    if(u.type.is_floating_point()) { switch(u.type.components()) {case 1:glUniform1fv(location,1,f);break;case 2:glUniform2fv(location,1,f);break;case 3:glUniform3fv(location,1,f);break;case 4:glUniform4fv(location,1,f);break;} }
                    else { switch(u.type.components()) {case 1:glUniform1iv(location,1,n);break;case 2:glUniform2iv(location,1,n);break;case 3:glUniform3iv(location,1,n);break;case 4:glUniform4iv(location,1,n);break;} }
                }
                for(const auto &binding:stage.textures) {
                    const auto match=std::find_if(p.texture_bindings.begin(),p.texture_bindings.end(),[&](const auto &b){return b.entry_point_binding==binding.second;});
                    if(match==p.texture_bindings.end()) throw std::runtime_error("Texture binding not found");
                    const auto &sampler=effect.module.samplers.at(match->index);
                    auto t=textures.find(sampler.texture_name); GLuint id=t==textures.end()?colors[current].id:t->second.id;
                    glActiveTexture(GL_TEXTURE0+binding.second); if(core) glBindSampler(binding.second,0); glBindTexture(GL_TEXTURE_2D,id);
                    const unsigned filter=static_cast<unsigned>(sampler.filter);
                    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,(filter&0x10)?GL_LINEAR:GL_NEAREST);
                    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,(filter&4)?GL_LINEAR:GL_NEAREST);
                    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,address(sampler.address_u)); glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,address(sampler.address_v));
                    glUniform1i(glGetUniformLocation(program,binding.first.c_str()),binding.second);
                }
            }
            if(!setupOnly)glDrawArrays(GL_TRIANGLES,0,p.num_vertices);
            if(back && !direct) current=1-current;
        }
        glDisable(GL_FRAMEBUFFER_SRGB);
        if(!direct) {
            macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLCopyBack,0,w,h);
            glBindFramebuffer(GL_READ_FRAMEBUFFER,colors[current].fbo); glReadBuffer(GL_COLOR_ATTACHMENT0);
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER,0); glDrawBuffer(GL_BACK);
            glBlitFramebuffer(0,0,w,h,0,0,w,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);
        }
        ++frames;
        if(frames==1 || frames==120) log("OpenGL effect frame="+std::to_string(frames)+" output="+(direct?"direct-backbuffer":"texture-copy")+" samples="+std::to_string(sampleBuffers)+(setupOnly?" diagnostics=setup-only":""));
    }
};
// Legacy GL cannot compile modern ReShade integer operations. Keep all frame
// data on the GPU: blit through IOSurface textures and run the Metal backend.
// Explicit GPU completion fences transfers between the independent API queues.
struct LegacySurface {
    IOSurfaceRef input=nullptr;GLuint inputTexture=0,inputFbo=0,outputTexture=0,outputFbo=0;
    unsigned w=0,h=0;uint64_t frames=0;
    void clear() {
        glDeleteTextures(1,&inputTexture);glDeleteTextures(1,&outputTexture);glDeleteFramebuffers(1,&inputFbo);glDeleteFramebuffers(1,&outputFbo);
        if(input) CFRelease(input);input=nullptr;inputTexture=outputTexture=inputFbo=outputFbo=0;w=h=0;
    }
    void resize(unsigned width,unsigned height,CGLContextObj context) {
        if(w==width && h==height && input) return;
        if(input) CFRelease(input);
        input=nullptr;w=width;h=height;
        if(!inputTexture) {glGenTextures(1,&inputTexture);glGenTextures(1,&outputTexture);glGenFramebuffers(1,&inputFbo);glGenFramebuffers(1,&outputFbo);}
        NSDictionary *properties=@{(NSString *)kIOSurfaceWidth:@(w),(NSString *)kIOSurfaceHeight:@(h),
            (NSString *)kIOSurfaceBytesPerElement:@4,(NSString *)kIOSurfaceBytesPerRow:@(IOSurfaceAlignProperty(kIOSurfaceBytesPerRow,w*4)),
            (NSString *)kIOSurfacePixelFormat:@((uint32_t)'BGRA')};
        input=IOSurfaceCreate((CFDictionaryRef)properties);
        if(!input) throw std::runtime_error("Cannot allocate legacy OpenGL GPU surface");
        glBindTexture(GL_TEXTURE_RECTANGLE,inputTexture);
        if(CGLTexImageIOSurface2D(context,GL_TEXTURE_RECTANGLE,GL_RGBA,w,h,GL_BGRA,GL_UNSIGNED_INT_8_8_8_8_REV,input,0)!=kCGLNoError)
            throw std::runtime_error("Cannot bind legacy OpenGL GPU surface");
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,inputFbo);
        glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_RECTANGLE,inputTexture,0);
        if(glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE) throw std::runtime_error("Legacy GPU framebuffer is incomplete");
        log("Legacy OpenGL GPU surface ready: "+std::to_string(w)+"x"+std::to_string(h));
    }
    void render(unsigned width,unsigned height,CGLContextObj context,bool core=false) {
        State restore(core,1);glActiveTexture(GL_TEXTURE0);
        GLint rectangle=0;glGetIntegerv(GL_TEXTURE_BINDING_RECTANGLE,&rectangle);
        struct RestoreRectangle {GLint binding;~RestoreRectangle(){glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_RECTANGLE,binding);}} restoreRectangle{rectangle};
        resize(width,height,context);
        glDisable(GL_SCISSOR_TEST);glDisable(GL_FRAMEBUFFER_SRGB);glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);
        glBindFramebuffer(GL_READ_FRAMEBUFFER,0);glReadBuffer(GL_BACK);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,inputFbo);glDrawBuffer(GL_COLOR_ATTACHMENT0);
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLSourceCopy,reinterpret_cast<uintptr_t>(context),w,h);glBlitFramebuffer(0,0,w,h,0,h,w,0,GL_COLOR_BUFFER_BIT,GL_NEAREST);}
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLSourceWait,reinterpret_cast<uintptr_t>(context),w,h);glFinish();}
        IOSurfaceRef output=rsFilterOpenGLSurface(context,input);
        // The shared processor owns its failure/retry state. A pending first
        // image does not permanently disable this context's future submissions.
        if(!output)return;
        struct ReleaseSurface {IOSurfaceRef surface;~ReleaseSurface(){CFRelease(surface);}} release{output};
        glBindTexture(GL_TEXTURE_RECTANGLE,outputTexture);
        if(CGLTexImageIOSurface2D(context,GL_TEXTURE_RECTANGLE,GL_RGBA,w,h,GL_BGRA,GL_UNSIGNED_INT_8_8_8_8_REV,output,0)!=kCGLNoError)
            throw std::runtime_error("Cannot bind filtered legacy OpenGL GPU surface");
        glBindFramebuffer(GL_READ_FRAMEBUFFER,outputFbo);
        glFramebufferTexture2D(GL_READ_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_RECTANGLE,outputTexture,0);glReadBuffer(GL_COLOR_ATTACHMENT0);
        if(glCheckFramebufferStatus(GL_READ_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE) throw std::runtime_error("Filtered legacy GPU framebuffer is incomplete");
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,0);glDrawBuffer(GL_BACK);
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLCopyBack,reinterpret_cast<uintptr_t>(context),w,h);glBlitFramebuffer(0,h,w,0,0,0,w,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);}
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLCopyWait,reinterpret_cast<uintptr_t>(context),w,h);glFinish();}
        if(++frames==1 || frames==120) log(std::string(core?"Core":"Legacy")+" OpenGL GPU surface effect frame="+std::to_string(frames));
    }
};
std::map<CGLContextObj,LegacySurface> &legacySurfaces() {static auto *m=new std::map<CGLContextObj,LegacySurface>;return *m;}
std::mutex &runtimeMutex() { static auto *m=new std::mutex; return *m; }
std::map<CGLContextObj,Runtime> &runtimes() { static auto *m=new std::map<CGLContextObj,Runtime>; return *m; }
thread_local bool inside=false;
struct FlushGuard {
    bool previous=inside;
    FlushGuard() { inside=true; }
    ~FlushGuard() { inside=previous; }
};
// GL entry points act on the thread's current context, while flush accepts an
// explicit context. Bind that target only for effects and restore the caller.
// CGL locks are recursive, including when a game already holds this lock.
struct CurrentContext {
    CGLContextObj target,previous;
    explicit CurrentContext(CGLContextObj context):target(context),previous(CGLGetCurrentContext()) {
        CGLError result;
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLContextLock,reinterpret_cast<uintptr_t>(target));result=CGLLockContext(target);}
        if(result!=kCGLNoError) throw std::runtime_error("Cannot lock OpenGL presentation context");
        if(previous!=target) {
            macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLContextBind,reinterpret_cast<uintptr_t>(target));
            if(CGLSetCurrentContext(target)!=kCGLNoError) {CGLUnlockContext(target);throw std::runtime_error("Cannot select OpenGL presentation context");}
        }
    }
    ~CurrentContext() {if(previous!=target) CGLSetCurrentContext(previous);CGLUnlockContext(target);}
};
void releaseContextResources(CGLContextObj context) {
    if(!context) return;
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::OpenGLCleanup,reinterpret_cast<uintptr_t>(context));
    macfx::forgetOpenGL(context);
    std::map<CGLContextObj,Runtime>::node_type runtime;
    std::map<CGLContextObj,LegacySurface>::node_type surface;
    {std::lock_guard<std::mutex> lock(runtimeMutex());
        runtime=runtimes().extract(context);surface=legacySurfaces().extract(context);}
    if(!runtime&&!surface)return;
    try {
        CurrentContext current(context);
        // CoreVideo cache disposal destroys its own auxiliary CGL contexts and
        // reenters these hooks. Remove ownership under the map lock, then invoke
        // driver cleanup without that lock held.
        if(runtime)runtime.mapped().clear();
        if(surface)surface.mapped().clear();
    } catch(const std::exception &error) {
        if(runtime)runtime.mapped().abandon();
        if(surface&&surface.mapped().input) {CFRelease(surface.mapped().input);surface.mapped().input=nullptr;}
        log("OpenGL context cleanup: "+std::string(error.what()));
    }
}
IMP originalDealloc=nullptr;
void deallocContext(__unsafe_unretained id object,SEL selector) {
    // The receiver is already deallocating. CGLContextObj is annotated as an
    // inner-pointer getter; ordinary ARC messaging extends its receiver with
    // retain/autorelease, which would enqueue a release of this dead context.
    // The raw message preserves the original dealloc receiver's lifetime.
    using ContextGetter=CGLContextObj(*)(__unsafe_unretained id,SEL);
    const auto context=reinterpret_cast<ContextGetter>(objc_msgSend)(object,@selector(CGLContextObj));
    releaseContextResources(context);
    reinterpret_cast<void(*)(__unsafe_unretained id,SEL)>(originalDealloc)(object,selector);
}
IMP originalFlushBuffer=nullptr;
void process(CGLContextObj context) {
    const auto &config=macfx::nativeConfig();const auto &transport=config.diagnostics.openGLTransport;
    if(!context || inside || config.explicitHost) return;
    static std::atomic<bool> participated{false};
    if(!participated.load(std::memory_order_relaxed)){
        bool source=false;try{source=macfx::drawableResolutionRequested();}catch(...){}
        const bool diagnostic=config.diagnostics.enabled&&(transport=="overlay"||transport=="metal"||transport=="corevideo");
        if(!macfx::imageProcessingRequested()&&!source&&!macfx::virtualWindowEnabled()&&!diagnostic&&!macfx::gpuTimingEnabled()){
            // A bypassed frame of the game's own context adopts a pass-through plan.
            if(macfx::runtimeStatusLeased()&&macfx::acceptsOpenGL(context))macfx::observeBypassedPlan(reinterpret_cast<uintptr_t>(context));
            return;
        }
        // Once a context can own output, keep its existing Off retirement path.
        participated.store(true,std::memory_order_relaxed);
    }
    bool accepted;{macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLOwnership,reinterpret_cast<uintptr_t>(context));accepted=macfx::acceptsOpenGL(context);}
    if(!accepted) return;
    const bool forcedOverlay=config.diagnostics.enabled&&transport=="overlay";
    if(!macfx::effectRequested()&&!forcedOverlay&&!macfx::openGLPresentation(context)){
        macfx::observeBypassedPlan(reinterpret_cast<uintptr_t>(context));
        std::lock_guard lock(runtimeMutex());const auto found=runtimes().find(context);
        if(found!=runtimes().end()&&found->second.interop)found->second.interop->resetHistory();
        return;
    }
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::OpenGLFrame,reinterpret_cast<uintptr_t>(context));
    inside=true;
    try {
        CurrentContext current(context);
        std::unique_lock<std::mutex> lock(runtimeMutex(),std::defer_lock);
        {macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLRuntimeLock,reinterpret_cast<uintptr_t>(context));lock.lock();}
        auto &r=runtimes()[context];
        GLint size[2]={};CGLGetParameter(context,kCGLCPSurfaceBackingSize,size);
        if(size[0]<=0||size[1]<=0){unsigned width=0,height=0;if(macfx::openGLSize(context,width,height)){size[0]=width;size[1]=height;}}
        r.sourceWidth=std::max(size[0],0);r.sourceHeight=std::max(size[1],0);
        if(r.failed&&r.sourceWidth&&r.sourceHeight){
            const bool unchanged=r.interop&&r.interop->terminalGpuFailure()?r.interop->failureMatchesCurrent(r.sourceWidth,r.sourceHeight):
                r.failedPlan==macfx::effectPlanDemandGeneration()&&r.failedControls==macfx::liveState().generation&&r.failedWidth==r.sourceWidth&&r.failedHeight==r.sourceHeight;
            if(!unchanged){State restore(r.core,1);r.clear();r.failed=false;r.metalEffect=false;r.frames=0;log("OpenGL processing resources renewed for the changed graphics or source contract");}
        }
        if(!r.failed) {
            if(!r.validate(context)) { inside=false; return; }
            if(size[0]>0 && size[1]>0) {
                macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLEffects,reinterpret_cast<uintptr_t>(context),size[0],size[1]);
                const bool metalTransport=config.diagnostics.enabled && transport=="metal";
                const bool presentationTransport=macfx::graphicsRequested() || (config.diagnostics.enabled && transport=="overlay");
                const bool coreVideoTransport=r.core && config.diagnostics.enabled && transport=="corevideo";
                // Legacy effects already use Metal. Inspect its compiled pass
                // bindings once per owner/size, then capture real window depth
                // only for techniques that actually consume DEPTH.
                bool depthTransport=false;
                if(!r.core||metalTransport) {
                    static id<MTLDevice> depthDevice=MTLCreateSystemDefaultDevice();
                    depthTransport=macfx::frameRequiresDepth(context,depthDevice,size[0],size[1]);
                }
                if(r.core&&!metalTransport&&!coreVideoTransport&&!presentationTransport&&!r.metalEffect) {
                    try{r.render(size[0],size[1]);}
                    catch(const RequiresMetal &){State restore(r.core);r.clear();r.metalEffect=true;log("OpenGL effect uses the shared Metal processor");}
                    if(!r.metalEffect){inside=false;return;}
                }
                if(coreVideoTransport||presentationTransport||r.metalEffect||depthTransport) {
                    State restore(r.core,1);glActiveTexture(GL_TEXTURE0);
                    GLint rectangle=0;glGetIntegerv(GL_TEXTURE_BINDING_RECTANGLE,&rectangle);
                    struct RestoreRectangle {GLint binding;~RestoreRectangle(){glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_RECTANGLE,binding);}} restoreRectangle{rectangle};
                    if(!r.interop)r.interop=std::make_unique<macfx::OpenGLInterop>(context,presentationTransport);
                    r.interop->render(size[0],size[1],presentationTransport);
                } else legacySurfaces()[context].render(size[0],size[1],context,r.core);
            }
        }
    } catch(const macfx::ImageBudgetExceeded &e) { log("OpenGL effect memory admission deferred: "+std::string(e.what())); }
      catch(const std::exception &e) {
        // A failed submission does not invalidate the last completed owned
        // image. Off or a successfully revealed replacement retires its view.
        log("OpenGL effect disabled for the current graphics and source contract: "+std::string(e.what()));
        std::lock_guard<std::mutex> lock(runtimeMutex());auto&r=runtimes()[context];r.failed=true;
        r.failedPlan=macfx::effectPlanDemandGeneration();r.failedControls=macfx::liveState().generation;r.failedWidth=r.sourceWidth;r.failedHeight=r.sourceHeight;
      }
    inside=false;
}
void flushBuffer(id object,SEL selector) {
    process([(NSOpenGLContext *)object CGLContextObj]);
    FlushGuard guard;
    macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLFlush,reinterpret_cast<uintptr_t>((__bridge void *)object));
    reinterpret_cast<void(*)(id,SEL)>(originalFlushBuffer)(object,selector);
}
}
extern "C" CGLError rsFlushDrawable(CGLContextObj context) {
    process(context);
    FlushGuard guard;
    macfx::DiagnosticScope scope(macfx::DiagnosticStage::OpenGLFlush,reinterpret_cast<uintptr_t>(context));
    return CGLFlushDrawable(context);
}
extern "C" CGLError rsDestroyContext(CGLContextObj context) {
    releaseContextResources(context);return CGLDestroyContext(context);
}
extern "C" void rsReleaseContext(CGLContextObj context) {
    if(context && CGLGetContextRetainCount(context)==1) releaseContextResources(context);
    CGLReleaseContext(context);
}
__attribute__((used)) static const struct {const void *replacement;const void *original;} interpose[]
__attribute__((section("__DATA,__interpose")))={{reinterpret_cast<const void*>(rsFlushDrawable),reinterpret_cast<const void*>(CGLFlushDrawable)},
 {reinterpret_cast<const void*>(rsDestroyContext),reinterpret_cast<const void*>(CGLDestroyContext)},
 {reinterpret_cast<const void*>(rsReleaseContext),reinterpret_cast<const void*>(CGLReleaseContext)}};
__attribute__((constructor)) static void loaded() {
    if(macfx::nativeConfig().explicitHost) return;
    macfx::DiagnosticScope diagnostics(macfx::DiagnosticStage::Hooks,2);
    if(macfx::nativeTraceEnabled())log("ReShade macOS library loaded");
    if(macfx::liveEffects()||macfx::effectRequested()||macfx::graphicsRequested()) {
        const SEL dealloc=sel_registerName("dealloc");
        Method destroy=class_getInstanceMethod(NSOpenGLContext.class,dealloc);originalDealloc=method_getImplementation(destroy);
        if(!class_addMethod(NSOpenGLContext.class,dealloc,reinterpret_cast<IMP>(deallocContext),method_getTypeEncoding(destroy)))
            method_setImplementation(destroy,reinterpret_cast<IMP>(deallocContext));
        Method method=class_getInstanceMethod(NSOpenGLContext.class,@selector(flushBuffer));
        originalFlushBuffer=method_setImplementation(method,reinterpret_cast<IMP>(flushBuffer));
    }
}
