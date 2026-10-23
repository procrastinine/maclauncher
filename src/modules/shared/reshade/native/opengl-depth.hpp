#pragma once
#include <OpenGL/gl3.h>
#include <algorithm>
#include <stdexcept>
#include <string>

extern "C" void glGenVertexArraysAPPLE(GLsizei, GLuint *);
extern "C" void glBindVertexArrayAPPLE(GLuint);
extern "C" void glDeleteVertexArraysAPPLE(GLsizei, const GLuint *);

namespace macfx {
// Captures only the actual window depth attachment. An engine's unrelated
// offscreen depth buffer cannot be inferred from its final color image.
// The caller saves GL state and supplies a single-channel float color FBO.
class OpenGLDepthCapture {
    GLuint texture=0,framebuffer=0,program=0,vao=0,vbo=0;
    bool core=false;
    unsigned width=0,height=0;
    GLint sourceUniform=-1,extentUniform=-1;
    static GLuint shader(GLenum type,const char *source) {
        GLuint shader=glCreateShader(type);glShaderSource(shader,1,&source,nullptr);glCompileShader(shader);
        GLint ok=0;glGetShaderiv(shader,GL_COMPILE_STATUS,&ok);
        if(!ok){char message[2048]={};glGetShaderInfoLog(shader,sizeof(message),nullptr,message);glDeleteShader(shader);throw std::runtime_error(std::string("Depth capture shader: ")+message);}
        return shader;
    }
public:
    ~OpenGLDepthCapture(){clear();}
    void abandon() noexcept {texture=framebuffer=program=vao=vbo=width=height=0;}
    void clear() {
        if(texture)glDeleteTextures(1,&texture);
        if(framebuffer)glDeleteFramebuffers(1,&framebuffer);
        if(program)glDeleteProgram(program);
        if(vbo)glDeleteBuffers(1,&vbo);
        if(vao){if(core)glDeleteVertexArrays(1,&vao);else glDeleteVertexArraysAPPLE(1,&vao);}
        texture=framebuffer=program=vao=vbo=width=height=0;
    }
    void prepare(unsigned w,unsigned h,bool isCore) {
        if(width==w&&height==h&&program)return;
        clear();core=isCore;
        // At most 64 MiB for the depth scratch (including packed stencil).
        if(!w||!h||w>16384||h>16384||size_t(w)*h>(64u<<20)/8)
            throw std::runtime_error("OpenGL depth dimensions exceed the capture limit");
        glBindFramebuffer(GL_FRAMEBUFFER,0);
        GLint bits=0,stencil=0,type=GL_UNSIGNED_NORMALIZED;
        if(core) {
            glGetFramebufferAttachmentParameteriv(GL_FRAMEBUFFER,GL_DEPTH,GL_FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE,&bits);
            glGetFramebufferAttachmentParameteriv(GL_FRAMEBUFFER,GL_STENCIL,GL_FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE,&stencil);
            if(bits)glGetFramebufferAttachmentParameteriv(GL_FRAMEBUFFER,GL_DEPTH,GL_FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE,&type);
        } else {
            glGetIntegerv(0x0D56/*GL_DEPTH_BITS*/,&bits);glGetIntegerv(0x0D57/*GL_STENCIL_BITS*/,&stencil);
        }
        GLenum internal=0,format=GL_DEPTH_COMPONENT,dataType=GL_UNSIGNED_INT;
        if(bits==24&&type==GL_UNSIGNED_NORMALIZED){internal=stencil?GL_DEPTH24_STENCIL8:GL_DEPTH_COMPONENT24;}
        else if(bits==16&&!stencil&&type==GL_UNSIGNED_NORMALIZED)internal=GL_DEPTH_COMPONENT16;
        // Default depth/stencil can be separate attachments. Do not infer a
        // floating packed depth format solely from the presence of stencil.
        else if(bits==32&&type==GL_UNSIGNED_NORMALIZED)internal=GL_DEPTH_COMPONENT32;
        else if(bits==32&&type==GL_FLOAT){internal=stencil?GL_DEPTH32F_STENCIL8:GL_DEPTH_COMPONENT32F;dataType=GL_FLOAT;}
        else throw std::runtime_error("The OpenGL window has no supported depth attachment (bits="+std::to_string(bits)+", stencil="+std::to_string(stencil)+", type="+std::to_string(type)+")");
        const bool packed=internal==GL_DEPTH24_STENCIL8||internal==GL_DEPTH32F_STENCIL8;
        if(packed){format=GL_DEPTH_STENCIL;dataType=internal==GL_DEPTH32F_STENCIL8?GL_FLOAT_32_UNSIGNED_INT_24_8_REV:GL_UNSIGNED_INT_24_8;}
        glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_COMPARE_MODE,GL_NONE);
        GLint unpack=0;glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING,&unpack);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,0);
        glTexImage2D(GL_TEXTURE_2D,0,internal,w,h,0,format,dataType,nullptr);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,unpack);
        GLint allocated=0;glGetTexLevelParameteriv(GL_TEXTURE_2D,0,GL_TEXTURE_WIDTH,&allocated);
        if(allocated!=GLint(w))throw std::runtime_error("Cannot allocate OpenGL depth capture");
        glGenFramebuffers(1,&framebuffer);glBindFramebuffer(GL_FRAMEBUFFER,framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER,GL_DEPTH_ATTACHMENT,GL_TEXTURE_2D,texture,0);
        if(packed)glFramebufferTexture2D(GL_FRAMEBUFFER,GL_STENCIL_ATTACHMENT,GL_TEXTURE_2D,texture,0);
        glDrawBuffer(GL_NONE);glReadBuffer(GL_NONE);
        if(glCheckFramebufferStatus(GL_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE)throw std::runtime_error("OpenGL depth framebuffer is incomplete");
        const char *vs=core?"#version 410\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}":
            "#version 120\nattribute float RSVertexID;void main(){vec2 p=vec2(RSVertexID==1.?2.:0.,RSVertexID==2.?2.:0.);gl_Position=vec4(p*2.-1.,0.,1.);}";
        const char *fs=core?"#version 410\nuniform sampler2D depthSource;uniform vec2 extent;layout(location=0)out float result;void main(){result=texture(depthSource,vec2(gl_FragCoord.x,extent.y-gl_FragCoord.y)/extent).r;}":
            "#version 120\nuniform sampler2D depthSource;uniform vec2 extent;void main(){float d=texture2D(depthSource,vec2(gl_FragCoord.x,extent.y-gl_FragCoord.y)/extent).r;gl_FragColor=vec4(d,0.,0.,1.);}";
        GLuint vertex=shader(GL_VERTEX_SHADER,vs),fragment=0;
        try {fragment=shader(GL_FRAGMENT_SHADER,fs);program=glCreateProgram();glAttachShader(program,vertex);glAttachShader(program,fragment);glBindAttribLocation(program,0,"RSVertexID");glLinkProgram(program);
            GLint ok=0;glGetProgramiv(program,GL_LINK_STATUS,&ok);if(!ok)throw std::runtime_error("Cannot link OpenGL depth capture");
        }catch(...){glDeleteShader(vertex);glDeleteShader(fragment);throw;}
        glDeleteShader(vertex);glDeleteShader(fragment);
        sourceUniform=glGetUniformLocation(program,"depthSource");extentUniform=glGetUniformLocation(program,"extent");
        if(core)glGenVertexArrays(1,&vao);else glGenVertexArraysAPPLE(1,&vao);
        if(core)glBindVertexArray(vao);else glBindVertexArrayAPPLE(vao);
        if(!core){const float ids[]={0,1,2};glGenBuffers(1,&vbo);glBindBuffer(GL_ARRAY_BUFFER,vbo);glBufferData(GL_ARRAY_BUFFER,sizeof(ids),ids,GL_STATIC_DRAW);glEnableVertexAttribArray(0);glVertexAttribPointer(0,1,GL_FLOAT,GL_FALSE,0,nullptr);}
        width=w;height=h;
    }
    void capture(GLuint output) {
        for(GLenum state:{GL_BLEND,GL_DEPTH_TEST,GL_STENCIL_TEST,GL_SCISSOR_TEST,GL_CULL_FACE,GL_FRAMEBUFFER_SRGB,GL_DITHER})glDisable(state);
        if(core)glDisable(GL_RASTERIZER_DISCARD);
        // The destination has one sample. Preserve the game's sample/clip state
        // while preventing those tests from dropping pixels in this full copy.
        const GLenum sampleStates[]={GL_SAMPLE_ALPHA_TO_COVERAGE,GL_SAMPLE_COVERAGE,GL_SAMPLE_MASK};GLboolean sampleEnabled[3]={};
        for(unsigned i=0;i<(core?3u:2u);++i){sampleEnabled[i]=glIsEnabled(sampleStates[i]);glDisable(sampleStates[i]);}
        GLint clips=0;glGetIntegerv(0x0D32/*GL_MAX_CLIP_PLANES / GL_MAX_CLIP_DISTANCES*/,&clips);clips=std::min(clips,8);GLboolean clipEnabled[8]={};
        for(GLint i=0;i<clips;++i){clipEnabled[i]=glIsEnabled(GL_CLIP_DISTANCE0+i);glDisable(GL_CLIP_DISTANCE0+i);}
        glColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);glPolygonMode(GL_FRONT_AND_BACK,GL_FILL);
        glBindFramebuffer(GL_READ_FRAMEBUFFER,0);glBindFramebuffer(GL_DRAW_FRAMEBUFFER,framebuffer);
        // Equal-sized, matching-format resolve; neither source depth nor stencil
        // is cleared or overwritten. Multisample resolution stays on the GPU.
        glBlitFramebuffer(0,0,width,height,0,0,width,height,GL_DEPTH_BUFFER_BIT,GL_NEAREST);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,output);glDrawBuffer(GL_COLOR_ATTACHMENT0);glViewport(0,0,width,height);
        glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,texture);if(core)glBindSampler(0,0);
        if(core)glBindVertexArray(vao);else glBindVertexArrayAPPLE(vao);
        glUseProgram(program);glUniform1i(sourceUniform,0);glUniform2f(extentUniform,width,height);
        glDrawArrays(GL_TRIANGLES,0,3);
        for(GLint i=0;i<clips;++i)if(clipEnabled[i])glEnable(GL_CLIP_DISTANCE0+i);
        for(unsigned i=0;i<(core?3u:2u);++i)if(sampleEnabled[i])glEnable(sampleStates[i]);
    }
};
}
