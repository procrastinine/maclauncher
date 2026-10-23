#include "../../src/modules/shared/reshade/native/live-controls.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <fstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// Actual Metal processing/readback through the installed native ABI. No game
// window, modified effect source or replacement rendering implementation.
using Process=bool(*)(void *,unsigned char *,unsigned,unsigned);
static void require(bool value,const char *message) {if(!value)throw std::runtime_error(message);}
struct Image {
    unsigned width,height;
    std::vector<unsigned char> pixels,original;
    Image(unsigned w,unsigned h):width(w),height(h),pixels(w*h*4) {
        for(unsigned y=0;y<h;++y)for(unsigned x=0;x<w;++x) {
            const auto i=(y*w+x)*4;pixels[i]=200;pixels[i+1]=160;pixels[i+2]=120;
            pixels[i+3]=(x*13+y*7)%256;
        }
        original=pixels;
    }
    unsigned red(unsigned x,unsigned y)const {return pixels[(y*width+x)*4];}
    void gray(unsigned x,unsigned y,unsigned value) {
        const auto i=(y*width+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=value;
    }
    void process(Process function,void *owner) {
        require(function(owner,pixels.data(),width,height),"Native Metal effect processing failed");
        for(unsigned i=0;i<width*height;++i)require(pixels[i*4+3]==original[i*4+3],"Effect changed source alpha");
    }
    bool black(double x,double y)const {
        const auto i=(unsigned(y*height)*width+unsigned(x*width))*4;
        return pixels[i]<=1&&pixels[i+1]<=1&&pixels[i+2]<=1;
    }
};
struct Bands {unsigned count;double contrast,mean;};
static Bands bands(const Image &image) {
    // Count visible local maxima rather than reconstructing the beam equation.
    // Ignore the border shoulders, preserving 80% of the content rows at both
    // output sizes.
    const unsigned first=image.height/10,last=image.height*9/10,x=image.width/2;
    std::vector<unsigned> peaks;double sum=0,contrast=0;
    for(unsigned y=first;y<last;++y) {
        const auto value=image.red(x,y);sum+=value;
        if(value>image.red(x,y-1)&&value>=image.red(x,y+1))peaks.push_back(y);
    }
    for(unsigned i=1;i<peaks.size();++i) {
        unsigned minimum=255;
        for(unsigned y=peaks[i-1];y<=peaks[i];++y)minimum=std::min(minimum,image.red(x,y));
        contrast+=(image.red(x,peaks[i-1])+image.red(x,peaks[i]))/2.0-minimum;
    }
    return {unsigned(peaks.size()),peaks.size()>1?contrast/(peaks.size()-1):0,sum/(last-first)};
}
static void requireBands(const Bands &value,unsigned expected) {
    require(std::abs(int(value.count)-int(expected))<=1,"Visible CRT content-row count is incorrect");
    require(value.contrast>20,"CRT scanlines have insufficient visible contrast");
}
static void requireCorners(const Image &image) {
    for(const auto &[x,y]:{std::pair<double,double>{.025,.025},{.975,.025},{.025,.975},{.975,.975}})
        require(image.black(x,y),"Curved CRT corners are not black");
    for(const auto &[x,y]:{std::pair<double,double>{.15,.15},{.85,.15},{.15,.85},{.85,.85}})
        require(!image.black(x,y),"CRT corner mask obscured the screen interior");
    require(image.black(.01,.25)&&image.black(.99,.75),"CRT curvature did not inset the side edges");
}
class Controls {
    std::string directory,file,key=std::string(64,'a');
public:
    Controls() {
        char temporary[]="/tmp/maclauncher-crt-native-XXXXXX";
        const auto created=mkdtemp(temporary);require(created,"Cannot create native control directory");directory=created;file=directory+"/controls.bin";
        setenv("RESHADE_CONTROL_FILE",file.c_str(),1);setenv("RESHADE_EFFECT_KEY",key.c_str(),1);
    }
    ~Controls(){unlink(file.c_str());unlink((file+".tmp").c_str());rmdir(directory.c_str());}
    void publish(std::vector<std::pair<const char *,float>> parameters) {
        macfx::LivePacket packet{};std::memcpy(packet.magic,"MLFXCTL2",8);
        packet.targetHz=60;packet.multiplier=2;packet.flags=8;packet.count=parameters.size();
        std::memcpy(packet.effectKey,key.data(),key.size());
        unsigned index=0;for(const auto &[name,value]:parameters) {
            auto &uniform=packet.uniforms[index++];std::strncpy(uniform.name,name,sizeof(uniform.name)-1);
            uniform.count=1;uniform.values[0]=value;
        }
        {std::ofstream stream(file+".tmp",std::ios::binary);stream.write(reinterpret_cast<const char *>(&packet),sizeof(packet));require(bool(stream),"Cannot write native controls");}
        require(rename((file+".tmp").c_str(),file.c_str())==0,"Cannot publish native controls");
        // The production reader intentionally polls at most ten times/second.
        std::this_thread::sleep_for(std::chrono::milliseconds(120));
    }
    void isolated(std::initializer_list<std::pair<const char *,float>> parameters) {
        std::vector<std::pair<const char *,float>> values={{"V__Strength",1},{"V__SimulatedHeight",100},
            {"V__ScanlineDepth",0},{"V__Softness",0},{"V__Glow",0},{"V__Curvature",0},
            {"V__CornerRadius",0},{"V__Vignette",0},{"V__EdgeFade",0}};
        for(const auto &parameter:parameters) {
            auto found=std::find_if(values.begin(),values.end(),[&](const auto &entry){return std::strcmp(entry.first,parameter.first)==0;});
            if(found==values.end())values.push_back(parameter);else found->second=parameter.second;
        }
        publish(std::move(values));
    }
};
int main(int argc,char **argv) {
    try {
        require(argc==3||(argc==4&&std::string(argv[3])=="grayscale"),"Usage: reshade-presets LIBRARY EFFECT [grayscale]");
        const bool grayscale=argc==4;
        setenv("RESHADE_EFFECT",argv[2],1);setenv("RESHADE_EXPLICIT_HOST","1",1);unsetenv("RESHADE_LIVE_EFFECTS");
        Controls controls;controls.publish({});
        void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library)throw std::runtime_error(dlerror());
        const auto process=reinterpret_cast<Process>(dlsym(library,"rsProcessRGBA"));require(process,"Native RGBA processing API is absent");
        int owner=0;
        if(grayscale) {
            for(const auto &[width,height]:{std::pair<unsigned,unsigned>{128,128},{256,96}}) {
                Image image(width,height);image.process(process,&owner);
                for(unsigned i=0;i<width*height;++i) {
                    const auto *pixel=&image.pixels[i*4];require(pixel[0]==pixel[1]&&pixel[1]==pixel[2]&&pixel[0]>120&&pixel[0]<200,"Grayscale did not produce neutral weighted brightness");
                }
                std::printf("Grayscale %ux%u: neutral weighted brightness; varying source alpha preserved\n",width,height);
            }
            return 0;
        }
        unsigned previous=0;
        for(const auto &[width,height]:{std::pair<unsigned,unsigned>{1280,800},{2560,1600}}) {
            Image image(width,height);image.process(process,&owner);const auto measured=bands(image);
            requireBands(measured,192);requireCorners(image);
            if(previous)require(std::abs(int(previous)-int(measured.count))<=1,"CRT content-row count changed after output resize");previous=measured.count;
            std::printf("CRT %ux%u: %u bands in center 80%% (240 content rows), contrast=%.1f; curved black corners and alpha preserved\n",width,height,measured.count,measured.contrast);
        }
        controls.publish({{"V__SimulatedHeight",120}});
        Image half(1280,800);half.process(process,&owner);const auto halfBands=bands(half);requireBands(halfBands,96);
        controls.publish({{"V__SimulatedHeight",120},{"V__BeamWidth",.25f}});
        Image narrow(1280,800);narrow.process(process,&owner);const auto narrowBands=bands(narrow);requireBands(narrowBands,96);
        controls.publish({{"V__SimulatedHeight",120},{"V__BeamWidth",.9f}});
        Image wide(1280,800);wide.process(process,&owner);const auto wideBands=bands(wide);
        require(std::abs(int(wideBands.count)-96)<=1,"Live beam width changed the content-row count");
        require(wideBands.mean-narrowBands.mean>15&&narrowBands.contrast-wideBands.contrast>10,"Live beam width did not change visible beam coverage and contrast");
        std::printf("Live CRT: SimulatedHeight 120 gives %u bands; BeamWidth .25 to .9 mean %.1f to %.1f, contrast %.1f to %.1f\n",halfBands.count,narrowBands.mean,wideBands.mean,narrowBands.contrast,wideBands.contrast);
        for(const auto rows:{100,120}) {
            controls.publish({{"V__SimulatedHeight",float(rows)}});
            for(const auto &[width,height]:{std::pair<unsigned,unsigned>{1280,800},{2560,1600}}) {
                Image image(width,height);image.process(process,&owner);const auto measured=bands(image);
                requireBands(measured,unsigned(rows*4/5));
                std::printf("Live CRT %ux%u: %d content rows give %u visible bands\n",width,height,rows,measured.count);
            }
        }
        for(const auto &size:{std::pair<unsigned,unsigned>{1280,800},{2560,1600}}) {
            const unsigned width=size.first,height=size.second,pitch=height/100,center=width/2,y=height/2;
            auto edge=[&] {
                Image image(width,height);
                for(unsigned row=0;row<height;++row)for(unsigned x=0;x<width;++x)image.gray(x,row,x<center?0:255);
                image.original=image.pixels;return image;
            };
            controls.isolated({});auto sharp=edge();sharp.process(process,&owner);
            controls.isolated({{"V__Softness",.8f}});auto soft=edge();soft.process(process,&owner);
            const unsigned inside=center+pitch*2/5,outside=center-pitch*2/5;
            require(sharp.red(outside,y)<=1&&sharp.red(inside,y)>=254,"Sharp source edge did not remain sharp with Softness 0");
            require(soft.red(outside,y)>60&&soft.red(outside,y)<190&&soft.red(inside,y)>180&&soft.red(inside,y)<250,"Pixel softness did not spread the edge across a content-pixel radius");
            require(soft.red(center-pitch*2,y)<=1&&soft.red(center+pitch*2,y)>=254,"Pixel softness washed out distant content");
            unsigned transition=0;
            for(unsigned x=center-pitch*2;x<center+pitch*2;++x)if(soft.red(x,y)>5&&soft.red(x,y)<250)++transition;
            require(transition>=pitch&&transition<=pitch*2,"Pixel softness transition did not scale with simulated content pixels");
            auto stripe=[&] {
                Image image(width,height);
                for(unsigned row=0;row<height;++row)for(unsigned x=0;x<width;++x)image.gray(x,row,x>=center-pitch/2&&x<center+pitch/2?255:0);
                image.original=image.pixels;return image;
            };
            controls.isolated({});auto dark=stripe();dark.process(process,&owner);
            controls.isolated({{"V__Glow",.6f}});auto glow=stripe();glow.process(process,&owner);
            for(const auto x:{center-pitch*3/2,center+pitch*3/2})
                require(dark.red(x,y)<=1&&glow.red(x,y)>25&&glow.red(x,y)<110,"Phosphor glow did not produce a bounded halo outside the bright stripe");
            require(glow.red(center,y)>=250&&glow.red(center-pitch*4,y)<=1&&glow.red(center+pitch*4,y)<=1,"Phosphor glow washed out the distant background or bright source");
            controls.isolated({});Image plain(width,height);plain.process(process,&owner);
            controls.isolated({{"V__EdgeFade",.12f}});Image faded(width,height);faded.process(process,&owner);
            const auto border=faded.red(width/100,y),shoulder=faded.red(width*3/100,y),inner=faded.red(width*5/100,y),interior=faded.red(center,y);
            require(border<interior/5&&shoulder>border+25&&inner>shoulder+25,"Screen edge fade did not form a smooth dark border");
            require(inner>interior*4/5&&std::abs(int(interior)-int(plain.red(center,y)))<=1&&std::abs(int(faded.red(width/10,y))-int(plain.red(width/10,y)))<=1,"Screen edge fade altered the clear interior");
            std::printf("CRT %ux%u: softness transition %u px / %u px content pitch; halo %u; edge fade %u < %u < %u < %u; alpha preserved\n",width,height,transition,pitch,glow.red(center+pitch*3/2,y),border,shoulder,inner,interior);
        }
        controls.publish({{"V__Curvature",0},{"V__CornerRadius",.12f}});
        Image rounded(1280,800);rounded.process(process,&owner);
        require(rounded.black(.01,.01)&&!rounded.black(.01,.5)&&!rounded.black(.05,.05),"Rounded CRT corner mask did not preserve the edge/interior shape");
        controls.publish({{"V__Curvature",0},{"V__CornerRadius",0}});
        Image square(1280,800);square.process(process,&owner);require(!square.black(.01,.01),"Live rounded-corner radius did not restore the square screen");
        controls.publish({{"V__Strength",0}});
        Image bypass(1280,800);bypass.process(process,&owner);require(bypass.pixels==bypass.original,"Live Strength 0 did not preserve exact source RGBA");
        controls.publish({});
        Image reset(1280,800);reset.process(process,&owner);requireBands(bands(reset),192);requireCorners(reset);
        std::puts("Live CRT: rounded/square controls, exact Strength 0 RGBA and default reset passed");
        return 0;
    } catch(const std::exception &error) {std::fprintf(stderr,"%s\n",error.what());return 1;}
}
