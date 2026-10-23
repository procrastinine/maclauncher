#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <VideoToolbox/VideoToolbox.h>
#include "video-frame.h"
#include <algorithm>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <vector>

namespace {
volatile sig_atomic_t cancelled = 0;
void cancelSignal(int) { cancelled = 1; }
struct Cancelled {};

void checkCancellation() { if (cancelled) throw Cancelled{}; }
std::runtime_error failure(NSString *message) {
    return std::runtime_error((message ?: @"Video processing failed").UTF8String);
}
void emit(NSDictionary *object) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingSortedKeys error:nil];
    if (data) {
        if (fwrite(data.bytes, 1, data.length, stdout) != data.length || fputc('\n', stdout) == EOF || fflush(stdout)) cancelled = 1;
    }
}
double seconds(CMTime time) { return CMTIME_IS_NUMERIC(time) ? CMTimeGetSeconds(time) : 0; }
double clockSeconds() { return NSProcessInfo.processInfo.systemUptime; }

struct Options {
    __strong NSString *input = nil, *output = nil, *library = nil;
    double scale = 1;
    uint32_t width = 0, height = 0, maxHeight = 0, targetHeight = 0;
    uint64_t frames = 0;
};
double number(NSString *text, NSString *name, double minimum, double maximum, bool integer = false) {
    const char *start = text.UTF8String;
    char *end = nullptr;
    errno = 0;
    double value = strtod(start, &end);
    if (!start || end == start || *end || errno || !std::isfinite(value) || value < minimum || value > maximum ||
        (integer && value != std::floor(value))) throw failure([@"Invalid video-processing option: " stringByAppendingString:name]);
    return value;
}
Options options(int argc, const char **argv) {
    Options result;
    NSMutableSet<NSString *> *seen = [NSMutableSet set];
    for (int i = 1; i < argc; i += 2) {
        NSString *key = [NSString stringWithUTF8String:argv[i]];
        if (i + 1 >= argc || [seen containsObject:key]) throw failure(@"Invalid or duplicate video-processing option");
        [seen addObject:key];
        NSString *value = [NSString stringWithUTF8String:argv[i + 1]];
        if ([key isEqualToString:@"--input"]) result.input = value;
        else if ([key isEqualToString:@"--output"]) result.output = value;
        else if ([key isEqualToString:@"--library"]) result.library = value;
        else if ([key isEqualToString:@"--scale"]) result.scale = number(value, key, 1, 4);
        else if ([key isEqualToString:@"--width"]) result.width = uint32_t(number(value, key, 2, 16384, true));
        else if ([key isEqualToString:@"--height"]) result.height = uint32_t(number(value, key, 2, 16384, true));
        else if ([key isEqualToString:@"--max-height"]) result.maxHeight = uint32_t(number(value, key, 2, 16384, true));
        else if ([key isEqualToString:@"--target-height"]) result.targetHeight = uint32_t(number(value, key, 2, 16384, true));
        else if ([key isEqualToString:@"--frames"]) result.frames = uint64_t(number(value, key, 1, 1000000000, true));
        else throw failure([@"Unknown video-processing option: " stringByAppendingString:key]);
    }
    if (!result.input.length || !result.output.length) throw failure(@"Input and new output video paths are required");
    if (bool(result.width) != bool(result.height)) throw failure(@"Video width and height must be supplied together");
    if (result.width && ((result.width & 1) || (result.height & 1))) throw failure(@"H.264 output width and height must be even");
    if (result.targetHeight && ((result.targetHeight & 1) || result.width || result.maxHeight)) throw failure(@"Choose an even target height or separate output dimensions");
    if (!result.library.length) {
        NSString *executable = NSProcessInfo.processInfo.arguments.firstObject.stringByStandardizingPath;
        result.library = [executable.stringByDeletingLastPathComponent stringByAppendingPathComponent:@"libreshade-macos.dylib"];
    }
    return result;
}

struct Core {
    using Create = decltype(&rsVideoCreate);
    using Process = decltype(&rsVideoProcess);
    using Release = decltype(&rsVideoRelease);
    void *library = nullptr, *handle = nullptr;
    Create create = nullptr;
    Process process = nullptr;
    Release release = nullptr;
    ~Core() { if (handle && release) release(handle); if (library) dlclose(library); }
    void open(NSString *path, id<MTLCommandQueue> queue) {
        library = dlopen(path.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL);
        if (!library) throw failure(@"Cannot load the video graphics runtime");
        create = reinterpret_cast<Create>(dlsym(library, "rsVideoCreate"));
        process = reinterpret_cast<Process>(dlsym(library, "rsVideoProcess"));
        release = reinterpret_cast<Release>(dlsym(library, "rsVideoRelease"));
        if (!create || !process || !release) throw failure(@"The graphics runtime does not support offline video processing");
        char error[2048] = {};
        handle = create((__bridge void *)queue, error, sizeof(error));
        if (!handle) throw failure(error[0] ? [NSString stringWithUTF8String:error] : @"Cannot create the video graphics processor");
    }
};

struct Resources {
    __strong AVAssetWriter *writer = nil;
    __strong NSMutableArray<AVAssetReader *> *readers = [NSMutableArray array];
    __strong NSString *staging = nil;
    CVMetalTextureCacheRef textureCache = nullptr;
    ~Resources() {
        for (AVAssetReader *reader in readers) if (reader.status == AVAssetReaderStatusReading) [reader cancelReading];
        if (writer.status == AVAssetWriterStatusWriting) [writer cancelWriting];
        if (textureCache) CFRelease(textureCache);
        if (staging) [NSFileManager.defaultManager removeItemAtPath:staging error:nil];
    }
};
struct Stream {
    bool video = false, finished = false;
    __strong AVAssetReader *reader = nil;
    __strong AVAssetReaderOutput *output = nil;
    __strong AVAssetWriterInput *input = nil;
    CMSampleBufferRef sample = nullptr;
    ~Stream() { if (sample) CFRelease(sample); }
    void advance() {
        if (sample) { CFRelease(sample); sample = nullptr; }
        sample = [output copyNextSampleBuffer];
        if (!sample) {
            if (reader.status == AVAssetReaderStatusFailed) throw failure(reader.error.localizedDescription);
            if (reader.status == AVAssetReaderStatusCancelled) { checkCancellation(); throw failure(@"Video reading was cancelled"); }
            finished = true;
            [input markAsFinished];
        }
    }
    void finish() {
        if (sample) { CFRelease(sample); sample = nullptr; }
        finished = true;
        [input markAsFinished];
        [reader cancelReading];
    }
};

void validateVideoSource(AVAssetTrack *track) {
    if ([track hasMediaCharacteristic:AVMediaCharacteristicContainsHDRVideo]) throw failure(@"Video graphics processing requires an SDR source");
    if ([track hasMediaCharacteristic:AVMediaCharacteristicContainsAlphaChannel]) throw failure(@"Video export requires an opaque source. Preview supports video with transparency.");
    for (id item in track.formatDescriptions) {
        CMFormatDescriptionRef format = (__bridge CMFormatDescriptionRef)item;
        NSString *transfer = (__bridge NSString *)CMFormatDescriptionGetExtension(format, kCMFormatDescriptionExtension_TransferFunction);
        FourCharCode codec = CMFormatDescriptionGetMediaSubType(format);
        if ([transfer isEqualToString:(__bridge NSString *)kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ] ||
            [transfer isEqualToString:(__bridge NSString *)kCVImageBufferTransferFunction_ITU_R_2100_HLG] ||
            codec == 'dvh1' || codec == 'dvhe' || codec == 'dva1' || codec == 'dvav') {
            throw failure(@"Video graphics processing requires an SDR source");
        }
    }
}
uint32_t evenSize(double value) {
    if (!std::isfinite(value) || value < 2 || value > 16384) throw failure(@"The output video dimensions are unsupported");
    return std::max(2u, uint32_t(std::floor(value / 2)) * 2);
}
struct Geometry {
    uint32_t width, height, displayWidth, displayHeight;
    CGAffineTransform transform;
};
Geometry geometry(CGSize source, CGAffineTransform transform, const Options &options) {
    auto unit = [](double value) { return std::abs(value) < 0.0001 || std::abs(std::abs(value) - 1) < 0.0001; };
    if (!(source.width > 0 && source.height > 0) || !unit(transform.a) || !unit(transform.b) ||
        !unit(transform.c) || !unit(transform.d) ||
        std::abs(transform.a * transform.a + transform.b * transform.b - 1) > 0.0001 ||
        std::abs(transform.c * transform.c + transform.d * transform.d - 1) > 0.0001 ||
        std::abs(transform.a * transform.c + transform.b * transform.d) > 0.0001) {
        throw failure(@"The source video has an unsupported display transform");
    }
    transform.tx = 0; transform.ty = 0;
    CGRect displayed = CGRectStandardize(CGRectApplyAffineTransform(CGRectMake(0, 0, source.width, source.height), transform));
    double width = options.width ?: displayed.size.width * options.scale;
    double height = options.height ?: displayed.size.height * options.scale;
    if (options.targetHeight) {
        width = displayed.size.width * options.targetHeight / displayed.size.height;
        height = options.targetHeight;
    }
    if (!options.width && options.maxHeight && height > options.maxHeight) {
        width *= options.maxHeight / height;
        height = options.maxHeight;
    }
    uint32_t displayWidth = evenSize(width), displayHeight = evenSize(height);
    bool quarterTurn = std::abs(transform.a) < 0.5;
    uint32_t encodedWidth = quarterTurn ? displayHeight : displayWidth;
    uint32_t encodedHeight = quarterTurn ? displayWidth : displayHeight;
    CGRect encoded = CGRectStandardize(CGRectApplyAffineTransform(CGRectMake(0, 0, encodedWidth, encodedHeight), transform));
    transform.tx = -encoded.origin.x; transform.ty = -encoded.origin.y;
    return {encodedWidth, encodedHeight, displayWidth, displayHeight, transform};
}

std::unique_ptr<Stream> makeStream(AVAsset *asset, AVAssetTrack *track, Resources &resources,
                                  bool video, NSDictionary *videoSettings) {
    NSError *error = nil;
    auto stream = std::make_unique<Stream>();
    stream->video = video;
    stream->reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
    if (!stream->reader) throw failure(error.localizedDescription);
    [resources.readers addObject:stream->reader];
    NSDictionary *decode = video ? @{
        (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (id)kCVPixelBufferMetalCompatibilityKey: @YES,
        (id)kCVPixelBufferIOSurfacePropertiesKey: @{}
    } : @{
        AVFormatIDKey: @(kAudioFormatLinearPCM), AVLinearPCMBitDepthKey: @16,
        AVLinearPCMIsFloatKey: @NO, AVLinearPCMIsBigEndianKey: @NO,
        AVLinearPCMIsNonInterleaved: @NO
    };
    AVAssetReaderTrackOutput *output = [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:decode];
    output.alwaysCopiesSampleData = NO;
    if (![stream->reader canAddOutput:output]) throw failure(@"The source media cannot be decoded for graphics processing");
    [stream->reader addOutput:output];
    stream->output = output;
    NSDictionary *settings = videoSettings;
    if (!video) {
        CMAudioFormatDescriptionRef format = (__bridge CMAudioFormatDescriptionRef)track.formatDescriptions.firstObject;
        const AudioStreamBasicDescription *description = format ? CMAudioFormatDescriptionGetStreamBasicDescription(format) : nullptr;
        uint32_t channels = description ? description->mChannelsPerFrame : 2;
        double sampleRate = description ? description->mSampleRate : 48000;
        if (!channels || channels > 8 || !std::isfinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
            throw failure(@"The source audio format cannot be encoded as AAC");
        }
        NSMutableDictionary *audio = [@{AVFormatIDKey: @(kAudioFormatMPEG4AAC), AVSampleRateKey: @(sampleRate),
            AVNumberOfChannelsKey: @(channels), AVEncoderBitRateKey: @(std::min(512000u, 96000u * channels))} mutableCopy];
        size_t layoutSize = 0;
        const AudioChannelLayout *layout = format ? CMAudioFormatDescriptionGetChannelLayout(format, &layoutSize) : nullptr;
        if (layout && layoutSize) audio[AVChannelLayoutKey] = [NSData dataWithBytes:layout length:layoutSize];
        settings = audio;
    }
    stream->input = [AVAssetWriterInput assetWriterInputWithMediaType:video ? AVMediaTypeVideo : AVMediaTypeAudio outputSettings:settings];
    stream->input.expectsMediaDataInRealTime = NO;
    if (![resources.writer canApplyOutputSettings:settings forMediaType:video ? AVMediaTypeVideo : AVMediaTypeAudio] ||
        ![resources.writer canAddInput:stream->input]) throw failure(video ? @"The requested H.264 video dimensions cannot be encoded" : @"The source audio format cannot be encoded as AAC");
    [resources.writer addInput:stream->input];
    return stream;
}

id<MTLTexture> texture(CVMetalTextureCacheRef cache, CVPixelBufferRef buffer, CVMetalTextureRef *owner) {
    NSDictionary *attributes = @{(id)kCVMetalTextureUsage: @(MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite)};
    CVReturn status = CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, cache, buffer,
        (__bridge CFDictionaryRef)attributes, MTLPixelFormatBGRA8Unorm,
        CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer), 0, owner);
    if (status != kCVReturnSuccess || !*owner) throw failure(@"Cannot create a Metal video surface");
    return CVMetalTextureGetTexture(*owner);
}

// PCM samples can be trimmed without re-timing the remaining source samples.
CMSampleBufferRef clippedAudio(CMSampleBufferRef sample, CMTime end) {
    CMTime start = CMSampleBufferGetPresentationTimeStamp(sample);
    if (CMTimeCompare(start, end) >= 0) return nullptr;
    CMTime duration = CMSampleBufferGetDuration(sample);
    if (!CMTIME_IS_NUMERIC(duration) || CMTimeCompare(CMTimeAdd(start, duration), end) <= 0) {
        return (CMSampleBufferRef)CFRetain(sample);
    }
    CMAudioFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
    const AudioStreamBasicDescription *description = CMAudioFormatDescriptionGetStreamBasicDescription(format);
    if (!description || !(description->mSampleRate > 0)) throw failure(@"Cannot trim the source audio timeline");
    CMItemCount count = std::min<CMItemCount>(CMSampleBufferGetNumSamples(sample),
        CMItemCount(std::floor(seconds(CMTimeSubtract(end, start)) * description->mSampleRate + 0.00001)));
    if (count <= 0) return nullptr;
    CMSampleBufferRef result = nullptr;
    if (CMSampleBufferCopySampleBufferForRange(kCFAllocatorDefault, sample, CFRangeMake(0, count), &result) != noErr) {
        throw failure(@"Cannot trim the source audio timeline");
    }
    return result;
}

void publish(NSString *staged, NSString *output) {
    // Both paths share a filesystem. Linking publishes complete bytes atomically
    // and refuses an output created while the encoder was running.
    if (link(staged.fileSystemRepresentation, output.fileSystemRepresentation) != 0) {
        throw failure(errno == EEXIST ? @"The output video already exists" : @"Cannot publish the processed video");
    }
}

void process(const Options &options) {
    NSFileManager *files = NSFileManager.defaultManager;
    NSURL *sourceURL = [NSURL fileURLWithPath:options.input].URLByStandardizingPath.URLByResolvingSymlinksInPath;
    NSURL *outputURL = [NSURL fileURLWithPath:options.output].URLByStandardizingPath;
    if ([sourceURL.path isEqualToString:outputURL.URLByResolvingSymlinksInPath.path]) throw failure(@"Choose a new output file for processed video");
    if ([files fileExistsAtPath:outputURL.path]) throw failure(@"The output video already exists");
    NSString *extension = outputURL.pathExtension.lowercaseString;
    if (![extension isEqualToString:@"mp4"] && ![extension isEqualToString:@"m4v"] && ![extension isEqualToString:@"mov"]) {
        throw failure(@"H.264 output requires an MP4, M4V or MOV file");
    }
    BOOL directory = NO;
    if (![files fileExistsAtPath:sourceURL.path isDirectory:&directory] || directory) throw failure(@"Select a readable source video");
    if (![files fileExistsAtPath:outputURL.URLByDeletingLastPathComponent.path isDirectory:&directory] || !directory) {
        throw failure(@"The output folder does not exist");
    }
    checkCancellation();
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:sourceURL options:@{AVURLAssetPreferPreciseDurationAndTimingKey: @YES}];
    NSArray<AVAssetTrack *> *videoTracks = [asset tracksWithMediaType:AVMediaTypeVideo];
    if (videoTracks.count != 1) throw failure(@"Select a video containing one video track");
    AVAssetTrack *videoTrack = videoTracks.firstObject;
    validateVideoSource(videoTrack);
    Geometry target = geometry(videoTrack.naturalSize, videoTrack.preferredTransform, options);
    Resources resources;
    resources.staging = [outputURL.URLByDeletingLastPathComponent.path stringByAppendingPathComponent:
        [NSString stringWithFormat:@".%@-%@.tmp", outputURL.lastPathComponent, NSUUID.UUID.UUIDString]];
    NSError *error = nil;
    if (![files createDirectoryAtPath:resources.staging withIntermediateDirectories:NO attributes:nil error:&error]) throw failure(error.localizedDescription);
    NSURL *stagedURL = [NSURL fileURLWithPath:[resources.staging stringByAppendingPathComponent:@"output.mp4"]];
    AVFileType fileType = [extension isEqualToString:@"mov"] ? AVFileTypeQuickTimeMovie : AVFileTypeMPEG4;
    resources.writer = [[AVAssetWriter alloc] initWithURL:stagedURL fileType:fileType error:&error];
    if (!resources.writer) throw failure(error.localizedDescription);
    resources.writer.shouldOptimizeForNetworkUse = YES;
    resources.writer.metadata = asset.commonMetadata;
    NSMutableDictionary *colour = [NSMutableDictionary dictionary];
    CMFormatDescriptionRef format = (__bridge CMFormatDescriptionRef)videoTrack.formatDescriptions.firstObject;
    for (NSArray *pair in @[@[(id)kCMFormatDescriptionExtension_ColorPrimaries, AVVideoColorPrimariesKey],
                            @[(id)kCMFormatDescriptionExtension_TransferFunction, AVVideoTransferFunctionKey],
                            @[(id)kCMFormatDescriptionExtension_YCbCrMatrix, AVVideoYCbCrMatrixKey]]) {
        id value = format ? (__bridge id)CMFormatDescriptionGetExtension(format, (__bridge CFStringRef)pair[0]) : nil;
        if (value) colour[pair[1]] = value;
    }
    NSMutableDictionary *settings = [@{AVVideoCodecKey: AVVideoCodecTypeH264,
        AVVideoWidthKey: @(target.width), AVVideoHeightKey: @(target.height),
        AVVideoEncoderSpecificationKey: @{(id)kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: @YES},
        AVVideoCompressionPropertiesKey: @{AVVideoAverageBitRateKey: @(std::max(2000000.0, std::min(80000000.0, double(target.width) * target.height * 6))),
                                           AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel}} mutableCopy];
    if (colour.count) settings[AVVideoColorPropertiesKey] = colour;
    std::vector<std::unique_ptr<Stream>> streams;
    streams.push_back(makeStream(asset, videoTrack, resources, true, settings));
    Stream &video = *streams.front();
    video.input.transform = target.transform;
    for (AVAssetTrack *audioTrack in [asset tracksWithMediaType:AVMediaTypeAudio]) {
        streams.push_back(makeStream(asset, audioTrack, resources, false, nil));
    }
    AVAssetWriterInputPixelBufferAdaptor *adaptor = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:video.input sourcePixelBufferAttributes:@{
        (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (id)kCVPixelBufferWidthKey: @(target.width), (id)kCVPixelBufferHeightKey: @(target.height),
        (id)kCVPixelBufferMetalCompatibilityKey: @YES, (id)kCVPixelBufferIOSurfacePropertiesKey: @{}
    }];
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    id<MTLCommandQueue> queue = [device newCommandQueue];
    if (!device || !queue || CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &resources.textureCache) != kCVReturnSuccess) {
        throw failure(@"Metal video processing is unavailable");
    }
    Core core;
    core.open(options.library, queue);
    if (![resources.writer startWriting]) throw failure(resources.writer.error.localizedDescription);
    [resources.writer startSessionAtSourceTime:kCMTimeZero];
    for (auto &stream : streams) {
        if (![stream->reader startReading]) throw failure(stream->reader.error.localizedDescription);
        stream->advance();
    }
    double start = clockSeconds(), lastProgress = 0, lastReady = start;
    double duration = std::max(0.0, seconds(asset.duration));
    double nominalFPS = videoTrack.nominalFrameRate;
    CMTime fallbackDuration = CMTimeMakeWithSeconds(nominalFPS > 0 ? 1 / nominalFPS : 1.0 / 30, 60000);
    CMTime clipEnd = kCMTimeInvalid, lastVideoEnd = kCMTimeZero;
    uint64_t count = 0, audioSamples = 0;
    emit(@{@"type": @"start", @"width": @(target.displayWidth), @"height": @(target.displayHeight),
        @"encodedWidth": @(target.width), @"encodedHeight": @(target.height), @"durationSeconds": @(duration),
        @"audioTracks": @(streams.size() - 1)});
    while (true) {
        checkCancellation();
        if (resources.writer.status == AVAssetWriterStatusFailed) throw failure(resources.writer.error.localizedDescription);
        Stream *next = nullptr;
        bool pending = false;
        for (auto &stream : streams) {
            if (stream->finished) continue;
            pending = true;
            if (!stream->input.readyForMoreMediaData) continue;
            if (!next || CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(stream->sample), CMSampleBufferGetPresentationTimeStamp(next->sample)) < 0) next = stream.get();
        }
        if (!pending) break;
        if (!next) {
            if (clockSeconds() - lastReady > 60) throw failure(@"The video encoder stopped accepting frames");
            usleep(2000);
            continue;
        }
        lastReady = clockSeconds();
        @autoreleasepool {
            CMTime pts = CMSampleBufferGetPresentationTimeStamp(next->sample);
            if (!CMTIME_IS_NUMERIC(pts) || CMTimeCompare(pts, kCMTimeZero) < 0) throw failure(@"The source video has an unsupported timeline");
            if (next->video) {
                CVPixelBufferRef input = CMSampleBufferGetImageBuffer(next->sample), output = nullptr;
                if (!input || CVPixelBufferGetPixelFormatType(input) != kCVPixelFormatType_32BGRA || !adaptor.pixelBufferPool ||
                    CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, adaptor.pixelBufferPool, &output) != kCVReturnSuccess) {
                    throw failure(@"Cannot allocate a video frame");
                }
                struct FrameOwners {
                    CVPixelBufferRef output;
                    CVMetalTextureRef sourceTexture = nullptr, targetTexture = nullptr;
                    ~FrameOwners() { if (sourceTexture) CFRelease(sourceTexture); if (targetTexture) CFRelease(targetTexture); CFRelease(output); }
                } owners{output};
                id<MTLTexture> sourceTexture = texture(resources.textureCache, input, &owners.sourceTexture);
                id<MTLTexture> outputTexture = texture(resources.textureCache, output, &owners.targetTexture);
                CMTime frameDuration = CMSampleBufferGetDuration(next->sample);
                if (!CMTIME_IS_NUMERIC(frameDuration) || CMTimeCompare(frameDuration, kCMTimeZero) <= 0) frameDuration = fallbackDuration;
                RSVideoFrame frame{sizeof(RSVideoFrame), 1, (__bridge void *)sourceTexture, (__bridge void *)outputTexture,
                    count + 1, seconds(pts) * 1000, float(seconds(frameDuration) * 1000)};
                char message[2048] = {};
                if (core.process(core.handle, &frame, message, sizeof(message)) != 0) throw failure(message[0] ? [NSString stringWithUTF8String:message] : @"Cannot process the video frame");
                checkCancellation();
                CMVideoFormatDescriptionRef outputFormat = nullptr;
                CMSampleBufferRef encodedInput = nullptr;
                CMSampleTimingInfo timing{frameDuration, pts, kCMTimeInvalid};
                if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, output, &outputFormat) != noErr ||
                    CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, output, outputFormat, &timing, &encodedInput) != noErr) {
                    if (outputFormat) CFRelease(outputFormat);
                    throw failure(@"Cannot preserve the video frame timeline");
                }
                bool appended = [video.input appendSampleBuffer:encodedInput];
                CFRelease(encodedInput); CFRelease(outputFormat);
                if (!appended) throw failure(resources.writer.error.localizedDescription);
                ++count;
                lastVideoEnd = CMTimeAdd(pts, frameDuration);
                if (options.frames && count >= options.frames) { clipEnd = lastVideoEnd; next->finish(); }
                else next->advance();
                double elapsed = clockSeconds() - start;
                if (count == 1 || elapsed - lastProgress >= 0.1 || next->finished) {
                    emit(@{@"type": @"progress", @"inputFrames": @(count), @"outputFrames": @(count),
                        @"fraction": @(duration > 0 ? std::min(1.0, seconds(lastVideoEnd) / duration) : 0),
                        @"elapsedSeconds": @(elapsed), @"timeSeconds": @(seconds(lastVideoEnd))});
                    lastProgress = elapsed;
                }
                CVMetalTextureCacheFlush(resources.textureCache, 0);
            } else {
                CMSampleBufferRef audio = CMTIME_IS_NUMERIC(clipEnd) ? clippedAudio(next->sample, clipEnd) : (CMSampleBufferRef)CFRetain(next->sample);
                if (!audio) { next->finish(); continue; }
                bool appended = [next->input appendSampleBuffer:audio];
                CFRelease(audio);
                if (!appended) throw failure(resources.writer.error.localizedDescription);
                ++audioSamples;
                next->advance();
            }
        }
    }
    if (!count) throw failure(@"The source video contains no readable frames");
    checkCancellation();
    if (CMTIME_IS_NUMERIC(clipEnd)) [resources.writer endSessionAtSourceTime:clipEnd];
    dispatch_semaphore_t complete = dispatch_semaphore_create(0);
    [resources.writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(complete); }];
    double finishing = clockSeconds();
    while (dispatch_semaphore_wait(complete, dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC))) {
        checkCancellation();
        if (clockSeconds() - finishing > 60) throw failure(@"The video encoder did not finish");
    }
    if (resources.writer.status != AVAssetWriterStatusCompleted) throw failure(resources.writer.error.localizedDescription);
    checkCancellation();
    publish(stagedURL.path, outputURL.path);
    emit(@{@"type": @"complete", @"output": outputURL.path, @"inputFrames": @(count), @"outputFrames": @(count),
        @"audioSamples": @(audioSamples), @"elapsedSeconds": @(clockSeconds() - start),
        @"width": @(target.displayWidth), @"height": @(target.displayHeight)});
}
}

#ifndef MACLAUNCHER_GRAPHICS_VIDEO_TESTING
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 2 && !std::strcmp(argv[1], "--help")) {
            puts("maclauncher-graphics-video --input FILE --output NEW_FILE [--library DYLIB] [--scale 1...4] [--target-height EVEN | --max-height PIXELS | --width EVEN --height EVEN] [--frames COUNT]");
            return 0;
        }
        struct sigaction action{};
        action.sa_handler = cancelSignal;
        sigemptyset(&action.sa_mask);
        sigaction(SIGINT, &action, nullptr);
        sigaction(SIGTERM, &action, nullptr);
        signal(SIGPIPE, SIG_IGN);
        setenv("RESHADE_EXPLICIT_HOST", "1", 1);
        @try {
            try {
                process(options(argc, argv));
                return 0;
            } catch (const Cancelled &) {
                emit(@{@"type": @"cancelled"});
                return 130;
            } catch (const std::exception &error) {
                emit(@{@"type": @"error", @"message": [NSString stringWithUTF8String:error.what()] ?: @"Video processing failed"});
                return 1;
            }
        } @catch (NSException *) {
            emit(@{@"type": @"error", @"message": @"The source media or output settings could not be processed"});
            return 1;
        }
    }
}
#endif
