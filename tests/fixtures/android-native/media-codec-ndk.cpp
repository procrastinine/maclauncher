// Exercises the published NDK ABI in the same JVM as the original Java API.
#include <jni.h>
#include <cstdint>
#if defined(__APPLE__)
using off64_t=int64_t;
#endif
#include <media/NdkMediaFormat.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaExtractor.h>
#include <algorithm>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace {
void require(bool value,const char *message){if(!value)throw std::runtime_error(message);}
struct Utf {
    JNIEnv *env;jstring object;const char *value;
    Utf(JNIEnv*e,jstring s):env(e),object(s),value(e->GetStringUTFChars(s,nullptr)){}
    ~Utf(){if(value)env->ReleaseStringUTFChars(object,value);}
};
struct Library {
    void *core,*value;
    void*(*symbol)(void*,const char*);
    int(*closeImage)(void*);
    explicit Library(const char *path):core(dlopen(path,RTLD_NOW|RTLD_LOCAL)){
        require(core,"Cannot load the shared native image owner");
        auto openImage=reinterpret_cast<void*(*)(const char*,int)>(dlsym(core,"klb_dlopen"));
        symbol=reinterpret_cast<void*(*)(void*,const char*)>(dlsym(core,"klb_dlsym"));
        closeImage=reinterpret_cast<int(*)(void*)>(dlsym(core,"klb_dlclose"));
        require(openImage&&symbol&&closeImage,"Shared loader entrypoints");
        value=openImage("libmediandk.so",RTLD_NOW);require(value,"Original installed libmediandk image");
    }
    ~Library(){if(value)closeImage(value);if(core)dlclose(core);}
    template<class T>T load(const char *name){auto p=reinterpret_cast<T>(symbol(value,name));require(p,name);return p;}
};
struct Api {
#define FUNCTIONS(F) \
 F(AMediaExtractor_new) F(AMediaExtractor_delete) F(AMediaExtractor_setDataSourceFd) \
 F(AMediaExtractor_getTrackCount) F(AMediaExtractor_getTrackFormat) F(AMediaExtractor_selectTrack) \
 F(AMediaExtractor_getSampleSize) F(AMediaExtractor_getSampleTime) F(AMediaExtractor_getSampleFlags) \
 F(AMediaExtractor_readSampleData) F(AMediaExtractor_advance) F(AMediaFormat_delete) \
 F(AMediaFormat_new) F(AMediaFormat_setInt32) F(AMediaFormat_getInt32) F(AMediaFormat_setInt64) F(AMediaFormat_getInt64) F(AMediaFormat_setFloat) F(AMediaFormat_getFloat) F(AMediaFormat_setDouble) F(AMediaFormat_getDouble) F(AMediaFormat_setSize) F(AMediaFormat_getSize) F(AMediaFormat_setRect) F(AMediaFormat_getRect) F(AMediaFormat_setString) F(AMediaFormat_setBuffer) F(AMediaFormat_getBuffer) F(AMediaFormat_toString) F(AMediaFormat_copy) F(AMediaFormat_clear) \
 F(AMediaFormat_getString) F(AMediaCodec_createDecoderByType) F(AMediaCodec_delete) \
 F(AMediaCodec_configure) F(AMediaCodec_start) F(AMediaCodec_flush) F(AMediaCodec_stop) \
 F(AMediaCodec_dequeueInputBuffer) F(AMediaCodec_getInputBuffer) F(AMediaCodec_queueInputBuffer) \
 F(AMediaCodec_dequeueOutputBuffer) F(AMediaCodec_getOutputBuffer) F(AMediaCodec_releaseOutputBuffer) \
 F(AMediaCodec_setAsyncNotifyCallback) F(AMediaCodec_getOutputFormat)
#define MEMBER(name) decltype(&name) name;
    FUNCTIONS(MEMBER)
#undef MEMBER
    explicit Api(Library&library){
#define LOAD(name) name=library.load<decltype(name)>(#name);
        FUNCTIONS(LOAD)
#undef LOAD
    }
#undef FUNCTIONS
};
void formats(Api& a){
    AMediaFormat *format=a.AMediaFormat_new(),*copy=a.AMediaFormat_new();assert(format&&copy);
    char key[32];for(int i=0;i<128;i++){std::snprintf(key,sizeof(key),"field-%d",i);a.AMediaFormat_setInt32(format,key,i*17-500);}
    for(int i=0;i<128;i++){int32_t value=0;std::snprintf(key,sizeof(key),"field-%d",i);assert(a.AMediaFormat_getInt32(format,key,&value)&&value==i*17-500);}
    constexpr int64_t wide=-(INT64_C(1)<<48)+17;constexpr size_t large=(UINT64_C(1)<<34)+37;
    a.AMediaFormat_setInt64(format,"wide",wide);a.AMediaFormat_setFloat(format,"float",1.25f);a.AMediaFormat_setDouble(format,"double",1.23456789012345);
    a.AMediaFormat_setSize(format,"size",large);a.AMediaFormat_setRect(format,"rect",-7,11,6000,9000);a.AMediaFormat_setString(format,"string","Original format 🎵");
    unsigned char bytes[]={0,1,255,8,0,42};a.AMediaFormat_setBuffer(format,"buffer",bytes,sizeof(bytes));bytes[1]=99;
    int64_t actualWide=0;float actualFloat=0;double actualDouble=0;size_t actualSize=0;int32_t left=0,top=0,right=0,bottom=0;
    assert(a.AMediaFormat_getInt64(format,"wide",&actualWide)&&actualWide==wide);
    assert(a.AMediaFormat_getFloat(format,"float",&actualFloat)&&actualFloat==1.25f);
    assert(a.AMediaFormat_getDouble(format,"double",&actualDouble)&&actualDouble==1.23456789012345);
    assert(a.AMediaFormat_getSize(format,"size",&actualSize)&&actualSize==large);
    assert(a.AMediaFormat_getRect(format,"rect",&left,&top,&right,&bottom)&&left==-7&&top==11&&right==6000&&bottom==9000);
    const char *string=nullptr;assert(a.AMediaFormat_getString(format,"string",&string)&&std::strcmp(string,"Original format 🎵")==0);
    void *buffer=nullptr;size_t length=0;assert(a.AMediaFormat_getBuffer(format,"buffer",&buffer,&length)&&length==sizeof(bytes)&&((unsigned char*)buffer)[1]==1);
    assert(!a.AMediaFormat_getFloat(format,"wide",&actualFloat));assert(std::strstr(a.AMediaFormat_toString(format),"field-127"));
    a.AMediaFormat_setString(copy,"obsolete","must disappear");assert(a.AMediaFormat_copy(copy,format)==AMEDIA_OK);
    assert(!a.AMediaFormat_getString(copy,"obsolete",&string));a.AMediaFormat_clear(format);
    assert(!a.AMediaFormat_getInt64(format,"wide",&actualWide));assert(!a.AMediaFormat_getBuffer(format,"buffer",&buffer,&length));
    assert(a.AMediaFormat_getInt64(copy,"wide",&actualWide)&&actualWide==wide);
    assert(a.AMediaFormat_getBuffer(copy,"buffer",&buffer,&length)&&length==sizeof(bytes)&&((unsigned char*)buffer)[1]==1);
    assert(a.AMediaFormat_getString(copy,"string",&string)&&std::strcmp(string,"Original format 🎵")==0);
    a.AMediaFormat_setString(copy,"string","replacement");assert(a.AMediaFormat_getString(copy,"string",&string)&&std::strcmp(string,"replacement")==0);
    assert(a.AMediaFormat_delete(format)==AMEDIA_OK&&a.AMediaFormat_delete(copy)==AMEDIA_OK);
}

struct Sample {std::vector<uint8_t> bytes;int64_t time;uint32_t flags;};
struct Notifications {
    std::mutex mutex;std::condition_variable changed;unsigned calls=0,active=0;int error=0;
    static void input(AMediaCodec*,void *context,int32_t){
        auto&s=*static_cast<Notifications*>(context);std::lock_guard lock(s.mutex);
        s.active++;s.calls++;s.active--;s.changed.notify_all();
    }
    static void failed(AMediaCodec*,void *context,media_status_t status,int32_t,const char*){
        auto&s=*static_cast<Notifications*>(context);std::lock_guard lock(s.mutex);s.error=status;s.changed.notify_all();
    }
};

unsigned decode(Api&a,AMediaCodec *codec,const std::vector<Sample>&samples,bool checkIndependent){
    ssize_t held=-1;uint8_t*first=nullptr;size_t firstCapacity=0;
    if(checkIndependent){
        held=a.AMediaCodec_dequeueInputBuffer(codec,1000000);require(held>=0,"First input lease missing");
        first=a.AMediaCodec_getInputBuffer(codec,held,&firstCapacity);require(first&&firstCapacity,"First input storage missing");
        first[0]=0x31;
    }
    for(size_t i=0;i<samples.size();i++){
        ssize_t index=(i==0&&held>=0)?held:a.AMediaCodec_dequeueInputBuffer(codec,1000000);
        require(index>=0,"Input dequeue failed");
        size_t capacity=0;uint8_t *bytes=a.AMediaCodec_getInputBuffer(codec,index,&capacity);
        require(bytes&&samples[i].bytes.size()<=capacity,"Input storage is too small");
        if(i==0&&checkIndependent){
            ssize_t second=a.AMediaCodec_dequeueInputBuffer(codec,1000000);require(second>=0&&second!=held,"Input leases are not independent");
            size_t otherCapacity=0;uint8_t*other=a.AMediaCodec_getInputBuffer(codec,second,&otherCapacity);
            require(other&&other!=first&&otherCapacity>=samples[1].bytes.size(),"Input buffers alias");
            other[0]=0x62;require(first[0]==0x31,"Second input write changed first input");
            std::memcpy(bytes,samples[0].bytes.data(),samples[0].bytes.size());
            std::memcpy(other,samples[1].bytes.data(),samples[1].bytes.size());
            require(a.AMediaCodec_queueInputBuffer(codec,index,0,samples[0].bytes.size(),samples[0].time,samples[0].flags)==AMEDIA_OK,"First input queue failed");
            require(a.AMediaCodec_queueInputBuffer(codec,second,0,samples[1].bytes.size(),samples[1].time,samples[1].flags)==AMEDIA_OK,"Second input queue failed");
            ++i;continue;
        }
        std::memcpy(bytes,samples[i].bytes.data(),samples[i].bytes.size());
        require(a.AMediaCodec_queueInputBuffer(codec,index,0,samples[i].bytes.size(),samples[i].time,samples[i].flags)==AMEDIA_OK,"Input queue failed");
    }
    ssize_t eos=a.AMediaCodec_dequeueInputBuffer(codec,1000000);require(eos>=0,"EOS input lease missing");
    require(a.AMediaCodec_queueInputBuffer(codec,eos,0,0,samples.back().time,AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM)==AMEDIA_OK,"EOS queue failed");
    unsigned frames=0;bool ended=false;ssize_t retained=-1;uint8_t*retainedBytes=nullptr;std::vector<uint8_t> copy;
    auto until=std::chrono::steady_clock::now()+std::chrono::seconds(5);
    while(!ended&&std::chrono::steady_clock::now()<until){
        AMediaCodecBufferInfo info={};ssize_t index=a.AMediaCodec_dequeueOutputBuffer(codec,&info,100000);
        if(index==AMEDIACODEC_INFO_TRY_AGAIN_LATER||index==AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED)continue;
        if(index==AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED){
            std::unique_ptr<AMediaFormat,decltype(a.AMediaFormat_delete)> format(a.AMediaCodec_getOutputFormat(codec),a.AMediaFormat_delete);
            require(format!=nullptr,"Output format missing");continue;
        }
        require(index>=0&&info.offset>=0&&info.size>=0,"Output dequeue failed");
        if(info.size){
            size_t capacity=0;uint8_t*bytes=a.AMediaCodec_getOutputBuffer(codec,index,&capacity);
            require(bytes&&static_cast<size_t>(info.offset)+info.size<=capacity,"Output view does not contain its sample");
            ++frames;
            if(retained<0&&checkIndependent){retained=index;retainedBytes=bytes+info.offset;copy.assign(retainedBytes,retainedBytes+info.size);}
            else{
                if(retained>=0){require(index!=retained&&bytes!=retainedBytes,"Output leases alias");require(std::equal(copy.begin(),copy.end(),retainedBytes),"Held output changed during later decode");}
                require(a.AMediaCodec_releaseOutputBuffer(codec,index,false)==AMEDIA_OK,"Output release failed");
            }
        }else require(a.AMediaCodec_releaseOutputBuffer(codec,index,false)==AMEDIA_OK,"Empty output release failed");
        ended=(info.flags&AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM)!=0;
    }
    if(retained>=0)require(a.AMediaCodec_releaseOutputBuffer(codec,retained,false)==AMEDIA_OK,"Held output release failed");
    require(ended&&frames==samples.size(),"Decoder did not drain all frames before EOS");
    return frames;
}

void run(const char*movie,const char*libraryPath){
    Library library(libraryPath);Api a(library);formats(a);
    std::unique_ptr<AMediaExtractor,decltype(a.AMediaExtractor_delete)> source(a.AMediaExtractor_new(),a.AMediaExtractor_delete);
    require(source!=nullptr,"Extractor creation failed");
    int fd=open(movie,O_RDONLY);require(fd>=0,"Movie open failed");struct stat st={};
    int statResult=fstat(fd,&st);int status=statResult?AMEDIA_ERROR_IO:a.AMediaExtractor_setDataSourceFd(source.get(),fd,0,st.st_size);close(fd);
    require(status==AMEDIA_OK&&a.AMediaExtractor_getTrackCount(source.get())==1,"Movie source failed");
    std::unique_ptr<AMediaFormat,decltype(a.AMediaFormat_delete)> format(a.AMediaExtractor_getTrackFormat(source.get(),0),a.AMediaFormat_delete);
    require(format!=nullptr,"Track format missing");const char*mime=nullptr;
    require(a.AMediaFormat_getString(format.get(),"mime",&mime)&&!std::strcmp(mime,"video/avc"),"Expected generated H264 track");
    // The original NDK getString pointer expires on the next getString call;
    // configure also reads this same format. Keep the caller-owned MIME value.
    const std::string mimeValue(mime);
    require(a.AMediaExtractor_selectTrack(source.get(),0)==AMEDIA_OK,"Track selection failed");
    std::vector<Sample> samples;
    do{
        ssize_t size=a.AMediaExtractor_getSampleSize(source.get());require(size>0,"Encoded sample missing");
        Sample sample={std::vector<uint8_t>(size),a.AMediaExtractor_getSampleTime(source.get()),a.AMediaExtractor_getSampleFlags(source.get())};
        require(a.AMediaExtractor_readSampleData(source.get(),sample.bytes.data(),sample.bytes.size())==size,"Encoded sample read failed");
        samples.push_back(std::move(sample));
    }while(a.AMediaExtractor_advance(source.get()));
    require(samples.size()==4,"Generated movie must have four frames");source.reset();

    // Delete waits for the actual callback owner to retire before the caller's
    // callback context can be destroyed. Subsequent decoding exercises workers
    // while the retired owner's callback count must remain unchanged.
    Notifications notifications;unsigned retiredCalls;
    {
        std::unique_ptr<AMediaCodec,decltype(a.AMediaCodec_delete)> async(a.AMediaCodec_createDecoderByType(mimeValue.c_str()),a.AMediaCodec_delete);
        require(async!=nullptr,"Async decoder creation failed");
        AMediaCodecOnAsyncNotifyCallback callbacks={Notifications::input,nullptr,nullptr,Notifications::failed};
        require(a.AMediaCodec_setAsyncNotifyCallback(async.get(),callbacks,&notifications)==AMEDIA_OK,"Callback installation failed");
        require(a.AMediaCodec_configure(async.get(),format.get(),nullptr,nullptr,0)==AMEDIA_OK&&a.AMediaCodec_start(async.get())==AMEDIA_OK,"Async decoder start failed");
        {std::unique_lock lock(notifications.mutex);require(notifications.changed.wait_for(lock,std::chrono::seconds(5),[&]{return notifications.calls||notifications.error;}),"Input callback missing");require(!notifications.error,"Async decoder failed");}
        async.reset();
        {std::lock_guard lock(notifications.mutex);require(notifications.active==0,"Callback still active after delete");retiredCalls=notifications.calls;}
    }
    std::unique_ptr<AMediaCodec,decltype(a.AMediaCodec_delete)> codec(a.AMediaCodec_createDecoderByType(mimeValue.c_str()),a.AMediaCodec_delete);
    require(codec!=nullptr,"Decoder creation failed");
    require(a.AMediaCodec_configure(codec.get(),format.get(),nullptr,nullptr,0)==AMEDIA_OK,"Decoder configure failed");
    format.reset(); // configure must own its original copied format/CSD.
    require(a.AMediaCodec_start(codec.get())==AMEDIA_OK,"Decoder start failed");
    decode(a,codec.get(),samples,true);
    require(a.AMediaCodec_flush(codec.get())==AMEDIA_OK,"Decoder flush failed");
    decode(a,codec.get(),samples,false);
    require(a.AMediaCodec_stop(codec.get())==AMEDIA_OK,"Decoder stop failed");codec.reset();
    {std::lock_guard lock(notifications.mutex);require(notifications.calls==retiredCalls&&!notifications.error,"Retired codec issued a callback");}
}
}

extern "C" JNIEXPORT void JNICALL Java_maclauncher_android_media_MediaCodecProbe_ndkProbe(JNIEnv *env,jclass,jstring movie,jstring library){
    try{
        Utf path(env,movie);if(env->ExceptionCheck()||!path.value)return;
        Utf dylib(env,library);if(env->ExceptionCheck()||!dylib.value)return;
        run(path.value,dylib.value);
    }catch(const std::exception&error){if(!env->ExceptionCheck()){jclass type=env->FindClass("java/lang/AssertionError");if(type){env->ThrowNew(type,error.what());env->DeleteLocalRef(type);}}}
}
