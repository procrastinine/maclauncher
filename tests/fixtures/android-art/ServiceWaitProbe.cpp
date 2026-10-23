#include <binder/Binder.h>
#include <binder/IServiceManager.h>
#include <binder/ProcessState.h>
#include <cstdio>
#include <unistd.h>

int main(){
 android::ProcessState::self()->startThreadPool();
 const auto manager=android::defaultServiceManager();
 if(!manager||manager->addService(android::String16("maclauncher.wait.first"),android::sp<android::BBinder>::make())!=android::OK)return 3;
 puts("FIRST");fflush(stdout);
 char command;if(read(STDIN_FILENO,&command,1)!=1)return 4;
 if(manager->addService(android::String16("maclauncher.wait.second"),android::sp<android::BBinder>::make())!=android::OK)return 5;
 puts("SECOND");fflush(stdout);
 return read(STDIN_FILENO,&command,1)==1?0:6;
}
