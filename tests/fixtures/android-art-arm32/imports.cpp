#include "arm32.h"
#include "native-imports.h"
#include "../library-registry.h"
#include "../image-constructor.h"
#include "../android-arm32/argument-span.h"
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <iostream>
#include <iterator>
using namespace maclauncher::arm32;
static void *lookup(const char *name){return dlsym(RTLD_DEFAULT,name);}
static std::vector<uint8_t> readFile(const char *path){std::ifstream input(path,std::ios::binary);return {std::istreambuf_iterator<char>(input),{}};}
struct Loaded {
 std::string path;
 std::unique_ptr<Image> image;
 std::vector<Loaded *> children;
 KlImageInitialization initialization{};
 Thread *thread;
 int initialize(){return klj_image_construct(&initialization,[](void *opaque){auto &self=*static_cast<Loaded *>(opaque);for(auto *child:self.children)if(!child->initialize())return 0;self.image->initialize(*self.thread);return 1;},this);}
};
struct Loader {
 Memory &memory;Thread &thread;uint32_t bias=0x31000000;
 KlImageRegistry *registry=klj_library_registry_create();pthread_mutex_t mutex=PTHREAD_MUTEX_INITIALIZER;
 ~Loader(){auto snapshot=klj_library_registry_snapshot(registry);for(size_t i=0;i<snapshot.count;i++)delete static_cast<Loaded *>(snapshot.entries[i].img);klj_library_registry_destroy(registry);pthread_mutex_destroy(&mutex);}
 KljLibraryGroupOperations operations(){
  return {this,
   [](void *,void *image){return static_cast<Loaded *>(image)->path.c_str();},
   [](void *,void *,void *){return 1;},
   [](void *opaque,void *,const char *path,char *,size_t)->void *{auto &self=*static_cast<Loader *>(opaque);auto value=std::make_unique<Loaded>();value->path=path;value->thread=&self.thread;value->image=std::make_unique<Image>(self.memory,readFile(path),self.bias);self.bias+=0x01000000;return value.release();},
   [](void *,void *image){delete static_cast<Loaded *>(image);},
   [](void *,const char *path,int (*visit)(void *,const char *),void *context,char *,size_t){for(auto &name:Image::inspect(readFile(path)).needed)if(!visit(context,name.c_str()))return 0;return 1;},
   [](void *,void *space,void *,const char *requester,const char *name,void **provider,char *path,size_t capacity,char *,size_t){std::string source(requester);auto value=source.substr(0,source.find_last_of('/')+1)+name;if(value.size()>=capacity)return 0;std::memcpy(path,value.c_str(),value.size()+1);*provider=space;return 1;},
   [](void *,void *image,const char *name)->void *{return reinterpret_cast<void *>(uintptr_t(static_cast<Loaded *>(image)->image->symbol(name)));},
   [](void *,void *,void *){return 1;},
   [](void *,void *image,void *(*lookup)(void *,const char *),void *context,char *,size_t){static_cast<Loaded *>(image)->image->relocate([&](std::string_view name){return uint32_t(reinterpret_cast<uintptr_t>(lookup(context,std::string(name).c_str())));});return 1;},
   [](void *,void *image,void *const *children,size_t count){auto &value=*static_cast<Loaded *>(image);for(size_t i=0;i<count;i++)value.children.push_back(static_cast<Loaded *>(children[i]));return 1;},
   nullptr,
   [](void *opaque,const KlImageRegistryEntry *entries,void *const *,size_t count){return klj_library_registry_publish_group(static_cast<Loader *>(opaque)->registry,entries,count);}
  };
 }
 Loaded *load(const char *path){auto ops=operations();char error[1024];auto *value=static_cast<Loaded *>(klj_library_group_load(&mutex,registry,&ops,nullptr,path,path,nullptr,nullptr,error,sizeof error));if(!value)throw std::runtime_error(error);return value;}
};
int main(int argc,char **argv){
 try{
  if(argc!=2&&argc!=4)throw std::runtime_error("Expected original ARM32 ELF and optional dependency group");
  std::ifstream file(argv[1],std::ios::binary);
  std::vector<uint8_t> bytes{std::istreambuf_iterator<char>(file),{}};
  Memory memory;Imports imports(memory,lookup);Thread thread(memory);
  imports.setThreadFactory([&]{return std::make_shared<Thread>(memory);});
  imports.setCallback([](Thread &thread,uint32_t address,std::span<const Value> arguments){return thread.call(address,arguments);});
  thread.setSyscall([&](Thread &caller,uint32_t number){return imports.syscall(caller,number);});
  Image image(memory,bytes,0x10000000,[&](std::string_view name){return imports.resolve(name);});
  image.initialize(thread);const auto result=thread.call(image.symbol("original_imports"));
  if(result)throw std::runtime_error("Original Bionic import contract failed: "+std::to_string(result));
  std::cout<<"PASS shared ARM32 imports into original Bionic: callbacks, allocation, errno, varargs, descriptors and mappings\n";
  argumentSpanProof(memory,thread);
  if(argc==4){
   auto a=readFile(argv[2]),b=readFile(argv[3]);
   auto first=Image::inspect(a),second=Image::inspect(b);
   if(first.needed!=std::vector<std::string>{"libgroup-b.so"}||second.needed!=std::vector<std::string>{"libgroup-a.so"})throw std::runtime_error("Original cyclic dependency metadata changed");
   bool eagerFailed=false;try{Image eager(memory,a,0x21000000,[](std::string_view){return uint32_t(0);});}catch(const std::runtime_error &){eagerFailed=true;}
   if(!eagerFailed)throw std::runtime_error("Eager relocation unexpectedly accepted the absent peer image");
   Loader loader{memory,thread};auto *left=loader.load(argv[2]),*right=loader.load(argv[3]);
   if(klj_library_registry_snapshot(loader.registry).count!=2||loader.load(argv[2])!=left)throw std::runtime_error("Shared registry did not reuse the dependency group");
   if(!left->initialize()||!right->initialize())throw std::runtime_error("Shared dependency constructors failed");
   auto groupValue=uint32_t(thread.call(left->image->symbol("group_value"))),peerValue=uint32_t(thread.call(right->image->symbol("peer_value")));
   if(groupValue!=31||peerValue!=19)throw std::runtime_error("Cyclic group relocation or constructor ordering changed: "+std::to_string(groupValue)+", "+std::to_string(peerValue));
   std::cout<<"PASS shared ARM32 cyclic ELF group: original DT_NEEDED, prepublication relocation, data identity and constructors\n";
  }
 }catch(const std::exception &error){std::cerr<<error.what()<<'\n';return 1;}
}
