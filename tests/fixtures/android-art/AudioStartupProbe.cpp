#define main maclauncher_original_composition_main
#include "composition-root.cpp"
#undef main
#include <atomic>
#include <condition_variable>

// Exercise the production publication owner with Android's original native
// ServiceManager, Binder Parcel and IAudioManager client. The test endpoint
// holds the permission barrier until the publication ordering is observed.
class AudioBarrier final:public BBinder {
 public:
 std::mutex mutex;std::condition_variable condition;
 bool entered=false,released=false;unsigned calls=0;
 const String16&getInterfaceDescriptor()const override{return IAudioManager::descriptor;}
 status_t onTransact(uint32_t code,const Parcel&data,Parcel*reply,uint32_t flags)override{
  if(code!=IAudioManager::PERMISSION_UPDATE_BARRIER)return BBinder::onTransact(code,data,reply,flags);
  if(!data.checkInterface(this))return BAD_TYPE;
  if(!defaultServiceManager()->checkService(String16("media.audio_policy")))return NAME_NOT_FOUND;
  std::unique_lock<std::mutex> guard(mutex);++calls;entered=true;condition.notify_all();
  condition.wait(guard,[this]{return released;});reply->writeNoException();return OK;
 }
};
int main(){
 ProcessState::self()->startThreadPool();auto manager=defaultServiceManager();
 auto audio=sp<AudioBarrier>::make();if(manager->addService(String16("audio"),audio,false)!=OK)return 1;
 auto directory=interface_cast<os::IServiceManager>(IInterface::asBinder(manager));
 auto owner=sp<NativePublication>::make(directory);auto policy=sp<BBinder>::make();
 std::atomic<bool> finished=false;status_t result=UNKNOWN_ERROR;
 std::thread publication([&]{result=owner->publish(policy);finished=true;});
 {std::unique_lock<std::mutex> guard(audio->mutex);audio->condition.wait(guard,[&]{return audio->entered;});
  if(finished)return 2;audio->released=true;audio->condition.notify_all();}
 publication.join();if(result!=OK||!finished||audio->calls!=1)return 3;
 if(owner->publish(policy)!=OK||audio->calls!=1)return 4;
 puts("PASS original native audio publication waits for complete permission replay once");return 0;
}
