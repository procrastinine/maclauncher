#include <string>
#include <unordered_map>
namespace android {
struct RegJNIRec {int (*mProc)(void *);};
static int registration(void *){return 0;}
static const std::unordered_map<std::string,RegJNIRec> gRegJNIMap={
    {"x/y/Z",{registration}},
    {"outside.graphics.with.a.long.registry.key",{registration}}
};
}
extern "C" int register_android_graphics_classes(void *){return android::gRegJNIMap.size();}
