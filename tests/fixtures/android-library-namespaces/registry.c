#include "library-registry.h"
#include <assert.h>
#include <stdio.h>
#include <unistd.h>
struct Image{char *path;int scope;};
struct State{KlImageRegistry *registry;int scope,mapped,unmapped,published;};
static const char *image_path(void *opaque,void *image){(void)opaque;return ((struct Image*)image)->path;}
static int accessible(void *opaque,void *image){return ((struct State*)opaque)->scope==((struct Image*)image)->scope;}
static void *map(void *opaque,const char *path){struct State *s=opaque;struct Image *image=calloc(1,sizeof *image);assert(image);image->path=strdup(path);image->scope=s->scope;s->mapped++;return image;}
static void unmap(void *opaque,void *image){((struct State*)opaque)->unmapped++;free(((struct Image*)image)->path);free(image);}
static int publish(void *opaque,const char *name,void *image){struct State *s=opaque;s->published++;return klj_library_registry_publish(s->registry,name,image);}
static int prepare(void *image,void *opaque){assert(image);return *(int*)opaque;}
int main(int argc,char **argv){
 assert(argc==3);struct State state={.registry=klj_library_registry_create()};assert(state.registry);
 pthread_mutex_t mutex=PTHREAD_MUTEX_INITIALIZER;char error[256];
 KljLibraryImageOperations ops={&state,image_path,accessible,map,unmap,NULL,publish};
 int ready=0;
 assert(!klj_library_image_load(&mutex,state.registry,&ops,argv[1],"image",prepare,&ready,error,sizeof error));
 assert(state.mapped==1&&state.unmapped==1&&state.published==0&&klj_library_registry_snapshot(state.registry).count==0);
 ready=1;void *first=klj_library_image_load(&mutex,state.registry,&ops,argv[1],"image",prepare,&ready,error,sizeof error);assert(first);
 assert(klj_library_image_load(&mutex,state.registry,&ops,argv[2],"alias",prepare,&ready,error,sizeof error)==first);
 assert(state.mapped==2&&state.published==1);
 state.scope=1;void *second=klj_library_image_load(&mutex,state.registry,&ops,argv[1],"image",prepare,&ready,error,sizeof error);assert(second&&second!=first);
 assert(state.mapped==3&&state.published==2&&klj_library_registry_snapshot(state.registry).count==2);
 // A rejected binding cannot retire an image already used by another caller.
 ready=0;assert(!klj_library_image_load(&mutex,state.registry,&ops,argv[1],"image",prepare,&ready,error,sizeof error));assert(state.unmapped==1);
 unmap(&state,first);unmap(&state,second);klj_library_registry_destroy(state.registry);pthread_mutex_destroy(&mutex);
 puts("PASS shared image publication, canonical aliases, namespace identity and failed-binding retry");
}
