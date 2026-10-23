#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

int main(int argc,char **argv) {
    assert(argc==4);
    void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!core){fprintf(stderr,"%s\n",dlerror());return 1;}
    void (*set_path)(const char *)=dlsym(core,"kl_set_library_path");
    void *(*open_image)(const char *,int)=dlsym(core,"klb_dlopen");
    void *(*symbol)(void *,const char *)=dlsym(core,"klb_dlsym");
    int (*close_image)(void *)=dlsym(core,"klb_dlclose");
    void *(*map)(const char *)=dlsym(core,"kl_load_auto");
    void (*unmap)(void *)=dlsym(core,"kl_unload");
    void (*capture)(void *)=dlsym(core,"klj_image_capture_identity");
    const char *(*soname)(void *)=dlsym(core,"klj_image_soname");
    assert(set_path&&open_image&&symbol&&close_image&&map&&unmap);
    set_path(argv[2]);
    /* An earlier miss must not hide a subsequently published SONAME. */
    assert(!open_image("libdeclared.so",2));
    assert(!open_image("libnotloaded.so",2|4));
    assert(!open_image("libnotloaded.so",2|4));
    void *image=open_image("libdifferent.so",2);
    assert(image);
    assert(open_image("libdeclared.so",2|4)==image);
    assert(open_image("libdifferent.so",2|4)==image);
    assert(open_image("libdeclared.so",2)==image);
    int (*count)(void)=symbol(image,"construction_count");
    assert(count && count()==1);
    assert(close_image(image)==0);
    /* The shared loader retains registered executable owners until process
     * retirement. A close and either spelling cannot rerun constructors. */
    assert(open_image("libdeclared.so",2|4)==image && count()==1);
    void *late=open_image("libnotloaded.so",2);
    assert(late && late!=image);
    count=symbol(late,"construction_count");assert(count && count()==1);
    /* Unpublished owners use the same metadata and ordinary image cleanup. */
    assert(capture&&soname);
    for(int i=0;i<32;i++) {
        void *temporary=map(argv[3]);assert(temporary);
        capture(temporary);capture(temporary);
        assert(soname(temporary) && !strcmp(soname(temporary),"libdeclared.so"));
        unmap(temporary);
    }
    puts("PASS SONAME and filename share one image, NOLOAD does not map, constructors and retirement retain ownership");
}
