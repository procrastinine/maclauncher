#include <assert.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern void *klj_graphics_symbol(const char *);
unsigned klj_vulkan_api_version(void){return 0;}
int klj_vulkan_api_level(void){return -1;}
static void *gles,*egl,*bind_texture,*polygon_mode;
static void check_owner(void *entry,void *expected){
    Dl_info actual={0},owner={0};
    assert(entry&&expected&&dladdr(entry,&actual)&&dladdr(expected,&owner));
    assert(actual.dli_fbase==owner.dli_fbase);
}
static void *repeat(void *ignored){
    (void)ignored;
    for(int i=0;i<500;i++){
        assert(klj_graphics_symbol("glBindTexture")==bind_texture);
        assert(klj_graphics_symbol("glPolygonModeNV")==polygon_mode);
        assert(!klj_graphics_symbol("glPolygonMode"));
        assert(!klj_graphics_symbol("glMissingMacLauncherTestEntry"));
    }
    return NULL;
}
int main(int argc,char **argv){
    assert(argc==3);assert(!setenv("KL_ANGLE_DIR",argv[1],1));
    char filename[4096];
    snprintf(filename,sizeof filename,"%s/libEGL.dylib",argv[1]);egl=dlopen(filename,RTLD_NOW|RTLD_LOCAL);assert(egl);
    snprintf(filename,sizeof filename,"%s/libGLESv2.dylib",argv[1]);gles=dlopen(filename,RTLD_NOW|RTLD_LOCAL);assert(gles);
    void *(*get)(const char *)=dlsym(egl,"eglGetProcAddress");assert(get);
    // The real macOS dependency closure reproduces the original false export;
    // ANGLE itself has no desktop core glPolygonMode entry.
    void *desktop=dlsym(gles,"glPolygonMode");Dl_info leaked={0};assert(desktop&&dladdr(desktop,&leaked));
    assert(strstr(leaked.dli_fname,"OpenGL.framework"));assert(!get("glPolygonMode"));
    assert(!klj_graphics_symbol("glPolygonMode"));
    bind_texture=dlsym(gles,"glBindTexture");polygon_mode=dlsym(gles,"glPolygonModeNV");
    assert(bind_texture&&polygon_mode);
    assert(klj_graphics_symbol("glBindTexture")==bind_texture);
    assert(klj_graphics_symbol("glPolygonModeNV")==polygon_mode);
    check_owner(klj_graphics_symbol("glPolygonModeANGLE"),bind_texture);
    void *display=dlsym(egl,"eglGetDisplay");assert(klj_graphics_symbol("eglGetDisplay")==display);
    check_owner(klj_graphics_symbol("eglGetDisplay"),display);
    // Preserve every available entry from the original ANGLE procedure table,
    // including extensions that a provider exposes only through that table.
    snprintf(filename,sizeof filename,"%s/libEGL.dylib",argv[1]);void *own_egl=dlopen(filename,RTLD_NOW|RTLD_LOCAL|RTLD_FIRST);assert(own_egl);
    snprintf(filename,sizeof filename,"%s/libGLESv2.dylib",argv[1]);void *own_gles=dlopen(filename,RTLD_NOW|RTLD_LOCAL|RTLD_FIRST);assert(own_gles);
    FILE *entries=fopen(argv[2],"r");assert(entries);char name[256];int available=0;
    while(fgets(name,sizeof name,entries)){
        name[strcspn(name,"\n")]=0;int is_egl=!strncmp(name,"egl",3);
        void *entry=dlsym(is_egl?own_egl:own_gles,name);
        if(!entry)entry=dlsym(is_egl?own_gles:own_egl,name);
        if(!entry)entry=get(name);
        assert(klj_graphics_symbol(name)==entry);if(entry)available++;
    }
    fclose(entries);assert(available>500);printf("Preserved %d actual ANGLE procedure entries\n",available);
    pthread_t threads[8];for(int i=0;i<8;i++)assert(!pthread_create(&threads[i],NULL,repeat,NULL));
    for(int i=0;i<8;i++)assert(!pthread_join(threads[i],NULL));
    assert(!klj_graphics_symbol(NULL));
    puts("PASS selected ANGLE exports, extension lookup and cached absence");
    return 0;
}
