#include <jni.h>
#include <stdlib.h>
#include <EGL/egl.h>
#include <GLES3/gl3.h>

JNIEXPORT jlong JNICALL Java_ArtGlesReadbackProbe_context(JNIEnv *env,jclass owner){(void)env;(void)owner;return (jlong)(uintptr_t)eglGetCurrentContext();}
JNIEXPORT jint JNICALL Java_ArtGlesReadbackProbe_upload(JNIEnv *env,jclass owner,jint width,jint height,jint alignment){
    (void)env;(void)owner;size_t stride=((size_t)width*3+alignment-1)&~((size_t)alignment-1),length=stride*height;unsigned char *bytes=malloc(length);if(!bytes)return -1;
    for(int y=0;y<height;y++)for(int x=0;x<width;x++){unsigned char *pixel=bytes+y*stride+x*3;pixel[0]=255;pixel[1]=64;pixel[2]=32;}
    GLuint texture=0;glGenTextures(1,&texture);glBindTexture(GL_TEXTURE_2D,texture);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_LINEAR);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);glPixelStorei(GL_UNPACK_ALIGNMENT,alignment);glTexImage2D(GL_TEXTURE_2D,0,GL_RGB,width,height,0,GL_RGB,GL_UNSIGNED_BYTE,bytes);free(bytes);return glGetError()==GL_NO_ERROR?(jint)texture:-2;
}
