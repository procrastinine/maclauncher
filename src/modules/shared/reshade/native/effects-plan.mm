// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#include "effects-plan.hpp"
#include "native-config.hpp"
#include "log.hpp"
#include "path-watch.hpp"
#include "scene-frame.h"
#include <dispatch/dispatch.h>
#include "shader-scene-roles.h"
#include "scene-aovs.hpp"
#include <regex>
#include "automatic-resolution.hpp"
#include "generation-methods.hpp"
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <fcntl.h>
#include <limits>
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
bool sceneResourceName(const std::string&name){if(name.empty()||name.size()>512||name=="__proto__"||name=="constructor"||name=="prototype")return false;const auto letter=[](char c){return c=='_'||(c>='a'&&c<='z')||(c>='A'&&c<='Z');};size_t i=0;for(;;){if(i>=name.size()||!letter(name[i++]))return false;while(i<name.size()&&(letter(name[i])||(name[i]>='0'&&name[i]<='9')))++i;if(i==name.size())return true;if(i+1>=name.size()||name[i]!=':'||name[i+1]!=':')return false;i+=2;}}
void parseOutput(id output,OutputPolicy &policy){
    fields(output,{@"motionClarity",@"subframes",@"duty",@"brightness",@"framePacing",@"targetFps",@"smoothCadence",@"comparison",@"adaptiveQuality",@"toneMapping"});
    if(output[@"toneMapping"]){
        policy.toneMapping=text(output[@"toneMapping"],16);
        if(policy.toneMapping!="auto"&&policy.toneMapping!="preserve"&&policy.toneMapping!="reinhard"&&policy.toneMapping!="pbr-neutral")throw std::runtime_error("Output tone mapping mode is invalid");
    }
    if(output[@"motionClarity"]){
        policy.motionClarity=text(output[@"motionClarity"],16);
        if(policy.motionClarity!="off"&&policy.motionClarity!="bfi"&&policy.motionClarity!="beam")throw std::runtime_error("Output motion clarity mode is invalid");
        for(NSString*key in @[@"subframes",@"duty",@"brightness"])if(!number(output[key]))throw std::runtime_error("Output subframe settings must be finite");
        const auto count=[output[@"subframes"] doubleValue],duty=[output[@"duty"] doubleValue],brightness=[output[@"brightness"] doubleValue];
        if(count<2||count>8||std::floor(count)!=count||duty<.125||duty>1||brightness<1||brightness>8)throw std::runtime_error("Output subframe settings exceed the supported bounds");
        policy.subframes=unsigned(count);policy.duty=duty;policy.brightness=brightness;
    }else if(output[@"subframes"]||output[@"duty"]||output[@"brightness"])throw std::runtime_error("Output motion clarity mode is required for subframe settings");
    if(id quality=output[@"adaptiveQuality"]){
        fields(quality,{@"enabled",@"nodeId",@"budgetMs",@"minScale",@"maxScale"});
        auto&adaptive=policy.adaptiveQuality;adaptive.enabled=flag(quality,@"enabled");adaptive.nodeId=text(quality[@"nodeId"],128);if(!std::regex_match(adaptive.nodeId,std::regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"))||adaptive.nodeId.find("..")!=std::string::npos)throw std::runtime_error("Adaptive quality target identity is invalid");
        for(NSString*key in @[@"budgetMs",@"minScale",@"maxScale"])if(!number(quality[key]))throw std::runtime_error("Adaptive quality settings must be finite");
        adaptive.budgetMs=[quality[@"budgetMs"] doubleValue];adaptive.minScale=[quality[@"minScale"] doubleValue];adaptive.maxScale=[quality[@"maxScale"] doubleValue];
        if(adaptive.budgetMs<.25||adaptive.budgetMs>1000||adaptive.minScale<1./16||adaptive.maxScale>1||adaptive.minScale>adaptive.maxScale)throw std::runtime_error("Adaptive quality settings exceed their selected bounds");
    }
    if(id comparison=output[@"comparison"]){
        fields(comparison,{@"mode",@"position",@"gain"});policy.comparison.mode=text(comparison[@"mode"],16);
        if(policy.comparison.mode!="off"&&policy.comparison.mode!="before"&&policy.comparison.mode!="wipe"&&policy.comparison.mode!="difference")throw std::runtime_error("Output comparison mode is invalid");
        if(!number(comparison[@"position"])||!number(comparison[@"gain"]))throw std::runtime_error("Output comparison settings must be finite");
        const double position=[comparison[@"position"] doubleValue],gain=[comparison[@"gain"] doubleValue];
        if(position<0||position>1||gain<1||gain>16)throw std::runtime_error("Output comparison position or gain exceeds its supported bounds");
        policy.comparison.position=position;policy.comparison.gain=gain;
    }
    if(output[@"framePacing"]){
        policy.framePacing=text(output[@"framePacing"],16);
        if(policy.framePacing!="fixed"&&policy.framePacing!="adaptive")throw std::runtime_error("Output frame pacing mode is invalid");
        const double target=number(output[@"targetFps"])?[output[@"targetFps"] doubleValue]:0;
        if(target<30||target>240||std::floor(target)!=target||!boolean(output[@"smoothCadence"]))throw std::runtime_error("Output frame pacing settings are invalid");
        policy.targetFps=unsigned(target);policy.smoothCadence=flag(output,@"smoothCadence");policy.hasPacing=true;
    }else if(output[@"targetFps"]||output[@"smoothCadence"])throw std::runtime_error("Output frame pacing mode is required");
}
// One row. The caller turns an exception into a bypassed row; identities that
// were reserved before the failure stay reserved.
void parseRow(id value,EffectPlanNode &node,std::set<std::string> &ids){
    if(![value isKindOfClass:NSDictionary.class])throw std::runtime_error("Effect plan rows are invalid");NSDictionary *row=value;
    if([row[@"id"] isKindOfClass:NSString.class])node.id=text(row[@"id"],128);if([row[@"kind"] isKindOfClass:NSString.class])node.kind=text(row[@"kind"],32);
    if(!safeId(node.id)||!ids.insert(node.id).second){node.id.clear();throw std::runtime_error("Effect plan row identities are invalid");}
    if(!boolean(row[@"enabled"]))throw std::runtime_error("Effect plan row identities are invalid");
    if(node.kind!="shader"&&node.kind!="spatial"&&node.kind!="temporal"&&node.kind!="frame-generation"&&node.kind!="neural")throw std::runtime_error("Effect plan row kind is invalid");
    node.enabled=[row[@"enabled"] boolValue];node.preservesCoordinates=flag(row,@"preservesCoordinates");
    if(row[@"gpuWorkScope"]){node.gpuWorkScope=text(row[@"gpuWorkScope"],32);if(node.gpuWorkScope!="caller-command-buffer"&&node.gpuWorkScope!="external-queues")throw std::runtime_error("Effect GPU work scope is invalid");}
    if(id requirements=row[@"requirements"]){fields(requirements,{@"depth",@"motion",@"camera",@"viewMatrix",@"projectionMatrix",@"sceneAovs",@"noisyColor",@"exposure"});node.requirements={flag(requirements,@"depth"),flag(requirements,@"motion"),flag(requirements,@"camera"),flag(requirements,@"viewMatrix"),flag(requirements,@"projectionMatrix")};node.requirements.noisyColor=flag(requirements,@"noisyColor");node.requirements.exposure=flag(requirements,@"exposure");
        if(id aovs=requirements[@"sceneAovs"]){if(![aovs isKindOfClass:NSArray.class]||[aovs count]>RS_SCENE_AOV_COUNT)throw std::runtime_error("Scene attachment requirements are invalid");for(id name in aovs){const auto value=text(name,32);const auto slot=std::find(sceneAovNames.begin(),sceneAovNames.end(),value);if(slot==sceneAovNames.end())throw std::runtime_error("The scene attachment requirement is unknown");const auto bit=uint32_t(1)<<std::distance(sceneAovNames.begin(),slot);if(node.requirements.sceneAovs&bit)throw std::runtime_error("Scene attachment requirements must be unique");node.requirements.sceneAovs|=bit;}}
    }
    if(node.kind=="shader"){
        fields(row,{@"id",@"kind",@"enabled",@"format",@"file",@"key",@"revision",@"technique",@"parameters",@"requirements",@"preservesCoordinates",@"gpuWorkScope",@"inputPolicy",@"outputScale",@"outputExtent",@"outputSize",@"presentationScale",@"resolutionAuto",@"resizeDirection",@"planeGroupMembers",@"displaySubframes",@"modelPath",@"modelOperation",@"sceneBindings",@"sceneHistory"});
        if(id policy=row[@"inputPolicy"]){node.inputPolicy=text(policy,32);if(node.inputPolicy!="source"&&node.inputPolicy!="srgb-sdr"&&node.inputPolicy!="linear-source")throw std::runtime_error("Shader input color policy is invalid");}
        if(id history=row[@"sceneHistory"]){if(text(history,16)!="real")throw std::runtime_error("Shader history policy is invalid");node.realHistory=true;}
        if(id bindings=row[@"sceneBindings"]){if(![bindings isKindOfClass:NSDictionary.class]||[bindings count]>128)throw std::runtime_error("Shader scene bindings are invalid");for(id key in bindings){const auto name=text(key,512),role=text(bindings[key],32);if(!sceneResourceName(name))throw std::runtime_error("Shader scene resource name is invalid");unsigned index=0;while(index<RS_SHADER_SCENE_ROLE_COUNT&&role!=rsShaderSceneRoleNames[index])++index;if(index==RS_SHADER_SCENE_ROLE_COUNT)throw std::runtime_error("Shader scene role is unknown");node.sceneBindings.emplace(name,index);if(index<RS_SCENE_AOV_COUNT)node.requirements.sceneAovs|=1u<<index;else if(index==RS_SHADER_SCENE_DEPTH)node.requirements.depth=true;else if(index==RS_SHADER_SCENE_MOTION)node.requirements.motion=true;else if(index==RS_SHADER_SCENE_EXPOSURE)node.requirements.exposure=true;else if(index==RS_SHADER_SCENE_VIEW_MATRIX)node.requirements.viewMatrix=true;else node.requirements.projectionMatrix=true;}}
        node.displaySubframes=flag(row,@"displaySubframes");
        if(!node.enabled)return;
        node.format=text(row[@"format"],32);if(node.format!="fx"&&node.format!="slangp"&&node.format!="libplacebo"&&node.format!="isf"&&node.format!="magpie"&&node.format!="native")throw std::runtime_error("Effect plan shader format is invalid");
        if(row[@"modelOperation"]||row[@"modelPath"]){node.modelOperation=text(row[@"modelOperation"],64);node.modelPath=text(row[@"modelPath"]);if(node.format!="native"||node.modelOperation!="depth-anything-v2-small"||node.modelPath.empty()||node.modelPath.front()!='/')throw std::runtime_error("Choose a prepared model for this native image operation");}
        if(id members=row[@"planeGroupMembers"]){
            if(node.format!="libplacebo"||![members isKindOfClass:NSArray.class]||[members count]<2||[members count]>maximumNodes)throw std::runtime_error("Plane group members are invalid");
            for(id member in members){auto name=text(member,128);if(!safeId(name)||std::find(node.planeGroupMembers.begin(),node.planeGroupMembers.end(),name)!=node.planeGroupMembers.end()||(!node.planeGroupMembers.empty()&&!ids.insert(name).second))throw std::runtime_error("Plane group identities are invalid");node.planeGroupMembers.push_back(name);}
            if(node.planeGroupMembers.front()!=node.id)throw std::runtime_error("Plane group must retain its first logical identity");
        }
        node.shader.selection.file=text(row[@"file"]);if(node.shader.selection.file.empty()||node.shader.selection.file.front()!='/')throw std::runtime_error("Effect plan shader needs a prepared absolute path");
        node.shader.selection.key=hash(row[@"key"]);node.shader.selection.revision=hash(row[@"revision"]);
        if(row[@"technique"])node.shader.selection.technique=text(row[@"technique"],128);
        node.shader.parameters=parameters(row[@"parameters"]?:@{});
        if(id direction=row[@"resizeDirection"]){node.resizeDirection=text(direction,16);if(node.resizeDirection!="downsample"&&node.resizeDirection!="upscale")throw std::runtime_error("Shader resize direction is invalid");}
        if(id output=row[@"outputSize"]){
            fields(output,{@"width",@"height"});
            const auto dimension=[&](NSString *key){id value=output[key];if(!value)return 0u;const double n=number(value)?[value doubleValue]:0;if(n<1||n>16384||std::floor(n)!=n)throw std::runtime_error("Shader output dimensions must be whole pixels from 1 to 16384");return unsigned(n);};
            node.outputWidth=dimension(@"width");node.outputHeight=dimension(@"height");
            if(!node.outputWidth&&!node.outputHeight)throw std::runtime_error("Choose a shader output width or height");
        }
        if(id scale=row[@"presentationScale"]){if(!number(scale)||[scale doubleValue]<1.0/16||[scale doubleValue]>16)throw std::runtime_error("Shader presentation scale must be from 1/16 to 16");node.presentationScale=[scale doubleValue];}
        if(row[@"resolutionAuto"]){if(!flag(row,@"resolutionAuto")||row[@"outputSize"]||row[@"presentationScale"])throw std::runtime_error("Automatic shader sizing cannot include an explicit output size");node.resolutionAuto=true;node.resizeDirection="downsample";}
        if(id extent=row[@"outputExtent"]){if(text(extent,32)!="presentation")throw std::runtime_error("Shader output extent must be presentation");node.outputPresentation=true;}
        if(id scale=row[@"outputScale"]){
            fields(scale,{@"x",@"y"});
            const auto factor=[&](NSString *key){id value=scale[key];const double n=number(value)?[value doubleValue]:0;
                if(n<1.0/16||n>16)throw std::runtime_error("Shader output scale must be from 1/16 to 16 per dimension");return n;};
            node.outputScaleX=factor(@"x");node.outputScaleY=factor(@"y");
        }
    }else{
        fields(row,{@"id",@"kind",@"enabled",@"method",@"settings",@"modelPath",@"requirements",@"preservesCoordinates",@"gpuWorkScope",@"outputSize",@"presentationScale",@"resolutionAuto",@"resizeDirection",@"intrinsicScale"});
        if(!node.enabled)return;
        if(node.kind!="spatial"&&node.kind!="temporal"&&node.kind!="frame-generation"&&node.kind!="neural")throw std::runtime_error("Effect plan row kind is invalid");
        node.method=text(row[@"method"],80);if(node.method.empty()||node.method.front()<'a'||node.method.front()>'z'||node.method.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789:._-")!=std::string::npos||node.method=="off"||(node.kind=="frame-generation"&&!generationMethodInfo(node.method)))throw std::runtime_error("Effect plan method is invalid");
        if(id direction=row[@"resizeDirection"]){
            node.resizeDirection=text(direction,16);
            if(node.kind!="spatial"||(node.resizeDirection!="downsample"&&node.resizeDirection!="upscale"))throw std::runtime_error("Effect resize direction is invalid");
        }
        if(id scale=row[@"intrinsicScale"]){
            if(node.kind!="neural"||!number(scale)||[scale doubleValue]<1||[scale doubleValue]>4)throw std::runtime_error("Neural output scale is invalid");
            node.intrinsicScale=[scale doubleValue];
        }
        if(row[@"resolutionAuto"]){
            if(node.kind!="spatial"||(node.method!="downsample"&&node.resizeDirection!="downsample")||!flag(row,@"resolutionAuto")||row[@"outputSize"])
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
            if(!node.outputWidth&&!node.outputHeight)
                throw std::runtime_error("A spatial output size needs a width or height");
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
            if((node.method!="mlx-dlss"&&node.method!="mlx-vsr"&&node.method!="mlx-sr-image"&&node.method!="realesrgan"&&node.method!="realcugan"&&node.method!="nafnet")||node.modelPath.empty())throw std::runtime_error("Choose a prepared neural model");
            const double expectedScale=node.method=="mlx-dlss"||node.method=="nafnet"?1:node.method=="realesrgan"?4:2;
            if(node.method=="realcugan"?(node.intrinsicScale!=2&&node.intrinsicScale!=3&&node.intrinsicScale!=4):node.intrinsicScale!=expectedScale)throw std::runtime_error("The neural output scale does not match its operation");
            if(id temporal=settings[@"temporal"];temporal&&!boolean(temporal))throw std::runtime_error("Neural temporal mode must be boolean");
            if(id intensity=settings[@"intensity"];intensity&&(!number(intensity)||[intensity doubleValue]<0||[intensity doubleValue]>2))throw std::runtime_error("Neural intensity must be from 0 to 2");
            if(node.requirements.depth||node.requirements.motion)throw std::runtime_error("Neural rendering does not consume game scene inputs");
        }
    }
}
// Only an unreadable document, a broken envelope or a newer schema rejects the
// whole publication. An invalid output block or row is bypassed on its own.
std::shared_ptr<EffectPlanSnapshot> parse(NSData *data){
    NSError *error=nil;id raw=[NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if(!raw||error)throw std::runtime_error("Effect plan JSON is invalid");
    if(![raw isKindOfClass:NSDictionary.class])throw std::runtime_error("Effect plan objects are invalid");NSDictionary *root=raw;
    if(number(root[@"schema"])&&[root[@"schema"] doubleValue]>1)throw std::runtime_error("This effect plan uses a newer schema than this graphics runtime reads");
    fields(raw,{@"schema",@"mode",@"revision",@"nodes",@"output"});
    if(!number(root[@"schema"])||[root[@"schema"] doubleValue]!=1||![root[@"nodes"] isKindOfClass:NSArray.class]||[root[@"nodes"] count]>maximumNodes)
        throw std::runtime_error("Effect plan schema is invalid");
    auto plan=std::make_shared<EffectPlanSnapshot>();plan->revision=hash(root[@"revision"]);plan->mode=text(root[@"mode"],16);
    if((plan->mode!="advanced"&&plan->mode!="simple")||(plan->mode=="simple"&&[root[@"nodes"] count]))throw std::runtime_error("Effect plan mode is invalid");
    if(id output=root[@"output"])try{parseOutput(output,plan->output);}catch(const std::exception &failure){plan->output={};plan->outputRejection=failure.what();}
    std::set<std::string> ids;size_t index=0;
    for(id value in root[@"nodes"]){
        ++index;EffectPlanNode node;
        try{parseRow(value,node,ids);}
        catch(const std::exception &failure){
            EffectPlanNode rejected;rejected.enabled=false;rejected.rejection=failure.what();
            rejected.id=node.id.empty()?"row-"+std::to_string(index):node.id;
            if(node.kind=="shader"||node.kind=="spatial"||node.kind=="temporal"||node.kind=="frame-generation"||node.kind=="neural")rejected.kind=node.kind;
            rejected.method=node.method;rejected.format=node.format;node=std::move(rejected);
        }
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
        if(!std::isfinite(node.workingScale)||node.workingScale<=0||node.workingScale>1)throw std::runtime_error("Adaptive working scale is invalid");
        width=std::max(1.,width*node.workingScale);height=std::max(1.,height*node.workingScale);
        if(!std::isfinite(width)||!std::isfinite(height)||width<1||height<1||width>16384||height>16384)
            throw std::runtime_error("Effect output dimensions must be from 1 to 16384 pixels");
        if(node.method=="downsample"||node.resizeDirection=="downsample"){width=std::min(width,double(input.width));height=std::min(height,double(input.height));}
        if(node.resizeDirection=="upscale"){width=std::max(width,double(input.width));height=std::max(height,double(input.height));}
        return EffectPlanSize{unsigned(std::ceil(width)),unsigned(std::ceil(height))};
    };
    if(node.outputWidth&&node.outputHeight)return checked(node.outputWidth,node.outputHeight);
    if(node.outputWidth||node.outputHeight){
        if(node.outputHeight){const double height=node.outputHeight;return checked(double(input.width)*height/input.height,height);}
        const double width=node.outputWidth;return checked(width,double(input.height)*width/input.width);
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
        if(node.method=="downsample"||node.resizeDirection=="downsample")scale=std::min(1.0,scale);
        return checked(std::max(1.0,double(input.width)*scale),std::max(1.0,double(input.height)*scale));
    }
    const auto found=node.settings.values.find("spatialMultiplier");
    if(found==node.settings.values.end()||std::holds_alternative<std::monostate>(found->second))return node.method=="downsample"||node.resizeDirection=="downsample"?checked(double(input.width)/2,double(input.height)/2):checked(presentation.width,presentation.height);
    const auto factor=std::get_if<double>(&found->second);
    if(!factor||!std::isfinite(*factor)||*factor<1.0/16||*factor>16)throw std::runtime_error("Unsupported spatial stage scale");
    return checked(double(input.width)* *factor,double(input.height)* *factor);
}
namespace {
// One publication of the process reader: the accepted plan and the latest read error.
struct Publication {uint64_t generation=0;std::shared_ptr<const EffectPlanSnapshot> plan;std::string error;};
// The process plan reader exists only when the launch configuration names a
// plan file. It is never destroyed: AppKit hooks can query it during static
// destruction. File reads, parsing and demand derivation run on its serial
// queue; consumers load atomics or copy the publication pointer.
class PlanReader {
public:
    static PlanReader *instance() noexcept;
    // generation counts publications (plan or error); planGeneration counts plan
    // identities (revision or mode). demand packs the flags and the AOV mask.
    std::atomic<uint64_t> generation{0},demand{0},planGeneration{0},bypassEpoch{0};
    std::atomic<uint32_t> sceneFrame{0};
    // The last open of the plan path was refused by policy (EPERM or EACCES),
    // as in a Chromium helper after its sandbox engages. It clears once a read
    // succeeds again.
    std::atomic<bool> denied{false};
    std::shared_ptr<const Publication> publication()const{std::lock_guard<std::mutex> guard(mutex);return current;}
    bool bypassRevision(std::string &revision)const{std::lock_guard<std::mutex> guard(mutex);revision=bypass;return !revision.empty();}
    void refresh(){dispatch_sync_f(queue,this,[](void *self){static_cast<PlanReader*>(self)->read();});}
private:
    explicit PlanReader(std::string file):path(std::move(file)){}
    void start();
    void read();
    void watchFile();
    void armDirectory();
    void retry();
    void opened(int error);
    void publish(std::shared_ptr<const EffectPlanSnapshot> plan,std::string error);
    const std::string path;std::string directory;
    dispatch_queue_t queue=nil;dispatch_source_t directorySource=nil,fileSource=nil,timer=nil;
    dev_t watchedDevice=0;ino_t watchedInode=0;
    // checked is the last file read in full, and checkedError its parse result.
    std::optional<Stamp> checked;std::string checkedError;
    RetryBackoff backoff;bool retrying=false;int openError=0;
    mutable std::mutex mutex;std::shared_ptr<const Publication> current=std::make_shared<Publication>();std::string bypass;
};
std::atomic<PlanReader*> readerInstance{nullptr};
std::atomic<bool> readerResolved{false};
PlanReader *PlanReader::instance() noexcept {
    if(const auto reader=readerInstance.load(std::memory_order_acquire))return reader;
    if(readerResolved.load(std::memory_order_acquire))return nullptr;
    static auto *const startup=new std::mutex;
    try{
        std::lock_guard<std::mutex> guard(*startup);
        if(!readerResolved.load(std::memory_order_acquire)){
            const auto &file=nativeConfig().effectPlanFile;
            if(file&&!file->empty()){auto *reader=new PlanReader(*file);reader->start();readerInstance.store(reader,std::memory_order_release);}
            readerResolved.store(true,std::memory_order_release);
        }
        return readerInstance.load(std::memory_order_acquire);
    }catch(...){return nullptr;}
}
void PlanReader::start(){
    queue=dispatch_queue_create("com.maclauncher.graphics.plan-reader",dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL,QOS_CLASS_USER_INITIATED,0));
    // The first consumer waits for the launch plan, as a frame did before.
    dispatch_sync(queue,^{
        // The launcher replaces the plan by rename(2) in its directory, which
        // the directory source observes; the file source sees in-place writes.
        const auto slash=path.rfind('/');
        directory=slash==std::string::npos?std::string{}:slash?path.substr(0,slash):std::string("/");
        // A safety tick covers missed events; without a directory source it is the only trigger.
        timer=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,queue);
        if(timer)dispatch_source_set_event_handler(timer,^{armDirectory();read();watchFile();});
        read();armDirectory();watchFile();
        if(timer)dispatch_resume(timer);
    });
}
// The directory source is armed again when its directory is replaced or could
// not be opened. The tick is slower while a source is armed.
void PlanReader::armDirectory(){
    if(directorySource)return;
    directorySource=watchDirectory(directory,queue,^(bool replaced){
        if(replaced&&directorySource){dispatch_source_cancel(directorySource);directorySource=nil;armDirectory();}
        read();watchFile();
    });
    if(!directorySource&&!directory.empty())retry();
    if(timer){
        const uint64_t interval=directorySource?2*NSEC_PER_SEC:100*NSEC_PER_MSEC;
        dispatch_source_set_timer(timer,dispatch_time(DISPATCH_TIME_NOW,int64_t(interval)),interval,directorySource?500*NSEC_PER_MSEC:10*NSEC_PER_MSEC);
    }
}
// Failed opens and an unarmed directory source retry after a bounded backoff,
// in addition to the tick; a failure is never final for the launch.
void PlanReader::retry(){
    if(retrying)return;retrying=true;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,int64_t(backoff.next())),queue,^{retrying=false;armDirectory();read();watchFile();});
}
void PlanReader::opened(int error){
    const bool refused=error==EPERM||error==EACCES;
    if(error!=openError){
        if(error)nativeLog("Effect plan read failed pid="+std::to_string(getpid())+": "+std::strerror(error)+(refused?"; this process cannot follow plan edits":""));
        else if(openError)nativeLog("Effect plan read recovered pid="+std::to_string(getpid()));
        openError=error;
    }
    denied.store(refused,std::memory_order_relaxed);
}
void PlanReader::watchFile(){
    struct stat named{};
    if(lstat(path.c_str(),&named)||!S_ISREG(named.st_mode)){if(fileSource){dispatch_source_cancel(fileSource);fileSource=nil;}return;}
    if(fileSource&&named.st_dev==watchedDevice&&named.st_ino==watchedInode)return;
    if(fileSource){dispatch_source_cancel(fileSource);fileSource=nil;}
    const int descriptor=open(path.c_str(),O_EVTONLY|O_NOFOLLOW|O_CLOEXEC);if(descriptor<0)return;
    fileSource=dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE,uintptr_t(descriptor),DISPATCH_VNODE_WRITE|DISPATCH_VNODE_EXTEND|DISPATCH_VNODE_ATTRIB|DISPATCH_VNODE_DELETE|DISPATCH_VNODE_RENAME|DISPATCH_VNODE_REVOKE,queue);
    if(!fileSource){close(descriptor);return;}
    dispatch_source_set_event_handler(fileSource,^{read();watchFile();});
    dispatch_source_set_cancel_handler(fileSource,^{close(descriptor);});
    watchedDevice=named.st_dev;watchedInode=named.st_ino;dispatch_resume(fileSource);
}
void PlanReader::read(){@autoreleasepool{
    int fd=-1;try{
        if(path.front()!='/')throw std::runtime_error("Effect plan needs an absolute path");
        fd=open(path.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);opened(fd<0?errno:0);if(fd<0)throw std::runtime_error("Effect plan is unavailable");
        struct stat before{},after{},named{};if(fstat(fd,&before)||!S_ISREG(before.st_mode)||before.st_size<1||before.st_size>off_t(maximumBytes))throw std::runtime_error("Effect plan file is invalid");
        // An unchanged file restores its own result; an earlier failed open
        // or interrupted read leaves no error behind.
        const auto identity=stamp(before);if(checked&&*checked==identity){close(fd);fd=-1;publish(nullptr,checkedError);if(checkedError.empty())backoff.reset();return;}
        std::vector<unsigned char> bytes(size_t(before.st_size));size_t offset=0;
        while(offset<bytes.size()){const auto n=::read(fd,bytes.data()+offset,bytes.size()-offset);if(n<0&&errno==EINTR)continue;if(n<=0)throw std::runtime_error("Effect plan read did not complete");offset+=size_t(n);}
        if(fstat(fd,&after)||lstat(path.c_str(),&named)||!(stamp(after)==identity)||!(stamp(named)==identity))throw std::runtime_error("Effect plan changed while reading");
        close(fd);fd=-1;checked=identity;
        std::shared_ptr<const EffectPlanSnapshot> plan;
        try{plan=parse([NSData dataWithBytes:bytes.data() length:bytes.size()]);}catch(const std::exception &failure){checkedError=failure.what();publish(nullptr,checkedError);return;}
        checkedError.clear();backoff.reset();publish(plan,{});
    }catch(const std::exception &failure){if(fd>=0)close(fd);publish(nullptr,failure.what());retry();}
}}
void PlanReader::publish(std::shared_ptr<const EffectPlanSnapshot> plan,std::string error){
    const auto previous=publication();
    // A rejected document keeps the last accepted plan and reports its error.
    if(!plan)plan=previous->plan;
    if(plan==previous->plan&&error==previous->error)return;
    auto next=std::make_shared<Publication>();next->generation=previous->generation+1;next->plan=plan;next->error=std::move(error);
    if(plan!=previous->plan){
        const auto value=effectPlanDemand(*plan);
        if(!plan->outputRejection.empty())nativeLog("Effect output settings bypassed: "+plan->outputRejection);
        for(const auto &node:plan->nodes)if(!node.rejection.empty())nativeLog("Effect row "+node.id+" bypassed: "+node.rejection);
        const bool identity=!previous->plan||previous->plan->revision!=plan->revision||previous->plan->mode!=plan->mode;
        demand.store(uint64_t(value.flags)|uint64_t(value.sceneAovs)<<32,std::memory_order_relaxed);sceneFrame.store(value.sceneFrame,std::memory_order_relaxed);
        std::lock_guard<std::mutex> guard(mutex);
        const bool bypassed=value.mode()==2;
        if(bypassed&&plan->revision!=bypass)bypassEpoch.fetch_add(1,std::memory_order_release);
        bypass=bypassed?plan->revision:std::string{};
        if(identity)planGeneration.fetch_add(1,std::memory_order_release);
        current=next;
    }else{std::lock_guard<std::mutex> guard(mutex);current=next;}
    generation.store(next->generation,std::memory_order_release);
}
}
PlanDemand effectPlanDemand(const EffectPlanSnapshot &plan) noexcept {
    PlanDemand demand;if(plan.mode!="advanced")return demand;
    const auto temporal=[](std::string_view method){
        uint32_t result=RS_SCENE_COLOR|RS_SCENE_DEPTH|RS_SCENE_MOTION|RS_SCENE_JITTER;
        if(method=="fsr2"||method=="fsr3"||method=="asr"||method=="sgsr2"||method=="metalfx-interpolation")result|=RS_SCENE_CAMERA;
        if(method=="metalfx-denoised")result|=RS_SCENE_VIEW_MATRIX|RS_SCENE_PROJECTION_MATRIX;
        return result;
    };
    bool any=false,neural=false,independent=true;
    for(const auto &node:plan.nodes){
        if(!node.enabled)continue;any=true;const auto &required=node.requirements;
        const bool sceneGeneration=node.kind=="frame-generation"&&generationRequiresScene(node.method);
        // Image frame sources (OpenGL default framebuffer, drawable and explicit
        // depth) supply depth without camera data or other guides. Only a row
        // that reads depth alone consumes it; a row that also needs projection
        // or guides receives depth with them from its renderer scene.
        const bool imageDepth=required.depth&&node.kind!="temporal"&&!sceneGeneration&&node.sceneBindings.empty()&&!required.motion&&!required.camera&&
            !required.viewMatrix&&!required.projectionMatrix&&!required.exposure&&!required.sceneAovs&&!required.noisyColor;
        if(imageDepth)demand.flags|=PlanDemandDepth;
        if(node.kind=="temporal"||sceneGeneration||required.scene())demand.flags|=PlanDemandTemporal;
        if(node.kind=="frame-generation")demand.flags|=PlanDemandGeneration|PlanDemandPresentationQueue;
        if(node.kind=="temporal"||node.kind=="frame-generation"||required.scene()||(node.kind=="neural"&&node.settings.boolean("temporal")))independent=false;
        neural|=node.kind=="neural";demand.sceneAovs|=required.sceneAovs;
        auto &scene=demand.sceneFrame;
        if(node.kind=="temporal")scene|=temporal(node.method);
        if(sceneGeneration){scene|=temporal(node.method=="metalfx"?"metalfx-interpolation":node.method);if(node.method=="xess")scene|=RS_SCENE_VIEW_MATRIX|RS_SCENE_PROJECTION_MATRIX;}
        if(required.depth)scene|=RS_SCENE_COLOR|RS_SCENE_DEPTH;
        if(required.motion)scene|=RS_SCENE_COLOR|RS_SCENE_MOTION;
        if(required.exposure)scene|=RS_SCENE_COLOR|RS_SCENE_EXPOSURE;
        if(required.camera)scene|=RS_SCENE_COLOR|RS_SCENE_CAMERA;
        if(required.viewMatrix)scene|=RS_SCENE_COLOR|RS_SCENE_VIEW_MATRIX;
        if(required.projectionMatrix)scene|=RS_SCENE_COLOR|RS_SCENE_PROJECTION_MATRIX;
        if(required.sceneAovs||required.noisyColor)scene|=RS_SCENE_COLOR;
    }
    if(plan.output.active())demand.flags|=PlanDemandPresentationQueue;
    if(plan.output.processing())demand.flags|=PlanDemandOutputPolicy;
    demand.flags|=any||plan.output.processing()?PlanDemandProcessing:PlanDemandPassThrough;
    if(neural&&independent)demand.flags|=PlanDemandIndependentImageQueue;
    if((demand.flags&PlanDemandProcessing)&&effectPlanNativeFxOnly(plan))demand.flags|=PlanDemandNativeFxOnly;
    return demand;
}
PlanDemand effectPlanDemand() noexcept {
    const auto reader=PlanReader::instance();if(!reader)return {};
    const auto packed=reader->demand.load(std::memory_order_relaxed);PlanDemand demand;
    demand.flags=uint32_t(packed);demand.sceneAovs=uint32_t(packed>>32);demand.sceneFrame=reader->sceneFrame.load(std::memory_order_relaxed);return demand;
}
bool effectPlanDemands(PlanDemandFlag flag) noexcept {const auto reader=PlanReader::instance();return reader&&(reader->demand.load(std::memory_order_relaxed)&flag);}
uint32_t effectPlanSceneAovDemand() noexcept {const auto reader=PlanReader::instance();return reader?uint32_t(reader->demand.load(std::memory_order_relaxed)>>32):0;}
uint32_t effectPlanSceneFrameDemand() noexcept {const auto reader=PlanReader::instance();return reader?reader->sceneFrame.load(std::memory_order_relaxed):0;}
void refreshEffectPlan() noexcept {if(const auto reader=PlanReader::instance())reader->refresh();}
bool effectPlanReadDenied() noexcept {const auto reader=PlanReader::instance();return reader&&reader->denied.load(std::memory_order_relaxed);}
std::shared_ptr<const EffectPlanSnapshot> currentEffectPlan() noexcept {const auto reader=PlanReader::instance();if(!reader)return nullptr;try{return reader->publication()->plan;}catch(...){return nullptr;}}
bool effectPlanRequested()noexcept{return nativeConfig().effectPlanRequested();}
int effectPlanMode()noexcept{const auto reader=PlanReader::instance();if(!reader)return 0;const auto flags=reader->demand.load(std::memory_order_relaxed);return flags&PlanDemandProcessing?1:flags&PlanDemandPassThrough?2:0;}
uint64_t effectPlanDemandGeneration()noexcept{const auto reader=PlanReader::instance();return reader?reader->planGeneration.load(std::memory_order_acquire):0;}
bool effectPlanNativeFxOnly()noexcept{return effectPlanDemands(PlanDemandNativeFxOnly);}
bool effectPlanBypassRevision(std::string &revision)noexcept{
    const auto reader=PlanReader::instance();if(!reader||effectPlanMode()!=2)return false;
    try{return reader->bypassRevision(revision);}catch(...){return false;}
}
uint64_t effectPlanBypassEpoch()noexcept{const auto reader=PlanReader::instance();return reader?reader->bypassEpoch.load(std::memory_order_acquire):0;}
bool effectPlanNativeFxOnly(const EffectPlanSnapshot &selected)noexcept{
    return selected.mode=="advanced"&&!selected.output.processing()&&!selected.output.adaptiveQuality.enabled&&std::any_of(selected.nodes.begin(),selected.nodes.end(),[](const auto &node){return node.enabled;})&&
        std::all_of(selected.nodes.begin(),selected.nodes.end(),[](const auto &node){
            return !node.enabled||(node.kind=="shader"&&node.format=="fx"&&node.inputPolicy!="srgb-sdr"&&node.inputPolicy!="linear-source"&&!node.realHistory&&!node.requirements.scene()&&
                !node.outputPresentation&&!node.outputWidth&&!node.outputHeight&&!node.presentationScale&&!node.resolutionAuto&&node.outputScaleX==1&&node.outputScaleY==1);
        });
}
// state: 1 active (Advanced), 2 valid (a plan was accepted), 4 the latest read failed.
struct EffectPlanState::Impl {
    mutable std::mutex lock;
    std::shared_ptr<const EffectPlanSnapshot> current;
    struct Instance {std::string source;ShaderParameters parameters;std::shared_ptr<ShaderNode> shader;};
    std::map<std::string,Instance> instances;
    std::string failure;
    std::atomic<uint64_t> seen{0};std::atomic<unsigned> state{0};
};
EffectPlanState::EffectPlanState():impl(std::make_unique<Impl>()){}
EffectPlanState::~EffectPlanState()=default;
EffectPlanPoll EffectPlanState::poll(){return poll(false);}
EffectPlanPoll EffectPlanState::poll(bool force){
    const auto reader=PlanReader::instance();if(!reader)return {};
    if(force)reader->refresh();
    // An unchanged publication is one acquire load and a compare.
    if(reader->generation.load(std::memory_order_acquire)==impl->seen.load(std::memory_order_acquire)){
        const auto state=impl->state.load(std::memory_order_relaxed);
        if(!(state&4))return {bool(state&1),false,{},bool(state&2)};
        std::lock_guard<std::mutex> guard(impl->lock);return {bool(state&1),false,impl->failure,bool(state&2)};
    }
    const auto published=reader->publication();
    std::lock_guard<std::mutex> guard(impl->lock);
    const bool changed=published->plan!=impl->current;
    if(changed&&published->plan)for(auto it=impl->instances.begin();it!=impl->instances.end();){
        const auto &nodes=published->plan->nodes;
        const auto found=std::find_if(nodes.begin(),nodes.end(),[&](const auto &node){return node.id==it->first&&node.kind=="shader"&&sourceIdentity(node)==it->second.source;});
        if(found==nodes.end())it=impl->instances.erase(it);else ++it;
    }
    impl->current=published->plan;impl->failure=published->error;
    const bool active=impl->current&&impl->current->mode=="advanced",valid=bool(impl->current);
    impl->state.store((active?1u:0u)|(valid?2u:0u)|(impl->failure.empty()?0u:4u),std::memory_order_relaxed);
    impl->seen.store(published->generation,std::memory_order_release);
    return {active,changed,impl->failure,valid};
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
