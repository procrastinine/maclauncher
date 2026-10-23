#include <string>
#include <unordered_map>
namespace android {
struct RegJNIRec {int (*mProc)(void *);};
static int registration(void *){return 0;}
static const std::unordered_map<std::string,RegJNIRec> gRegJNIMap={
    {"a",{registration}},
    {"android/util/Log",{registration}},
    {"android.util.Log",{registration}},
    {"future.publisher.Native$Nested",{registration}}
};
}
extern "C" int JNI_OnLoad(void *,void *){return android::gRegJNIMap.size();}
