#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static void owner(const char *path,unsigned uid,unsigned gid,unsigned mode){
 struct stat info;assert(!stat(path,&info));
 if(info.st_uid!=uid||info.st_gid!=gid||(info.st_mode&07777)!=mode){fprintf(stderr,"%s: %u:%u %o expected %u:%u %o\n",path,info.st_uid,info.st_gid,info.st_mode&07777,uid,gid,mode);assert(0);}
}
int main(void){
 // Read-only mapped code and an undeclared writable area keep the original
 // root identity, including descriptor queries, without looking above mounts.
 owner("/code",0,0,0444);owner("/plain/file",0,0,0644);
 int code=open("/code",O_RDONLY);assert(code>=0);struct stat code_info;
 assert(!fstat(code,&code_info)&&code_info.st_uid==0);assert(!close(code));
 owner("/app/nested/existing",10001,10001,0640);
 owner("/alias/nested/existing",10001,10001,0640);
 owner("/app/late/deep/new",10001,10001,0600);
 assert(!chown("/app/nested/existing",10023,10024));assert(!chmod("/app/nested/existing",0644));
 owner("/alias/nested/existing",10023,10024,0644);
 int fd=open("/app/nested/existing",O_RDONLY);assert(fd>=0);
 struct stat info;assert(!fstat(fd,&info)&&info.st_uid==10023&&info.st_gid==10024);assert(!close(fd));
 // Neither source has been read by the guest. Their ownership must survive
 // crossing into a tree whose imported default is different.
 assert(!link("/app/unseen-link","/peer/linked"));owner("/peer/linked",10001,10001,0600);
 assert(!rename("/app/unseen-tree","/peer/moved"));owner("/peer/moved/deep/child",10001,10001,0600);
 // Explicit directory chown does not change untouched descendants' owner.
 assert(!chown("/app/explicit-tree",10023,10024));owner("/app/explicit-tree/child",10001,10001,0600);
 // Original guest create remains authoritative over the import default.
 assert(!mkdir("/app/guest-made",0700));fd=open("/app/guest-made/file",O_CREAT|O_RDWR,0600);assert(fd>=0);assert(!close(fd));owner("/app/guest-made/file",0,0,0600);
 // Link identity is the application's; following it uses the destination's.
 assert(!lstat("/app/symlink",&info)&&info.st_uid==10001);owner("/app/symlink",10002,10002,0644);
 assert(!setgid(10001));assert(!setuid(10001));
 fd=open("/app/late/deep/new",O_RDWR);assert(fd>=0);assert(!close(fd));
 assert(!chmod("/app/late/deep/new",0400));errno=0;assert(open("/app/late/deep/new",O_WRONLY)<0&&errno==EACCES);
 puts("PASS imported metadata, aliases, explicit owners/modes, late imports, rename/link, guest create and permission enforcement");
 return 0;
}
