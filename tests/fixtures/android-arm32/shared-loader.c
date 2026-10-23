#include <jni.h>
static int initialized;
static int dso;
typedef struct {const char *name;void *base;const char *symbol;void *address;} ImageInfo;
extern int dladdr(const void *,ImageInfo *);
extern void __aeabi_memcpy(void *,const void *,unsigned);
extern int __aeabi_idiv(int,int);
extern int __aeabi_atexit(void *,void (*)(void *),void *);
extern void __cxa_finalize(void *);
extern void pthread_exit(void *);
extern void *new_object(unsigned) __asm__("_Znwj");
extern void *new_array(unsigned) __asm__("_Znaj");
extern void *new_object_nothrow(unsigned,const void *) __asm__("_ZnwjRKSt9nothrow_t");
extern void *new_array_nothrow(unsigned,const void *) __asm__("_ZnajRKSt9nothrow_t");
extern void delete_object(void *) __asm__("_ZdlPv");
extern void delete_array(void *) __asm__("_ZdaPv");
extern void delete_object_nothrow(void *,const void *) __asm__("_ZdlPvRKSt9nothrow_t");
extern void delete_array_nothrow(void *,const void *) __asm__("_ZdaPvRKSt9nothrow_t");
extern void delete_object_sized(void *,unsigned) __asm__("_ZdlPvj");
extern void delete_array_sized(void *,unsigned) __asm__("_ZdaPvj");
extern const char original_nothrow __asm__("_ZSt7nothrow");
static void end(void *object){*(int *)object+=7;}
__attribute__((constructor)) static void begin(void){int value=__aeabi_idiv(84,42),copy=0;__aeabi_memcpy(&copy,&value,sizeof copy);initialized+=copy-1;if(__aeabi_atexit(&initialized,end,&dso))initialized=-1;}
JNIEXPORT jint JNI_OnLoad(JavaVM *vm,void *unused){(void)vm;(void)unused;return JNI_VERSION_1_6;}
JNIEXPORT jint Java_SharedLoaderProbe_value(JNIEnv *env,jclass type){(void)env;(void)type;return initialized;}
JNIEXPORT jint Java_SharedLoaderProbe_narrowByte(JNIEnv *env,jclass type,jbyte value){(void)env;(void)type;return value;}
JNIEXPORT jint Java_SharedLoaderProbe_narrowShort(JNIEnv *env,jclass type,jshort value){(void)env;(void)type;return value;}
JNIEXPORT jint Java_SharedLoaderProbe_narrowChar(JNIEnv *env,jclass type,jchar value){(void)env;(void)type;return value;}
JNIEXPORT jint Java_SharedLoaderProbe_narrowBoolean(JNIEnv *env,jclass type,jboolean value){(void)env;(void)type;return value;}
JNIEXPORT void Java_SharedLoaderProbe_finish(JNIEnv *env,jclass type){(void)env;(void)type;__cxa_finalize(&dso);}
JNIEXPORT void Java_SharedLoaderProbe_exitThread(JNIEnv *env,jclass type){
 (void)env;(void)type;pthread_exit(0);__builtin_trap();
}

extern const short *_tolower_tab_, *_toupper_tab_;
extern const char *_ctype_;
JNIEXPORT jboolean Java_SharedLoaderProbe_legacyTables(JNIEnv *env,jclass type){
 (void)env;(void)type;
 ImageInfo variable={0},classification={0},lowerTable={0},upperTable={0};
 if(!dladdr(&_ctype_,&variable)||!dladdr(_ctype_,&classification)||
    !dladdr(_tolower_tab_,&lowerTable)||!dladdr(_toupper_tab_,&upperTable)||
    variable.base!=classification.base||classification.base!=lowerTable.base||lowerTable.base!=upperTable.base)return JNI_FALSE;
 if(_ctype_[0]||_tolower_tab_[0]!=-1||_toupper_tab_[0]!=-1)return JNI_FALSE;
 for(int c=0;c<256;c++){
  int lower=c>='A'&&c<='Z'?c+('a'-'A'):c;
  int upper=c>='a'&&c<='z'?c-('a'-'A'):c;
  if(_tolower_tab_[c+1]!=lower||_toupper_tab_[c+1]!=upper)return JNI_FALSE;
  unsigned expected=0;
  if(c<32||c==127)expected|=0x20;
  if(c==32||(c>=9&&c<=13))expected|=0x08;
  if(c==32)expected|=0x80;
  if(c>='A'&&c<='Z')expected|=0x01;
  if(c>='a'&&c<='z')expected|=0x02;
  if(c>='0'&&c<='9')expected|=0x04;
  if((c>='A'&&c<='F')||(c>='a'&&c<='f'))expected|=0x40;
  if(c>32&&c<127&&!(expected&(0x01|0x02|0x04)))expected|=0x10;
  if((unsigned char)_ctype_[c+1]!=expected)return JNI_FALSE;
 }
 return JNI_TRUE;
}
JNIEXPORT jboolean Java_SharedLoaderProbe_imageAddress(JNIEnv *env,jclass type){
 (void)env;(void)type;ImageInfo image={(const char *)16,(void *)16,(const char *)16,(void *)16};
 if(!dladdr((const void *)Java_SharedLoaderProbe_imageAddress,&image)||!image.name||!image.name[0]||!image.base)return JNI_FALSE;
 if((unsigned)image.base>(unsigned)Java_SharedLoaderProbe_imageAddress)return JNI_FALSE;
 return !dladdr((const void *)16,&image);
}
JNIEXPORT jboolean Java_SharedLoaderProbe_allocations(JNIEnv *env,jclass type){
 (void)env;(void)type;
 unsigned *values[6]={new_object(16),new_array(16),new_object_nothrow(16,&original_nothrow),new_array_nothrow(16,&original_nothrow),new_object(16),new_array(16)};
 for(unsigned i=0;i<6;i++){if(!values[i])return JNI_FALSE;for(unsigned j=0;j<4;j++)values[i][j]=i*4+j;}
 for(unsigned i=0;i<6;i++)for(unsigned j=0;j<4;j++)if(values[i][j]!=i*4+j)return JNI_FALSE;
 delete_object(values[0]);delete_array(values[1]);delete_object_nothrow(values[2],&original_nothrow);delete_array_nothrow(values[3],&original_nothrow);delete_object_sized(values[4],16);delete_array_sized(values[5],16);
 delete_object(0);delete_array(0);return JNI_TRUE;
}

typedef long Jump[64];
typedef long SignalJump[65];
extern int setjmp(Jump) __attribute__((returns_twice));
extern int _setjmp(Jump) __attribute__((returns_twice));
extern int sigsetjmp(SignalJump,int) __attribute__((returns_twice));
extern void longjmp(Jump,int) __attribute__((noreturn));
extern void _longjmp(Jump,int) __attribute__((noreturn));
extern void siglongjmp(SignalJump,int) __attribute__((noreturn));
JNIEXPORT jboolean Java_SharedLoaderProbe_jumps(JNIEnv *env,jclass type){
 (void)env;(void)type;Jump plain;SignalJump outer,inner;volatile int steps=0;
 int value=setjmp(plain);if(!value){steps++;longjmp(plain,7);}if(value!=7||steps!=1)return JNI_FALSE;
 value=_setjmp(plain);if(!value){steps++;_longjmp(plain,0);}if(value!=1||steps!=2)return JNI_FALSE;
 value=sigsetjmp(outer,1);if(!value){if(!sigsetjmp(inner,0)){steps++;siglongjmp(inner,3);}steps++;siglongjmp(outer,11);}
 return value==11&&steps==4;
}

typedef struct {char* key;void* data;} SearchEntry;
typedef struct {void* table;} SearchTable;
extern int hcreate_r(unsigned,SearchTable*);
extern int hsearch_r(SearchEntry,int,SearchEntry**,SearchTable*);
extern void hdestroy_r(SearchTable*);
extern void* tsearch(const void*,void**,int(*)(const void*,const void*));
extern void* tfind(const void*,void* const*,int(*)(const void*,const void*));
extern void tdestroy(void*,void(*)(void*));
static int keys_freed;
static void count_key(void* key){if(key)keys_freed++;}
static int compare_key(const void* a,const void* b){return *(const int*)a-*(const int*)b;}
JNIEXPORT jboolean Java_SharedLoaderProbe_searches(JNIEnv *env,jclass type){
 (void)env;(void)type;void* root=0;int values[]={4,2,6,1,3,5,7};
 for(int i=0;i<7;i++)if(!tsearch(values+i,&root,compare_key))return JNI_FALSE;
 int key=3;int** found=tfind(&key,&root,compare_key);if(!found||**found!=3)return JNI_FALSE;
 keys_freed=0;tdestroy(root,count_key);if(keys_freed!=7)return JNI_FALSE;
 SearchTable table={0};if(!hcreate_r(1,&table))return JNI_FALSE;
 SearchEntry insert={"original",(void*)37},*entry=0;
 if(!hsearch_r(insert,1,&entry,&table)||!entry||entry->data!=(void*)37)return JNI_FALSE;
 insert.data=0;if(!hsearch_r(insert,0,&entry,&table)||entry->data!=(void*)37)return JNI_FALSE;
 hdestroy_r(&table);return JNI_TRUE;
}
