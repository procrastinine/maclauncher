#include "library-namespace.h"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <limits.h>
#include <pthread.h>
#include <unistd.h>
// Exercise the production candidate filter with readable on-disk containers.
// Platform symbol providers are outside this file-selection fixture.
static char g_libdir[PATH_MAX];
static int kl_can_load(const char *name){return access(name,R_OK)==0;}
static const char *klj_mapped_guest_path(const char *,char *,size_t){return nullptr;}
static int kl_dep_is_shim_served(const char *){return 0;}
#include "library-paths.inc"
static std::vector<std::string> tried;
static int candidate(void*,const char *input,char *output,size_t size){
 tried.emplace_back(input);char *actual=realpath(input,nullptr);if(!actual)return 0;
 const bool fits=std::strlen(actual)<size;if(fits)std::strcpy(output,actual);std::free(actual);return fits;
}
int main(int argc,char **argv){
 assert(argc==2);const std::string base=argv[1];
 auto owner=klj_namespaces_create();assert(owner);
 auto make=[&](const char *name,const char *ld,const char *defaults,uint64_t flags,const char *permitted=nullptr,KljLibraryNamespace *parent=nullptr){
  return klj_namespace_create(owner,name,ld,defaults,flags,permitted,parent,nullptr);
 };
 const auto ld=base+"/ld",def=base+"/default",run=base+"/run",permit=base+"/permit",outside=base+"/outside";
 auto app=make("app",ld.c_str(),def.c_str(),1,permit.c_str());assert(app);
 assert(!klj_namespace_exported(owner,"app"));klj_namespace_export(app);assert(klj_namespace_exported(owner,"app")==app);
 char path[4096];
 auto resolve=[&](KljLibraryNamespace *ns,const char *name,const char *runpath=nullptr){tried.clear();return klj_namespace_resolve(ns,name,runpath,candidate,nullptr,path,sizeof path);};
 assert(resolve(app,"same.so",run.c_str())==app&&std::string(path)==ld+"/same.so");
 assert(resolve(app,"run.so",run.c_str())==nullptr); // RUNPATH never grants isolated access.
 assert(resolve(app,"deep.so",(permit+"/nested").c_str())==app);
 assert(!resolve(app,"escape.so")); // Canonical symlink target is outside the namespace.
 assert(!klj_namespace_accessible(app,(permit+"-other/file.so").c_str()));
 assert(klj_namespace_accessible(app,(permit+"/nested/deep.so").c_str()));
 auto provider=make("provider",outside.c_str(),nullptr,1);assert(provider);
 assert(klj_namespace_link(app,provider,"allowed.so",0));
 assert(resolve(app,"allowed.so")==provider&&std::string(path)==outside+"/allowed.so");
 assert(!resolve(app,"hidden.so"));
 auto other=make("other",run.c_str(),nullptr,1);assert(other);
 assert(klj_namespace_link(provider,other,"run.so",0));
 assert(!resolve(app,"run.so")); // Links are not transitive for this lookup.
 assert(resolve(provider,"run.so")==other);
 int global=1,local=2,later=3;
 assert(klj_namespace_publish(app,&global,1)&&klj_namespace_publish(app,&local,0));
 auto shared=make("shared",nullptr,nullptr,3,nullptr,app);
 auto isolated=make("isolated",nullptr,nullptr,1,nullptr,app);
 assert(shared&&isolated&&klj_namespace_contains(shared,&local)&&klj_namespace_contains(shared,&global));
 assert(!klj_namespace_contains(isolated,&local)&&klj_namespace_contains(isolated,&global));
 assert(klj_namespace_publish(app,&later,0)&&!klj_namespace_contains(shared,&later));
 assert(resolve(shared,"same.so")==shared); // Actual pinned Bionic copies parent paths.
 assert(make("anonymous",nullptr,nullptr,0x10000000));
 assert(!make("second-anonymous",nullptr,nullptr,0x10000000));
 klj_namespaces_destroy(owner);
 const auto appPath=base+"/app",requester=appPath+"/parent.so";
 std::strcpy(g_libdir,appPath.c_str());
 // Native-width applications retain the original ELF64 default.
 assert(klj_resolve_library_path("dep64.so",requester.c_str(),path,sizeof path));
 assert(!klj_resolve_library_path("dep32.so",requester.c_str(),path,sizeof path));
 assert(klj_resolve_library_path("translated.so",requester.c_str(),path,sizeof path));
 auto *application=klj_default_library_namespace();
 assert(klj_namespace_resolve_from(application,"run.so",requester.c_str(),"$ORIGIN/$LIB",klj_library_elf_class,klj_library_candidate,nullptr,path,sizeof path)==application);
 assert(std::string(path)==appPath+"/lib64/run.so");
 // ARM32 setup selects guest dependency width without replacing the owner.
 klj_set_library_elf_class(1);
 assert(klj_default_library_namespace()==application);
 assert(klj_resolve_library_path("dep32.so",requester.c_str(),path,sizeof path));
 assert(std::string(path)==appPath+"/dep32.so");
 assert(!klj_resolve_library_path("dep64.so",requester.c_str(),path,sizeof path));
 assert(klj_resolve_library_path("translated.so",requester.c_str(),path,sizeof path));
 assert(klj_namespace_resolve_from(application,"run.so",requester.c_str(),"$ORIGIN/$LIB",klj_library_elf_class,klj_library_candidate,nullptr,path,sizeof path)==application);
 assert(std::string(path)==appPath+"/lib/run.so");
 puts("PASS original Bionic access, search, links, shared membership and namespace ownership");
}
