#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>

int main(int argc,char **argv) {
    assert(argc==3);
    void *runtime=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);
    if(!runtime){fprintf(stderr,"%s\n",dlerror());return 2;}
    void *(*load)(const char *)=dlsym(runtime,"kl_load");
    const char *const *(*missing)(void *,unsigned *)=dlsym(runtime,"kl_missing_imports");
    const char *(*error)(void)=dlsym(runtime,"kl_error");
    assert(load&&missing&&error);
    void *image=load(argv[2]);
    if(!image){fprintf(stderr,"%s\n",error());return 3;}
    unsigned count=0;
    const char *const *names=missing(image,&count);
    for(unsigned i=0;i<count;i++)printf("unresolved: %s\n",names[i]);
    printf("Unresolved imports: %u; constructors were not executed\n",count);
    return 0;
}
