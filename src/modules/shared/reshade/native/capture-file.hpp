#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// A capture is raw bytes, never an image-codec call in an injected process.
#include <array>
#include <cerrno>
#include <cstdint>
#include <fcntl.h>
#include <stdexcept>
#include <string>
#include <unistd.h>

namespace macfx {
inline constexpr unsigned captureMaximumDimension=32768;
inline constexpr uint64_t captureMaximumBytes=256ull*1024*1024;
inline bool captureLayout(unsigned width,unsigned height,unsigned stride) {
    return width&&height&&width<=captureMaximumDimension&&height<=captureMaximumDimension&&
        stride>=uint64_t(width)*4&&stride%4==0&&uint64_t(stride)*height<=captureMaximumBytes;
}
inline void writeCaptureFile(const std::string&file,const void*bytes,unsigned width,unsigned height,bool bgra,bool flip,unsigned stride) {
    if(!bytes||!captureLayout(width,height,stride))throw std::runtime_error("The captured frame has an invalid layout");
    const int descriptor=open(file.c_str(),O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
    if(descriptor<0)throw std::runtime_error("Cannot create the raw captured frame: "+file);
    struct Output {
        int descriptor;const std::string&file;bool complete=false;
        ~Output(){if(descriptor>=0)close(descriptor);if(!complete)unlink(file.c_str());}
        void append(const void*data,size_t size){
            const auto*next=static_cast<const unsigned char*>(data);
            while(size){const auto written=write(descriptor,next,size);if(written<0&&errno==EINTR)continue;
                if(written<=0)throw std::runtime_error("Cannot write the raw captured frame: "+file);
                next+=written;size-=size_t(written);}
        }
    }output{descriptor,file};
    std::array<unsigned char,24>header{'M','C','L','C','A','P','0','1'};
    const uint32_t fields[]{width,height,width*4,uint32_t(bgra)|(uint32_t(flip)<<1)};
    for(unsigned field=0;field<4;++field)for(unsigned byte=0;byte<4;++byte)header[8+field*4+byte]=static_cast<unsigned char>(fields[field]>>(byte*8));
    output.append(header.data(),header.size());
    // Padding in a Metal readback buffer is not image data and may be uninitialised.
    const auto*source=static_cast<const unsigned char*>(bytes);
    for(unsigned y=0;y<height;++y)output.append(source+size_t(y)*stride,size_t(width)*4);
    const int status=close(output.descriptor);output.descriptor=-1;
    if(status)throw std::runtime_error("Cannot close the raw captured frame: "+file);
    output.complete=true;
}
}
