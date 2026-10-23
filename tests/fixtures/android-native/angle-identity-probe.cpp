#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#include <GLES3/gl3.h>
#include <dlfcn.h>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#define EGL(name) auto name = reinterpret_cast<decltype(&::name)>(dlsym(egl, #name)); assert(name)
#define GL(name) auto name = reinterpret_cast<decltype(&::name)>(dlsym(gles, #name)); assert(name)

int main(int argc, char **argv)
{
    assert(argc == 3);
    const bool vulkan = !strcmp(argv[2], "vulkan");
    auto egl = dlopen((std::string(argv[1])+"/libEGL.dylib").c_str(), RTLD_NOW | RTLD_LOCAL);
    auto gles = dlopen((std::string(argv[1])+"/libGLESv2.dylib").c_str(), RTLD_NOW | RTLD_LOCAL);
    assert(egl && gles);
    EGL(eglInitialize); EGL(eglChooseConfig); EGL(eglCreateContext); EGL(eglCreatePbufferSurface);
    EGL(eglMakeCurrent); EGL(eglDestroyContext); EGL(eglDestroySurface); EGL(eglTerminate);
    auto platform = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(dlsym(egl, "eglGetPlatformDisplayEXT"));
    assert(platform);
    const EGLint displayAttributes[] = {EGL_PLATFORM_ANGLE_TYPE_ANGLE,
        vulkan ? EGL_PLATFORM_ANGLE_TYPE_VULKAN_ANGLE : EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE, EGL_NONE};
    auto display = platform(EGL_PLATFORM_ANGLE_ANGLE, nullptr, displayAttributes);
    assert(display && eglInitialize(display, nullptr, nullptr));
    const EGLint attributes[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE,
        EGL_OPENGL_ES3_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE};
    EGLConfig config;
    EGLint count;
    assert(eglChooseConfig(display, attributes, &config, 1, &count) && count);
    const EGLint contextAttributes[] = {EGL_CONTEXT_MAJOR_VERSION_KHR, 3,
        EGL_CONTEXT_MINOR_VERSION_KHR, vulkan ? 1 : 0, EGL_NONE};
    auto context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
    const EGLint extent[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
    auto surface = eglCreatePbufferSurface(display, config, extent);
    assert(context && surface && eglMakeCurrent(display, surface, surface, context));
    GL(glCreateProgram); GL(glProgramBinary); GL(glGetProgramiv); GL(glGetProgramInfoLog);
    GL(glGetString); GL(glDeleteProgram); GL(glCreateShader); GL(glShaderSource);
    GL(glCompileShader); GL(glAttachShader); GL(glLinkProgram); GL(glGetProgramBinary); GL(glDeleteShader);
    const char *vertex = "#version 300 es\nvoid main(){gl_Position=vec4(0.,0.,0.,1.);}";
    const char *fragment = "#version 300 es\nprecision highp float;out vec4 c;void main(){c=vec4(1.);}";
    auto vs = glCreateShader(GL_VERTEX_SHADER), fs = glCreateShader(GL_FRAGMENT_SHADER);
    glShaderSource(vs, 1, &vertex, nullptr); glShaderSource(fs, 1, &fragment, nullptr);
    glCompileShader(vs); glCompileShader(fs);
    auto program = glCreateProgram();
    glAttachShader(program, vs); glAttachShader(program, fs); glLinkProgram(program);
    GLint linked = 0, length = 0;
    glGetProgramiv(program, GL_LINK_STATUS, &linked); assert(linked);
    glGetProgramiv(program, GL_PROGRAM_BINARY_LENGTH, &length); assert(length > 16);
    std::vector<char> binary(length);
    GLenum format;
    glGetProgramBinary(program, length, nullptr, &format, binary.data());
    auto restored = glCreateProgram();
    glProgramBinary(restored, format, binary.data(), length);
    glGetProgramiv(restored, GL_LINK_STATUS, &linked); assert(linked);
    binary[0] = binary[0] == '0' ? '1' : '0';
    auto incompatible = glCreateProgram();
    glProgramBinary(incompatible, format, binary.data(), length);
    glGetProgramiv(incompatible, GL_LINK_STATUS, &linked); assert(!linked);
    char log[4096] = {};
    glGetProgramInfoLog(incompatible, sizeof(log), nullptr, log);
    assert(strstr(log, "Invalid program binary version."));
    glGetProgramBinary(program, length, nullptr, &format, binary.data());
    printf("{\"version\":\"%s\",\"renderer\":\"%s\",\"binaryVersion\":\"%.16s\","
        "\"roundtrip\":true,\"incompatibleRejected\":true}\n",
        glGetString(GL_VERSION), glGetString(GL_RENDERER), binary.data());
    glDeleteProgram(incompatible); glDeleteProgram(restored); glDeleteProgram(program);
    glDeleteShader(vs); glDeleteShader(fs);
    eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroySurface(display, surface); eglDestroyContext(display, context); eglTerminate(display);
}
