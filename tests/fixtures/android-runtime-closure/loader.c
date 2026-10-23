#include <dlfcn.h>
#include <stdio.h>
int main(int argc,char **argv){
 if(argc!=2)return 2;
 void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
 if(!library){fprintf(stderr,"%s\n",dlerror());return 3;}
 int (*value)(void)=dlsym(library,"original_library");
 int result=value?value():0;
 dlclose(library);
 return result==42?0:4;
}
