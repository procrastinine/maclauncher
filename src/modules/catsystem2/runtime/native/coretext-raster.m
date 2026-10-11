// SPDX-License-Identifier: MIT
// Independently owned font-data raster service; no script or archive execution.
#import <Foundation/Foundation.h>
#import <CoreText/CoreText.h>
#import <CoreGraphics/CoreGraphics.h>
#include <unistd.h>
#include <math.h>

#define MAX_JSON 65536u
#define MAX_FONT (16u * 1024u * 1024u)
#define MAX_TEXT 8192u
#define MAX_PIXELS (4u * 1024u * 1024u)
static BOOL integer(id value, NSInteger low, NSInteger high) {
  return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
    isfinite([value doubleValue]) && floor([value doubleValue]) == [value doubleValue] &&
    [value doubleValue] >= low && [value doubleValue] <= high;
}
static uint32_t word(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static void put(uint8_t *p, uint32_t value) { for(unsigned i=0;i<4;i++) p[i]=(uint8_t)(value >> (i*8)); }
static BOOL exact(void *buffer, size_t length) {
  size_t offset=0; while(offset<length) { ssize_t count=read(STDIN_FILENO,(uint8_t *)buffer+offset,length-offset); if(count<=0)return NO; offset+=(size_t)count; } return YES;
}
static BOOL keys(NSDictionary *record, NSArray<NSString *> *allowed) {
  if(record.count != allowed.count)return NO; for(NSString *key in record)if(![allowed containsObject:key])return NO; return YES;
}
static BOOL triplet(id value) {
  if(![value isKindOfClass:NSArray.class] || [value count]!=3)return NO;
  for(id part in value)if(!integer(part,0,255))return NO; return YES;
}

static NSDictionary *render(NSDictionary *record, NSData *fontData, NSData *textData, NSData **pixels) {
  NSArray *fields=@[@"width",@"height",@"fontBytes",@"textBytes",@"fontSize",@"margin",@"color",@"lineSpacing",@"letterSpacing",@"shadow",@"alignment"];
  if(!keys(record,fields) || !integer(record[@"width"],1,8192) || !integer(record[@"height"],1,8192) ||
    !integer(record[@"fontBytes"],12,MAX_FONT) || !integer(record[@"textBytes"],0,MAX_TEXT) ||
    !integer(record[@"fontSize"],1,256) || !integer(record[@"lineSpacing"],-128,256) || !integer(record[@"letterSpacing"],-128,256) ||
    !triplet(record[@"color"]) || ![record[@"alignment"] isEqual:@"left"] || ![record[@"shadow"] isEqual:@"none"] ||
    ![record[@"margin"] isKindOfClass:NSArray.class] || [record[@"margin"] count]!=4)return nil;
  NSUInteger width=[record[@"width"] unsignedIntegerValue], height=[record[@"height"] unsignedIntegerValue];
  if(width*height>MAX_PIXELS || fontData.length!=[record[@"fontBytes"] unsignedIntegerValue] || textData.length!=[record[@"textBytes"] unsignedIntegerValue])return nil;
  NSArray *margin=record[@"margin"]; for(id value in margin)if(!integer(value,0,8192))return nil;
  CGFloat left=[margin[0] doubleValue], top=[margin[1] doubleValue], right=[margin[2] doubleValue], bottom=[margin[3] doubleValue];
  if(left+right>=width || top+bottom>=height)return nil;
  NSString *text=[[NSString alloc] initWithData:textData encoding:NSUTF8StringEncoding]; if(!text)return nil;
  // Reject unsupported escapes and controls before a partial draw. Newlines
  // are authored paragraph boundaries, not an implicit engine opcode.
  for(NSUInteger i=0;i<text.length;i++){unichar c=[text characterAtIndex:i]; if((c<32 && c!='\n') || c==127 || c=='\\')return nil;}
  const uint8_t *fontBytes=fontData.bytes;
  BOOL sfnt=fontData.length>=12 && ((!memcmp(fontBytes,"OTTO",4)) || (!memcmp(fontBytes,"true",4)) || (!memcmp(fontBytes,"typ1",4)) ||
    (fontBytes[0]==0 && fontBytes[1]==1 && fontBytes[2]==0 && fontBytes[3]==0));
  if(!sfnt)return nil;
  uint32_t tables=(uint32_t)fontBytes[4]<<8 | fontBytes[5]; if(!tables || tables>4096 || 12u+tables*16u>fontData.length)return nil;
  for(uint32_t i=0;i<tables;i++){
    const uint8_t *entry=fontBytes+12+i*16; uint32_t offset=(uint32_t)entry[8]<<24 | (uint32_t)entry[9]<<16 | (uint32_t)entry[10]<<8 | entry[11];
    uint32_t length=(uint32_t)entry[12]<<24 | (uint32_t)entry[13]<<16 | (uint32_t)entry[14]<<8 | entry[15];
    if(offset>fontData.length || length>fontData.length-offset || !memcmp(entry,"COLR",4) || !memcmp(entry,"CBDT",4) || !memcmp(entry,"sbix",4) ||
      !memcmp(entry,"EBDT",4) || !memcmp(entry,"SVG ",4))return nil;
  }
  CGDataProviderRef provider=CGDataProviderCreateWithCFData((__bridge CFDataRef)fontData); if(!provider)return nil;
  CGFontRef graphicFont=CGFontCreateWithDataProvider(provider); CGDataProviderRelease(provider); if(!graphicFont)return nil;
  CTFontRef font=CTFontCreateWithGraphicsFont(graphicFont,[record[@"fontSize"] doubleValue],NULL,NULL); CGFontRelease(graphicFont); if(!font)return nil;
  CGFloat ascent=CTFontGetAscent(font), descent=CTFontGetDescent(font), leading=CTFontGetLeading(font);
  CGFloat step=ascent+descent+leading+[record[@"lineSpacing"] doubleValue];
  if(!isfinite(step) || step<=0){CFRelease(font);return nil;}
  CGColorSpaceRef space=CGColorSpaceCreateDeviceRGB(); NSMutableData *data=[NSMutableData dataWithLength:width*height*4];
  CGContextRef context=CGBitmapContextCreate(data.mutableBytes,width,height,8,width*4,space,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(space); if(!context){CFRelease(font);return nil;}
  CGContextSetTextMatrix(context,CGAffineTransformIdentity); CGContextSetShouldAntialias(context,true);
  CGContextClipToRect(context,CGRectMake(left,bottom,width-left-right,height-top-bottom));
  NSArray *color=record[@"color"]; CGFloat rgba[]={[color[0] doubleValue]/255.0,[color[1] doubleValue]/255.0,[color[2] doubleValue]/255.0,1};
  space=CGColorSpaceCreateDeviceRGB(); CGColorRef ink=CGColorCreate(space,rgba); CGColorSpaceRelease(space);
  NSDictionary *attributes=@{(__bridge NSString *)kCTFontAttributeName:(__bridge id)font,(__bridge NSString *)kCTForegroundColorAttributeName:(__bridge id)ink,
    (__bridge NSString *)kCTKernAttributeName:record[@"letterSpacing"]};
  CGColorRelease(ink);
  CGFloat lineTop=top, endX=left, endY=top; NSUInteger lines=0, glyphs=0, consumed=0; BOOL clipped=NO, ok=YES;
  for(NSString *paragraph in [text componentsSeparatedByString:@"\n"]){
    NSAttributedString *styled=[[NSAttributedString alloc] initWithString:paragraph attributes:attributes];
    CTTypesetterRef typesetter=CTTypesetterCreateWithAttributedString((__bridge CFAttributedStringRef)styled); CFIndex offset=0;
    do {
      if(lineTop+ascent+descent>height-bottom){clipped=YES;break;}
      CFIndex count=paragraph.length?CTTypesetterSuggestLineBreak(typesetter,offset,width-left-right):0;
      if(count<0 || (paragraph.length && count==0)){ok=NO;break;}
      CTLineRef line=CTTypesetterCreateLine(typesetter,CFRangeMake(offset,count)); if(!line){ok=NO;break;}
      // Fallback font substitution would hide an unsupported authored glyph.
      CFArrayRef runs=CTLineGetGlyphRuns(line);
      for(CFIndex r=0;r<CFArrayGetCount(runs);r++){
        CTRunRef run=(CTRunRef)CFArrayGetValueAtIndex(runs,r); CFDictionaryRef a=CTRunGetAttributes(run);
        CTFontRef actual=(CTFontRef)CFDictionaryGetValue(a,kCTFontAttributeName);
        CFStringRef expectedName=CTFontCopyPostScriptName(font), actualName=actual?CTFontCopyPostScriptName(actual):NULL;
        BOOL same=actualName && CFEqual(expectedName,actualName); if(expectedName)CFRelease(expectedName); if(actualName)CFRelease(actualName);
        if(!same){ok=NO;break;}
        CFIndex n=CTRunGetGlyphCount(run); if(n<0 || n>MAX_TEXT){ok=NO;break;}
        CGGlyph *ids=calloc((size_t)MAX(n,1),sizeof(CGGlyph)); if(!ids){ok=NO;break;} CTRunGetGlyphs(run,CFRangeMake(0,0),ids);
        for(CFIndex g=0;g<n;g++)if(!ids[g])ok=NO; free(ids); if(!ok)break; glyphs+=(NSUInteger)n;
      }
      if(ok){CGContextSetTextPosition(context,left,height-lineTop-ascent); CTLineDraw(line,context);
        endX=left+(CGFloat)CTLineGetTypographicBounds(line,NULL,NULL,NULL); endY=lineTop; lines++; consumed+=(NSUInteger)count;}
      CFRelease(line); if(!ok)break; offset+=count; lineTop+=step;
    }while(offset<(CFIndex)paragraph.length);
    CFRelease(typesetter); if(!ok || clipped)break;
  }
  CGContextRelease(context); CFRelease(font); if(!ok)return nil;
  uint8_t *bytes=data.mutableBytes;
  // Monochrome outline fonts have one authored ink color. Retain that exact
  // straight color even at low coverage, avoiding premultiplication rounding.
  for(NSUInteger p=0;p<width*height;p++)for(unsigned channel=0;channel<3;channel++)bytes[p*4+channel]=bytes[p*4+3]?[color[channel] unsignedCharValue]:0;
  *pixels=data;
  return @{@"schemaVersion":@1,@"protocolVersion":@"CSTR1",@"width":@(width),@"height":@(height),@"rgbaBytes":@(data.length),
    @"glyphs":@(glyphs),@"lines":@(lines),@"consumedUtf16":@(consumed),@"clipped":@(clipped),@"endX":@(endX),@"endY":@(endY)};
}

int main(int argc,const char **argv){@autoreleasepool{
  if(argc==2 && !strcmp(argv[1],"--version")){puts("maclauncher-catsystem2-coretext 1.0.0-ml1 CSTR1");return 0;}
  if(argc!=1)return 2; uint8_t header[8]; if(!exact(header,sizeof(header)) || memcmp(header,"CSTR",4))return 2;
  uint32_t size=word(header+4); if(!size || size>MAX_JSON)return 2;
  NSMutableData *json=[NSMutableData dataWithLength:size]; if(!exact(json.mutableBytes,size))return 2;
  id object=[NSJSONSerialization JSONObjectWithData:json options:0 error:NULL]; if(![object isKindOfClass:NSDictionary.class])return 2;
  if(!integer(object[@"fontBytes"],12,MAX_FONT) || !integer(object[@"textBytes"],0,MAX_TEXT))return 2;
  NSMutableData *font=[NSMutableData dataWithLength:[object[@"fontBytes"] unsignedIntegerValue]],*text=[NSMutableData dataWithLength:[object[@"textBytes"] unsignedIntegerValue]];
  if(!exact(font.mutableBytes,font.length) || !exact(text.mutableBytes,text.length))return 2;
  uint8_t trailing; ssize_t tail=read(STDIN_FILENO,&trailing,1); if(tail!=0)return 2;
  NSData *pixels=nil; NSDictionary *receipt=render(object,font,text,&pixels); if(!receipt || !pixels)return 3;
  NSData *metadata=[NSJSONSerialization dataWithJSONObject:receipt options:NSJSONWritingSortedKeys error:NULL]; if(!metadata || metadata.length>MAX_JSON)return 3;
  uint8_t output[12];memcpy(output,"CSTR",4);put(output+4,(uint32_t)metadata.length);put(output+8,(uint32_t)pixels.length);
  if(fwrite(output,1,sizeof(output),stdout)!=sizeof(output) || fwrite(metadata.bytes,1,metadata.length,stdout)!=metadata.length || fwrite(pixels.bytes,1,pixels.length,stdout)!=pixels.length || fflush(stdout))return 4;
  return 0;
}}
