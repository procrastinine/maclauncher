#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
extern void *kl_shim_lookup(const char *);
#define kl_upstream_shim_lookup kl_shim_lookup
#include "native-file-imports.h"

int main(int argc,char **argv){
    assert(argc==2);assert(!chdir(argv[1]));
    int file=open("present",O_CREAT|O_EXCL|O_RDWR,0600);assert(file>=0);close(file);
    int directory=open(".",O_RDONLY|O_DIRECTORY);assert(directory>=0);
    int (*check)(int,const char*,int,int)=klj_native_file_lookup("faccessat");assert(check);
    assert(!check(-100,"present",F_OK,0));assert(!check(directory,"present",R_OK|W_OK,0));
    char absolute[PATH_MAX];assert(realpath("present",absolute));
    assert(!check(-777,absolute,R_OK,0));assert(!check(-777,absolute,R_OK,0x200));
    assert(!check(directory,"present",R_OK,0x200));
    assert(check(directory,"present",X_OK,0)==-1&&errno==EACCES);
    assert(check(-777,"present",F_OK,0)==-1&&errno==EBADF);
    assert(check(directory,"missing",F_OK,0)==-1&&errno==ENOENT);
    assert(check(directory,"",F_OK,0)==-1&&errno==ENOENT);
    assert(check(directory,NULL,F_OK,0)==-1&&errno==EFAULT);
    assert(check(directory,"present",8,0)==-1&&errno==EINVAL);
    assert(check(directory,"present",F_OK,0x80000000)==-1&&errno==EINVAL);
    assert(!symlink("missing","dangling"));
    assert(check(directory,"dangling",F_OK,0)==-1&&errno==ENOENT);
    assert(!check(directory,"dangling",F_OK,0x100));
    assert(!check(directory,"dangling",R_OK,0x300));
    char mapped[PATH_MAX];const char *proc=kl_guest_path("/proc/self/status",mapped,sizeof(mapped));
    assert(proc&&strcmp(proc,"/proc/self/status"));
    assert(!check(-100,"/proc/self/status",R_OK,0));
    assert(!check(-100,"/proc/self/status",R_OK,0x200));
    close(directory);assert(!unlink("dangling"));assert(!unlink("present"));
    puts("PASS Android faccessat relative/absolute and guest proc lookup, original access, sentinel, flags, symlink and errno semantics");
}
