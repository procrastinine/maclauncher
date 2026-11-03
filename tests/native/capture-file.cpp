// Copyright (c) MacLauncher contributors. MIT license.
#include "../../src/modules/shared/reshade/native/capture-file.hpp"
#include <cstdio>
int main(int argc,char**argv){try{
    if(argc!=2)throw std::runtime_error("Capture output path required");
    // Two pixels per row with deliberately non-image padding between rows.
    const unsigned char pixels[]{3,2,1,4,7,6,5,8,99,99,99,99,11,10,9,12,15,14,13,16,99,99,99,99};
    macfx::writeCaptureFile(argv[1],pixels,2,2,true,true,12);
    if(macfx::captureLayout(0,1,4)||macfx::captureLayout(32769,1,131076)||macfx::captureLayout(2,1,4)||macfx::captureLayout(32768,32768,131072))
        throw std::runtime_error("Invalid capture bounds accepted");
    bool refused=false;try{macfx::writeCaptureFile(argv[1],pixels,2,2,true,true,12);}catch(const std::exception&){refused=true;}
    if(!refused)throw std::runtime_error("Existing capture replaced");
    return 0;
}catch(const std::exception&error){std::fprintf(stderr,"%s\n",error.what());return 1;}}
