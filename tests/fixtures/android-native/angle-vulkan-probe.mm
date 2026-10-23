#import <Cocoa/Cocoa.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl32.h>
#include "presentation.mm"

@interface AngleVulkanOutput:CAMetalLayer
@property(strong) id<CAMetalDrawable> captured;
@end
@implementation AngleVulkanOutput
-(id<CAMetalDrawable>)nextDrawable{auto result=[super nextDrawable];self.captured=result;return result;}
@end
namespace {
struct Probe {JavaVM *vm;Presenter *presenter;std::atomic<unsigned> complete{0};};
int nativeFrame(void *context,void *commands,void *texture){@autoreleasepool{
 auto probe=static_cast<Probe*>(context);JNIEnv *env=nullptr;
 bool attached=probe->vm->GetEnv((void**)&env,JNI_VERSION_1_8)==JNI_EDETACHED;
 if(attached)probe->vm->AttachCurrentThreadAsDaemon((void**)&env,nullptr);
 int result=klj_metal_native_frame(env,probe->presenter,commands,texture);
 if(env->ExceptionCheck()){env->ExceptionDescribe();env->ExceptionClear();result=4;}
 if(!result)[(__bridge id<MTLCommandBuffer>)commands addCompletedHandler:^(id<MTLCommandBuffer>){++probe->complete;}];
 if(attached)probe->vm->DetachCurrentThread();return result==0;
}}
template<class T>T entry(const char *name){auto result=klj_graphics_symbol(name);check(result,(std::string("Missing ANGLE entry ")+name).c_str());return reinterpret_cast<T>(result);}
#define EGL(name) entry<decltype(&name)>(#name)
#define GL(name) entry<decltype(&name)>(#name)
void eglOkay(EGLBoolean result,const char *name){if(!result)throw std::runtime_error(std::string(name)+" EGL error "+std::to_string(EGL(eglGetError)()));}
void metalDefault(PFNEGLGETPLATFORMDISPLAYEXTPROC getPlatform){
 const EGLint attributes[]={EGL_PLATFORM_ANGLE_TYPE_ANGLE,EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,EGL_NONE};auto display=getPlatform(EGL_PLATFORM_ANGLE_ANGLE,nullptr,attributes);eglOkay(EGL(eglInitialize)(display,nullptr,nullptr),"Metal eglInitialize");
 const EGLint requested[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_NONE};EGLConfig config;EGLint count=0;eglOkay(EGL(eglChooseConfig)(display,requested,&config,1,&count),"Metal eglChooseConfig");check(count==1,"Combined provider lost Metal ES3 configuration");
 const EGLint contextAttributes[]={EGL_CONTEXT_MAJOR_VERSION,3,EGL_CONTEXT_MINOR_VERSION,0,EGL_NONE},size[]={EGL_WIDTH,1,EGL_HEIGHT,1,EGL_NONE};auto context=EGL(eglCreateContext)(display,config,EGL_NO_CONTEXT,contextAttributes);auto surface=EGL(eglCreatePbufferSurface)(display,config,size);check(context!=EGL_NO_CONTEXT&&surface!=EGL_NO_SURFACE,"Combined provider lost Metal ES3 context");eglOkay(EGL(eglMakeCurrent)(display,surface,surface,context),"Metal eglMakeCurrent");
 fprintf(stderr,"Default Metal renderer=%s version=%s\n",GL(glGetString)(GL_RENDERER),GL(glGetString)(GL_VERSION));GL(glClearColor)(.2f,.4f,.6f,1);GL(glClear)(GL_COLOR_BUFFER_BIT);check(GL(glGetError)()==GL_NO_ERROR,"Combined provider Metal draw failed");
 eglOkay(EGL(eglMakeCurrent)(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT),"Metal release");eglOkay(EGL(eglDestroySurface)(display,surface),"Metal destroy surface");eglOkay(EGL(eglDestroyContext)(display,context),"Metal destroy context");eglOkay(EGL(eglTerminate)(display),"Metal terminate");
}
void compute(){
 const char *source="#version 310 es\nlayout(local_size_x=1) in; layout(std430,binding=0) buffer Output {uint value;}; void main(){value=0x12345678u;}";
 GLuint shader=GL(glCreateShader)(GL_COMPUTE_SHADER);GL(glShaderSource)(shader,1,&source,nullptr);GL(glCompileShader)(shader);
 GLint okay=0;GL(glGetShaderiv)(shader,GL_COMPILE_STATUS,&okay);if(!okay){char info[2048];GL(glGetShaderInfoLog)(shader,sizeof(info),nullptr,info);throw std::runtime_error(info);}
 GLuint program=GL(glCreateProgram)();GL(glAttachShader)(program,shader);GL(glLinkProgram)(program);GL(glGetProgramiv)(program,GL_LINK_STATUS,&okay);check(okay,"Compute program link failed");
 GLuint buffer=0;GL(glGenBuffers)(1,&buffer);GL(glBindBuffer)(GL_SHADER_STORAGE_BUFFER,buffer);uint32_t initial=0;GL(glBufferData)(GL_SHADER_STORAGE_BUFFER,sizeof(initial),&initial,GL_DYNAMIC_COPY);GL(glBindBufferBase)(GL_SHADER_STORAGE_BUFFER,0,buffer);
 GL(glUseProgram)(program);GL(glDispatchCompute)(1,1,1);GL(glMemoryBarrier)(GL_BUFFER_UPDATE_BARRIER_BIT|GL_SHADER_STORAGE_BARRIER_BIT);
 auto data=(const uint32_t*)GL(glMapBufferRange)(GL_SHADER_STORAGE_BUFFER,0,sizeof(initial),GL_MAP_READ_BIT);check(data&&*data==0x12345678u,"GPU compute output differs");GL(glUnmapBuffer)(GL_SHADER_STORAGE_BUFFER);
 GL(glBindBufferBase)(GL_SHADER_STORAGE_BUFFER,0,0);GL(glDeleteBuffers)(1,&buffer);GL(glUseProgram)(0);GL(glDeleteProgram)(program);GL(glDeleteShader)(shader);check(GL(glGetError)()==GL_NO_ERROR,"ES3.1 compute returned a GL error");
}
GLuint geometryTessellation(){
 const std::pair<GLenum,const char*> stages[]={
  {GL_VERTEX_SHADER,"#version 320 es\nprecision highp float; void main(){vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(p[gl_VertexID],0,1);}"},
  {GL_TESS_CONTROL_SHADER,"#version 320 es\nprecision highp float; layout(vertices=3)out;void main(){gl_out[gl_InvocationID].gl_Position=gl_in[gl_InvocationID].gl_Position;if(gl_InvocationID==0){gl_TessLevelInner[0]=1.;gl_TessLevelOuter[0]=1.;gl_TessLevelOuter[1]=1.;gl_TessLevelOuter[2]=1.;}}"},
  {GL_TESS_EVALUATION_SHADER,"#version 320 es\nprecision highp float; layout(triangles,equal_spacing,ccw)in;void main(){gl_Position=gl_TessCoord.x*gl_in[0].gl_Position+gl_TessCoord.y*gl_in[1].gl_Position+gl_TessCoord.z*gl_in[2].gl_Position;}"},
  {GL_GEOMETRY_SHADER,"#version 320 es\nprecision highp float; layout(triangles)in;layout(triangle_strip,max_vertices=3)out;void main(){for(int i=0;i<3;i++){gl_Position=gl_in[i].gl_Position;EmitVertex();}EndPrimitive();}"},
  {GL_FRAGMENT_SHADER,"#version 320 es\nprecision highp float;out vec4 color;void main(){color=vec4(.2,.4,.6,1);}"}
 };
 GLuint program=GL(glCreateProgram)();
 for(auto [type,source]:stages){GLuint shader=GL(glCreateShader)(type);GL(glShaderSource)(shader,1,&source,nullptr);GL(glCompileShader)(shader);GLint okay=0;GL(glGetShaderiv)(shader,GL_COMPILE_STATUS,&okay);if(!okay){char info[2048];GL(glGetShaderInfoLog)(shader,sizeof(info),nullptr,info);throw std::runtime_error(std::string("GLES3.2 shader ")+std::to_string(type)+": "+info);}GL(glAttachShader)(program,shader);GL(glDeleteShader)(shader);}
 GL(glLinkProgram)(program);GLint okay=0;GL(glGetProgramiv)(program,GL_LINK_STATUS,&okay);if(!okay){char info[2048];GL(glGetProgramInfoLog)(program,sizeof(info),nullptr,info);throw std::runtime_error(info);}return program;
}
void transformFeedback(){
 const std::pair<GLenum,const char*> stages[]={
  {GL_VERTEX_SHADER,"#version 320 es\nprecision highp float;out float value;void main(){gl_Position=vec4(0,0,0,1);value=float(gl_VertexID)+10.;}"},
  {GL_FRAGMENT_SHADER,"#version 320 es\nprecision highp float;out vec4 color;void main(){color=vec4(1);}"}
 };
 GLuint program=GL(glCreateProgram)();
 for(auto [type,source]:stages){auto shader=GL(glCreateShader)(type);GL(glShaderSource)(shader,1,&source,nullptr);GL(glCompileShader)(shader);GLint okay=0;GL(glGetShaderiv)(shader,GL_COMPILE_STATUS,&okay);check(okay,"Transform-feedback shader compilation failed");GL(glAttachShader)(program,shader);GL(glDeleteShader)(shader);}
 const char *varying="value";GL(glTransformFeedbackVaryings)(program,1,&varying,GL_INTERLEAVED_ATTRIBS);GL(glLinkProgram)(program);GLint okay=0;GL(glGetProgramiv)(program,GL_LINK_STATUS,&okay);check(okay,"Transform-feedback program link failed");
 GLuint buffer=0,query=0;GL(glGenBuffers)(1,&buffer);GL(glBindBuffer)(GL_TRANSFORM_FEEDBACK_BUFFER,buffer);GL(glBufferData)(GL_TRANSFORM_FEEDBACK_BUFFER,3*sizeof(float),nullptr,GL_DYNAMIC_COPY);GL(glBindBufferBase)(GL_TRANSFORM_FEEDBACK_BUFFER,0,buffer);GL(glGenQueries)(1,&query);
 GL(glUseProgram)(program);GL(glEnable)(GL_RASTERIZER_DISCARD);GL(glBeginQuery)(GL_TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN,query);GL(glBeginTransformFeedback)(GL_POINTS);GL(glDrawArrays)(GL_POINTS,0,3);GL(glEndTransformFeedback)();GL(glEndQuery)(GL_TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN);GL(glDisable)(GL_RASTERIZER_DISCARD);check(GL(glGetError)()==GL_NO_ERROR,"Transform feedback draw failed");
 GLuint written=0;GL(glGetQueryObjectuiv)(query,GL_QUERY_RESULT,&written);check(written==3,"Transform feedback query lost primitives");
 auto values=(const float*)GL(glMapBufferRange)(GL_TRANSFORM_FEEDBACK_BUFFER,0,3*sizeof(float),GL_MAP_READ_BIT);if(values)fprintf(stderr,"Transform feedback actual values=%g,%g,%g\n",values[0],values[1],values[2]);check(values&&values[0]==10&&values[1]==11&&values[2]==12,"Transform feedback GPU output differs");GL(glUnmapBuffer)(GL_TRANSFORM_FEEDBACK_BUFFER);GL(glBindBufferBase)(GL_TRANSFORM_FEEDBACK_BUFFER,0,0);GL(glDeleteQueries)(1,&query);GL(glDeleteBuffers)(1,&buffer);GL(glUseProgram)(0);GL(glDeleteProgram)(program);
 fprintf(stderr,"Real GLES3.2 transform feedback primitives=%u values=10,11,12\n",written);
}
void customBorder(){
 const std::pair<GLenum,const char*> stages[]={
  {GL_VERTEX_SHADER,"#version 320 es\nprecision highp float;void main(){vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(p[gl_VertexID],0,1);}"},
  {GL_FRAGMENT_SHADER,"#version 320 es\nprecision highp float;uniform sampler2D source;out vec4 color;void main(){color=texture(source,vec2(2,2));}"}
 };
 GLuint program=GL(glCreateProgram)();for(auto [type,source]:stages){auto shader=GL(glCreateShader)(type);GL(glShaderSource)(shader,1,&source,nullptr);GL(glCompileShader)(shader);GLint okay=0;GL(glGetShaderiv)(shader,GL_COMPILE_STATUS,&okay);check(okay,"Border shader compilation failed");GL(glAttachShader)(program,shader);GL(glDeleteShader)(shader);}GL(glLinkProgram)(program);GLint okay=0;GL(glGetProgramiv)(program,GL_LINK_STATUS,&okay);check(okay,"Border program link failed");
 GLuint images[2],framebuffer=0;GL(glGenTextures)(2,images);GL(glBindTexture)(GL_TEXTURE_2D,images[1]);GL(glTexImage2D)(GL_TEXTURE_2D,0,GL_RGBA8,2,2,0,GL_RGBA,GL_UNSIGNED_BYTE,nullptr);GL(glGenFramebuffers)(1,&framebuffer);GL(glBindFramebuffer)(GL_FRAMEBUFFER,framebuffer);GL(glFramebufferTexture2D)(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,images[1],0);check(GL(glCheckFramebufferStatus)(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE,"No border output framebuffer");
 GL(glBindTexture)(GL_TEXTURE_2D,images[0]);const uint8_t red[]={255,0,0,255};GL(glTexImage2D)(GL_TEXTURE_2D,0,GL_RGBA8,1,1,0,GL_RGBA,GL_UNSIGNED_BYTE,red);GL(glTexParameteri)(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_LINEAR);GL(glTexParameteri)(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);GL(glTexParameteri)(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_BORDER);GL(glTexParameteri)(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_BORDER);const float border[]={.3f,.5f,.7f,1};GL(glTexParameterfv)(GL_TEXTURE_2D,GL_TEXTURE_BORDER_COLOR,border);GL(glViewport)(0,0,2,2);GL(glUseProgram)(program);GL(glDrawArrays)(GL_TRIANGLES,0,3);
 uint8_t pixel[4]={};GL(glReadPixels)(1,1,1,1,GL_RGBA,GL_UNSIGNED_BYTE,pixel);check(GL(glGetError)()==GL_NO_ERROR,"Custom border draw failed");check(abs(int(pixel[0])-77)<=1&&abs(int(pixel[1])-128)<=1&&abs(int(pixel[2])-179)<=1&&pixel[3]==255,"Custom border GPU color differs");fprintf(stderr,"Real GLES3.2 custom border RGBA=%u,%u,%u,%u\n",pixel[0],pixel[1],pixel[2],pixel[3]);
 GL(glBindFramebuffer)(GL_FRAMEBUFFER,0);GL(glDeleteFramebuffers)(1,&framebuffer);GL(glDeleteTextures)(2,images);GL(glUseProgram)(0);GL(glDeleteProgram)(program);
}
}
extern "C" JNIEXPORT void JNICALL Java_AngleVulkanProbe_run(JNIEnv *env,jclass){@autoreleasepool{try{
 auto getPlatform=entry<PFNEGLGETPLATFORMDISPLAYEXTPROC>("eglGetPlatformDisplayEXT");
 metalDefault(getPlatform);
 const EGLint displayAttributes[]={EGL_PLATFORM_ANGLE_TYPE_ANGLE,EGL_PLATFORM_ANGLE_TYPE_VULKAN_ANGLE,EGL_NONE};
 EGLDisplay display=getPlatform(EGL_PLATFORM_ANGLE_ANGLE,nullptr,displayAttributes);check(display!=EGL_NO_DISPLAY,"No Vulkan EGL display");eglOkay(EGL(eglInitialize)(display,nullptr,nullptr),"eglInitialize");
 const EGLint configAttributes[]={EGL_SURFACE_TYPE,EGL_WINDOW_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};EGLConfig config;EGLint count=0;eglOkay(EGL(eglChooseConfig)(display,configAttributes,&config,1,&count),"eglChooseConfig");check(count==1,"No Vulkan EGL window configuration");
 const char *requested=std::getenv("ANDROID_ANGLE_REQUIRED_MINOR");int minor=requested?std::atoi(requested):1;check(minor==1||minor==2,"Invalid requested GLES minor version");
 if(std::getenv("ANDROID_ANGLE_DUMP_EXTENSIONS")){
  const EGLint inspectAttributes[]={EGL_CONTEXT_MAJOR_VERSION,3,EGL_CONTEXT_MINOR_VERSION,1,EGL_NONE},inspectSize[]={EGL_WIDTH,1,EGL_HEIGHT,1,EGL_NONE};auto inspect=EGL(eglCreateContext)(display,config,EGL_NO_CONTEXT,inspectAttributes);auto buffer=EGL(eglCreatePbufferSurface)(display,config,inspectSize);check(inspect!=EGL_NO_CONTEXT&&buffer!=EGL_NO_SURFACE,"No diagnostics context");eglOkay(EGL(eglMakeCurrent)(display,buffer,buffer,inspect),"Diagnostic context");GLint extensions=0;GL(glGetIntegerv)(GL_NUM_EXTENSIONS,&extensions);for(GLint i=0;i<extensions;++i)fprintf(stderr,"Capability %s\n",GL(glGetStringi)(GL_EXTENSIONS,i));eglOkay(EGL(eglMakeCurrent)(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT),"Diagnostic release");EGL(eglDestroySurface)(display,buffer);EGL(eglDestroyContext)(display,inspect);
 }
 const EGLint contextAttributes[]={EGL_CONTEXT_MAJOR_VERSION,3,EGL_CONTEXT_MINOR_VERSION,minor,EGL_NONE};EGLContext context=EGL(eglCreateContext)(display,config,EGL_NO_CONTEXT,contextAttributes);
 check(context!=EGL_NO_CONTEXT,("No real ES3."+std::to_string(minor)+" Vulkan context: EGL "+std::to_string(EGL(eglGetError)())).c_str());
 auto output=[AngleVulkanOutput layer];output.bounds=CGRectMake(0,0,64,48);output.drawableSize=CGSizeMake(64,48);output.framebufferOnly=NO;
 Probe probe;env->GetJavaVM(&probe.vm);probe.presenter=static_cast<Presenter*>(klj_metal_create(env,(__bridge void*)output,64,48));check(probe.presenter,"No common presenter");
 void *carrier=klj_metal_native_layer(env,64,48,nativeFrame,&probe);check(carrier,"No native carrier");
 EGLSurface surface=EGL(eglCreateWindowSurface)(display,config,(EGLNativeWindowType)carrier,nullptr);check(surface!=EGL_NO_SURFACE,"No original Vulkan EGL window surface");eglOkay(EGL(eglMakeCurrent)(display,surface,surface,context),"eglMakeCurrent");
 fprintf(stderr,"Real ANGLE renderer=%s version=%s\n",GL(glGetString)(GL_RENDERER),GL(glGetString)(GL_VERSION));GLint actualMajor=0,actualMinor=0;GL(glGetIntegerv)(GL_MAJOR_VERSION,&actualMajor);GL(glGetIntegerv)(GL_MINOR_VERSION,&actualMinor);check(actualMajor==3&&actualMinor>=minor,"Actual GLES context is below the requested version");compute();if(minor>=2){customBorder();transformFeedback();}GLuint geometry=minor>=2?geometryTessellation():0;
 for(unsigned phase=0;phase<2;phase++){
  auto layer=(__bridge CAMetalLayer*)carrier;layer.bounds=CGRectMake(0,0,phase?32:64,phase?24:48);layer.drawableSize=layer.bounds.size;
  GL(glViewport)(0,0,phase?32:64,phase?24:48);GL(glClearColor)(geometry?0:.2f,geometry?0:.4f,geometry?0:.6f,1);GL(glClear)(GL_COLOR_BUFFER_BIT);
  if(geometry){GL(glUseProgram)(geometry);GL(glPatchParameteri)(GL_PATCH_VERTICES,3);GL(glDrawArrays)(GL_PATCHES,0,3);check(GL(glGetError)()==GL_NO_ERROR,"GLES3.2 tessellation/geometry draw failed");}
  eglOkay(EGL(eglSwapBuffers)(display,surface),"eglSwapBuffers");
  for(unsigned wait=0;probe.complete<=phase&&wait<500;wait++)CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,false);check(probe.complete>phase,"ANGLE Vulkan frame never reached common presenter");
  auto image=output.captured.texture;check(image&&image.width==64&&image.height==48,"Wrong common output extent");
  auto buffer=[image.device newBufferWithLength:256 options:MTLResourceStorageModeShared];auto queue=[image.device newCommandQueue];auto commands=[queue commandBuffer];auto copy=[commands blitCommandEncoder];[copy copyFromTexture:image sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(32,24,0) sourceSize:MTLSizeMake(1,1,1) toBuffer:buffer destinationOffset:0 destinationBytesPerRow:256 destinationBytesPerImage:256];[copy endEncoding];[commands commit];[commands waitUntilCompleted];
  auto pixel=(uint8_t*)buffer.contents;fprintf(stderr,"ANGLE native pixels phase=%u BGRA=%u,%u,%u,%u\n",phase,pixel[0],pixel[1],pixel[2],pixel[3]);check(abs(int(pixel[0])-153)<=2&&abs(int(pixel[1])-102)<=2&&abs(int(pixel[2])-51)<=2,"ANGLE Vulkan output pixels differ");
  check(probe.presenter->source.width==(phase?32u:64u)&&probe.presenter->source.height==(phase?24u:48u),"ANGLE source resize differs from native extent");
 }
 if(geometry){GL(glUseProgram)(0);GL(glDeleteProgram)(geometry);}eglOkay(EGL(eglMakeCurrent)(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT),"eglMakeCurrent release");eglOkay(EGL(eglDestroySurface)(display,surface),"eglDestroySurface");eglOkay(EGL(eglDestroyContext)(display,context),"eglDestroyContext");eglOkay(EGL(eglTerminate)(display),"eglTerminate");klj_metal_release_native_layer(carrier);klj_metal_destroy(probe.presenter);
}catch(const std::exception &error){fail(env,error.what());}}}
