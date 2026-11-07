#pragma once
#include <OpenGL/gl3.h>
#include <stdexcept>
namespace macfx {
// A multisample resolve/copy uses identical rectangles. Only the single-sample
// intermediate is flipped; callers retain their normal GL state restoration.
class OpenGLFlip {
    GLuint texture=0,fbo=0;unsigned width=0,height=0;
    void prepare(unsigned w,unsigned h){
        if(fbo&&width==w&&height==h)return;
        clear();GLint binding=0,unpack=0;glGetIntegerv(GL_TEXTURE_BINDING_2D,&binding);glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING,&unpack);
        struct Restore {GLint texture,unpack;~Restore(){glBindTexture(GL_TEXTURE_2D,texture);glBindBuffer(GL_PIXEL_UNPACK_BUFFER,unpack);}} restore{binding,unpack};
        glBindBuffer(GL_PIXEL_UNPACK_BUFFER,0);glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);
        glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,w,h,0,GL_RGBA,GL_UNSIGNED_BYTE,nullptr);
        glGenFramebuffers(1,&fbo);glBindFramebuffer(GL_DRAW_FRAMEBUFFER,fbo);
        glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,texture,0);
        if(glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER)!=GL_FRAMEBUFFER_COMPLETE){clear();throw std::runtime_error("Cannot prepare the OpenGL resolve image");}
        width=w;height=h;
    }
public:
    ~OpenGLFlip(){clear();}
    void clear(){if(fbo)glDeleteFramebuffers(1,&fbo);if(texture)glDeleteTextures(1,&texture);abandon();}
    void abandon()noexcept{texture=fbo=width=height=0;}
    void fromDefault(GLuint target,unsigned w,unsigned h){
        glBindFramebuffer(GL_READ_FRAMEBUFFER,0);glReadBuffer(GL_BACK);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,0);GLint samples=0;glGetIntegerv(GL_SAMPLE_BUFFERS,&samples);
        if(samples){
            prepare(w,h);glBindFramebuffer(GL_DRAW_FRAMEBUFFER,fbo);glDrawBuffer(GL_COLOR_ATTACHMENT0);
            glBlitFramebuffer(0,0,w,h,0,0,w,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);
            glBindFramebuffer(GL_READ_FRAMEBUFFER,fbo);glReadBuffer(GL_COLOR_ATTACHMENT0);
        }
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,target);glDrawBuffer(GL_COLOR_ATTACHMENT0);
        glBlitFramebuffer(0,0,w,h,0,h,w,0,GL_COLOR_BUFFER_BIT,GL_NEAREST);
    }
    void toDefault(GLuint source,unsigned w,unsigned h){
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,0);GLint samples=0;glGetIntegerv(GL_SAMPLE_BUFFERS,&samples);
        if(samples)prepare(w,h);
        glBindFramebuffer(GL_READ_FRAMEBUFFER,source);glReadBuffer(GL_COLOR_ATTACHMENT0);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER,samples?fbo:0);glDrawBuffer(samples?GL_COLOR_ATTACHMENT0:GL_BACK);
        glBlitFramebuffer(0,h,w,0,0,0,w,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);
        if(samples){
            glBindFramebuffer(GL_READ_FRAMEBUFFER,fbo);glReadBuffer(GL_COLOR_ATTACHMENT0);
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER,0);glDrawBuffer(GL_BACK);
            glBlitFramebuffer(0,0,w,h,0,0,w,h,GL_COLOR_BUFFER_BIT,GL_NEAREST);
        }
    }
};
}
