#pragma once
#include "native-config.hpp"
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
        // The launch selection comes from the native configuration; the control
        // file (MLTMCTL1) replaces it while the process runs.
        Reader(){const auto &launch=nativeConfig().temporal;const auto &v=launch.method;value.method=v=="metalfx"?1:v=="fsr2"?2:v=="fsr3"?3:v=="fsr4"?4:v=="xess"?5:v=="asr"?6:v=="sgsr2"?7:v=="metalfx-denoised"?8:0;value.sharpness=.5;if(value.method==6){const auto &quality=launch.asrQuality;value.reserved=quality=="balanced"?2:quality=="performance"?3:quality=="ultra-performance"?4:1;}if(value.method==4){const auto &profile=launch.fsr4Profile;value.reserved=profile=="lite"?2:profile=="lite2"?3:0;}}
        void poll(){const auto now=std::chrono::steady_clock::now();if(now<next)return;next=now+std::chrono::milliseconds(100);
            const auto &control=nativeConfig().temporal.controlFile;if(!control||control->empty())return;const char *file=control->c_str();
            const int fd=open(file,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return;
            struct stat s{};TemporalControls incoming{};
            const bool valid=fstat(fd,&s)==0&&S_ISREG(s.st_mode)&&s.st_size==sizeof(incoming);
            if(valid&&s.st_ino==inode&&s.st_mtimespec.tv_sec==modified.tv_sec&&s.st_mtimespec.tv_nsec==modified.tv_nsec){close(fd);return;}
            const bool readOK=valid&&pread(fd,&incoming,sizeof(incoming),0)==sizeof(incoming);close(fd);
            if(!readOK||memcmp(incoming.magic,"MLTMCTL1",8)||incoming.method>8||!std::isfinite(incoming.sharpness)||incoming.sharpness<0||incoming.sharpness>1||incoming.flags>1||(incoming.method==6?incoming.reserved>4:incoming.method==4?incoming.reserved>3:incoming.reserved!=0))return;
            value=incoming;inode=s.st_ino;modified=s.st_mtimespec;
        }
    };thread_local Reader reader;reader.poll();return reader.value;
}
}
