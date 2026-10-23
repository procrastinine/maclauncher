#include "../../src/modules/shared/reshade/native/live-controls.hpp"
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <fstream>
#include <stdexcept>
#include <thread>
#include <vector>
using Process=bool(*)(void *,unsigned char *,unsigned,unsigned);
static void require(bool value,const char *message){if(!value)throw std::runtime_error(message);}
static std::vector<unsigned char> image(unsigned w,unsigned h) {
    std::vector<unsigned char> bytes(w*h*4);
    for(unsigned y=0;y<h;++y)for(unsigned x=0;x<w;++x){const auto i=(y*w+x)*4;
        bytes[i]=40+(x/16%2)*140;bytes[i+1]=40+(y/16%2)*140;bytes[i+2]=80+(x/32%2)*80;bytes[i+3]=255;}
    return bytes;
}
static double mean(const std::vector<unsigned char>&bytes,unsigned w,unsigned h) {
    double sum=0;unsigned count=0;
    for(unsigned y=h/4;y<h*3/4;++y)for(unsigned x=w/4;x<w*3/4;++x)for(unsigned c=0;c<3;++c){sum+=bytes[(y*w+x)*4+c];++count;}
    return sum/count;
}
static void controls(const char *file,const char *parameter=nullptr,float value=0) {
    macfx::LivePacket packet{};std::memcpy(packet.magic,"MLFXCTL2",8);packet.targetHz=60;packet.multiplier=2;packet.flags=8;
    std::memset(packet.effectKey,'a',64);
    if(parameter){packet.count=1;std::strncpy(packet.uniforms[0].name,parameter,127);packet.uniforms[0].count=1;packet.uniforms[0].values[0]=value;}
    const auto temporary=std::string(file)+".tmp";
    {std::ofstream out(temporary,std::ios::binary);out.write(reinterpret_cast<const char*>(&packet),sizeof(packet));require(bool(out),"Cannot write live controls");}
    require(rename(temporary.c_str(),file)==0,"Cannot publish live controls");std::this_thread::sleep_for(std::chrono::milliseconds(120));
}
int main(int argc,char **argv){try{
    require(argc==5,"Usage: retroarch LIBRARY PRESET stock|royale|history|feedback|libplacebo CONTROL_FILE");
    setenv("RESHADE_EFFECT",argv[2],1);setenv("RESHADE_EXPLICIT_HOST","1",1);setenv("RESHADE_EFFECT_KEY",std::string(64,'a').c_str(),1);
    setenv("RESHADE_CONTROL_FILE",argv[4],1);unsetenv("RESHADE_LIVE_EFFECTS");controls(argv[4]);
    const auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library)throw std::runtime_error(dlerror());
    const auto process=reinterpret_cast<Process>(dlsym(library,"rsProcessRGBA"));require(process,"Missing native effect API");
    const std::string mode=argv[3];
    if(mode=="libplacebo") {
        int owner=0;auto original=image(64,48);for(size_t i=3;i<original.size();i+=4)original[i]=77;
        const auto verify=[&](float gain){auto pixels=original;require(process(&owner,pixels.data(),64,48),"Simple libplacebo Metal processing failed");for(size_t i=0;i<pixels.size();++i)require(std::abs(int(pixels[i])-int(i%4==3?original[i]:std::lround(original[i]*gain)))<=1,"Simple libplacebo control, default or alpha is incorrect");};
        verify(1);controls(argv[4],"Gain",.5);verify(.5);controls(argv[4]);verify(1);
        std::printf("Simple libplacebo: actual shared API defaults → live Gain0.5 → defaults; alpha77 preserved\n");unlink(argv[4]);return 0;
    }
    if(mode=="history"||mode=="feedback") {
        int owner=0;const unsigned w=64,h=48;const int input[]={64,32,128,96},history[]={64,32,96,32},feedback[]={13,17,39,50};
        for(unsigned frame=0;frame<4;++frame) {
            auto pixels=image(w,h);for(unsigned i=0;i<w*h;++i)pixels[i*4]=pixels[i*4+1]=pixels[i*4+2]=input[frame];
            require(process(&owner,pixels.data(),w,h),"Original temporal Slang preset failed");
            const auto expected=mode=="history"?history[frame]:feedback[frame];
            require(std::abs(int(pixels[(h/2*w+w/2)*4])-expected)<=2,"Original Slang history/feedback was not retained between submitted frames");
            std::printf("Original Slang %s frame%u: input%d output%u expected%d\n",argv[3],frame,input[frame],pixels[(h/2*w+w/2)*4],expected);
        }
        unlink(argv[4]);return 0;
    }
    int owner=0;const bool stock=std::string(argv[3])=="stock";
    for(const auto size:{std::pair<unsigned,unsigned>{640,400},{1280,800}}){const auto w=size.first,h=size.second;
        const auto original=image(w,h);auto filtered=original;
        require(process(&owner,filtered.data(),w,h),"Original Slang pipeline failed");
        if(stock){for(size_t i=0;i<original.size();++i)require(std::abs(int(original[i])-int(filtered[i]))<=1,"Original stock Slang changed source RGBA/orientation");}
        else {
            const double normal=mean(filtered,w,h);require(normal>15&&normal<230,"Original Royale produced a blank or clipped image");
            controls(argv[4],"levels_contrast",0);auto dark=original;require(process(&owner,dark.data(),w,h),"Live Slang parameter update failed");
            const auto black=mean(dark,w,h);require(black<normal*.15,"Original Royale live parameter did not change actual Metal output");
            controls(argv[4]);auto reset=original;require(process(&owner,reset.data(),w,h),"Slang parameter reset failed");
            require(std::abs(mean(reset,w,h)-normal)<2,"Slang parameter removal did not restore the original preset default");
            double changed=0;for(size_t i=0;i<original.size();++i)if(i%4!=3)changed+=std::abs(int(original[i])-int(filtered[i]));
            require(changed/(w*h*3)>8,"Original Royale did not visibly process the source");
            std::printf("Royale %ux%u: original12-pass preset, mean %.2f → %.2f → %.2f with live contrast/reset\n",w,h,normal,black,mean(reset,w,h));
        }
        if(stock)std::printf("Stock Slang %ux%u: exact source RGBA and orientation preserved\n",w,h);
    }
    unlink(argv[4]);return 0;
}catch(const std::exception&error){std::fprintf(stderr,"%s\n",error.what());return 1;}}
