#import <Foundation/Foundation.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include "surface-format.hpp"
#include <dlfcn.h>
#include <cassert>
#include <cstdio>
#include <string>
static void*eglLibrary,*glLibrary;
template<class T>T api(const char*name){
    void*value=dlsym(eglLibrary,name);if(!value)value=dlsym(glLibrary,name);
    if(!value)value=(void*)((PFNEGLGETPROCADDRESSPROC)dlsym(eglLibrary,"eglGetProcAddress"))(name);
    assert(value);return reinterpret_cast<T>(value);
}
#define CALL(name) api<decltype(&name)>(#name)
static void sampleExternal(GLuint texture,int alpha){
    for(int version:{100,300}){
        auto compile=[&](GLenum kind,const std::string&text){
            GLuint shader=CALL(glCreateShader)(kind);const char*source=text.c_str();CALL(glShaderSource)(shader,1,&source,nullptr);CALL(glCompileShader)(shader);
            GLint good=0;CALL(glGetShaderiv)(shader,GL_COMPILE_STATUS,&good);if(!good){char log[2048]{};CALL(glGetShaderInfoLog)(shader,sizeof(log),nullptr,log);std::fprintf(stderr,"%s\n",log);}assert(good);return shader;
        };
        auto vertex=compile(GL_VERTEX_SHADER,version==100?"attribute vec2 position;void main(){gl_Position=vec4(position,0,1);}":"#version 300 es\nin vec2 position;void main(){gl_Position=vec4(position,0,1);}");
        auto fragment=compile(GL_FRAGMENT_SHADER,version==100?
            "#extension GL_OES_EGL_image_external : require\nprecision mediump float;uniform samplerExternalOES image;void main(){gl_FragColor=(texture2D(image,vec2(0.5))+texture2DProj(image,vec3(0.5,0.5,1))+texture2DProj(image,vec4(0.5,0.5,0,1)))/3.0;}":
            "#version 300 es\n#extension GL_OES_EGL_image_external_essl3 : require\nprecision mediump float;uniform samplerExternalOES image;out vec4 color;void main(){color=(texture(image,vec2(0.5))+texture(image,vec2(0.5),0.0)+textureProj(image,vec3(0.5,0.5,1))+textureProj(image,vec4(0.5,0.5,0,1))+textureProj(image,vec3(0.5,0.5,1),0.0)+textureProj(image,vec4(0.5,0.5,0,1),0.0)+texelFetch(image,ivec2(0),0))/7.0;if(any(notEqual(textureSize(image,0),ivec2(4))))color=vec4(1,0,0,1);}");
        auto program=CALL(glCreateProgram)();CALL(glAttachShader)(program,vertex);CALL(glAttachShader)(program,fragment);CALL(glBindAttribLocation)(program,0,"position");CALL(glLinkProgram)(program);
        GLint good=0;CALL(glGetProgramiv)(program,GL_LINK_STATUS,&good);if(!good){char log[4096]{};CALL(glGetProgramInfoLog)(program,sizeof(log),nullptr,log);std::fprintf(stderr,"link GLSL%d: %s\n",version,log);}assert(good);CALL(glUseProgram)(program);
        GLuint vertices=0;CALL(glGenBuffers)(1,&vertices);CALL(glBindBuffer)(GL_ARRAY_BUFFER,vertices);const float triangle[]={-1,-1,3,-1,-1,3};CALL(glBufferData)(GL_ARRAY_BUFFER,sizeof(triangle),triangle,GL_STATIC_DRAW);
        CALL(glVertexAttribPointer)(0,2,GL_FLOAT,GL_FALSE,0,nullptr);CALL(glEnableVertexAttribArray)(0);
        CALL(glActiveTexture)(GL_TEXTURE0);CALL(glBindTexture)(GL_TEXTURE_EXTERNAL_OES,texture);CALL(glUniform1i)(CALL(glGetUniformLocation)(program,"image"),0);
        CALL(glBindFramebuffer)(GL_FRAMEBUFFER,0);CALL(glViewport)(0,0,4,4);CALL(glDrawArrays)(GL_TRIANGLES,0,3);
        unsigned char pixel[4]{};CALL(glReadPixels)(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
        const auto error=CALL(glGetError)();std::fprintf(stderr,"external GLSL%d error0x%x pixel=%u/%u/%u/%u\n",version,error,pixel[0],pixel[1],pixel[2],pixel[3]);
        assert(error==GL_NO_ERROR&&pixel[0]==0&&pixel[1]==0&&pixel[2]==255&&pixel[3]==alpha);
        CALL(glDeleteBuffers)(1,&vertices);CALL(glDeleteShader)(vertex);CALL(glDeleteShader)(fragment);CALL(glDeleteProgram)(program);
    }
}
int main(int argc,char**argv){@autoreleasepool{
    assert(argc==2);std::string root=argv[1];
    eglLibrary=dlopen((root+"/libEGL.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);
    glLibrary=dlopen((root+"/libGLESv2.dylib").c_str(),RTLD_NOW|RTLD_LOCAL);assert(eglLibrary&&glLibrary);
    const EGLint platform[]={EGL_PLATFORM_ANGLE_TYPE_ANGLE,EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,EGL_NONE};
    auto display=api<PFNEGLGETPLATFORMDISPLAYEXTPROC>("eglGetPlatformDisplayEXT")(EGL_PLATFORM_ANGLE_ANGLE,nullptr,platform);
    assert(CALL(eglInitialize)(display,nullptr,nullptr));
    EGLAttrib eglDevice=0,metalDevice=0;
    assert(api<PFNEGLQUERYDISPLAYATTRIBEXTPROC>("eglQueryDisplayAttribEXT")(display,EGL_DEVICE_EXT,&eglDevice));
    assert(api<PFNEGLQUERYDEVICEATTRIBEXTPROC>("eglQueryDeviceAttribEXT")((EGLDeviceEXT)eglDevice,0x34A6,&metalDevice));
    auto device=(__bridge id<MTLDevice>)(void*)metalDevice;assert(device);
    EGLConfig config=nullptr;EGLint count=0;const EGLint configAttrs[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES2_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
    assert(CALL(eglChooseConfig)(display,configAttrs,&config,1,&count)&&count);
    const EGLint contextAttrs[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE},surfaceAttrs[]={EGL_WIDTH,4,EGL_HEIGHT,4,EGL_NONE};
    auto context=CALL(eglCreateContext)(display,config,EGL_NO_CONTEXT,contextAttrs);
    auto surface=CALL(eglCreatePbufferSurface)(display,config,surfaceAttrs);assert(context&&surface);
    assert(CALL(eglMakeCurrent)(display,surface,surface,context));
    for(const auto variant:{std::pair{1,false},std::pair{2,false},std::pair{4,false},std::pair{2,true}}){
        const auto[format,renderbuffer]=variant;
        const size_t bytes=format==4?2:4,row=IOSurfaceAlignProperty(kIOSurfaceBytesPerRow,4*bytes);
        auto storage=IOSurfaceCreate((__bridge CFDictionaryRef)@{(__bridge NSString*)kIOSurfaceWidth:@4,(__bridge NSString*)kIOSurfaceHeight:@4,
            (__bridge NSString*)kIOSurfaceBytesPerElement:@(bytes),(__bridge NSString*)kIOSurfaceBytesPerRow:@(row),
            (__bridge NSString*)kIOSurfacePixelFormat:@(format==4?(uint32_t)'L565':(uint32_t)'RGBA')});assert(storage);
        assert(IOSurfaceLock(storage,0,nullptr)==kIOReturnSuccess);
        for(size_t y=0;y<4;y++)for(size_t x=0;x<4;x++){
            auto*pixel=static_cast<unsigned char*>(IOSurfaceGetBaseAddress(storage))+y*row+x*bytes;
            if(format==4)*reinterpret_cast<uint16_t*>(pixel)=0x001f;
            else{pixel[0]=0;pixel[1]=0;pixel[2]=255;pixel[3]=17;}
        }
        IOSurfaceUnlock(storage,0,nullptr);
        auto nativeTexture=klj_surface_format::texture(device,storage);assert(nativeTexture);
        const EGLint imageAttrs[]={0x345D,format==1?0x8058:(format==4?0x8D62:0x8051),EGL_NONE};
        auto image=api<PFNEGLCREATEIMAGEKHRPROC>("eglCreateImageKHR")(display,EGL_NO_CONTEXT,0x34A7,(__bridge void*)nativeTexture,imageAttrs);assert(image);
        GLuint external=0;CALL(glGenTextures)(1,&external);CALL(glBindTexture)(GL_TEXTURE_EXTERNAL_OES,external);
        api<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_EXTERNAL_OES,image);assert(CALL(glGetError)()==GL_NO_ERROR);
        GLuint texture=0,framebuffer=0,render=0;
        if(renderbuffer){CALL(glGenRenderbuffers)(1,&render);CALL(glBindRenderbuffer)(GL_RENDERBUFFER,render);
            api<PFNGLEGLIMAGETARGETRENDERBUFFERSTORAGEOESPROC>("glEGLImageTargetRenderbufferStorageOES")(GL_RENDERBUFFER,image);
        }else{CALL(glGenTextures)(1,&texture);CALL(glBindTexture)(GL_TEXTURE_2D,texture);
            api<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>("glEGLImageTargetTexture2DOES")(GL_TEXTURE_2D,image);}
        assert(CALL(glGetError)()==GL_NO_ERROR);
        // GL's sibling must retain storage after EGL image destruction and the
        // importing Metal view releases its reference.
        assert(api<PFNEGLDESTROYIMAGEKHRPROC>("eglDestroyImageKHR")(display,image));nativeTexture=nil;
        sampleExternal(external,format==1?17:255);
        CALL(glGenFramebuffers)(1,&framebuffer);CALL(glBindFramebuffer)(GL_FRAMEBUFFER,framebuffer);
        if(renderbuffer)CALL(glFramebufferRenderbuffer)(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_RENDERBUFFER,render);
        else CALL(glFramebufferTexture2D)(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,texture,0);
        assert(CALL(glCheckFramebufferStatus)(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);
        unsigned char original[4]{};CALL(glReadPixels)(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,original);
        assert(CALL(glGetError)()==GL_NO_ERROR&&original[0]==0&&original[1]==0&&original[2]==255&&original[3]==(format==1?17:255));
        CALL(glClearColor)(1,0,0,0);CALL(glClear)(GL_COLOR_BUFFER_BIT);
        unsigned char pixel[4]{};CALL(glReadPixels)(0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);
        const auto error=CALL(glGetError)();std::fprintf(stderr,"format%d error0x%x pixel=%u/%u/%u/%u\n",format,error,pixel[0],pixel[1],pixel[2],pixel[3]);
        assert(error==GL_NO_ERROR&&pixel[0]==255&&pixel[1]==0&&pixel[2]==0&&pixel[3]==(format==1?0:255));
        CALL(glFinish)();assert(IOSurfaceLock(storage,kIOSurfaceLockReadOnly,nullptr)==kIOReturnSuccess);
        if(format==4)assert(*static_cast<uint16_t*>(IOSurfaceGetBaseAddress(storage))==0xf800);
        else assert(*static_cast<uint8_t*>(IOSurfaceGetBaseAddress(storage))==255);
        IOSurfaceUnlock(storage,kIOSurfaceLockReadOnly,nullptr);
        CALL(glDeleteFramebuffers)(1,&framebuffer);CALL(glDeleteTextures)(1,&texture);CALL(glDeleteTextures)(1,&external);CALL(glDeleteRenderbuffers)(1,&render);CFRelease(storage);
    }
    assert(CALL(eglMakeCurrent)(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT));
    assert(CALL(eglDestroySurface)(display,surface));assert(CALL(eglDestroyContext)(display,context));assert(CALL(eglTerminate)(display));
    puts("PASS actual ANGLE native storage images, alpha, pixels and sibling lifetime");
}}
