// SPDX-License-Identifier: MIT
// Owned PCM output only. Original compressed audio is decoded separately.
#import <Foundation/Foundation.h>
#import <AVFAudio/AVFAudio.h>
#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <math.h>
#include <stdatomic.h>

#define MAX_WAVE (256u * 1024u * 1024u + 44u)
#define MAX_TOTAL (512u * 1024u * 1024u)
#define MAX_LINE 65536
static NSString *rootPath;
static atomic_uint pendingCommands;
static uint16_t u16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t u32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static BOOL integer(id v, NSInteger lo, NSInteger hi) {
  return [v isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)v) != CFBooleanGetTypeID() &&
    isfinite([v doubleValue]) && floor([v doubleValue]) == [v doubleValue] && [v doubleValue] >= lo && [v doubleValue] <= hi;
}
static BOOL sameStat(struct stat a, struct stat b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
    a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
    a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}
static void emit(NSDictionary *record) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:record options:0 error:NULL];
  if (data && data.length < MAX_LINE) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}
static NSData *wave(NSString *file, NSString *sha, NSDictionary **dimensions) {
  if (![file isKindOfClass:[NSString class]] || file.length > 4096 || ![sha isKindOfClass:[NSString class]] || sha.length != 64) return nil;
  NSCharacterSet *hex = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
  if ([sha rangeOfCharacterFromSet:hex.invertedSet].location != NSNotFound) return nil;
  NSString *directory = [rootPath stringByAppendingPathComponent:@"audio"], *name = file.lastPathComponent;
  if (![[file stringByDeletingLastPathComponent] isEqualToString:directory] || name.length != 68 || ![name hasSuffix:@".wav"] ||
      [[name substringToIndex:64] rangeOfCharacterFromSet:hex.invertedSet].location != NSNotFound) return nil;
  struct stat parent, before, after, current;
  if (lstat(directory.fileSystemRepresentation, &parent) || !S_ISDIR(parent.st_mode) || S_ISLNK(parent.st_mode)) return nil;
  int fd = open(file.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return nil;
  if (fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_size < 46 || before.st_size > MAX_WAVE) { close(fd); return nil; }
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)before.st_size]; NSUInteger offset = 0;
  while (offset < data.length) {
    ssize_t count = read(fd, (uint8_t *)data.mutableBytes + offset, MIN((NSUInteger)1048576, data.length - offset));
    if (count <= 0) { close(fd); return nil; } offset += (NSUInteger)count;
  }
  BOOL stable = !fstat(fd, &after) && !lstat(file.fileSystemRepresentation, &current) && sameStat(before, after) && sameStat(before, current) && !S_ISLNK(current.st_mode);
  close(fd); if (!stable) return nil;
  const uint8_t *b = data.bytes;
  if (memcmp(b,"RIFF",4) || memcmp(b+8,"WAVEfmt ",8) || u32(b+4) != data.length-8 || u32(b+16)!=16 || u16(b+20)!=1 ||
      u16(b+34)!=16 || memcmp(b+36,"data",4) || u32(b+40)!=data.length-44) return nil;
  uint32_t rate = u32(b+24), channels = u16(b+22), bytes = u32(b+40);
  if ((channels!=1 && channels!=2) || rate<8000 || rate>192000 || u16(b+32)!=channels*2 || u32(b+28)!=rate*channels*2 ||
      bytes%(channels*2) || bytes/(channels*2)>(uint64_t)rate*600) return nil;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes,(CC_LONG)data.length,digest);
  NSMutableString *actual = [NSMutableString stringWithCapacity:64]; for(unsigned i=0;i<sizeof(digest);i++) [actual appendFormat:@"%02x",digest[i]];
  if (![actual isEqualToString:sha]) return nil;
  *dimensions = @{@"channels":@(channels),@"sampleRate":@(rate),@"frames":@(bytes/(channels*2))}; return data;
}

@interface AudioOutput : NSObject <AVAudioPlayerDelegate>
@property NSMutableDictionary<NSNumber *, AVAudioPlayer *> *players;
@property NSMutableDictionary<NSNumber *, NSNumber *> *sizes;
- (BOOL)command:(NSDictionary *)record;
- (void)stopAll;
@end
@implementation AudioOutput
- (instancetype)init { self=[super init]; if(self){_players=[NSMutableDictionary dictionary];_sizes=[NSMutableDictionary dictionary];}return self; }
- (void)stopAll { for(AVAudioPlayer *player in _players.allValues){player.delegate=nil;[player stop];}[_players removeAllObjects];[_sizes removeAllObjects]; }
- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)ok {
  NSNumber *key = [_players allKeysForObject:player].firstObject; if(!key)return;
  [_players removeObjectForKey:key]; [_sizes removeObjectForKey:key]; emit(@{@"type":ok?@"finished":@"failed",@"id":key});
}
- (void)audioPlayerDecodeErrorDidOccur:(AVAudioPlayer *)player error:(NSError *)error {
  (void)error; NSNumber *key=[_players allKeysForObject:player].firstObject; if(!key)return;
  player.delegate=nil;[player stop];[_players removeObjectForKey:key];[_sizes removeObjectForKey:key];emit(@{@"type":@"failed",@"id":key});
}
- (BOOL)command:(NSDictionary *)record {
  NSString *type=record[@"type"]; if(![type isKindOfClass:[NSString class]])return NO;
  if([type isEqualToString:@"close"]){[self stopAll];exit(0);}
  if([type isEqualToString:@"inspect"]){
    NSDictionary *dimensions; NSData *data=wave(record[@"path"],record[@"sha256"],&dimensions);if(!data)return NO;
    NSMutableDictionary *response=[dimensions mutableCopy];response[@"type"]=@"inspected";emit(response);return YES;
  }
  NSNumber *key=record[@"id"]; if(!integer(key,1,65535))return NO;
  if([type isEqualToString:@"stop"]){AVAudioPlayer *p=_players[key];if(p){p.delegate=nil;[p stop];[_players removeObjectForKey:key];[_sizes removeObjectForKey:key];}emit(@{@"type":@"stopped",@"id":key});return YES;}
  id value=record[@"gain"]; if(![value isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value)==CFBooleanGetTypeID() || !isfinite([value doubleValue]) || [value doubleValue]<0 || [value doubleValue]>1)return NO;
  if([type isEqualToString:@"gain"]){AVAudioPlayer *p=_players[key];if(!p){emit(@{@"type":@"inactive",@"id":key});return YES;}p.volume=[value floatValue];emit(@{@"type":@"gain",@"id":key});return YES;}
  if(![type isEqualToString:@"play"] || _players[key] || _players.count>=64 || !integer(record[@"loops"],0,65535))return NO;
  NSDictionary *dimensions;NSData *data=wave(record[@"path"],record[@"sha256"],&dimensions);if(!data)return NO;
  NSUInteger total=data.length;for(NSNumber *size in _sizes.allValues)total+=size.unsignedIntegerValue;if(total>MAX_TOTAL)return NO;
  NSError *error=nil; AVAudioPlayer *player=[[AVAudioPlayer alloc] initWithData:data error:&error];
  if(!player || error)return NO;
  player.volume=[value floatValue];player.numberOfLoops=[record[@"loops"] integerValue]==0?-1:[record[@"loops"] integerValue]-1;player.delegate=self;
  if(![player prepareToPlay] || ![player play]){player.delegate=nil;[player stop];return NO;}
  _players[key]=player;_sizes[key]=@(data.length);emit(@{@"type":@"playing",@"id":key});return YES;
}
@end

int main(int argc,const char **argv) { @autoreleasepool {
  if(argc==2 && !strcmp(argv[1],"--version")){puts("maclauncher-catsystem2-pcm-output 1.0.0-ml1 protocol1");return 0;}
  if(argc!=3 || strcmp(argv[1],"--cache-root"))return 2;
  struct stat st;char canonical[PATH_MAX];
  if(lstat(argv[2],&st) || !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode) || !realpath(argv[2],canonical))return 2;
  rootPath=[NSString stringWithUTF8String:canonical]; if(!rootPath)return 2;
  AudioOutput *output=[AudioOutput new];emit(@{@"type":@"ready",@"protocolVersion":@1});
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
    char line[MAX_LINE+1];size_t size=0;uint8_t buffer[4096];ssize_t count;
    while((count=read(STDIN_FILENO,buffer,sizeof(buffer)))>0){
      for(ssize_t i=0;i<count;i++){
        if(buffer[i]=='\n'){
          if(!size)continue;
          if(atomic_fetch_add(&pendingCommands,1)>=256)exit(3);
          @autoreleasepool { NSData *data=[NSData dataWithBytes:line length:size];size=0;
          dispatch_async(dispatch_get_main_queue(),^{ @autoreleasepool {
            id record=[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
            if(![record isKindOfClass:[NSDictionary class]] || ![output command:record]){[output stopAll];emit(@{@"type":@"error"});exit(3);}
            atomic_fetch_sub(&pendingCommands,1);
          }}); }
        }else{if(size>=MAX_LINE || !buffer[i])exit(3);line[size++]=(char)buffer[i];}
      }
    }
    dispatch_async(dispatch_get_main_queue(),^{[output stopAll];exit(size||count<0?3:0);});
  });
  [[NSRunLoop currentRunLoop] run];return 0;
}}
