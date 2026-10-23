#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
int scope_main(void){return 303;}
static int value(void *p){return p?((int(*)(void))p)():-1;}
int main(int argc,char **argv){
 if(argc!=3)return 2;
 void *caller=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL),*provider=dlopen(argv[2],RTLD_NOW|RTLD_LOCAL);
 if(!caller||!provider){fprintf(stderr,"%s\n",dlerror());return 3;}
 void *(*lookup)(void*,const char*)=dlsym(caller,"scope_lookup");if(!lookup)return 4;
 int self=value(lookup(RTLD_SELF,"scope_same")),next=value(lookup(RTLD_NEXT,"scope_same")),dependency=value(lookup(RTLD_SELF,"scope_dependency"));
 int global=value(lookup(RTLD_DEFAULT,"scope_main")),mainOnly=value(lookup(RTLD_MAIN_ONLY,"scope_main")),explicit=value(lookup(provider,"scope_same"));
 int *data=lookup(provider,"scope_data");int dataValue=data?*data:-1;
 dlerror();void *missing=lookup(RTLD_SELF,"scope_deliberately_missing");const char *error=dlerror();int missingError=!missing&&error&&strstr(error,"scope_deliberately_missing"),cleared=dlerror()==NULL;
 lookup(RTLD_SELF,"scope_deliberately_missing");int success=value(lookup(provider,"scope_same")),successClears=dlerror()==NULL;
 void *first=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL|RTLD_FIRST);void *firstMissing=lookup(first,"scope_dependency");int firstOnly=!firstMissing&&dlerror()!=NULL;
 void *jniSelf=lookup(RTLD_SELF,"JNI_CreateJavaVM"),*jniNext=lookup(RTLD_NEXT,"JNI_CreateJavaVM"),*jniExplicit=lookup(provider,"JNI_CreateJavaVM");
 typedef int(*Create)(void**,void**,void*);
 int jniSelfValue=jniSelf?((Create)jniSelf)(NULL,NULL,NULL):-100,jniNextValue=jniNext?((Create)jniNext)(NULL,NULL,NULL):-100,jniExplicitValue=jniExplicit?((Create)jniExplicit)(NULL,NULL,NULL):-100;
 printf("{\"self\":%d,\"next\":%d,\"dependency\":%d,\"default\":%d,\"mainOnly\":%d,\"explicit\":%d,\"data\":%d,\"missingError\":%d,\"errorConsumed\":%d,\"success\":%d,\"successClearsError\":%d,\"firstOnly\":%d,\"jniSelf\":%d,\"jniNext\":%d,\"jniExplicit\":%d}\n",self,next,dependency,global,mainOnly,explicit,dataValue,missingError,cleared,success,successClears,firstOnly,jniSelfValue,jniNextValue,jniExplicitValue);return 0;
}
