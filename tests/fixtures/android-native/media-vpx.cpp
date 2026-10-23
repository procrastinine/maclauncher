// Encoded fixtures exercise production libvpx, the shared MediaCodec owner,
// original NDK clients and retained native Surface delivery. No codec doubles.
#include "MediaCodecOwner.h"
#include "MediaCodecCatalog.h"
#include "VideoDecoder.h"
#include <media/NdkMediaCodec.h>
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
extern "C" int klj_process_ids_configure(const char*);
extern "C" void klj_set_guest_thread_vm(JavaVM*);
using Bytes=std::vector<uint8_t>;
Bytes fixture(const std::string &directory,const std::string &name){std::ifstream input(directory+"/"+name,std::ios::binary);assert(input);return Bytes(std::istreambuf_iterator<char>(input),{});}
void pixels(const uint8_t *bytes,size_t size,int stride,unsigned width,unsigned height,int luma){
    assert(bytes&&stride>=static_cast<int>(width)&&size>=static_cast<size_t>(stride)*(height+(height+1)/2));
    for(unsigned y=0;y<height;y++)for(unsigned x=0;x<width;x++)assert(std::abs(int(bytes[y*stride+x])-luma)<=3);
    const auto *uv=bytes+stride*height;
    for(unsigned y=0;y<(height+1)/2;y++)for(unsigned x=0;x<(width+1)/2;x++){assert(std::abs(int(uv[y*stride+2*x])-90)<=3);assert(std::abs(int(uv[y*stride+2*x+1])-180)<=3);}
}
AMediaFormat *format(const char *mime,int width=16,int height=16){auto *value=AMediaFormat_new();assert(value);AMediaFormat_setString(value,AMEDIAFORMAT_KEY_MIME,mime);AMediaFormat_setInt32(value,AMEDIAFORMAT_KEY_WIDTH,width);AMediaFormat_setInt32(value,AMEDIAFORMAT_KEY_HEIGHT,height);AMediaFormat_setInt32(value,AMEDIAFORMAT_KEY_MAX_INPUT_SIZE,1<<20);return value;}
KLJCodec *create(const char *mime,const KLJCodecSurface *surface=nullptr){auto *codec=klj_codec_create(mime,true,false);assert(codec);auto *f=format(mime);assert(!klj_codec_configure(codec,f,surface,0));AMediaFormat_delete(f);assert(!klj_codec_start(codec));return codec;}
int queue(KLJCodec *codec,const Bytes &bytes,int64_t time,unsigned flags=0){auto input=klj_codec_dequeue_input(codec,1000000);assert(input>=0);size_t capacity=0;auto *data=klj_codec_input_buffer(codec,input,&capacity);assert(data&&capacity>=bytes.size());if(!bytes.empty())std::memcpy(data,bytes.data(),bytes.size());return klj_codec_queue_input(codec,input,0,bytes.size(),time,flags);}
ssize_t output(KLJCodec *codec,KLJCodecBufferInfo &info){
    for(int i=0;i<16;i++){auto index=klj_codec_dequeue_output(codec,&info,1000000);if(index==AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED||index==AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED)continue;return index;}assert(false);return -1;
}
void check(KLJCodec *codec,ssize_t index,int width,int height,int luma){
    auto *f=klj_codec_buffer_format(codec,index);assert(f);int32_t w=0,h=0,stride=0,color=0;
    assert(AMediaFormat_getInt32(f,AMEDIAFORMAT_KEY_WIDTH,&w)&&w==width);assert(AMediaFormat_getInt32(f,AMEDIAFORMAT_KEY_HEIGHT,&h)&&h==height);
    assert(AMediaFormat_getInt32(f,AMEDIAFORMAT_KEY_STRIDE,&stride));assert(AMediaFormat_getInt32(f,AMEDIAFORMAT_KEY_COLOR_FORMAT,&color)&&color==21);AMediaFormat_delete(f);
    size_t size=0;auto *bytes=klj_codec_output_buffer(codec,index,&size);pixels(bytes,size,stride,width,height,luma);
}
void synchronous(const std::string &directory,bool vp9){
    const char *mime=vp9?"video/x-vnd.on2.vp9":"video/x-vnd.on2.vp8";const std::string name=vp9?"vp9":"vp8";
    auto key=fixture(directory,name+"-16-0.bin"),inter=fixture(directory,name+"-16-1.bin"),wide=fixture(directory,name+"-32-0.bin");
    auto *codec=create(mime);KLJCodecBufferInfo info={};assert(!queue(codec,key,-12345));
    auto first=output(codec,info);assert(first>=0&&info.presentationTimeUs==-12345&&info.size>0);check(codec,first,16,16,70);
    size_t heldSize=0;auto *held=klj_codec_output_buffer(codec,first,&heldSize);Bytes heldCopy(held,held+heldSize);
    assert(!queue(codec,inter,54321));auto second=output(codec,info);assert(second>=0&&second!=first&&info.presentationTimeUs==54321);check(codec,second,16,16,100);
    assert(std::equal(heldCopy.begin(),heldCopy.end(),held));assert(!klj_codec_release_output(codec,second,false,0));
    assert(!queue(codec,wide,77777));second=output(codec,info);assert(second>=0&&info.presentationTimeUs==77777);check(codec,second,32,16,70);
    assert(std::equal(heldCopy.begin(),heldCopy.end(),held));assert(!klj_codec_release_output(codec,first,false,0));assert(!klj_codec_release_output(codec,second,false,0));
    assert(!queue(codec,{},90000,AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM));auto end=output(codec,info);assert(end>=0&&info.size==0&&info.presentationTimeUs==90000&&(info.flags&AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM));assert(!klj_codec_release_output(codec,end,false,0));
    assert(!klj_codec_flush(codec));assert(klj_codec_dequeue_output(codec,&info,0)==AMEDIACODEC_INFO_TRY_AGAIN_LATER);
    // Invisible reference packets must not consume output leases indefinitely.
    Bytes hidden=key;hidden[0]&=vp9?~0x02:~0x10;
    for(int i=0;i<40;i++)assert(!queue(codec,hidden,i));
    assert(klj_codec_dequeue_output(codec,&info,0)==AMEDIACODEC_INFO_TRY_AGAIN_LATER);
    assert(!queue(codec,inter,123456));first=output(codec,info);assert(first>=0&&info.presentationTimeUs==123456);check(codec,first,16,16,100);assert(!klj_codec_release_output(codec,first,false,0));
    if(vp9){Bytes showExisting={0x88};assert(!queue(codec,showExisting,222222));first=output(codec,info);assert(first>=0&&info.presentationTimeUs==222222);assert(!klj_codec_release_output(codec,first,false,0));}
    assert(!klj_codec_flush(codec));
    for(int i=0;i<24;i++)assert(!queue(codec,key,i));
    assert(klj_codec_dequeue_input(codec,0)==AMEDIACODEC_INFO_TRY_AGAIN_LATER);
    first=output(codec,info);assert(first>=0);assert(!klj_codec_release_output(codec,first,false,0));
    assert(klj_codec_dequeue_input(codec,0)>=0);assert(!klj_codec_flush(codec));
    assert(queue(codec,Bytes{0},0)!=0);assert(output(codec,info)<0);assert(!klj_codec_flush(codec));
    assert(!queue(codec,key,333333));first=output(codec,info);assert(first>=0&&info.presentationTimeUs==333333);check(codec,first,16,16,70);assert(!klj_codec_release_output(codec,first,false,0));
    if(vp9){assert(queue(codec,fixture(directory,"vp9-profile1-16-0.bin"),0)!=0);assert(!klj_codec_flush(codec));}
    assert(!klj_codec_close(codec));klj_codec_release(codec);
    for(bool oversized:{false,true}){
        codec=klj_codec_create(mime,true,false);assert(codec);auto *f=format(mime,oversized?KLJ_VPX_MAX_WIDTH+1:16);
        if(!oversized)AMediaFormat_setInt32(f,"profile",2);
        assert(klj_codec_configure(codec,f,nullptr,0)==AMEDIA_ERROR_UNSUPPORTED);AMediaFormat_delete(f);klj_codec_close(codec);klj_codec_release(codec);
    }
    std::printf("PASS %s NV12 bytes, independent leases, timestamps, resize, hidden references, backpressure, EOS, flush and errors\n",name.c_str());
}
struct Async {
    static constexpr unsigned target=64;
    KLJCodec *codec=nullptr;Bytes key;std::atomic<unsigned> queued{0};
    std::mutex mutex;std::condition_variable changed;unsigned outputs=0,presented=0,formats=0,rendered=0;bool ended=false;int failure=0;
    static void input(void *opaque,size_t index){auto &s=*static_cast<Async*>(opaque);unsigned n=s.queued.fetch_add(1);if(n>=target)return;size_t capacity=0;auto *bytes=klj_codec_input_buffer(s.codec,index,&capacity);assert(bytes&&capacity>=s.key.size());std::memcpy(bytes,s.key.data(),s.key.size());assert(!klj_codec_queue_input(s.codec,index,0,s.key.size(),444444+n,n+1==target?AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM:0));}
    static void output(void *opaque,size_t index,const KLJCodecBufferInfo *info){auto &s=*static_cast<Async*>(opaque);bool eos=info->flags&AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM;assert(info->presentationTimeUs==444444+(eos?target-1:s.outputs));assert(!klj_codec_release_output(s.codec,index,!eos,0));std::lock_guard lock(s.mutex);s.outputs+=!eos;s.ended|=eos;s.changed.notify_all();}
    static void format(void *opaque,const AMediaFormat *f){auto &s=*static_cast<Async*>(opaque);int32_t value=0;assert(AMediaFormat_getInt32(const_cast<AMediaFormat*>(f),AMEDIAFORMAT_KEY_COLOR_FORMAT,&value)&&value==21);std::lock_guard lock(s.mutex);s.formats++;}
    static void error(void *opaque,int failure){auto &s=*static_cast<Async*>(opaque);std::lock_guard lock(s.mutex);s.failure=failure;s.changed.notify_all();}
    static int present(void *opaque,CVPixelBufferRef pixels,int64_t pts,int64_t,void(*complete)(void*,int64_t),void *completion){
        auto &s=*static_cast<Async*>(opaque);assert(pixels&&pts==444444+s.presented&&CVPixelBufferGetWidth(pixels)==16&&CVPixelBufferIsPlanar(pixels));
        auto type=CVPixelBufferGetPixelFormatType(pixels);assert(type==kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange||type==kCVPixelFormatType_420YpCbCr8BiPlanarFullRange);
        assert(CVPixelBufferLockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly)==kCVReturnSuccess);
        auto *luma=static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pixels,0));assert(std::abs(int(luma[0])-70)<=3);
        CVPixelBufferUnlockBaseAddress(pixels,kCVPixelBufferLock_ReadOnly);
        {std::lock_guard lock(s.mutex);s.presented++;}if(complete)complete(completion,987654321);return 0;
    }
    static void frame(void *opaque,int64_t media,int64_t system){auto &s=*static_cast<Async*>(opaque);assert(media==444444+s.rendered&&system==987654321);std::lock_guard lock(s.mutex);s.rendered++;s.changed.notify_all();}
    void wait(){std::unique_lock lock(mutex);assert(changed.wait_for(lock,std::chrono::seconds(5),[&]{return failure||(ended&&rendered==target);}));assert(!failure&&outputs==target&&presented==target&&formats==1&&rendered==target);}
};
void asynchronous(const std::string &directory,bool vp9){
    Async state;state.key=fixture(directory,std::string(vp9?"vp9":"vp8")+"-16-0.bin");
    KLJCodecSurface surface={&state,nullptr,nullptr,Async::present};state.codec=klj_codec_create(vp9?"video/x-vnd.on2.vp9":"video/x-vnd.on2.vp8",true,false);assert(state.codec);
    auto *f=format(vp9?"video/x-vnd.on2.vp9":"video/x-vnd.on2.vp8");assert(!klj_codec_configure(state.codec,f,&surface,0));AMediaFormat_delete(f);
    KLJCodecCallbacks callbacks={&state,nullptr,nullptr,Async::input,Async::output,Async::format,Async::error};assert(!klj_codec_callbacks(state.codec,&callbacks));
    KLJCodecRenderedCallbacks rendered={&state,nullptr,nullptr,Async::frame};assert(!klj_codec_rendered_callbacks(state.codec,&rendered));assert(!klj_codec_start(state.codec));state.wait();
    assert(!klj_codec_flush(state.codec));{std::lock_guard lock(state.mutex);state.outputs=state.presented=state.formats=state.rendered=0;state.ended=false;state.queued=0;}
    assert(!klj_codec_start(state.codec));state.wait();assert(!klj_codec_close(state.codec));klj_codec_release(state.codec);
    std::printf("PASS %s asynchronous callbacks, NV12 Surface presentation, rendered timestamps and async flush\n",vp9?"vp9":"vp8");
}
void ndk(const std::string &directory,bool vp9){
    auto *codec=AMediaCodec_createDecoderByType(vp9?"video/x-vnd.on2.vp9":"video/x-vnd.on2.vp8");assert(codec);
    auto *f=format(vp9?"video/x-vnd.on2.vp9":"video/x-vnd.on2.vp8");assert(AMediaCodec_configure(codec,f,nullptr,nullptr,0)==AMEDIA_OK);AMediaFormat_delete(f);assert(AMediaCodec_start(codec)==AMEDIA_OK);
    const auto bytes=fixture(directory,std::string(vp9?"vp9":"vp8")+"-16-0.bin");auto index=AMediaCodec_dequeueInputBuffer(codec,1000000);assert(index>=0);size_t capacity=0;auto *data=AMediaCodec_getInputBuffer(codec,index,&capacity);assert(data&&capacity>=bytes.size());std::memcpy(data,bytes.data(),bytes.size());
    assert(AMediaCodec_queueInputBuffer(codec,index,0,bytes.size(),555555,AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM)==AMEDIA_OK);
    bool ended=false;unsigned frames=0;for(int attempts=0;attempts<16&&!ended;attempts++){
        AMediaCodecBufferInfo info={};index=AMediaCodec_dequeueOutputBuffer(codec,&info,1000000);if(index==AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED||index==AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED)continue;
        assert(index>=0&&info.presentationTimeUs==555555);if(info.size){auto *out=AMediaCodec_getOutputFormat(codec);int32_t stride=0;assert(out&&AMediaFormat_getInt32(out,AMEDIAFORMAT_KEY_STRIDE,&stride));AMediaFormat_delete(out);data=AMediaCodec_getOutputBuffer(codec,index,&capacity);pixels(data,capacity,stride,16,16,70);frames++;}
        ended=info.flags&AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM;assert(AMediaCodec_releaseOutputBuffer(codec,index,false)==AMEDIA_OK);
    }
    assert(ended&&frames==1);assert(AMediaCodec_stop(codec)==AMEDIA_OK);assert(AMediaCodec_delete(codec)==AMEDIA_OK);
    std::printf("PASS %s original NDK MediaCodec entry points\n",vp9?"vp9":"vp8");
}
int main(int argc,char **argv){
    assert(argc==2);assert(klj_process_ids_configure(argv[1])>0);klj_set_guest_thread_vm(nullptr);assert(klj_codec_catalog().size()>=4);
    for(bool vp9:{false,true}){synchronous(argv[1],vp9);asynchronous(argv[1],vp9);ndk(argv[1],vp9);}
    std::puts("PASS native VP8/VP9 media integration");
}
