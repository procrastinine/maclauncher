// Copyright (c) MacLauncher contributors. MIT license.
// Linked into fixture executables only. A failed fixture assertion prints the
// standard message and exits with status 134 instead of aborting, so a fixture
// that owns windows produces no system crash report or dialog. Assertions in
// the product library keep the system handler.
#include <cstdio>
#include <unistd.h>

extern "C" [[noreturn]] void __assert_rtn(const char *function,const char *file,int line,const char *expression){
    if(function)std::fprintf(stderr,"Assertion failed: (%s), function %s, file %s, line %d.\n",expression,function,file,line);
    else std::fprintf(stderr,"Assertion failed: (%s), file %s, line %d.\n",expression,file,line);
    std::fflush(stderr);_exit(134);
}
