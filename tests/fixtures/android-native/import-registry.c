#include "native-import-registry.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
static int first,second;static atomic_int firstCalls,secondCalls;
static void *base(const char *name){atomic_fetch_add(&firstCalls,1);return !strcmp(name,"base")||!strcmp(name,"both")?&first:NULL;}
static void *extension(const char *name){atomic_fetch_add(&secondCalls,1);return !strcmp(name,"both")||!strcmp(name,"extension")?&second:NULL;}
static void *run(void *unused){(void)unused;for(int i=0;i<10000;i++){assert(klj_register_import_resolver(base));assert(klj_register_import_resolver(extension));assert(klj_resolve_import("both")==&second);assert(klj_resolve_import("base")==&first);assert(!klj_resolve_import("absent"));}return NULL;}
int main(void){assert(klj_register_import_resolver(base));assert(klj_register_import_resolver(extension));assert(!klj_register_import_resolver(NULL));assert(!klj_register_import_resolver(klj_resolve_import));pthread_t workers[8];for(int i=0;i<8;i++)assert(!pthread_create(&workers[i],NULL,run,NULL));for(int i=0;i<8;i++)assert(!pthread_join(workers[i],NULL));atomic_store(&firstCalls,0);atomic_store(&secondCalls,0);assert(!klj_resolve_import("absent"));assert(atomic_load(&firstCalls)==1&&atomic_load(&secondCalls)==1);puts("PASS concurrent duplicate registration preserves precedence and bounded immutable ownership");}
