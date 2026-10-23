#pragma once
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
namespace macfx {
struct TemporalControls {char magic[8];uint32_t method;float sharpness;uint32_t flags,reserved;};
static_assert(sizeof(TemporalControls)==24);
inline const TemporalControls &temporalControls(){
    struct Reader {
        TemporalControls value{};ino_t inode=0;timespec modified{};
        std::chrono::steady_clock::time_point next{};
        Reader(){const auto v=std::getenv("RESHADE_TEMPORAL_METHOD");value.method=v&&!strcmp(v,"metalfx")?1:v&&!strcmp(v,"fsr2")?2:v&&!strcmp(v,"fsr3")?3:v&&!strcmp(v,"fsr4")?4:0;value.sharpness=.5;}
        void poll(){const auto now=std::chrono::steady_clock::now();if(now<next)return;next=now+std::chrono::milliseconds(100);
            const auto file=std::getenv("RESHADE_TEMPORAL_CONTROL_FILE");if(!file||!*file)return;
            const int fd=open(file,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return;
            struct stat s{};TemporalControls incoming{};
            const bool valid=fstat(fd,&s)==0&&S_ISREG(s.st_mode)&&s.st_size==sizeof(incoming);
            if(valid&&s.st_ino==inode&&s.st_mtimespec.tv_sec==modified.tv_sec&&s.st_mtimespec.tv_nsec==modified.tv_nsec){close(fd);return;}
            const bool readOK=valid&&pread(fd,&incoming,sizeof(incoming),0)==sizeof(incoming);close(fd);
            if(!readOK||memcmp(incoming.magic,"MLTMCTL1",8)||incoming.method>4||!std::isfinite(incoming.sharpness)||incoming.sharpness<0||incoming.sharpness>1||incoming.flags>1||incoming.reserved)return;
            value=incoming;inode=s.st_ino;modified=s.st_mtimespec;
        }
    };thread_local Reader reader;reader.poll();return reader.value;
}
}
