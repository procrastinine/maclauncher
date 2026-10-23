#include "lsfg.hpp"
#include "spatial.hpp"
#include "simple-generation-policy.hpp"
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <CommonCrypto/CommonDigest.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <filesystem>
#include <memory>
#include <type_traits>
#include <stdexcept>
#include <vector>
using namespace macfx;
static void require(bool value,const std::string &reason){if(!value)throw std::runtime_error(reason);}
static id<MTLTexture> texture(id<MTLDevice>device,unsigned width,unsigned height){
    auto descriptor=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];
    descriptor.storageMode=MTLStorageModeShared;descriptor.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite|MTLTextureUsageRenderTarget;
    auto value=[device newTextureWithDescriptor:descriptor];require(value!=nil,"Cannot allocate benchmark image");return value;
}
static std::vector<unsigned char> pixels(id<MTLTexture>image){
    std::vector<unsigned char>bytes(image.width*image.height*4);
    [image getBytes:bytes.data() bytesPerRow:image.width*4 fromRegion:MTLRegionMake2D(0,0,image.width,image.height) mipmapLevel:0];return bytes;
}
static void ppm(const std::string &file,const std::vector<unsigned char> &bytes,unsigned width,unsigned height){
    std::ofstream output(file,std::ios::binary);require(bool(output),"Cannot create comparison image");output<<"P6\n"<<width<<" "<<height<<"\n255\n";
    for(size_t i=0;i<bytes.size();i+=4)output.write(reinterpret_cast<const char*>(bytes.data()+i),3);
    require(bool(output),"Cannot write comparison image");
}
static std::string sha256(const void *bytes,size_t size){
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];CC_SHA256(bytes,CC_LONG(size),digest);std::string value;
    for(unsigned char byte:digest){value.push_back("0123456789abcdef"[byte>>4]);value.push_back("0123456789abcdef"[byte&15]);}return value;
}
struct InputFrame {std::string name,fileHash,rgbaHash;std::vector<unsigned char>rgba;};
static std::vector<InputFrame> inputFrames(const std::string &directory,unsigned width,unsigned height,unsigned count){
    std::vector<std::filesystem::path> files;unsigned entries=0;
    require(std::filesystem::is_directory(directory),"Input frames require an existing directory");
    for(const auto &entry:std::filesystem::directory_iterator(directory)){
        require(++entries<=64,"Input directory exceeds 64 entries");const auto extension=entry.path().extension().string();
        if(extension!=".png"&&extension!=".ppm")continue;
        require(!entry.is_symlink()&&entry.is_regular_file(),"Input images must be regular files, without symlinks");files.push_back(entry.path());
    }
    std::sort(files.begin(),files.end());require(files.size()==count,"Input directory must contain exactly ITERATIONS + 3 ordered PNG/PPM frames");
    require(uint64_t(width)*height*4*count<=256ull*1024*1024,"Decoded input frames exceed 256 MiB");
    std::vector<InputFrame> frames;
    for(const auto &file:files){
        require(std::filesystem::file_size(file)<=64ull*1024*1024,"Input image exceeds 64 MiB");
        NSData *data=[NSData dataWithContentsOfFile:@(file.c_str())];require(data.length>0,"Cannot read input image");
        InputFrame frame{file.filename().string(),sha256(data.bytes,data.length),{},std::vector<unsigned char>(size_t(width)*height*4)};
        if(file.extension()==".ppm"){
            std::ifstream stream(file,std::ios::binary);std::string magic;unsigned w=0,h=0,maximum=0;stream>>magic>>w>>h>>maximum;
            require(stream.good()&&magic=="P6"&&w==width&&h==height&&maximum==255,"PPM must be P6 with matching dimensions and maximum 255");
            int newline=stream.get();if(newline=='\r')newline=stream.get();require(newline=='\n',"PPM requires a newline after its header");
            std::vector<unsigned char>rgb(size_t(width)*height*3);stream.read(reinterpret_cast<char*>(rgb.data()),rgb.size());require(size_t(stream.gcount())==rgb.size()&&stream.peek()==EOF,"PPM pixel byte count differs from its dimensions");
            for(size_t i=0;i<rgb.size()/3;++i){std::copy_n(rgb.data()+i*3,3,frame.rgba.data()+i*4);frame.rgba[i*4+3]=255;}
        }else{
            auto source=std::unique_ptr<std::remove_pointer_t<CGImageSourceRef>,decltype(&CFRelease)>(CGImageSourceCreateWithData((__bridge CFDataRef)data,nullptr),CFRelease);
            require(bool(source),"Cannot decode PNG input");
            NSDictionary *properties=CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source.get(),0,nullptr));
            require([properties[(__bridge NSString*)kCGImagePropertyPixelWidth]unsignedLongLongValue]==width&&[properties[(__bridge NSString*)kCGImagePropertyPixelHeight]unsignedLongLongValue]==height,"PNG dimensions differ from the source extent");
            const auto orientation=[properties[(__bridge NSString*)kCGImagePropertyOrientation]unsignedIntValue];require(!orientation||orientation==1,"Input PNG requires an unapplied orientation transform");
            auto image=std::unique_ptr<CGImage,decltype(&CGImageRelease)>(CGImageSourceCreateImageAtIndex(source.get(),0,nullptr),CGImageRelease);
            auto color=std::unique_ptr<CGColorSpace,decltype(&CGColorSpaceRelease)>(CGColorSpaceCreateWithName(kCGColorSpaceSRGB),CGColorSpaceRelease);
            require(image&&color,"Cannot create canonical input image/color space");
            auto context=std::unique_ptr<CGContext,decltype(&CGContextRelease)>(CGBitmapContextCreate(frame.rgba.data(),width,height,8,width*4,color.get(),kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big),CGContextRelease);
            require(image&&context,"Cannot create canonical RGBA input");CGContextDrawImage(context.get(),CGRectMake(0,0,width,height),image.get());
        }
        for(size_t i=3;i<frame.rgba.size();i+=4)require(frame.rgba[i]==255,"Input frames must have opaque alpha");
        frame.rgbaHash=sha256(frame.rgba.data(),frame.rgba.size());frames.push_back(std::move(frame));
    }
    return frames;
}
struct Trial {NSMutableArray *frames=[NSMutableArray new],*captures=[NSMutableArray new];std::vector<std::vector<unsigned char>>last;std::string modelHash;};
static Trial run(bool sourcePlacement,id<MTLDevice>device,const LsfgConfig &config,unsigned sw,unsigned sh,unsigned ow,unsigned oh,
        SpatialMethod method,unsigned iterations,const std::string &directory,const std::vector<InputFrame>&inputs){
    Trial trial;auto queue=[device newCommandQueue];require(queue!=nil,"Cannot create benchmark queue");
    // A trial batches every delivery into one command buffer. Independent
    // destination owners prevent the bounded FSR scratch slots of one scaler
    // from being reused while that same buffer still references them.
    std::vector<std::unique_ptr<SpatialEncoder>> scalers;
    for(unsigned i=0;i<(sourcePlacement?config.multiplier:1);++i)scalers.push_back(std::make_unique<SpatialEncoder>(device));
    // Trials run sequentially so the two full model graphs are never resident
    // together. Graph/model construction and three history warmup frames are
    // reported separately from the steady command-buffer measurements.
    LsfgEncoder generator(device,config);auto source=texture(device,sw,sh),upscaled=texture(device,ow,oh);
    std::vector<id<MTLTexture>>generated,delivered;
    for(unsigned i=1;i<config.multiplier;++i){generated.push_back(texture(device,sourcePlacement?sw:ow,sourcePlacement?sh:oh));delivered.push_back(texture(device,ow,oh));}
    for(unsigned frame=0;frame<iterations+3;++frame){@autoreleasepool{
        std::vector<unsigned char>input(sw*sh*4);
        if(inputs.empty()){
        const unsigned boxWidth=std::max(8u,sw/8),boxHeight=std::max(8u,sh/3),left=sw/4+frame*std::max(1u,sw/256),top=sh/3;
        for(unsigned y=0;y<sh;++y)for(unsigned x=0;x<sw;++x){
            auto *pixel=&input[(size_t(y)*sw+x)*4];const bool box=x>=left&&x<left+boxWidth&&y>=top&&y<top+boxHeight;
            pixel[0]=box?230:20;pixel[1]=box?180:40+(y*40/sh);pixel[2]=box?60:50+(x*40/sw);pixel[3]=255;
            if(y<sh/5&&x<sw/2){const auto line=((x/2+frame)%2)?215:30;pixel[0]=pixel[1]=pixel[2]=line;}
        }
        }else input=inputs.at(frame).rgba;
        [source replaceRegion:MTLRegionMake2D(0,0,sw,sh) mipmapLevel:0 withBytes:input.data() bytesPerRow:sw*4];
        auto commands=[queue commandBuffer];const auto started=std::chrono::steady_clock::now();
        auto scale=[&](unsigned index,id<MTLTexture>inputImage,id<MTLTexture>outputImage){
            auto status=scalers.at(index)->encode(commands,{inputImage,outputImage,uint64_t(frame)+1},method);
            require(status.encoded&&status.active==method,status.reason.empty()?"The selected scaler was not applied":status.reason);
        };
        if(!sourcePlacement)scale(0,source,upscaled);
        const auto result=generator.encode(commands,sourcePlacement?source:upscaled,generated,uint64_t(frame)+1);
        require(result.encoded&&!result.busy,result.reason);require(result.graphBuilds==1,"A steady trial rebuilt its graph");
        if(frame>=3)require(result.ready&&result.generated==config.multiplier-1,"A steady trial did not generate every requested output");
        if(sourcePlacement){scale(0,source,upscaled);if(result.ready)for(size_t i=0;i<generated.size();++i)scale(unsigned(i)+1,generated[i],delivered[i]);}
        auto done=dispatch_semaphore_create(0);[commands addCompletedHandler:^(id<MTLCommandBuffer>){dispatch_semaphore_signal(done);}];[commands commit];
        require(!dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,20*NSEC_PER_SEC)),"Benchmark GPU deadline");
        require(commands.status==MTLCommandBufferStatusCompleted,commands.error.localizedDescription.UTF8String?:"Benchmark GPU failed");
        const double elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
        const double gpuMs=(commands.GPUEndTime-commands.GPUStartTime)*1000;
        require(std::isfinite(gpuMs)&&gpuMs>=0,"Invalid GPU timing");trial.modelHash=result.modelHash;
        require(pixels(source)==input,"A trial changed the source image");
        [trial.frames addObject:@{@"frame":@(frame),@"warmup":@(frame<3),@"gpuMs":@(gpuMs),@"wallMs":@(elapsed),
            @"generated":@(result.generated),@"dispatches":@(result.dispatches),@"graphBuilds":@(result.graphBuilds)}];
        if(frame==iterations+2||(!inputs.empty()&&frame+2>=iterations+3)){
            require(result.ready&&result.generated==config.multiplier-1,"A captured batch did not generate every requested output");
            if(!inputs.empty()&&!sourcePlacement)ppm(directory+"/input-frame"+std::to_string(frame)+".ppm",input,sw,sh);
            std::vector<std::vector<unsigned char>> images{pixels(upscaled)};
            for(size_t i=0;i<generated.size();++i)images.push_back(pixels(sourcePlacement?delivered[i]:generated[i]));
            for(size_t i=0;i<images.size();++i){const auto &bytes=images[i];
                for(size_t pixel=3;pixel<bytes.size();pixel+=4)require(bytes[pixel]==255,"A trial lost opaque alpha");
                const auto file=(sourcePlacement?"source":"output")+std::string(inputs.empty()?"":"-frame"+std::to_string(frame))+"-"+std::to_string(i)+".ppm";
                ppm(directory+"/"+file,bytes,ow,oh);[trial.captures addObject:@{@"file":@(file.c_str()),@"sourceFrame":@(frame),@"previousSourceFrame":@(frame-1),@"delivery":@(i),@"generated":@(i!=0),@"fraction":@(i?double(i)/config.multiplier:1),@"rgbaSha256":@(sha256(bytes.data(),bytes.size()).c_str())}];
            }
            if(frame==iterations+2)trial.last=std::move(images);
        }
    }}
    return trial;
}
int main(int argc,char **argv){@autoreleasepool{try{
    require(argc==10||argc==11,"Usage: simple-generation-cost DLL SOURCE_WIDTH SOURCE_HEIGHT OUTPUT_WIDTH OUTPUT_HEIGHT MULTIPLIER SCALER OUTPUT_DIRECTORY ITERATIONS [INPUT_FRAME_DIRECTORY]");
    const unsigned sw=std::stoul(argv[2]),sh=std::stoul(argv[3]),ow=std::stoul(argv[4]),oh=std::stoul(argv[5]),multiplier=std::stoul(argv[6]),iterations=std::stoul(argv[9]);
    require(sw>=64&&sh>=64&&ow>=sw&&oh>=sh&&ow<=3840&&oh<=2160&&iterations>=1&&iterations<=16,"Invalid bounded benchmark dimensions");
    const auto inputs=argc==11?inputFrames(argv[10],sw,sh,iterations+3):std::vector<InputFrame>{};
    auto device=MTLCreateSystemDefaultDevice();require(device!=nil,"Metal device unavailable");
    require(simplegeneration::scalerPasses(argv[7])!=0,"This trial measures a supported native final scaler");const auto method=spatialMethodForName(argv[7]);
    const std::string directory=argv[8];require([@(directory.c_str()) isAbsolutePath]&&![[NSFileManager defaultManager]fileExistsAtPath:@(directory.c_str())],"Choose a new absolute output directory");
    require([[NSFileManager defaultManager]createDirectoryAtPath:@(directory.c_str()) withIntermediateDirectories:YES attributes:nil error:nil],"Cannot create output directory");
    const LsfgConfig config{argv[1],true,false,1,multiplier};
    const auto baseline=run(false,device,config,sw,sh,ow,oh,method,iterations,directory,inputs),candidate=run(true,device,config,sw,sh,ow,oh,method,iterations,directory,inputs);
    require(!baseline.modelHash.empty()&&baseline.modelHash==candidate.modelHash,"Comparison trials used different model resources");
    NSMutableArray *differences=[NSMutableArray new];
    for(size_t i=0;i<baseline.last.size();++i){double error=0;unsigned maximum=0;for(size_t p=0;p<baseline.last[i].size();p+=4)for(unsigned c=0;c<3;++c){
        const unsigned delta=std::abs(int(baseline.last[i][p+c])-int(candidate.last[i][p+c]));error+=delta;maximum=std::max(maximum,delta);
    }[differences addObject:@{@"output":@(i),@"meanRgbDifference":@(error/(ow*oh*3)),@"maximumRgbDifference":@(maximum)}];}
    NSMutableArray *inputIdentities=[NSMutableArray new];for(const auto &input:inputs){require(sha256(input.rgba.data(),input.rgba.size())==input.rgbaHash,"A trial changed canonical input bytes");[inputIdentities addObject:@{@"file":@(input.name.c_str()),@"fileSha256":@(input.fileHash.c_str()),@"rgbaSha256":@(input.rgbaHash.c_str())}];}
    require(inputs.empty()||baseline.last.front()==candidate.last.front(),"Placements changed the real scaled image");
    require(baseline.captures.count==candidate.captures.count,"Placements captured different delivered batches");
    for(NSUInteger i=0;i<baseline.captures.count;++i){NSDictionary *a=baseline.captures[i],*b=candidate.captures[i];
        require([a[@"sourceFrame"]isEqual:b[@"sourceFrame"]]&&[a[@"delivery"]isEqual:b[@"delivery"]],"Placements captured different source pairs/phases");
        if(![a[@"generated"]boolValue])require([a[@"rgbaSha256"]isEqual:b[@"rgbaSha256"]],"Placements changed a captured real scaled image");
    }
    const auto result=@{@"device":device.name,@"syntheticInput":@(inputs.empty()),@"qualityQualified":@NO,@"sourceWidth":@(sw),@"sourceHeight":@(sh),
        @"outputWidth":@(ow),@"outputHeight":@(oh),@"multiplier":@(multiplier),@"scaler":@(argv[7]),@"modelHash":@(candidate.modelHash.c_str()),
        @"fp16":@YES,@"performance":@NO,@"flowScale":@1,@"inputFrames":inputIdentities,@"canonicalInput":@"Opaque RGBA8; PNG color converted to sRGB, no geometry/orientation transform",
        @"outputPlacement":baseline.frames,@"sourcePlacement":candidate.frames,@"outputCaptures":baseline.captures,@"sourceCaptures":candidate.captures,@"differences":differences};
    auto json=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:nil];require(json!=nil,"Cannot encode benchmark result");
    fwrite(json.bytes,1,json.length,stdout);putchar('\n');return 0;
}catch(const std::exception &error){fprintf(stderr,"%s\n",error.what());return 1;}}}
