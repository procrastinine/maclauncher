#include "source-control.hpp"
#include "fixture-files.hpp"
#include <cassert>
#include <cstdio>
#include <functional>

static bool fails(const std::function<void()> &operation){try{operation();return false;}catch(const std::exception &){return true;}}
int main(){@autoreleasepool{
    char temporary[1024];temporaryPath(temporary,"macfx-source-XXXXXX");assert(mkdtemp(temporary));
    NSString *directory=[NSString stringWithUTF8String:temporary];
    NSString *file=[directory stringByAppendingPathComponent:@"source-control-owned.json"],*status=[directory stringByAppendingPathComponent:@"source-status-owned.json"];
    setenv("RESHADE_RENDER_SOURCE_CONTROL_FILE",file.fileSystemRepresentation,1);
    setenv("RESHADE_RENDER_SOURCE_STATUS_FILE",status.fileSystemRepresentation,1);
    setenv("RESHADE_RENDER_SOURCE_LAUNCH_ID","owned",1);
    macfx::SourceControlReader reader;assert(reader.configured()&&!reader.poll());
    auto document=[](unsigned epoch,id source){return [@{@"schema":@1,@"launchId":@"owned",@"control":@"virtual",@"epoch":@(epoch),
        @"revision":epoch%2?@"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":@"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",@"source":source} mutableCopy];};
    auto bytes=[](id value){return [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];};
    auto write=[&](id value){assert(replaceFile(bytes(value),file));};
    write(document(1,@{@"multiplier":@2}));auto first=reader.poll();assert(first&&first->epoch==1&&first->source->multiplier==2);
    reader.accept(*first);assert(!reader.poll());
    auto size=macfx::renderSourceSize(*first->source,1920,1080,1920,1080);assert(size.width==960&&size.height==540);
    write(document(2,@{@"height":@480,@"maximum":@YES}));auto second=reader.poll();assert(second&&second->source->maximum==480);reader.accept(*second);
    size=macfx::renderSourceSize(*second->source,1920,1080,1920,1080);assert(size.width==854&&size.height==480);
    write(document(1,NSNull.null));assert(fails([&]{reader.poll();}));
    auto equalEpoch=document(2,@{@"height":@360});equalEpoch[@"revision"]=@"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    write(equalEpoch);assert(fails([&]{reader.poll();}));
    for(id source in @[@{@"height":@YES},@{@"height":@0},@{@"height":@1.5},@{@"height":@16385},@{@"multiplier":@0.5},
        @{@"height":@480,@"multiplier":@2},@{@"multiplier":@2,@"maximum":@NO},@{@"height":@480,@"maximum":@1},
        @{@"height":@480,@"method":@"metalfx"},@{@"height":@480,@"unknown":@1},
        @{@"automatic":@NO},@{@"automatic":@0},@{@"automatic":@1},@{@"automatic":@1.5},@{@"automatic":@"true"},@{@"automatic":NSNull.null},
        @{@"automatic":@YES,@"height":@480},@{@"automatic":@YES,@"maximum":@NO},@{@"automatic":@YES,@"multiplier":@2},
        @{@"automatic":@YES,@"method":NSNull.null},@{@"automatic":@YES,@"unknown":@1}])
        assert(fails([&]{macfx::SourceControlReader::parse(bytes(document(3,source)),"owned");}));
    auto automatic=macfx::SourceControlReader::parse(bytes(document(3,@{@"automatic":@YES})),"owned");
    assert(automatic.source&&automatic.source->automatic&&!automatic.source->height&&!automatic.source->maximum&&!automatic.source->multiplier);
    for(id revision in @[@YES,@1,NSNull.null,@"short",@"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",@"gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]){
        auto invalid=document(3,@{@"automatic":@YES});invalid[@"revision"]=revision;
        assert(fails([&]{macfx::SourceControlReader::parse(bytes(invalid),"owned");}));
    }
    auto foreign=document(3,NSNull.null);foreign[@"launchId"]=@"other";
    assert(fails([&]{macfx::SourceControlReader::parse(bytes(foreign),"owned");}));
    auto wrongControl=document(3,NSNull.null);wrongControl[@"control"]=@"engine";
    assert(fails([&]{macfx::SourceControlReader::parse(bytes(wrongControl),"owned");}));
    auto booleanEpoch=document(3,NSNull.null);booleanEpoch[@"epoch"]=@YES;
    assert(fails([&]{macfx::SourceControlReader::parse(bytes(booleanEpoch),"owned");}));
    NSMutableData *huge=[NSMutableData dataWithLength:4097];assert(fails([&]{macfx::SourceControlReader::parse(huge,"owned");}));
    write(document(3,NSNull.null));auto original=reader.poll();assert(original&&!original->source);reader.accept(*original);
    reader.writeStatus(*original,NSNull.null,@"Waiting for a completed frame at the original render source size.");
    auto waiting=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:status] options:0 error:nil];assert([waiting[@"reason"] length]>0);
    reader.writeStatus(*original,NSNull.null,@"");NSData *completed=[NSData dataWithContentsOfFile:status];
    auto result=[NSJSONSerialization JSONObjectWithData:completed options:0 error:nil];assert([result[@"epoch"] unsignedIntValue]==3&&result[@"applied"]==NSNull.null&&![result[@"reason"] length]);
    struct stat before{},after{};assert(!stat(status.fileSystemRepresentation,&before));reader.writeStatus(*original,NSNull.null,@"");
    assert(!stat(status.fileSystemRepresentation,&after)&&before.st_ino==after.st_ino&&before.st_mtimespec.tv_sec==after.st_mtimespec.tv_sec&&before.st_mtimespec.tv_nsec==after.st_mtimespec.tv_nsec);
    write(document(4,@{@"automatic":@YES}));auto adaptive=reader.poll();assert(adaptive&&adaptive->source&&adaptive->source->automatic);reader.accept(*adaptive);assert(!reader.poll());
    size=macfx::renderSourceSize(*adaptive->source,7680,4320,960,540);assert(size.width==1920&&size.height==1080);
    reader.writeStatus(*adaptive,adaptive->requested,@"",true,size);
    auto adaptiveStatus=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:status] options:0 error:nil];
    assert([adaptiveStatus[@"applied"] isEqual:@{@"automatic":@YES}]&&[adaptiveStatus[@"observed"][@"width"] unsignedIntValue]==1920&&[adaptiveStatus[@"sessionReady"] boolValue]);
    assert([NSFileManager.defaultManager removeItemAtPath:file error:nil]);assert(!symlink(status.fileSystemRepresentation,file.fileSystemRepresentation));
    assert(fails([&]{reader.poll();}));
    assert([NSFileManager.defaultManager removeItemAtPath:directory error:nil]);
    std::puts("source control: bounded protocol, immutable requests, monotonic epochs, foreign/invalid rejection, nofollow and status dedup passed");
}}
