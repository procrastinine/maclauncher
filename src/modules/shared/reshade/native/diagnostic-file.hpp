#pragma once
#include <cerrno>
#include <cstdint>
#include <fcntl.h>
#include <string>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

namespace macfx {
// Optional diagnostics own an ordinary file, never an inherited protocol fd.
// This is defense in depth: a host concurrently closing all descriptors still
// requires preventing diagnostic workers from starting in its exec helper.
class DiagnosticFile {
    int descriptor=-1;
    const pid_t owner=getpid();
    struct stat identity{};
    static bool same(const struct stat &a,const struct stat &b)noexcept {
        return S_ISREG(a.st_mode)&&S_ISREG(b.st_mode)&&a.st_dev==b.st_dev&&a.st_ino==b.st_ino&&a.st_uid==b.st_uid;
    }
    bool owns()const noexcept {
        struct stat current{};
        if(descriptor<0||getpid()!=owner||fstat(descriptor,&current)||!same(identity,current))return false;
        const int flags=fcntl(descriptor,F_GETFD);return flags>=0&&(flags&FD_CLOEXEC)!=0;
    }
    void discard()noexcept {if(owns())close(descriptor);descriptor=-1;}
public:
    enum class AppendResult {Written,Contended,Limit,Unavailable};
    explicit DiagnosticFile(const std::string &path)noexcept {
        struct stat existing{};if(lstat(path.c_str(),&existing)==0&&!S_ISREG(existing.st_mode))return;
        descriptor=open(path.c_str(),O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK,0600);
        if(descriptor<0)return;
        struct stat named{};
        if(fstat(descriptor,&identity)||lstat(path.c_str(),&named)||identity.st_uid!=getuid()||!same(identity,named))discard();
    }
    ~DiagnosticFile(){discard();}
    DiagnosticFile(const DiagnosticFile&)=delete;
    DiagnosticFile& operator=(const DiagnosticFile&)=delete;
    explicit operator bool()const noexcept{return owns();}
    bool append(const std::string &bytes)noexcept {
        size_t offset=0;
        do {
            if(!owns()){descriptor=-1;return false;}
            if(offset==bytes.size())return true;
            const auto count=write(descriptor,bytes.data()+offset,bytes.size()-offset);
            if(count>0)offset+=size_t(count);
            else if(count<0&&errno==EINTR)continue;
            else {discard();return false;}
        }while(true);
    }
    AppendResult appendBounded(const std::string &bytes,size_t maximum)noexcept {
        if(!owns()){descriptor=-1;return AppendResult::Unavailable;}
        if(flock(descriptor,LOCK_EX|LOCK_NB)!=0){
            if(errno==EWOULDBLOCK)return AppendResult::Contended;
            discard();return AppendResult::Unavailable;
        }
        // The host can replace descriptor integers. Never unlock or close a
        // replacement; this check cannot eliminate a concurrent close-all race.
        if(!owns()){descriptor=-1;return AppendResult::Unavailable;}
        struct stat current{};
        const bool valid=fstat(descriptor,&current)==0&&current.st_size>=0;
        if(!valid||uint64_t(current.st_size)>maximum||bytes.size()>maximum-uint64_t(current.st_size)){
            if(owns())flock(descriptor,LOCK_UN);
            return valid?AppendResult::Limit:AppendResult::Unavailable;
        }
        const bool written=append(bytes);
        if(owns())flock(descriptor,LOCK_UN);
        return written?AppendResult::Written:AppendResult::Unavailable;
    }
};
}
