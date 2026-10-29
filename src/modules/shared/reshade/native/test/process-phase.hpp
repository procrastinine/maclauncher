#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// The library reads its launch configuration once (native-config.hpp); a
// fixture linked to it does so before main. A fixture that needs another launch
// environment runs that part as a phase: this executable, spawned with
// "--phase NAME" and that environment, so every phase starts as a launch does.
#include <cerrno>
#include <crt_externs.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <string>
#include <sys/wait.h>
#include <utility>
#include <vector>
namespace fixture {
// The phase this process runs (empty in the parent), with the phase arguments
// removed so argv[1] is the first argument given to runPhase.
struct Phase {std::string name;int argc;char **argv;};
inline Phase phase(int argc,char **argv){
    if(argc<3||std::strcmp(argv[1],"--phase"))return {{},argc,argv};
    std::string name=argv[2];argv[2]=argv[0];return {name,argc-2,argv+2};
}
// A null value removes the variable; other variables are inherited.
using Environment=std::vector<std::pair<const char*,const char*>>;
// Runs phase `name` and waits for it. Returns its exit status, 128 plus the
// signal number, or 127 when it cannot start. Output is shared with this process.
inline int runPhase(const char *name,const Environment &environment,const std::vector<std::string> &arguments={}){
    char path[4096];uint32_t size=sizeof(path);if(_NSGetExecutablePath(path,&size))return 127;
    std::vector<std::string> variables;
    for(char **entry=*_NSGetEnviron();*entry;++entry){
        const char *equals=std::strchr(*entry,'=');const std::string key(*entry,equals?size_t(equals-*entry):std::strlen(*entry));
        bool replaced=false;for(const auto &[variable,value]:environment)replaced|=key==variable;
        if(!replaced)variables.emplace_back(*entry);
    }
    for(const auto &[variable,value]:environment)if(value)variables.push_back(std::string(variable)+"="+value);
    std::vector<std::string> words{path,"--phase",name};words.insert(words.end(),arguments.begin(),arguments.end());
    std::vector<char*> argv,envp;for(auto &word:words)argv.push_back(word.data());argv.push_back(nullptr);
    for(auto &variable:variables)envp.push_back(variable.data());envp.push_back(nullptr);
    std::fflush(stdout);std::fflush(stderr);
    pid_t child=0;if(posix_spawn(&child,path,nullptr,nullptr,argv.data(),envp.data()))return 127;
    int status=0;while(waitpid(child,&status,0)<0)if(errno!=EINTR)return 127;
    if(WIFEXITED(status))return WEXITSTATUS(status);
    return WIFSIGNALED(status)?128+WTERMSIG(status):127;
}
}
