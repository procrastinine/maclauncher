// Copyright (c) MacLauncher contributors. MIT license.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>
using Process=bool(*)(void*,unsigned char*,unsigned,unsigned);
static void require(bool value,const char *why){if(!value)throw std::runtime_error(why);}
static std::string quote(const std::string &value){std::string out="\"";for(char c:value){if(c=='\\'||c=='"')out+='\\';out+=c;}return out+'"';}
struct Fixture {
    std::string directory,plan,add,multiply,bad;unsigned revision=0;
    Fixture(){char name[]="/tmp/maclauncher-effects-gpu-XXXXXX";require(mkdtemp(name),"Cannot create effect fixture");directory=name;plan=directory+"/plan.json";add=directory+"/add.fx";multiply=directory+"/multiply.fx";bad=directory+"/bad.fx";
        const std::string prefix="#include \"ReShade.fxh\"\nuniform float Amount=.2;uniform float Gain=.5;\nfloat4 Filter(float4 position:SV_Position,float2 uv:TEXCOORD):SV_Target{float4 c=tex2D(ReShade::BackBuffer,uv);return float4(";
        std::ofstream(add)<<prefix<<"c.rgb+Amount,c.a);}\ntechnique Main{pass{VertexShader=PostProcessVS;PixelShader=Filter;}}\n";
        std::ofstream(multiply)<<prefix<<"c.rgb*Gain,c.a);}\ntechnique Main{pass{VertexShader=PostProcessVS;PixelShader=Filter;}}\n";
        std::ofstream(bad)<<"This is an invalid shader source.\n";
        setenv("RESHADE_EFFECT_PLAN",plan.c_str(),1);setenv("RESHADE_EXPLICIT_HOST","1",1);setenv("RESHADE_EFFECT",add.c_str(),1);unsetenv("RESHADE_LIVE_EFFECTS");
    }
    ~Fixture(){std::filesystem::remove_all(directory);}
    std::string shader(const char *id,const std::string &file,const std::string &parameters="{}",const char *format="fx")const{
        return "{\"id\":"+quote(id)+",\"kind\":\"shader\",\"enabled\":true,\"format\":"+quote(format)+",\"file\":"+quote(file)+",\"key\":\""+std::string(64,'a')+"\",\"revision\":\""+std::string(64,'b')+"\",\"parameters\":"+parameters+",\"preservesCoordinates\":true}";
    }
    void publish(const std::string &nodes,const char *mode="advanced"){
        // Different row settings/revisions, same immutable shader identities.
        ++revision;const auto key=std::string(62,'c')+"0123456789abcdef"[(revision/16)%16]+"0123456789abcdef"[revision%16];
        {std::ofstream out(plan+".tmp");out<<"{\"schema\":1,\"mode\":"<<quote(mode)<<",\"revision\":"<<quote(key)<<",\"nodes\":["<<nodes<<"]}";require(bool(out),"Cannot write effect plan");}
        require(rename((plan+".tmp").c_str(),plan.c_str())==0,"Cannot publish effect plan");std::this_thread::sleep_for(std::chrono::milliseconds(120));
    }
};
int main(int argc,char **argv){try{
    require(argc==3||argc==4||argc==5&&std::string(argv[3])=="--libplacebo","Usage: effects-execution LIBRARY INCLUDE_DIRECTORY [ORIGINAL_FEEDBACK_PRESET | --libplacebo PREPARED_HOOK]");Fixture fixture;setenv("RESHADE_INCLUDE_PATH",argv[2],1);
    const auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library)throw std::runtime_error(dlerror());
    const auto process=reinterpret_cast<Process>(dlsym(library,"rsProcessRGBA"));require(process,"Missing frame processing API");int owner=0;
    const auto verify=[&](int expected,const char *stage,unsigned width=64,unsigned height=48,bool opaque=false){
        std::vector<unsigned char> pixels(width*height*4);for(unsigned i=0;i<width*height;++i){pixels[i*4]=pixels[i*4+1]=pixels[i*4+2]=64;pixels[i*4+3]=opaque?255:(i*7)%256;}
        require(process(&owner,pixels.data(),width,height),"Ordered Metal processing failed");
        for(unsigned i=0;i<width*height;++i){const auto alpha=opaque?255:(i*7)%256;for(unsigned c=0;c<3;++c)if(alpha&&std::abs(int(pixels[i*4+c])-expected)>1)throw std::runtime_error(std::string(stage)+": RGB"+std::to_string(pixels[i*4+c])+" expected "+std::to_string(expected)+" at pixel "+std::to_string(i));require(pixels[i*4+3]==alpha,"Ordered effects changed source alpha");}
        std::printf("%s %ux%u: expected RGB%d, varying source alpha preserved\n",stage,width,height,expected);
    };
    const auto add=fixture.shader("add",fixture.add),multiply=fixture.shader("multiply",fixture.multiply);
    if(argc==5){
        const auto provider=fixture.shader("placebo",argv[4],"{\"Gain\":[0.5]}","libplacebo");
        fixture.publish(add+','+provider);verify(58,"FX then libplacebo");
        fixture.publish(provider+','+add);verify(83,"libplacebo then FX");
        fixture.publish(fixture.shader("placebo",argv[4],"{\"Gain\":[0]}","libplacebo")+','+add);verify(51,"Generic libplacebo row parameter");
        return 0;
    }
    fixture.publish(add+','+multiply);verify(58,"Add then multiply");
    fixture.publish(multiply+','+add);verify(83,"Multiply then add");
    const auto edited=fixture.shader("add",fixture.add,"{\"V__Amount\":[0.4]}");
    fixture.publish(edited+','+multiply);verify(83,"Per-row live parameter");
    // A bad later shader must not apply earlier changed parameters, replace
    // ordering, or expose a partially rendered candidate chain.
    fixture.publish(fixture.shader("add",fixture.add,"{\"V__Amount\":[0.8]}")+','+multiply+','+fixture.shader("bad",fixture.bad));verify(83,"Failed new row retains entire working chain");
    fixture.publish(add+",{\"id\":\"scale\",\"kind\":\"spatial\",\"enabled\":true,\"method\":\"bilinear\",\"settings\":{\"spatialSharpness\":0.1}},"+multiply);verify(58,"Shader spatial shader");verify(58,"Resized ordered chain",96,32);
    if(argc==4){
        const auto feedback=fixture.shader("feedback",argv[3],"{}","slangp");
        fixture.publish(add+','+feedback);verify(23,"Original feedback first input",64,48,true);verify(41,"Original feedback retained input",64,48,true);
        fixture.publish(edited+','+feedback);verify(33,"Upstream parameter change resets downstream history",64,48,true);verify(60,"Reset history then retained",64,48,true);
        fixture.publish(feedback+','+edited);verify(115,"Reorder resets changed history input",64,48,true);
        fixture.publish(feedback+','+add);verify(74,"Downstream uniform edit retains upstream history",64,48,true);
    }
    fixture.publish("");verify(64,"Advanced empty bypass");
    fixture.publish("","simple");verify(115,"Simple restores legacy shader");
    const auto release=reinterpret_cast<void(*)(void*)>(dlsym(library,"rsReleaseFrameOwner"));require(release,"Missing frame owner retirement");release(&owner);return 0;
}catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 1;}}
