// Copyright (c) MacLauncher contributors. MIT license.
// A screenshot channel on a dormant OpenGL game: no effect, no live graphics.
// A frame flushed without a request is not captured. A frame flushed while a
// request is pending is read from the game's own back buffer and published once
// as an 8-bit capture, top row first. The next frame is not captured again.
// opengl-dormant-screenshot <libreshade-macos.dylib>
#import <Cocoa/Cocoa.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

static void check(bool value,const char*reason){if(!value)throw std::runtime_error(reason);}
static bool waitFor(const std::string&file,bool present,int milliseconds){
    for(int waited=0;waited<milliseconds;waited+=10){if(std::filesystem::exists(file)==present)return true;std::this_thread::sleep_for(std::chrono::milliseconds(10));}
    return std::filesystem::exists(file)==present;
}
// Top half red, bottom half blue, in GL's bottom-up rows.
static void draw(GLint width,GLint height){
    glBindFramebuffer(GL_FRAMEBUFFER,0);glDrawBuffer(GL_BACK);glViewport(0,0,width,height);glDisable(GL_SCISSOR_TEST);
    glClearColor(0,0,1,1);glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_SCISSOR_TEST);glScissor(0,height/2,width,height-height/2);glClearColor(1,0,0,1);glClear(GL_COLOR_BUFFER_BIT);glDisable(GL_SCISSOR_TEST);
}
int main(int argc,char**argv){@autoreleasepool{
    char directory[]="/private/tmp/maclauncher-opengl-dormant-screenshot-XXXXXX";
    try{
        check(argc==2,"Usage: opengl-dormant-screenshot <libreshade-macos.dylib>");
        check(mkdtemp(directory)!=nullptr,"Cannot create the fixture directory");
        const std::string prefix=std::string(directory)+"/frame",trigger=std::string(directory)+"/request",after=prefix+"-after.rgba";
        setenv("RESHADE_LOG",(std::string(directory)+"/reshade.log").c_str(),1);
        setenv("RESHADE_CAPTURE_PREFIX",prefix.c_str(),1);setenv("RESHADE_CAPTURE_TRIGGER",trigger.c_str(),1);setenv("RESHADE_CAPTURE_FINAL","1",1);
        for(const char*name:{"RESHADE_EFFECT","RESHADE_EFFECT_PLAN","RESHADE_LIVE_EFFECTS","RESHADE_CONTROL_FILE","RESHADE_EXPLICIT_HOST","RESHADE_DIAGNOSTICS",
            "RESHADE_GPU_TIMING","RESHADE_TRACE","RESHADE_CAPTURE_FRAME"})unsetenv(name);
        [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSOpenGLPixelFormatAttribute attributes[]={NSOpenGLPFAAccelerated,NSOpenGLPFAOpenGLProfile,NSOpenGLProfileVersion4_1Core,NSOpenGLPFADoubleBuffer,
            NSOpenGLPFAColorSize,32,NSOpenGLPFAAlphaSize,8,0};
        auto*format=[[NSOpenGLPixelFormat alloc]initWithAttributes:attributes];
        if(!format){std::puts("No hardware-accelerated OpenGL context; check requires a physical Mac.");std::filesystem::remove_all(directory);return 77;}
        void*library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library)throw std::runtime_error(std::string("dlopen: ")+dlerror());
        auto flush=reinterpret_cast<CGLError(*)(CGLContextObj)>(dlsym(library,"rsFlushDrawable"));check(flush!=nullptr,"rsFlushDrawable is not exported");
        auto*window=[[NSPanel alloc]initWithContentRect:NSMakeRect(24,24,96,64) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed=NO;auto*view=[[NSOpenGLView alloc]initWithFrame:NSMakeRect(0,0,96,64)pixelFormat:format];window.contentView=view;
        [window orderBack:nil];[window display];CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.05,false);
        [view.openGLContext update];[view.openGLContext makeCurrentContext];
        const auto context=view.openGLContext.CGLContextObj;check(context!=nullptr,"No OpenGL context");
        const NSRect backing=[view convertRectToBacking:view.bounds];const GLint width=GLint(backing.size.width),height=GLint(backing.size.height);
        CGLSetParameter(context,kCGLCPSurfaceBackingSize,(const GLint[]){width,height});CGLEnable(context,kCGLCESurfaceBackingSize);

        draw(width,height);flush(context);
        check(!waitFor(after,true,400),"A frame without a request was captured");
        {std::ofstream request(trigger);request<<"capture";}
        check(waitFor(trigger,false,3000),"The request file was not taken while the hooks are dormant");
        draw(width,height);flush(context);
        check(waitFor(after,true,5000),"A requested frame of a dormant OpenGL game was not captured");
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        std::ifstream input(after,std::ios::binary);std::vector<unsigned char>data((std::istreambuf_iterator<char>(input)),{});
        check(data.size()>=24&&std::memcmp(data.data(),"MCLCAP01",8)==0,"The capture is not an 8-bit capture file");
        uint32_t fields[4];std::memcpy(fields,data.data()+8,sizeof(fields));
        if(!(fields[0]==uint32_t(width)&&fields[1]==uint32_t(height)&&fields[2]==uint32_t(width)*4&&data.size()==24+size_t(width)*height*4))
            throw std::runtime_error("The capture lost the back buffer's extent: "+std::to_string(fields[0])+"x"+std::to_string(fields[1])+" stride "+std::to_string(fields[2])+
                ", "+std::to_string(data.size())+" bytes for "+std::to_string(width)+"x"+std::to_string(height));
        const auto pixel=[&](uint32_t x,uint32_t y){return data.data()+24+(size_t(y)*width+x)*4;};
        const auto*top=pixel(width/2,1),*bottom=pixel(width/2,height-2);
        std::printf("capture %ux%u top=%u,%u,%u,%u bottom=%u,%u,%u,%u\n",fields[0],fields[1],top[0],top[1],top[2],top[3],bottom[0],bottom[1],bottom[2],bottom[3]);
        check(top[0]>=250&&top[1]<=5&&top[2]<=5&&top[3]==255,"The top row is not the game's red top half");
        check(bottom[0]<=5&&bottom[1]<=5&&bottom[2]>=250&&bottom[3]==255,"The bottom row is not the game's blue bottom half");
        std::filesystem::remove(after);draw(width,height);flush(context);
        check(!waitFor(after,true,400),"A published request captured a second frame");
        [NSOpenGLContext clearCurrentContext];[window orderOut:nil];[window close];
        std::filesystem::remove_all(directory);
        std::puts("opengl-dormant-screenshot: a requested frame of a dormant OpenGL game is captured once from its back buffer, top row first");
        return 0;
    }catch(const std::exception&error){
        std::ifstream log(std::string(directory)+"/reshade.log");std::fprintf(stderr,"%s\n%s",error.what(),std::string((std::istreambuf_iterator<char>(log)),{}).c_str());
        std::filesystem::remove_all(directory);return 1;
    }
}}
