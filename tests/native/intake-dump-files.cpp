// Copyright (c) MacLauncher contributors. MIT license.
#include "temporal-frame-policy.hpp"
#include <cstdio>
#include <cstdlib>
#include <set>
#include <string>
namespace {
void require(bool value,const char*reason){if(!value){std::fprintf(stderr,"intake-dump-files: %s\n",reason);std::exit(1);}}
}
int main(){
 // A launch with diagnostics answers many screenshot requests, each at a later
 // frame. Every request's dump replaces the same two files.
 const std::string prefix="/launch/frame-capture";std::set<std::string> files;
 for(unsigned request=0;request<100;++request)for(const char*plane:{"depth","motion"})files.insert(macfx::temporalIntakeDumpPath(prefix,plane));
 require(files.size()==2,"intake dumps of repeated capture requests must keep only the latest depth and motion pair");
 require(files.count(prefix+"-intake-depth.rgba")&&files.count(prefix+"-intake-motion.rgba"),"intake dumps use the fixed names beside the capture prefix");
 std::puts("intake-dump-files: pass");return 0;
}
