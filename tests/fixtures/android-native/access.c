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
    // The installer uses these same Linux AT operations with strict ownership
    // checks. Descriptor-relative paths stay relative after flag conversion.
    assert(!klj_fchmodat(directory,"present",0640,0));
    struct stat status;assert(!stat("present",&status));assert((status.st_mode&0777)==0640);
    assert(!klj_chmod(absolute,0600));
    assert(!klj_linkat(directory,"present",-100,"hardlink",0));
    assert(!klj_renameat(-100,"hardlink",directory,"renamed-link"));
    assert(!klj_link("present","second-link"));
    assert(!symlink("present","target-link"));
    assert(!klj_linkat(-100,"target-link",directory,"followed-link",0x400));
    struct stat target;assert(!stat("present",&target));assert(!lstat("followed-link",&status));
    assert(S_ISREG(status.st_mode)&&status.st_ino==target.st_ino);
    assert(!mkdir("remove-dir",0700));assert(!klj_unlinkat(directory,"remove-dir",0x200));
    assert(!mkdir("remove-other",0700));assert(!klj_rmdir("remove-other"));
    errno=0;assert(klj_unlinkat(directory,"present",0x100)==-1&&errno==EINVAL);
    errno=0;assert(klj_fchmodat(directory,"present",0600,0x200)==-1&&errno==EINVAL);
    errno=0;assert(klj_linkat(directory,"present",directory,"bad-link",0x100)==-1&&errno==EINVAL);
    assert(!klj_unlinkat(-100,"renamed-link",0));assert(!klj_unlinkat(directory,"second-link",0));
    assert(!klj_unlinkat(-100,"target-link",0));assert(!klj_unlinkat(-100,"followed-link",0));
    close(directory);assert(!unlink("dangling"));assert(!unlink("present"));
    puts("PASS Android faccessat relative/absolute and guest proc lookup, original access, sentinel, flags, symlink and errno semantics");
}
