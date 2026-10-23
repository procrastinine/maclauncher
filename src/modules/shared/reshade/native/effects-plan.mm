// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#include "effects-plan.hpp"
#include "automatic-resolution.hpp"
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <fcntl.h>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

namespace macfx {
namespace {
constexpr size_t maximumBytes=4*1024*1024,maximumNodes=32,maximumParameters=4096;
bool boolean(id value){return value&&CFGetTypeID((__bridge CFTypeRef)value)==CFBooleanGetTypeID();}
bool number(id value){return [value isKindOfClass:NSNumber.class]&&!boolean(value)&&std::isfinite([value doubleValue]);}
std::string text(id value,size_t maximum=32768){
    if(![value isKindOfClass:NSString.class])throw std::runtime_error("Effect plan text is invalid");
    const char *bytes=[value UTF8String];
    if(!bytes||[value lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>maximum||std::strlen(bytes)!=[value lengthOfBytesUsingEncoding:NSUTF8StringEncoding])
        throw std::runtime_error("Effect plan text exceeds its limit");
    return bytes;
}
bool flag(NSDictionary *value,NSString *key,bool fallback=false){
    id item=value[key];if(!item)return fallback;
    if(!boolean(item))throw std::runtime_error("Effect plan flags must be boolean");return [item boolValue];
}
void fields(NSDictionary *value,std::initializer_list<NSString*> allowed){
    if(![value isKindOfClass:NSDictionary.class])throw std::runtime_error("Effect plan objects are invalid");
    for(id key in value){bool found=false;for(NSString *name:allowed)found|=[key isEqual:name];if(!found)throw std::runtime_error("Effect plan contains unsupported fields");}
}
std::string hash(id value){const auto s=text(value,64);if(s.size()!=64||s.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("Effect plan identity is invalid");return s;}
bool safeId(const std::string &s){return !s.empty()&&s.size()<=128&&std::isalnum(static_cast<unsigned char>(s.front()))&&s.find("..") == std::string::npos&&s.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")==std::string::npos;}
ShaderParameters parameters(id value){
    if(![value isKindOfClass:NSDictionary.class]||[value count]>maximumParameters)throw std::runtime_error("Effect plan shader parameters are invalid");
    ShaderParameters result;
    for(id key in value){const auto name=text(key,4096);id values=value[key];
        if(name.empty()||name=="__proto__"||name=="constructor"||name=="prototype"||std::any_of(name.begin(),name.end(),[](unsigned char c){return c<32||c==127;})||![values isKindOfClass:NSArray.class]||[values count]<1||[values count]>4)
            throw std::runtime_error("Effect plan shader parameters are invalid");
        auto &out=result[name];for(id item in values){if(!number(item)||!std::isfinite(float([item doubleValue])))throw std::runtime_error("Effect plan shader values must be finite");out.push_back([item floatValue]);}
    }
    return result;
}
std::shared_ptr<EffectPlanSnapshot> parse(NSData *data){
    NSError *error=nil;id raw=[NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if(!raw||error)throw std::runtime_error("Effect plan JSON is invalid");
    fields(raw,{@"schema",@"mode",@"revision",@"nodes"});NSDictionary *root=raw;
    if(!number(root[@"schema"])||[root[@"schema"] doubleValue]!=1||![root[@"nodes"] isKindOfClass:NSArray.class]||[root[@"nodes"] count]>maximumNodes)
        throw std::runtime_error("Effect plan schema is invalid");
    auto plan=std::make_shared<EffectPlanSnapshot>();plan->revision=hash(root[@"revision"]);plan->mode=text(root[@"mode"],16);
    if((plan->mode!="advanced"&&plan->mode!="simple")||(plan->mode=="simple"&&[root[@"nodes"] count]))throw std::runtime_error("Effect plan mode is invalid");
    std::set<std::string> ids;bool generated=false;
    for(id value in root[@"nodes"]){
        if(![value isKindOfClass:NSDictionary.class])throw std::runtime_error("Effect plan rows are invalid");NSDictionary *row=value;EffectPlanNode node;
        node.id=text(row[@"id"],128);node.kind=text(row[@"kind"],32);
        if(!safeId(node.id)||!ids.insert(node.id).second||!boolean(row[@"enabled"]))throw std::runtime_error("Effect plan row identities are invalid");
        if(node.kind!="shader"&&node.kind!="spatial"&&node.kind!="temporal"&&node.kind!="frame-generation"&&node.kind!="neural")throw std::runtime_error("Effect plan row kind is invalid");
        node.enabled=[row[@"enabled"] boolValue];node.preservesCoordinates=flag(row,@"preservesCoordinates");
        if(id requirements=row[@"requirements"]){fields(requirements,{@"depth",@"motion"});node.requirements={flag(requirements,@"depth"),flag(requirements,@"motion")};}
        if(node.kind=="shader"){
            fields(row,{@"id",@"kind",@"enabled",@"format",@"file",@"key",@"revision",@"technique",@"parameters",@"requirements",@"preservesCoordinates",@"outputScale",@"outputExtent"});
            if(!node.enabled){plan->nodes.push_back(std::move(node));continue;}
            node.format=text(row[@"format"],32);if(node.format!="fx"&&node.format!="slangp"&&node.format!="libplacebo")throw std::runtime_error("Effect plan shader format is invalid");
            node.shader.selection.file=text(row[@"file"]);if(node.shader.selection.file.empty()||node.shader.selection.file.front()!='/')throw std::runtime_error("Effect plan shader needs a prepared absolute path");
            node.shader.selection.key=hash(row[@"key"]);node.shader.selection.revision=hash(row[@"revision"]);
            if(row[@"technique"])node.shader.selection.technique=text(row[@"technique"],128);
            node.shader.parameters=parameters(row[@"parameters"]?:@{});
            if(id extent=row[@"outputExtent"]){if(text(extent,32)!="presentation")throw std::runtime_error("Shader output extent must be presentation");node.outputPresentation=true;}
            if(id scale=row[@"outputScale"]){
                fields(scale,{@"x",@"y"});
                const auto factor=[&](NSString *key){id value=scale[key];const double n=number(value)?[value doubleValue]:0;
                    if(n<1.0/16||n>16)throw std::runtime_error("Shader output scale must be from 1/16 to 16 per dimension");return n;};
                node.outputScaleX=factor(@"x");node.outputScaleY=factor(@"y");
            }
        }else{
            fields(row,{@"id",@"kind",@"enabled",@"method",@"settings",@"modelPath",@"requirements",@"preservesCoordinates",@"outputSize",@"presentationScale",@"resolutionAuto"});
            if(!node.enabled){plan->nodes.push_back(std::move(node));continue;}
            if(node.kind!="spatial"&&node.kind!="temporal"&&node.kind!="frame-generation"&&node.kind!="neural")throw std::runtime_error("Effect plan row kind is invalid");
            node.method=text(row[@"method"],80);if(node.method.empty()||node.method.front()<'a'||node.method.front()>'z'||node.method.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789:._-")!=std::string::npos||node.method=="off"||(node.kind=="frame-generation"&&node.method!="lsfg"))throw std::runtime_error("Effect plan method is invalid");
            if(row[@"resolutionAuto"]){
                if(node.kind!="spatial"||node.method!="downsample"||!flag(row,@"resolutionAuto")||row[@"outputSize"])
                    throw std::runtime_error("Automatic processing size requires a downsample row without fixed dimensions");
                node.resolutionAuto=true;
            }
            if(id value=row[@"presentationScale"]){
                if(node.kind!="spatial"||!number(value)||[value doubleValue]<1.0/16||[value doubleValue]>16)
                    throw std::runtime_error("Spatial presentation scale must be from 1/16 to 16");
                node.presentationScale=[value doubleValue];
            }
            if(id output=row[@"outputSize"]){
                if(node.kind!="spatial")throw std::runtime_error("Only spatial rows accept an output size");
                fields(output,{@"width",@"height"});
                const auto dimension=[&](NSString *key){id value=output[key];if(!value)return 0u;const double n=number(value)?[value doubleValue]:0;
                    if(n<1||n>16384||std::floor(n)!=n)throw std::runtime_error("Effect output dimensions must be whole pixels from 1 to 16384");return unsigned(n);};
                node.outputWidth=dimension(@"width");node.outputHeight=dimension(@"height");
                if((!node.outputWidth||!node.outputHeight)&&(node.method!="downsample"||(!node.outputWidth&&!node.outputHeight)))
                    throw std::runtime_error("A spatial output size needs both dimensions; downsampling also accepts one dimension");
            }
            if(row[@"modelPath"]){node.modelPath=text(row[@"modelPath"]);if(node.modelPath.empty()||node.modelPath.front()!='/')throw std::runtime_error("Effect plan model needs a prepared absolute path");}
            id settings=row[@"settings"];if(![settings isKindOfClass:NSDictionary.class]||[settings count]>128)throw std::runtime_error("Effect plan graphics settings are invalid");
            for(id key in settings){const auto name=text(key,128);id item=settings[key];
                if(item==NSNull.null)node.settings.values[name]=std::monostate{};
                else if(boolean(item))node.settings.values[name]=bool([item boolValue]);
                else if(number(item))node.settings.values[name]=double([item doubleValue]);
                else if([item isKindOfClass:NSString.class])node.settings.values[name]=text(item);
                else throw std::runtime_error("Effect plan graphics settings must be scalar values");
            }
            if(node.kind=="neural"){
                if(node.method!="mlx-dlss"||node.modelPath.empty())throw std::runtime_error("Choose a prepared neural-rendering model");
                if(id temporal=settings[@"temporal"];temporal&&!boolean(temporal))throw std::runtime_error("Neural temporal mode must be boolean");
                if(generated&&[settings[@"temporal"] boolValue])throw std::runtime_error("Temporal neural rendering must precede frame generation");
                if(id intensity=settings[@"intensity"];intensity&&(!number(intensity)||[intensity doubleValue]<0||[intensity doubleValue]>2))throw std::runtime_error("Neural intensity must be from 0 to 2");
                if(node.requirements.depth||node.requirements.motion)throw std::runtime_error("Neural rendering does not consume game scene inputs");
            }
        }
        if(node.kind=="frame-generation")generated=true;
        plan->nodes.push_back(std::move(node));
    }
    return plan;
}
std::string sourceIdentity(const EffectPlanNode &node){const auto &s=node.shader.selection;return node.format+'\0'+s.file+'\0'+s.key+'\0'+s.revision+'\0'+s.technique;}
struct Stamp {dev_t dev{};ino_t ino{};off_t size{};timespec modified{},changed{};
    bool operator==(const Stamp &other)const{return dev==other.dev&&ino==other.ino&&size==other.size&&modified.tv_sec==other.modified.tv_sec&&modified.tv_nsec==other.modified.tv_nsec&&changed.tv_sec==other.changed.tv_sec&&changed.tv_nsec==other.changed.tv_nsec;}};
Stamp stamp(const struct stat &s){return {s.st_dev,s.st_ino,s.st_size,s.st_mtimespec,s.st_ctimespec};}
}
EffectPlanSize spatialOutputSize(const EffectPlanNode &node,EffectPlanSize input,EffectPlanSize presentation){
    const auto checked=[&](double width,double height){
        if(node.method=="downsample"){width=std::min(width,double(input.width));height=std::min(height,double(input.height));}
        if(!std::isfinite(width)||!std::isfinite(height)||width<1||height<1||width>16384||height>16384)
            throw std::runtime_error("Effect output dimensions must be from 1 to 16384 pixels");
        return EffectPlanSize{unsigned(std::ceil(width)),unsigned(std::ceil(height))};
    };
    if(node.outputWidth&&node.outputHeight)return checked(node.outputWidth,node.outputHeight);
    if(node.outputWidth||node.outputHeight){
        if(node.method!="downsample")throw std::runtime_error("A spatial output size needs both dimensions");
        if(node.outputHeight){const double height=std::min(input.height,node.outputHeight);return checked(double(input.width)*height/input.height,height);}
        const double width=std::min(input.width,node.outputWidth);return checked(width,double(input.height)*width/input.width);
    }
    if(node.presentationScale||node.resolutionAuto){
        if(!input.width||!input.height||!presentation.width||!presentation.height||(!node.resolutionAuto&&(!std::isfinite(node.presentationScale)||node.presentationScale<1.0/16||node.presentationScale>16)))
            throw std::runtime_error("Spatial presentation scale requires valid image dimensions");
        // Use this frame's fitted physical drawable, including letterboxing,
        // Retina backing scale and window/fullscreen changes. A smaller source
        // is already at its target and must never be reduced a second time.
        if(node.resolutionAuto){
            const auto target=automaticResolutionTarget(presentation.width,presentation.height,input.width,input.height);
            return checked(target.width,target.height);
        }
        const double fit=std::min(double(presentation.width)/input.width,double(presentation.height)/input.height);
        double scale=fit*node.presentationScale;
        if(node.method=="downsample")scale=std::min(1.0,scale);
        return checked(std::max(1.0,double(input.width)*scale),std::max(1.0,double(input.height)*scale));
    }
    const auto found=node.settings.values.find("spatialMultiplier");
    if(found==node.settings.values.end()||std::holds_alternative<std::monostate>(found->second))return node.method=="downsample"?checked(double(input.width)/2,double(input.height)/2):checked(presentation.width,presentation.height);
    const auto factor=std::get_if<double>(&found->second);
    if(!factor||(*factor!=.25&&*factor!=.5&&*factor!=2.0/3&&*factor!=1&&*factor!=1.5&&*factor!=2&&*factor!=3&&*factor!=4))throw std::runtime_error("Unsupported spatial stage scale");
    return checked(double(input.width)* *factor,double(input.height)* *factor);
}
struct EffectPlanState::Impl {
    mutable std::mutex lock;
    std::shared_ptr<const EffectPlanSnapshot> current;
    struct Instance {std::string source;ShaderParameters parameters;std::shared_ptr<ShaderNode> shader;};
    std::map<std::string,Instance> instances;
    std::string path,failure;std::optional<Stamp> checked;
    std::chrono::steady_clock::time_point next{};
};
EffectPlanState::EffectPlanState():impl(std::make_unique<Impl>()){}
EffectPlanState::~EffectPlanState()=default;
bool effectPlanRequested()noexcept{const auto path=std::getenv("RESHADE_EFFECT_PLAN");return path&&*path;}
EffectPlanPoll EffectPlanState::poll(){return poll(false);}
EffectPlanPoll EffectPlanState::poll(bool force){ @autoreleasepool {
    std::lock_guard<std::mutex> guard(impl->lock);const auto now=std::chrono::steady_clock::now();
    if(!force&&now<impl->next)return {impl->current&&impl->current->mode=="advanced",false,impl->failure,bool(impl->current)};impl->next=now+std::chrono::milliseconds(100);
    const auto environment=std::getenv("RESHADE_EFFECT_PLAN");const std::string file=environment?environment:"";
    if(file.empty()){const bool changed=bool(impl->current);impl->current.reset();impl->instances.clear();impl->checked.reset();impl->path.clear();impl->failure.clear();return {false,changed,{},false};}
    if(file!=impl->path){impl->path=file;impl->checked.reset();}
    int fd=-1;try{
        if(file.front()!='/')throw std::runtime_error("Effect plan needs an absolute path");
        fd=open(file.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)throw std::runtime_error("Effect plan is unavailable");
        struct stat before{},after{},named{};if(fstat(fd,&before)||!S_ISREG(before.st_mode)||before.st_size<1||before.st_size>maximumBytes)throw std::runtime_error("Effect plan file is invalid");
        const auto identity=stamp(before);if(impl->checked&&*impl->checked==identity){close(fd);return {impl->current&&impl->current->mode=="advanced",false,impl->failure,bool(impl->current)};}
        impl->checked=identity;std::vector<unsigned char> bytes(before.st_size);size_t offset=0;
        while(offset<bytes.size()){const auto n=read(fd,bytes.data()+offset,bytes.size()-offset);if(n<0&&errno==EINTR)continue;if(n<=0)throw std::runtime_error("Effect plan read did not complete");offset+=n;}
        if(fstat(fd,&after)||lstat(file.c_str(),&named)||!(stamp(after)==identity)||!(stamp(named)==identity))throw std::runtime_error("Effect plan changed while reading");
        close(fd);fd=-1;auto selected=parse([NSData dataWithBytes:bytes.data() length:bytes.size()]);
        for(auto it=impl->instances.begin();it!=impl->instances.end();){
            const auto found=std::find_if(selected->nodes.begin(),selected->nodes.end(),[&](const auto &node){return node.id==it->first&&node.kind=="shader"&&sourceIdentity(node)==it->second.source;});
            if(found==selected->nodes.end())it=impl->instances.erase(it);else ++it;
        }
        impl->current=std::move(selected);impl->failure.clear();return {impl->current->mode=="advanced",true,{},true};
    }catch(const std::exception &error){if(fd>=0)close(fd);impl->failure=error.what();return {impl->current&&impl->current->mode=="advanced",false,impl->failure,bool(impl->current)};}
}}
namespace {
std::atomic<uint64_t> demandGeneration{0};
std::mutex demandIdentityMutex;
std::string demandRevision,demandMode;
unsigned demandMetadata()noexcept{ @autoreleasepool {
    static std::atomic<unsigned> previous{0};
    try{
        // AppKit can invoke hooked layer methods after C++ static destructors
        // run. This process-wide metadata reader must remain available then;
        // ordinary per-owner states still release their GPU nodes normally.
        static auto *const state=new EffectPlanState;
        const bool changed=state->poll().changed;
        const auto selected=state->snapshot();
        if(changed){std::lock_guard<std::mutex> identity(demandIdentityMutex);
            const std::string revision=selected?selected->revision:"",mode=selected?selected->mode:"";
            if(revision!=demandRevision||mode!=demandMode){demandRevision=revision;demandMode=mode;demandGeneration.fetch_add(1,std::memory_order_relaxed);}}
        const unsigned mode=!selected||selected->mode!="advanced"?0:std::any_of(selected->nodes.begin(),selected->nodes.end(),[](const auto &node){return node.enabled;})?1:2;
        const bool fxOnly=mode==1&&effectPlanNativeFxOnly(*selected);
        const unsigned value=mode|(fxOnly?4:0);previous.store(value,std::memory_order_relaxed);return value;
    }catch(...){return previous.load(std::memory_order_relaxed);}
}}
}
int effectPlanMode()noexcept{return demandMetadata()&3;}
uint64_t effectPlanDemandGeneration()noexcept{demandMetadata();return demandGeneration.load(std::memory_order_relaxed);}
bool effectPlanNativeFxOnly()noexcept{return demandMetadata()&4;}
bool effectPlanNativeFxOnly(const EffectPlanSnapshot &selected)noexcept{
    return selected.mode=="advanced"&&std::any_of(selected.nodes.begin(),selected.nodes.end(),[](const auto &node){return node.enabled;})&&
        std::all_of(selected.nodes.begin(),selected.nodes.end(),[](const auto &node){
            return !node.enabled||(node.kind=="shader"&&node.format=="fx"&&!node.requirements.depth&&!node.requirements.motion&&
                !node.outputPresentation&&node.outputScaleX==1&&node.outputScaleY==1);
        });
}
std::shared_ptr<const EffectPlanSnapshot> EffectPlanState::snapshot()const{std::lock_guard<std::mutex> guard(impl->lock);return impl->current;}
std::string EffectPlanState::error()const{std::lock_guard<std::mutex> guard(impl->lock);return impl->failure;}
std::shared_ptr<ShaderNode> EffectPlanState::shader(const EffectPlanNode &node,const Factory &factory){
    if(node.kind!="shader"||!node.enabled)throw std::runtime_error("Effect plan row is not an enabled shader");
    std::lock_guard<std::mutex> guard(impl->lock);auto &instance=impl->instances[node.id];const auto source=sourceIdentity(node);
    if(!instance.shader||instance.source!=source){auto value=factory?factory(node):makeShaderNode(node.shader);if(!value)throw std::runtime_error("Effect plan shader is unavailable");instance={source,node.shader.parameters,std::move(value)};}
    else if(instance.parameters!=node.shader.parameters){instance.shader->setParameters(node.shader.parameters);instance.parameters=node.shader.parameters;}
    return instance.shader;
}
std::string EffectPlanSettings::string(const std::string &key,std::string fallback)const{const auto it=values.find(key);return it!=values.end()&&std::holds_alternative<std::string>(it->second)?std::get<std::string>(it->second):fallback;}
double EffectPlanSettings::number(const std::string &key,double fallback)const{const auto it=values.find(key);return it!=values.end()&&std::holds_alternative<double>(it->second)?std::get<double>(it->second):fallback;}
bool EffectPlanSettings::boolean(const std::string &key,bool fallback)const{const auto it=values.find(key);return it!=values.end()&&std::holds_alternative<bool>(it->second)?std::get<bool>(it->second):fallback;}
}
