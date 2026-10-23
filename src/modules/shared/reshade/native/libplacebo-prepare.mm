// Copyright (c) MacLauncher contributors. MIT license.
#import <Foundation/Foundation.h>
#include "libplacebo-node.hpp"
#include <CommonCrypto/CommonDigest.h>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
namespace {
std::string sha(NSData *bytes){unsigned char result[CC_SHA256_DIGEST_LENGTH];CC_SHA256(bytes.bytes,CC_LONG(bytes.length),result);static const char hex[]="0123456789abcdef";std::string out;for(auto value:result){out+=hex[value>>4];out+=hex[value&15];}return out;}
NSMutableDictionary *inspect(const char *file){const char *text=rsLibplaceboInspect(file);if(!text)throw std::runtime_error(rsLibplaceboLastError());NSData *data=[NSData dataWithBytes:text length:strlen(text)];return [[NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil] mutableCopy];}
void print(NSDictionary *value){NSData *bytes=[NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];if(!bytes)throw std::runtime_error("The shader metadata could not be encoded.");fwrite(bytes.bytes,1,bytes.length,stdout);putchar('\n');}
}
int main(int argc,const char **argv){@autoreleasepool{try{
    if(argc==2&&std::string(argv[1])=="--filters"){const char *catalog=rsLibplaceboFilters();if(!catalog)throw std::runtime_error(rsLibplaceboLastError());std::puts(catalog);return 0;}
    if(argc!=3&&argc!=4)throw std::runtime_error("Use --inspect FILE or --prepare FILE DESTINATION.");
    const std::string operation=argv[1];if((operation!="--inspect"||argc!=3)&&(operation!="--prepare"||argc!=4))throw std::runtime_error("Use --inspect FILE or --prepare FILE DESTINATION.");
    if(operation=="--inspect"){print(inspect(argv[2]));return 0;}
    NSString *destination=[NSString stringWithUTF8String:argv[3]];if(!destination.isAbsolutePath)throw std::runtime_error("The prepared shader needs an absolute destination.");
    auto manager=[NSFileManager defaultManager];if([manager fileExistsAtPath:destination])throw std::runtime_error("The shader destination already exists.");
    if(![manager createDirectoryAtPath:destination withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:nil])throw std::runtime_error("The prepared shader directory could not be created.");
    try{NSData *source=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]] options:0 error:nil];if(!source||source.length>16*1024*1024)throw std::runtime_error("The shader source is unavailable or too large.");
        // Inspect the exact copied bytes, rather than reopening a mutable
        // original file after parsing its declarations. A .hook contains its
        // shader/texture/buffer declarations; the parser has no file includes.
        NSString *effect=[destination stringByAppendingPathComponent:@"effect.hook"];
        if(![source writeToFile:effect options:NSDataWritingAtomic error:nil])throw std::runtime_error("The prepared shader could not be written.");
        NSMutableDictionary *metadata=inspect(effect.fileSystemRepresentation);if(![metadata[@"rgbCompatible"] boolValue])throw std::runtime_error("This shader has no hook applicable to RGB game frames.");
        metadata[@"files"]=@[@{@"path":@"effect.hook",@"size":@(source.length),@"sha256":[NSString stringWithUTF8String:sha(source).c_str()]}];
        NSData *record=[NSJSONSerialization dataWithJSONObject:metadata options:NSJSONWritingSortedKeys error:nil];if(!record||![record writeToFile:[destination stringByAppendingPathComponent:@"metadata.json"] options:NSDataWritingAtomic error:nil])throw std::runtime_error("The shader resource inventory could not be written.");print(metadata);return 0;
    }catch(...){[manager removeItemAtPath:destination error:nil];throw;}
}catch(const std::exception &error){fprintf(stderr,"%s\n",error.what());return 1;}}}
