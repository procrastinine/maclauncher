#import <AVFoundation/AVFoundation.h>
#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdatomic.h>

static void make_movie(NSString *path){
    NSError *error=nil;
    AVAssetWriter *writer=[AVAssetWriter assetWriterWithURL:[NSURL fileURLWithPath:path] fileType:AVFileTypeMPEG4 error:&error];assert(writer);
    AVAssetWriterInput *input=[AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{AVVideoCodecKey:AVVideoCodecTypeH264,AVVideoWidthKey:@32,AVVideoHeightKey:@32}];
    AVAssetWriterInputPixelBufferAdaptor *adaptor=[AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:input sourcePixelBufferAttributes:@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA),(id)kCVPixelBufferWidthKey:@32,(id)kCVPixelBufferHeightKey:@32}];
    [writer addInput:input];assert([writer startWriting]);[writer startSessionAtSourceTime:kCMTimeZero];
    for(int frame=0;frame<4;++frame){
        for(int n=0;!input.readyForMoreMediaData&&n<1000;++n)usleep(1000);
        assert(input.readyForMoreMediaData);CVPixelBufferRef pixels=NULL;
        assert(CVPixelBufferPoolCreatePixelBuffer(NULL,adaptor.pixelBufferPool,&pixels)==kCVReturnSuccess);
        CVPixelBufferLockBaseAddress(pixels,0);memset(CVPixelBufferGetBaseAddress(pixels),32+frame*40,CVPixelBufferGetBytesPerRow(pixels)*32);CVPixelBufferUnlockBaseAddress(pixels,0);
        assert([adaptor appendPixelBuffer:pixels withPresentationTime:CMTimeMake(frame,30)]);CVPixelBufferRelease(pixels);
    }
    [input markAsFinished];dispatch_semaphore_t done=dispatch_semaphore_create(0);
    [writer finishWritingWithCompletionHandler:^{dispatch_semaphore_signal(done);}];
    assert(!dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC)));assert(writer.status==AVAssetWriterStatusCompleted);dispatch_release(done);
}
int main(int argc,char **argv){@autoreleasepool {
    assert(argc==3);make_movie([NSString stringWithUTF8String:argv[2]]);
    if(!strcmp(argv[1],"--movie")){puts("PASS generated local four-frame movie");return 0;}
    return 1;
}}
