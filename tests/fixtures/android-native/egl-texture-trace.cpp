#include "native-egl-trace.hpp"
#include <cassert>
#include <string>
static int forwarded,queries;
static int compiles,links,shaderQueries;
static const unsigned char pixels[]={19,23,29,31};
static void query(unsigned name,int*value){assert(name==0x8069);*value=73;queries++;}
static void*context(){return (void*)0x1234;}
static void image(unsigned target,int level,int internal,int width,int height,int border,unsigned format,unsigned type,const void*data){assert(target==0x0DE1&&level==2&&internal==0x1908&&width==476&&height==88&&border==0&&format==0x1908&&type==0x1401&&data==pixels);forwarded++;}
static void parameter(unsigned target,unsigned name,int value){assert(target==0x0DE1&&name==0x813C&&value==2);forwarded++;}
static void compile(unsigned shader){assert(shader==0||shader==17);compiles++;}
static void link(unsigned program){assert(program==13||program==15);links++;}
static unsigned char valid(unsigned object){return object!=0;}
static void shaderQuery(unsigned object,unsigned name,int*value){shaderQueries++;assert(object==17||object==13||object==15);if(name==0x8B81||name==0x8B82)*value=object==13;else if(name==0x8B84||name==0x8B88)*value=20000;else assert(false);}
static void info(unsigned object,int count,int*length,char*value){assert(object==17||object==15);assert(count==8192);assert(!length);std::snprintf(value,count,"original compiler diagnostic");}
static void source(unsigned object,int count,int*length,char*value){assert(object==17&&count==4096&&!length);std::snprintf(value,count,"original native shader source");}
static void*provider(const char*name){if(!strcmp(name,"glGetError"))assert(false);if(!strcmp(name,"glGetIntegerv"))return(void*)query;if(!strcmp(name,"eglGetCurrentContext"))return(void*)context;if(!strcmp(name,"glTexImage2D"))return(void*)image;if(!strcmp(name,"glTexParameteri"))return(void*)parameter;if(!strcmp(name,"glCompileShader"))return(void*)compile;if(!strcmp(name,"glLinkProgram"))return(void*)link;if(!strcmp(name,"glIsShader")||!strcmp(name,"glIsProgram"))return(void*)valid;if(!strcmp(name,"glGetShaderiv")||!strcmp(name,"glGetProgramiv"))return(void*)shaderQuery;if(!strcmp(name,"glGetShaderInfoLog")||!strcmp(name,"glGetProgramInfoLog"))return(void*)info;if(!strcmp(name,"glGetShaderSource"))return(void*)source;return nullptr;}
int main(int argc,char**argv){
 bool active=argc>1&&!strcmp(argv[1],"on");setenv("KL_GL_TEXTURE_TRACE",active?"1":"0",1);
 bool shaders=argc>1&&!strcmp(argv[1],"shaders");setenv("KL_GL_SHADER_TRACE",shaders?"1":"0",1);
 if(shaders){
  assert(!klj_egl_trace::lookup("glTexImage2D",provider));
  auto compiler=reinterpret_cast<decltype(&compile)>(klj_egl_trace::lookup("glCompileShader",provider));assert(compiler&&compiler!=compile);
  auto linker=reinterpret_cast<decltype(&link)>(klj_egl_trace::lookup("glLinkProgram",provider));assert(linker&&linker!=link);
  compiler(0);assert(compiles==1&&shaderQueries==0);linker(13);assert(links==1&&shaderQueries==1);
  compiler(17);linker(15);for(int i=0;i<30;i++)compiler(17);
  assert(compiles==32&&links==2&&queries==0);puts("PASS native shader diagnostics preserve compiler dispatch and error ownership");return 0;
 }
 auto upload=klj_egl_trace::lookup("glTexImage2D",provider);
 if(!active){assert(!upload&&forwarded==0&&queries==0);puts("PASS disabled diagnostics preserve direct dispatch");return 0;}
 assert(upload&&upload!=(void*)image);assert(!klj_egl_trace::lookup("glUnavailable",provider));
 reinterpret_cast<decltype(&image)>(upload)(0x0DE1,2,0x1908,476,88,0,0x1908,0x1401,pixels);
 auto set= reinterpret_cast<decltype(&parameter)>(klj_egl_trace::lookup("glTexParameteri",provider));
 for(int i=0;i<10000;i++)set(0x0DE1,0x813C,2);
 assert(forwarded==10001&&queries==8192);puts("PASS texture metadata forwarding and bounded logging");
}
