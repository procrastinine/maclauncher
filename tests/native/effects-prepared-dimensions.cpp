// Copyright (c) MacLauncher contributors. MIT license.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>
static void require(bool value,const char *why){if(!value)throw std::runtime_error(why);}
int main(int argc,char **argv){try{
    require(argc==4,"Usage: effects-prepared-dimensions LIBRARY PREPARED_FILE PLAN_ROOT");const std::string root=argv[3],plan=root+"/plan.json";setenv("RESHADE_EFFECT_PLAN",plan.c_str(),1);setenv("RESHADE_EFFECT_PLAN_ROOT",root.c_str(),1);setenv("RESHADE_LIVE_EFFECTS",(root+"/legacy").c_str(),1);setenv("RESHADE_EXPLICIT_HOST","1",1);
    std::ofstream(plan)<<"{\"schema\":1,\"mode\":\"advanced\",\"revision\":\""<<std::string(64,'a')<<"\",\"nodes\":[{\"id\":\"dimensions\",\"kind\":\"shader\",\"enabled\":true,\"format\":\"fx\",\"file\":\""<<argv[2]<<"\",\"key\":\""<<std::string(64,'b')<<"\",\"revision\":\""<<std::string(64,'c')<<"\"}]}";
    auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);require(library,dlerror()?:"Cannot load native processor");const auto process=reinterpret_cast<bool(*)(void*,unsigned char*,unsigned,unsigned)>(dlsym(library,"rsProcessRGBA"));require(process,"Missing original frame API");int owner=0;
    for(const auto size:std::vector<std::pair<unsigned,unsigned>>{{64,48},{96,32}}){const auto [width,height]=size;std::vector<unsigned char> bytes(width*height*4,64);for(size_t i=3;i<bytes.size();i+=4)bytes[i]=77;require(process(&owner,bytes.data(),width,height),"Prepared dimensions failed to render");for(size_t i=0;i<bytes.size();i+=4){require(std::abs(int(bytes[i])-int(width))<=1&&std::abs(int(bytes[i+1])-int(height))<=1&&std::abs(int(bytes[i+2])-128)<=1,"Prepared dimensions or reciprocals did not match the actual resized frame");require(bytes[i+3]==77,"Prepared shader changed alpha");}std::printf("Prepared plan FX %ux%u: actual WIDTH/HEIGHT/RCP values and alpha77 PASS\n",width,height);}return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}}
