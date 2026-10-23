#include <jni.h>
#include <stdio.h>
#include <string.h>
static int calls,loc,count,first,last,mask,pixelMode,uniformReads;
static float firstFloat,lastFloat;
static void uniform1iv(int l,int n,const int*p){calls++;loc=l;count=n;first=n?p[0]:0;last=n?p[n-1]:0;}
static void uniform1fv(int l,int n,const float*p){calls++;loc=l;count=n;firstFloat=n?p[0]:0;lastFloat=n?p[n-1]:0;}
static void uniform2fv(int l,int n,const float*p){calls++;loc=l;count=n;firstFloat=n?p[0]:0;lastFloat=n?p[n*2-1]:0;}
static void uniform3iv(int l,int n,const int*p){calls++;loc=l;count=n;first=n?p[0]:0;last=n?p[n*3-1]:0;}
static void matrix2(int l,int n,unsigned char transpose,const float*p){calls++;loc=l;count=n;mask=transpose;firstFloat=n?p[0]:0;lastFloat=n?p[n*4-1]:0;}
static void matrix3(int l,int n,unsigned char transpose,const float*p){calls++;loc=l;count=n;mask=transpose;firstFloat=n?p[0]:0;lastFloat=n?p[n*9-1]:0;}
static void active(unsigned value){calls++;mask=(int)value;}
static void blend(float r,float g,float b,float a){calls++;firstFloat=r;lastFloat=a;first=(int)(g*100);last=(int)(b*100);}
static unsigned char isTexture(unsigned value){calls++;return value==123;}
static void gen(int n,unsigned*p){calls++;count=n;for(int i=0;i<n;i++)p[i]=100u+(unsigned)i;}
static void deleteNames(int n,const unsigned*p){calls++;count=n;first=n?(int)p[0]:0;last=n?(int)p[n-1]:0;}
static void texParameter(unsigned target,unsigned pname,const float*p){calls++;loc=(int)target;count=pname==0x1004?4:1;firstFloat=p[0];lastFloat=p[count-1];}
static void vertex(unsigned index,unsigned pname,float*p){calls++;loc=(int)index;count=pname==0x8626?4:1;for(int i=0;i<count;i++)p[i]=10.0f+i;}
static void program(unsigned object,unsigned parameter,int*p){(void)object;if(parameter==0x8B86)*p=2;else if(parameter==0x8B87)*p=32;else *p=0;}
static void activeUniform(unsigned programId,unsigned index,int capacity,int*length,int*size,unsigned*type,char*name){(void)programId;const char*text=index==0?"uMatrix":"uArray[0]";snprintf(name,(size_t)capacity,"%s",text);*length=(int)strlen(text);*size=index==0?1:3;*type=index==0?0x8B5C:0x8B51;}
static int uniformLocation(unsigned object,const char*name){(void)object;if(!strcmp(name,"uMatrix"))return 5;for(int i=0;i<3;i++){char n[32];snprintf(n,sizeof n,"uArray[%d]",i);if(!strcmp(name,n))return 10+i;}return -1;}
static void uniformRead(unsigned object,int location,float*p){(void)object;calls++;uniformReads++;count=location==5?16:3;for(int i=0;i<count;i++)p[i]=20.0f+i;}
static void query(unsigned parameter,int*p){switch(parameter){case 0x0D05:case 0x0CF5:*p=4;break;case 0x0D02:case 0x0CF2:*p=pixelMode?5:0;break;case 0x0D04:case 0x0CF4:case 0x0D03:case 0x0CF3:*p=pixelMode?1:0;break;default:*p=0;break;}}
static const unsigned char*string(unsigned p){(void)p;return(const unsigned char*)"OpenGL ES 3.0";}
static void readPixels(int x,int y,int w,int h,unsigned format,unsigned type,void*p){(void)x;(void)y;(void)type;calls++;int bytes=format==0x1908?4:3;int row=((pixelMode?5:w)*bytes+3)/4*4;count=w&&h?(pixelMode?row+bytes:0)+(h-1)*row+w*bytes:0;memset(p,0x4D,(size_t)count);}
static void booleanQuery(unsigned parameter,unsigned char*p){calls++;count=parameter==0x0C23?4:1;for(int i=0;i<count;i++)p[i]=(unsigned char)(i%2);}
static void attached(unsigned object,int maximum,int*used,unsigned*shaders){(void)object;calls++;count=maximum<2?maximum:2;if(used)*used=count;for(int i=0;i<count;i++)shaders[i]=501u+(unsigned)i;}
static void precision(unsigned shader,unsigned type,int*range,int*p){(void)shader;(void)type;calls++;range[0]=-127;range[1]=127;*p=23;}
static void binary(int n,const unsigned*shaders,unsigned format,const void*data,int length){calls++;count=n;first=n?(int)shaders[0]:0;last=length?*(const unsigned char*)data:0;mask=(int)format;}
void*klj_graphics_symbol(const char*name){
#define FN(n,f) if(!strcmp(name,n))return(void*)f;
 FN("glUniform1iv",uniform1iv) FN("glUniform1fv",uniform1fv) FN("glUniform2fv",uniform2fv) FN("glUniform3iv",uniform3iv) FN("glUniformMatrix2fv",matrix2) FN("glUniformMatrix3fv",matrix3)
 FN("glActiveTexture",active) FN("glBlendColor",blend) FN("glIsTexture",isTexture) FN("glGenFramebuffers",gen) FN("glDeleteRenderbuffers",deleteNames)
 FN("glTexParameterfv",texParameter) FN("glGetVertexAttribfv",vertex) FN("glGetProgramiv",program) FN("glGetActiveUniform",activeUniform) FN("glGetUniformLocation",uniformLocation) FN("glGetUniformfv",uniformRead)
 FN("glGetIntegerv",query) FN("glGetString",string) FN("glReadPixels",readPixels) FN("glGetBooleanv",booleanQuery) FN("glGetAttachedShaders",attached) FN("glGetShaderPrecisionFormat",precision) FN("glShaderBinary",binary)
 return NULL;
}
JNIEXPORT jintArray JNICALL Java_GlesBatchProbe_state(JNIEnv*e,jclass c){(void)c;jint v[]={calls,loc,count,first,last,mask,uniformReads};jintArray a=(*e)->NewIntArray(e,7);if(a)(*e)->SetIntArrayRegion(e,a,0,7,v);return a;}
JNIEXPORT jfloatArray JNICALL Java_GlesBatchProbe_floats(JNIEnv*e,jclass c){(void)c;jfloat v[]={firstFloat,lastFloat};jfloatArray a=(*e)->NewFloatArray(e,2);if(a)(*e)->SetFloatArrayRegion(e,a,0,2,v);return a;}
JNIEXPORT void JNICALL Java_GlesBatchProbe_pixelMode(JNIEnv*e,jclass c,jint mode){(void)e;(void)c;pixelMode=mode;}
