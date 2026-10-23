#define main original_composition_main
#include "composition-root.cpp"
#undef main

int main(int argc,char**argv){
 if(argc!=2)return 2;
 ProcessState::self()->startThreadPool();
 if(strcmp(argv[1],"client")==0){
  auto service=defaultServiceManager()->checkService(String16("connectivity"));
  if(!service||service->getInterfaceDescriptor()!=String16("android.net.IConnectivityManager"))return 3;
  fprintf(stdout,"PASS original cross-UID connectivity lookup\n");return 0;
 }
 auto root=sp<WindowRoot>::make(10021,sp<SurfaceControl>{},sp<IBinder>{},0,sp<NativePublication>{});
 const auto status=defaultServiceManager()->addService(String16("maclauncher.art.window"),root,false);
 if(status!=OK){fprintf(stderr,"Window root registration failed: %d\n",status);return 4;}
 fprintf(stdout,"READY original WindowRoot\n");fflush(stdout);
 IPCThreadState::self()->joinThreadPool();return 0;
}
