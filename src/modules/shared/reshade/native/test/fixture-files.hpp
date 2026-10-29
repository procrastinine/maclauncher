#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>

// Writes a mkdtemp/mkstemp template under TMPDIR, or under /tmp when TMPDIR is
// unset, and returns the buffer.
template<size_t N> char *temporaryPath(char (&path)[N],const char *name){
    const char *root=std::getenv("TMPDIR");if(!root||!*root)root="/tmp";
    size_t length=std::strlen(root);while(length>1&&root[length-1]=='/')--length;
    const int written=std::snprintf(path,N,"%.*s/%s",int(length),root,name);
    if(written<0||size_t(written)>=N){std::fputs("Temporary path is too long\n",stderr);std::_Exit(1);}
    return path;
}
#ifdef __OBJC__
#import <Foundation/Foundation.h>
// Replaces a file through a sibling and rename(2), as the launcher publishes
// plans and controls. Foundation's atomic option instead stages the bytes in a
// separate replacement directory.
inline bool replaceFile(NSData *bytes,NSString *path){
    if(!bytes||!path)return false;
    NSString *sibling=[path stringByAppendingFormat:@".%d.new",getpid()];
    if(![bytes writeToFile:sibling options:0 error:nil])return false;
    if(rename(sibling.fileSystemRepresentation,path.fileSystemRepresentation)==0)return true;
    unlink(sibling.fileSystemRepresentation);return false;
}
#endif
