#define MACLAUNCHER_GRAPHICS_VIDEO_TESTING
#include <graphics-video.mm>
#include <cassert>
@interface VideoSourceTraits : NSObject
@property BOOL alpha;
@property BOOL hdr;
@end
@implementation VideoSourceTraits
- (BOOL)hasMediaCharacteristic:(AVMediaCharacteristic)characteristic {
    return [characteristic isEqualToString:AVMediaCharacteristicContainsAlphaChannel] ? self.alpha :
        [characteristic isEqualToString:AVMediaCharacteristicContainsHDRVideo] ? self.hdr : NO;
}
- (NSArray *)formatDescriptions { return @[]; }
@end

template<class Body> static bool rejects(Body body) {
    try { body(); return false; } catch (const std::runtime_error &) { return true; }
}

int main() {
    @autoreleasepool {
        Options values;
        values.scale = 2;
        auto doubled = geometry(CGSizeMake(1920, 1080), CGAffineTransformIdentity, values);
        assert(doubled.width == 3840 && doubled.height == 2160);
        values.maxHeight = 1080;
        auto capped = geometry(CGSizeMake(1920, 1080), CGAffineTransformIdentity, values);
        assert(capped.width == 1920 && capped.height == 1080);
        values.targetHeight = 2160; values.maxHeight = 0;
        auto fourK = geometry(CGSizeMake(320, 180), CGAffineTransformIdentity, values);
        assert(fourK.width == 3840 && fourK.height == 2160);
        values.targetHeight = 0;
        values.width = 1280; values.height = 720;
        auto explicitSize = geometry(CGSizeMake(1920, 1080), CGAffineTransformIdentity, values);
        assert(explicitSize.width == 1280 && explicitSize.height == 720);
        CGAffineTransform rotated = CGAffineTransformMake(0, 1, -1, 0, 1080, 0);
        auto orientation = geometry(CGSizeMake(1080, 1920), rotated, values);
        assert(orientation.width == 720 && orientation.height == 1280);
        CGRect displayed = CGRectApplyAffineTransform(CGRectMake(0, 0, orientation.width, orientation.height), orientation.transform);
        assert(displayed.origin.x == 0 && displayed.origin.y == 0 && displayed.size.width == 1280 && displayed.size.height == 720);
        assert(rejects([&] { geometry(CGSizeMake(1920, 1080), CGAffineTransformMakeScale(2, 1), values); }));
        assert(rejects([] { number(@"nan", @"--scale", 1, 4); }));
        assert(rejects([] { number(@"2junk", @"--scale", 1, 4); }));
        assert(rejects([] { number(@"1.5", @"--frames", 1, 100, true); }));
        const char *odd[] = {"test", "--input", "a.mp4", "--output", "b.mp4", "--width", "321", "--height", "240"};
        assert(rejects([&] { options(9, odd); }));
        const char *missing[] = {"test", "--input", "a.mp4", "--output", "b.mp4", "--width", "320"};
        assert(rejects([&] { options(7, missing); }));
        VideoSourceTraits *source = [VideoSourceTraits new];
        validateVideoSource((AVAssetTrack *)source);
        source.alpha = YES;
        assert(rejects([&] { validateVideoSource((AVAssetTrack *)source); }));
        source.alpha = NO; source.hdr = YES;
        assert(rejects([&] { validateVideoSource((AVAssetTrack *)source); }));

        AudioStreamBasicDescription description{};
        description.mSampleRate = 48000;
        description.mFormatID = kAudioFormatLinearPCM;
        description.mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
        description.mBytesPerPacket = 4; description.mFramesPerPacket = 1;
        description.mBytesPerFrame = 4; description.mChannelsPerFrame = 2; description.mBitsPerChannel = 16;
        CMAudioFormatDescriptionRef format = nullptr;
        assert(CMAudioFormatDescriptionCreate(kCFAllocatorDefault, &description, 0, nullptr, 0, nullptr, nullptr, &format) == noErr);
        CMBlockBufferRef bytes = nullptr;
        assert(CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, nullptr, 480 * 4, kCFAllocatorDefault, nullptr, 0, 480 * 4, 0, &bytes) == noErr);
        CMSampleTimingInfo timing{CMTimeMake(1, 48000), CMTimeMake(48000, 48000), kCMTimeInvalid};
        size_t sampleSize = 4;
        CMSampleBufferRef sample = nullptr;
        assert(CMSampleBufferCreateReady(kCFAllocatorDefault, bytes, format, 480, 1, &timing, 1, &sampleSize, &sample) == noErr);
        CMSampleBufferRef clipped = clippedAudio(sample, CMTimeMake(48240, 48000));
        assert(clipped && CMSampleBufferGetNumSamples(clipped) == 240);
        assert(CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(clipped), timing.presentationTimeStamp) == 0);
        CFRelease(clipped);
        assert(!clippedAudio(sample, timing.presentationTimeStamp));
        clipped = clippedAudio(sample, CMTimeMake(49000, 48000));
        assert(clipped && CMSampleBufferGetNumSamples(clipped) == 480);
        CFRelease(clipped); CFRelease(sample); CFRelease(bytes); CFRelease(format);

        NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        NSFileManager *files = NSFileManager.defaultManager;
        assert([files createDirectoryAtPath:directory withIntermediateDirectories:NO attributes:nil error:nil]);
        NSString *output = [directory stringByAppendingPathComponent:@"result.mp4"];
        NSString *staging = [directory stringByAppendingPathComponent:@".staging.tmp"];
        assert([files createDirectoryAtPath:staging withIntermediateDirectories:NO attributes:nil error:nil]);
        NSString *staged = [staging stringByAppendingPathComponent:@"output.mp4"];
        NSData *original = [@"completed media" dataUsingEncoding:NSUTF8StringEncoding];
        assert([original writeToFile:staged atomically:NO]);
        { Resources owned; owned.staging = staging; publish(staged, output); }
        assert(![files fileExistsAtPath:staging] && [[NSData dataWithContentsOfFile:output] isEqualToData:original]);
        assert([@"another media" writeToFile:[directory stringByAppendingPathComponent:@"second.mp4"] atomically:NO encoding:NSUTF8StringEncoding error:nil]);
        assert(rejects([&] { publish([directory stringByAppendingPathComponent:@"second.mp4"], output); }));
        assert([[NSData dataWithContentsOfFile:output] isEqualToData:original]);
        @try {
            Resources owned;
            owned.staging = staging;
            assert([files createDirectoryAtPath:staging withIntermediateDirectories:NO attributes:nil error:nil]);
            @throw [NSException exceptionWithName:@"MediaFailure" reason:@"unsupported settings" userInfo:nil];
        } @catch (NSException *) {}
        assert(![files fileExistsAtPath:staging]);
        assert([files removeItemAtPath:directory error:nil]);
        cancelled = 1;
        bool cancellation = false;
        try { checkCancellation(); } catch (const Cancelled &) { cancellation = true; }
        assert(cancellation);
        cancelled = 0;
        puts("graphics video: geometry, arguments, source audio timestamps, atomic publication, cleanup and cancellation passed");
    }
}
