// SPDX-License-Identifier: MIT
// First-party fixed-width/POSIX implementation. No SDK declarations or code.
#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <dirent.h>
#include <fcntl.h>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

#define API extern "C" __attribute__((visibility("default")))
using u64 = std::uint64_t;
using u32 = std::uint32_t;
struct Object { void **table; };
using Table = std::array<void *, 80>;
static Table clientTable, modernClientTable, userTable, modernUserTable, friendsTable, modernFriendsTable, utilsTable, modernUtilsTable, appsTable, statsTable, intermediateStatsTable, modernStatsTable, storageTable, modernStorageTable;
static Object client{clientTable.data()}, modernClient{modernClientTable.data()}, user{userTable.data()}, modernUser{modernUserTable.data()}, friends{friendsTable.data()}, modernFriends{modernFriendsTable.data()}, utils{utilsTable.data()}, modernUtils{modernUtilsTable.data()}, apps{appsTable.data()}, stats{statsTable.data()}, intermediateStats{intermediateStatsTable.data()}, modernStats{modernStatsTable.data()}, storage{storageTable.data()}, modernStorage{modernStorageTable.data()};
enum class Family { Any, Client, User, Friends, Utils, Apps, Stats, Storage, Matchmaking, MatchmakingServers, Networking, Screenshots, HTTP, Unified, Controller, UGC, AppList, Music, MusicRemote, HTML, Inventory, Video, GameSearch, Timeline, Input, Parental, RemotePlay, NetworkingMessages, NetworkingSockets, NetworkingUtils, Parties };
struct Service { Family family; Table table{}; Object object{table.data()}; };
static std::array<Service,23> services{{{Family::Matchmaking}, {Family::MatchmakingServers}, {Family::Networking}, {Family::Screenshots}, {Family::HTTP}, {Family::Unified}, {Family::Controller}, {Family::UGC}, {Family::AppList}, {Family::Music}, {Family::MusicRemote}, {Family::HTML}, {Family::Inventory}, {Family::Video}, {Family::GameSearch}, {Family::Timeline}, {Family::Input}, {Family::Parental}, {Family::RemotePlay}, {Family::NetworkingMessages}, {Family::NetworkingSockets}, {Family::NetworkingUtils}, {Family::Parties}}};
static Service modernScreenshots{Family::Screenshots},modernUGC{Family::UGC};
static Table flatClientTable; static Object flatClient{flatClientTable.data()};
static bool manualMode=false,manualHasCurrent=false;

static std::once_flag tableOnce;
static std::recursive_mutex lock;
static int stateFd = -1;
static std::atomic<u32> application{0};
static std::atomic<bool> initialized{false};
static constexpr u64 localUser = 76561197960265729ULL;
static std::string language = "english";
struct Callback { void *object; int type; };
struct CallResult { void *object; int type; u64 call; };
struct Event { int type; std::vector<unsigned char> bytes; u64 call = 0; bool failed = false; };
static std::vector<Callback> callbacks;
static std::vector<CallResult> callResults;
static std::vector<Event> events, manualResults;
static std::vector<unsigned char> manualCurrent;
static unsigned temporaryCounter = 0;
static u64 nextCall = 1;
static u64 contextGeneration = 1;
static void (*warningHook)(int,const char *) = nullptr;
static bool screenshotsHooked = false;
struct Leaderboard { std::string name; u64 handle; int sort; int display; };
static std::vector<Leaderboard> leaderboards;

[[noreturn]] static void unsupported() {
    static constexpr const char *message = "The offline Steam API method is unavailable.\n";
    void (*hook)(int,const char *) = nullptr;
    { std::lock_guard<std::recursive_mutex> guard(lock); hook = warningHook; }
    if (hook) hook(1,message);
    std::fputs(message, stderr); std::fflush(stderr);
    std::_Exit(78);
}
template<class F> static void *address(F function) { return reinterpret_cast<void *>(function); }
static bool token(const char *value, std::string &result) {
    if (!value) return false;
    const auto size = strnlen(value, 121);
    if (!size || size > 120) return false;
    static constexpr char digits[] = "0123456789abcdef";
    result.clear(); result.reserve(size * 2);
    for (std::size_t i = 0; i < size; ++i) {
        const auto byte = static_cast<unsigned char>(value[i]);
        result.push_back(digits[byte >> 4]); result.push_back(digits[byte & 15]);
    }
    return true;
}
static int directoryAt(int parent, const char *name) {
    if (mkdirat(parent, name, 0700) && errno != EEXIST) return -1;
    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}
static bool writeRecord(const std::string &name, const void *bytes, int size) {
    if (stateFd < 0 || !bytes || size < 0 || size > 16 * 1024 * 1024) return false;
    const std::string temporary = ".write-" + std::to_string(getpid()) + "-" + std::to_string(++temporaryCounter);
    const int fd = openat(stateFd, temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    int offset = 0; bool success = true;
    while (offset < size) {
        const auto count = write(fd, static_cast<const char *>(bytes) + offset, static_cast<std::size_t>(size - offset));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { success = false; break; }
        offset += static_cast<int>(count);
    }
    if (success && fsync(fd)) success = false;
    if (close(fd)) success = false;
    if (success && renameat(stateFd, temporary.c_str(), stateFd, name.c_str())) success = false;
    unlinkat(stateFd, temporary.c_str(), 0);
    return success;
}
static int readRecord(const std::string &name, void *bytes, int capacity, int exactSize = -1) {
    if (stateFd < 0 || !bytes || capacity < 0 || capacity > 16 * 1024 * 1024) return -1;
    const int fd = openat(stateFd, name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat info{};
    if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_size < 0 || info.st_size > 16 * 1024 * 1024 ||
        (exactSize >= 0 && info.st_size != exactSize)) { close(fd); return -1; }
    const auto size = static_cast<int>(std::min<off_t>(info.st_size, capacity));
    int offset = 0;
    while (offset < size) {
        const auto count = read(fd, static_cast<char *>(bytes) + offset, static_cast<std::size_t>(size - offset));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { close(fd); return -1; }
        offset += static_cast<int>(count);
    }
    close(fd); return offset;
}
static bool enqueueStats(int type) {
    if (events.size() + manualResults.size() >= 256) return false;
    // Legacy consumer observations: callback1101=20bytes, result at byte8.
    Event event{type, std::vector<unsigned char>(type == 1101 ? 20 : 12)};
    const u64 game = application;
    const int result = 1;
    std::memcpy(event.bytes.data(), &game, 8);
    std::memcpy(event.bytes.data() + 8, &result, 4);
    if (type == 1101) std::memcpy(event.bytes.data() + 12, &localUser, 8);
    events.push_back(std::move(event)); return true;
}
static int handle(Object *) { return initialized ? 1 : 0; }
static bool offline(Object *) { return false; }
static u64 identifier(Object *) { return initialized ? localUser : 0; }
static const char *persona(Object *) { return "Player"; }
static const char *friendPersona(Object *,u64 id) { return id==localUser ? "Player" : ""; }
static bool noUserInformation(Object *,u64,bool) { return false; }
static u32 appId(Object *) { return application; }
static const char *currentLanguage(Object *) { return language.c_str(); }
static bool subscribed(Object *) { return initialized; }
static bool subscribedApplication(Object *, u32 id) { return initialized && id == application; }
static bool noDlc(Object *, u32) { return false; }
static int noCount(Object *) { return 0; }
static bool requestStats(Object *) { std::lock_guard<std::recursive_mutex> guard(lock); return initialized && enqueueStats(1101); }
static bool getAchievement(Object *, const char *name, bool *achieved) {
    std::lock_guard<std::recursive_mutex> guard(lock);
    if (achieved) *achieved = false;
    std::string key; if (!initialized || !achieved || !token(name, key)) return false;
    unsigned char value = 0; const int count = readRecord("achievement-" + key, &value, 1, 1);
    *achieved = count == 1 && value == 1; return count == 1 && value <= 1;
}
static bool achievementValue(const char *name, unsigned char value) {
    std::lock_guard<std::recursive_mutex> guard(lock);
    std::string key; return initialized && token(name, key) && writeRecord("achievement-" + key, &value, 1);
}
static bool setAchievement(Object *, const char *name) { return achievementValue(name, 1); }
static bool clearAchievement(Object *, const char *name) { return achievementValue(name, 0); }
static bool storeStats(Object *) { std::lock_guard<std::recursive_mutex> guard(lock); return initialized && enqueueStats(1102); }
static const char *emptyAttribute(Object *, const char *, const char *) { return ""; }
static bool fileWrite(Object *, const char *name, const void *bytes, int size) { std::lock_guard<std::recursive_mutex> guard(lock); std::string key; return initialized && token(name, key) && writeRecord("remote-" + key, bytes, size); }
static int fileRead(Object *, const char *name, void *bytes, int capacity) { std::lock_guard<std::recursive_mutex> guard(lock); std::string key; if (!initialized || !token(name, key)) return 0; return std::max(0, readRecord("remote-" + key, bytes, capacity)); }
static bool getStatInt(Object *, const char *name, std::int32_t *value) {
    std::lock_guard<std::recursive_mutex> guard(lock); if (value) *value = 0;
    std::string key; return initialized && value && token(name,key) && readRecord("stat-int-"+key,value,4,4)==4;
}
static bool getStatFloat(Object *, const char *name, float *value) {
    std::lock_guard<std::recursive_mutex> guard(lock); if (value) *value = 0;
    std::string key; float stored = 0;
    if (!initialized || !value || !token(name,key) || readRecord("stat-float-"+key,&stored,4,4)!=4 || !std::isfinite(stored)) return false;
    *value = stored; return true;
}
static bool setStatInt(Object *, const char *name, std::int32_t value) {
    std::lock_guard<std::recursive_mutex> guard(lock); std::string key;
    return initialized && token(name,key) && writeRecord("stat-int-"+key,&value,4);
}
static bool setStatFloat(Object *, const char *name, float value) {
    std::lock_guard<std::recursive_mutex> guard(lock); std::string key;
    return initialized && std::isfinite(value) && token(name,key) && writeRecord("stat-float-"+key,&value,4);
}
static bool resetStats(Object *, bool achievements) {
    std::lock_guard<std::recursive_mutex> guard(lock); if (!initialized || stateFd < 0) return false;
    const int duplicate = openat(stateFd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); if (duplicate < 0) return false;
    DIR *directory = fdopendir(duplicate); if (!directory) { close(duplicate); return false; }
    bool success = true; std::size_t seen = 0;
    while (const auto *entry = readdir(directory)) {
        if (++seen > 4096) { success = false; break; }
        const std::string name = entry->d_name;
        const char *prefix = name.rfind("stat-int-",0)==0 ? "stat-int-" : name.rfind("stat-float-",0)==0 ? "stat-float-" :
            achievements && name.rfind("achievement-",0)==0 ? "achievement-" : nullptr;
        if (!prefix) continue;
        const std::string suffix = name.substr(std::strlen(prefix));
        if (suffix.empty() || suffix.size()>240 || suffix.size()%2 || suffix.find_first_not_of("0123456789abcdef")!=std::string::npos) continue;
        if (unlinkat(stateFd,name.c_str(),0) && errno!=ENOENT) success = false;
    }
    closedir(directory); return success;
}
static bool fileDelete(Object *, const char *name) { std::lock_guard<std::recursive_mutex> guard(lock); std::string key; return initialized && token(name,key) && unlinkat(stateFd,("remote-"+key).c_str(),0)==0; }
static int fileSize(Object *, const char *name) { std::lock_guard<std::recursive_mutex> guard(lock); std::string key; if (!initialized || !token(name,key)) return 0; struct stat info{}; if (fstatat(stateFd,("remote-"+key).c_str(),&info,AT_SYMLINK_NOFOLLOW) || !S_ISREG(info.st_mode) || info.st_size < 0 || info.st_size > 16*1024*1024) return 0; return static_cast<int>(info.st_size); }
static bool fileExists(Object *,const char *name) { std::lock_guard<std::recursive_mutex> guard(lock); std::string key; struct stat info{}; return initialized && token(name,key) && fstatat(stateFd,("remote-"+key).c_str(),&info,AT_SYMLINK_NOFOLLOW)==0 && S_ISREG(info.st_mode) && info.st_size>=0 && info.st_size<=16*1024*1024; }
static bool cloudDisabled(Object *) { return false; }
static bool fileNotPersisted(Object *,const char *) { return false; }
static bool legacyQuotaUnavailable(Object *,u32 *total,u32 *available) { if(total)*total=0;if(available)*available=0;return false; }
static void setWarningHook(Object *,void (*hook)(int,const char *)) { std::lock_guard<std::recursive_mutex> guard(lock); warningHook=hook; }
static void hookScreenshots(Object *,bool enabled) { std::lock_guard<std::recursive_mutex> guard(lock); screenshotsHooked=initialized && enabled; }
static u32 noSubscribedItems(Object *) { return 0; }
static u32 noSubscribedList(Object *,u64 *,u32) { return 0; }
static u64 findOrCreateLeaderboard(Object *, const char *name, int sort, int display) {
    std::lock_guard<std::recursive_mutex> guard(lock);
    std::string key;
    if (!initialized || !token(name, key) || sort < 1 || sort > 2 || display < 1 || display > 3 ||
        events.size() + manualResults.size() >= 256 || nextCall == UINT64_MAX) return 0;
    auto found = std::find_if(leaderboards.begin(), leaderboards.end(), [&key](const Leaderboard &value) { return value.name == key; });
    if (found == leaderboards.end()) {
        if (leaderboards.size() >= 256) return 0;
        const u64 handle = static_cast<u64>(leaderboards.size()) + 1;
        leaderboards.push_back({key, handle, sort, display});
        found = leaderboards.end() - 1;
    }
    // The compiled Lua consumer expects12bytes: handle0..7, found8..11.
    Event event{1104, std::vector<unsigned char>(12), nextCall++};
    const int created = 1;
    std::memcpy(event.bytes.data(), &found->handle, 8);
    std::memcpy(event.bytes.data() + 8, &created, 4);
    const u64 call = event.call;
    events.push_back(std::move(event));
    return call;
}
static u64 currentPlayers(Object *) {
    std::lock_guard<std::recursive_mutex> guard(lock);
    if (!initialized || events.size() + manualResults.size() >= 256 || nextCall == UINT64_MAX) return 0;
    // Unchanged JNI expects8bytes: success byte0, player count bytes4..7.
    // A disconnected service cannot supply an online player count.
    Event event{1107, std::vector<unsigned char>(8), nextCall++};
    const u64 call = event.call; events.push_back(std::move(event)); return call;
}
static bool releasePipe(Object *, int value) { return initialized && value == 1; }
static int connectUser(Object *, int value) { return initialized && value == 1 ? 1 : 0; }
static void releaseUser(Object *, int, int) {}
static void *factory(const char *version,Family family=Family::Any);
template<Family family> static void *getFamily(Object *,int userHandle,int pipeHandle,const char *version) { return userHandle==1 && pipeHandle==1 ? factory(version,family) : nullptr; }
static void *getUtils(Object *,int pipeHandle,const char *version) { return pipeHandle==1 ? factory(version,Family::Utils) : nullptr; }
static void *noInterface(Object *,int,int,const char *) { return nullptr; }
static Object *serviceObject(Family family) { for (auto &service : services) if (service.family==family) return &service.object; return nullptr; }
static void tables() {
    for (auto *table : {&clientTable, &modernClientTable, &userTable, &modernUserTable, &friendsTable, &modernFriendsTable, &utilsTable, &modernUtilsTable, &appsTable, &statsTable, &intermediateStatsTable, &modernStatsTable, &storageTable, &modernStorageTable}) table->fill(address(unsupported));
    for (auto &service : services) service.table.fill(address(unsupported));
    modernScreenshots.table.fill(address(unsupported)); modernUGC.table.fill(address(unsupported)); flatClientTable.fill(address(unsupported));
    // Each getter's family/slot is fixed by the measured legacy context.
    clientTable[0]=address(handle); clientTable[1]=address(releasePipe); clientTable[2]=address(connectUser); clientTable[4]=address(releaseUser);
    clientTable[5]=address(getFamily<Family::User>); clientTable[6]=address(noInterface); clientTable[8]=address(getFamily<Family::Friends>); clientTable[9]=address(getUtils);
    clientTable[10]=address(getFamily<Family::Matchmaking>); clientTable[11]=address(getFamily<Family::MatchmakingServers>); clientTable[12]=address(getFamily<Family::Any>);
    clientTable[13]=address(getFamily<Family::Stats>); clientTable[14]=address(noInterface); clientTable[15]=address(getFamily<Family::Apps>); clientTable[16]=address(getFamily<Family::Networking>); clientTable[17]=address(getFamily<Family::Storage>); clientTable[18]=address(getFamily<Family::Screenshots>);
    clientTable[21]=address(setWarningHook); clientTable[23]=address(getFamily<Family::HTTP>); clientTable[24]=address(getFamily<Family::Unified>); clientTable[25]=address(getFamily<Family::Controller>); clientTable[26]=address(getFamily<Family::UGC>); clientTable[27]=address(getFamily<Family::AppList>); clientTable[28]=address(getFamily<Family::Music>); clientTable[29]=address(getFamily<Family::MusicRemote>); clientTable[30]=address(getFamily<Family::HTML>); clientTable[34]=address(getFamily<Family::Inventory>); clientTable[35]=address(getFamily<Family::Video>);
    // Only the modern client's unchanged measured primary slots are exposed.
    for(const auto slot:{0,1,2,4,5,8,9,13,15,17}) modernClientTable[slot]=clientTable[slot];
    userTable[0]=address(handle); userTable[1]=address(offline); userTable[2]=address(identifier);
    friendsTable[0]=address(persona); friendsTable[2]=address(noCount);
    // The publisher Greenworks bridge measures these newer identity queries.
    modernUserTable=userTable; modernUserTable[24]=address(noCount);
    modernFriendsTable=friendsTable; modernFriendsTable[6]=address(friendPersona); modernFriendsTable[36]=address(noUserInformation);
    utilsTable[9]=address(appId); utilsTable[17]=address(offline); utilsTable[18]=address(offline);
    modernUtilsTable=utilsTable; modernUtilsTable[34]=address(offline);
    appsTable[0]=address(subscribed); appsTable[1]=address(offline); appsTable[2]=address(offline); appsTable[3]=address(offline);
    appsTable[4]=address(currentLanguage); appsTable[5]=address(currentLanguage); appsTable[6]=address(subscribedApplication); appsTable[7]=address(noDlc); appsTable[10]=address(noCount);
    statsTable[0]=address(requestStats); statsTable[1]=address(getStatInt); statsTable[2]=address(getStatFloat); statsTable[3]=address(setStatInt); statsTable[4]=address(setStatFloat);
    statsTable[6]=address(getAchievement); statsTable[7]=address(setAchievement); statsTable[8]=address(clearAchievement); statsTable[10]=address(storeStats); statsTable[12]=address(emptyAttribute); statsTable[21]=address(resetStats); statsTable[22]=address(findOrCreateLeaderboard);
    intermediateStatsTable=statsTable; intermediateStatsTable[33]=address(currentPlayers);
    for(std::size_t slot=0;slot+1<statsTable.size();++slot) modernStatsTable[slot]=statsTable[slot+1];
    modernStatsTable[21]=address(findOrCreateLeaderboard); modernStatsTable[32]=address(currentPlayers);
    storageTable[0]=address(fileWrite); storageTable[1]=address(fileRead); storageTable[6]=address(fileDelete); storageTable[13]=address(fileExists); storageTable[14]=address(fileNotPersisted); storageTable[15]=address(fileSize); storageTable[20]=address(legacyQuotaUnavailable); storageTable[21]=address(cloudDisabled); storageTable[22]=address(cloudDisabled);
    modernStorageTable[0]=address(fileWrite); modernStorageTable[1]=address(fileRead);
    for(auto &service:services) {
        if(service.family==Family::Screenshots) service.table[3]=address(hookScreenshots);
        if(service.family==Family::UGC) { service.table[50]=address(noSubscribedItems); service.table[51]=address(noSubscribedList); }
    }
}
static void *factory(const char *version,Family family) {
    if(!version || !initialized || strnlen(version,81)>80) return nullptr;
    std::call_once(tableOnce,tables);
    struct Entry {const char *version; Family family; Object *object;};
    const Entry entries[]={
      {"SteamClient017",Family::Client,&client}, {"SteamClient023",Family::Client,&modernClient}, {"SteamClient021",Family::Client,&flatClient},
      {"SteamUser018",Family::User,&user}, {"SteamUser021",Family::User,&user}, {"SteamUser023",Family::User,&modernUser},
      {"SteamFriends015",Family::Friends,&friends}, {"SteamFriends017",Family::Friends,&friends}, {"SteamFriends018",Family::Friends,&modernFriends},
      {"SteamUtils007",Family::Utils,&utils}, {"SteamUtils010",Family::Utils,&modernUtils},
      {"STEAMAPPS_INTERFACE_VERSION007",Family::Apps,&apps}, {"STEAMAPPS_INTERFACE_VERSION008",Family::Apps,&apps},
      {"STEAMUSERSTATS_INTERFACE_VERSION011",Family::Stats,&stats}, {"STEAMUSERSTATS_INTERFACE_VERSION012",Family::Stats,&intermediateStats}, {"STEAMUSERSTATS_INTERFACE_VERSION013",Family::Stats,&modernStats},
      {"STEAMREMOTESTORAGE_INTERFACE_VERSION013",Family::Storage,&storage}, {"STEAMREMOTESTORAGE_INTERFACE_VERSION016",Family::Storage,&modernStorage},
      {"SteamMatchMaking009",Family::Matchmaking,serviceObject(Family::Matchmaking)}, {"SteamMatchMakingServers002",Family::MatchmakingServers,serviceObject(Family::MatchmakingServers)},
      {"SteamNetworking005",Family::Networking,serviceObject(Family::Networking)}, {"SteamNetworking006",Family::Networking,serviceObject(Family::Networking)},
      {"STEAMSCREENSHOTS_INTERFACE_VERSION002",Family::Screenshots,serviceObject(Family::Screenshots)}, {"STEAMSCREENSHOTS_INTERFACE_VERSION003",Family::Screenshots,&modernScreenshots.object},
      {"STEAMHTTP_INTERFACE_VERSION002",Family::HTTP,serviceObject(Family::HTTP)}, {"STEAMHTTP_INTERFACE_VERSION003",Family::HTTP,serviceObject(Family::HTTP)},
      {"STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001",Family::Unified,serviceObject(Family::Unified)},
      {"SteamController003",Family::Controller,serviceObject(Family::Controller)}, {"SteamController008",Family::Controller,serviceObject(Family::Controller)},
      {"STEAMUGC_INTERFACE_VERSION007",Family::UGC,serviceObject(Family::UGC)}, {"STEAMUGC_INTERFACE_VERSION021",Family::UGC,&modernUGC.object}, {"STEAMUGC_INTERFACE_VERSION020",Family::UGC,&modernUGC.object},
      {"STEAMAPPLIST_INTERFACE_VERSION001",Family::AppList,serviceObject(Family::AppList)},
      {"STEAMMUSIC_INTERFACE_VERSION001",Family::Music,serviceObject(Family::Music)}, {"STEAMMUSICREMOTE_INTERFACE_VERSION001",Family::MusicRemote,serviceObject(Family::MusicRemote)},
      {"STEAMHTMLSURFACE_INTERFACE_VERSION_003",Family::HTML,serviceObject(Family::HTML)}, {"STEAMHTMLSURFACE_INTERFACE_VERSION_005",Family::HTML,serviceObject(Family::HTML)},
      {"STEAMINVENTORY_INTERFACE_V001",Family::Inventory,serviceObject(Family::Inventory)}, {"STEAMINVENTORY_INTERFACE_V003",Family::Inventory,serviceObject(Family::Inventory)},
      {"STEAMVIDEO_INTERFACE_V001",Family::Video,serviceObject(Family::Video)}, {"STEAMVIDEO_INTERFACE_V007",Family::Video,serviceObject(Family::Video)},
      {"SteamMatchGameSearch001",Family::GameSearch,serviceObject(Family::GameSearch)}, {"STEAMTIMELINE_INTERFACE_V001",Family::Timeline,serviceObject(Family::Timeline)}, {"STEAMTIMELINE_INTERFACE_V004",Family::Timeline,serviceObject(Family::Timeline)},
      {"SteamInput006",Family::Input,serviceObject(Family::Input)}, {"STEAMPARENTALSETTINGS_INTERFACE_VERSION001",Family::Parental,serviceObject(Family::Parental)}, {"STEAMREMOTEPLAY_INTERFACE_VERSION003",Family::RemotePlay,serviceObject(Family::RemotePlay)}, {"STEAMREMOTEPLAY_INTERFACE_VERSION002",Family::RemotePlay,serviceObject(Family::RemotePlay)},
      {"SteamNetworkingMessages002",Family::NetworkingMessages,serviceObject(Family::NetworkingMessages)}, {"SteamNetworkingSockets012",Family::NetworkingSockets,serviceObject(Family::NetworkingSockets)}, {"SteamNetworkingUtils004",Family::NetworkingUtils,serviceObject(Family::NetworkingUtils)}, {"SteamParties002",Family::Parties,serviceObject(Family::Parties)}
    };
    for(const auto &entry:entries) if((family==Family::Any || family==entry.family) && !std::strcmp(version,entry.version)) return entry.object;
    return nullptr;
}
API bool SteamAPI_Init() {
    std::lock_guard<std::recursive_mutex> guard(lock);
    if (initialized) return true;
    const char *root = std::getenv("GseSavePath"), *id = std::getenv("SteamAppId");
    if (!root || root[0] != '/' || !id || !*id || strnlen(id, 11) > 10) return false;
    for (const char *digit = id; *digit; ++digit) if (*digit < '0' || *digit > '9') return false;
    char *end = nullptr; const unsigned long value = std::strtoul(id, &end, 10);
    if (*end || value == 0 || value > UINT32_MAX) return false;
    const int parent = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) return false;
    const int isolated = directoryAt(parent, "maclauncher-offline-api-v1"); close(parent);
    if (isolated < 0) return false;
    const std::string namespaceId = std::to_string(value);
    stateFd = directoryAt(isolated, namespaceId.c_str()); close(isolated);
    if (stateFd < 0) return false;
    application = static_cast<u32>(value); initialized = true; ++contextGeneration;
    std::call_once(tableOnce, tables); return true;
}
API bool SteamAPI_InitSafe() { return SteamAPI_Init(); }
API bool SteamAPI_RestartAppIfNecessary(u32) { return false; }
API bool SteamAPI_IsSteamRunning() { return false; }
API int SteamAPI_GetHSteamUser() { return initialized ? 1 : 0; }
API int SteamAPI_GetHSteamPipe() { return initialized ? 1 : 0; }
API void SteamAPI_ReleaseCurrentThreadMemory() {}
API void *SteamInternal_CreateInterface(const char *version) { return factory(version); }
API void *SteamInternal_FindOrCreateUserInterface(int handle, const char *version) { return handle==1 ? factory(version) : handle==0 ? factory(version,Family::Utils) : nullptr; }
API void *SteamInternal_ContextInit(void *data) {
    std::lock_guard<std::recursive_mutex> guard(lock);
    if (!data) return nullptr;
    // Consumer data is an initializer pointer,64-bit counter, then context.
    unsigned char *bytes = static_cast<unsigned char *>(data);
    void (*initialize)(void *) = nullptr; u64 observed = 0;
    std::memcpy(&initialize, bytes, sizeof(initialize));
    std::memcpy(&observed, bytes + 8, 8);
    void *context = bytes + 16;
    if (!initialize) return nullptr;
    if (observed != contextGeneration) {
        initialize(context);
        std::memcpy(bytes + 8, &contextGeneration, 8);
    }
    return context;
}
API int SteamInternal_SteamAPI_Init(const char *, char *error) { if(error)*error=0; return SteamAPI_Init() ? 0 : 1; }
API void *SteamInternal_FindOrCreateGameServerInterface(int, const char *) { return nullptr; }
API int SteamInternal_GameServer_Init_V2(u32, std::uint16_t, std::uint16_t, int, const char *, const char *, char *) { return 1; }
API int SteamGameServer_GetHSteamUser() { return 0; }
API void SteamGameServer_RunCallbacks() {}
API void SteamGameServer_Shutdown() {}
API void *SteamClient() { return factory("SteamClient017"); }
API void SteamAPI_RegisterCallback(void *object, int type) {
    std::lock_guard<std::recursive_mutex> guard(lock);
    if (!object || !initialized) return;
    callbacks.erase(std::remove_if(callbacks.begin(), callbacks.end(), [object](const Callback &value) { return value.object == object; }), callbacks.end());
    if (callbacks.size() >= 256) return;
    callbacks.push_back({object, type});
    static_cast<unsigned char *>(object)[8] |= 1;
    std::memcpy(static_cast<unsigned char *>(object) + 12, &type, 4);
}
API void SteamAPI_UnregisterCallback(void *object) {
    std::lock_guard<std::recursive_mutex> guard(lock);
    callbacks.erase(std::remove_if(callbacks.begin(), callbacks.end(), [object](const Callback &value) { return value.object == object; }), callbacks.end());
    if (object) static_cast<unsigned char *>(object)[8] &= static_cast<unsigned char>(~1);
}
API void SteamAPI_RegisterCallResult(void *object, u64 call) {
    std::lock_guard<std::recursive_mutex> guard(lock);
    if (!object || !call || !initialized) return;
    int type = 0; std::memcpy(&type, static_cast<unsigned char *>(object) + 12, 4);
    const auto duplicate = std::find_if(callResults.begin(), callResults.end(), [object, call](const CallResult &value) { return value.object == object && value.call == call; });
    if (duplicate != callResults.end()) { duplicate->type = type; return; }
    if (callResults.size() < 256) callResults.push_back({object, type, call});
}
API void SteamAPI_UnregisterCallResult(void *object, u64 call) {
    std::lock_guard<std::recursive_mutex> guard(lock);
    callResults.erase(std::remove_if(callResults.begin(), callResults.end(), [object, call](const CallResult &value) { return value.object == object && value.call == call; }), callResults.end());
}
API void SteamAPI_RunCallbacks() {
    std::vector<Event> pending; std::vector<Callback> targets; u64 generation = 0;
    { std::lock_guard<std::recursive_mutex> guard(lock); if (!initialized || manualMode) return; pending.swap(events); targets = callbacks; generation = contextGeneration; }
    for (const auto &event : pending) {
      if (event.call) {
        std::vector<CallResult> results;
        { std::lock_guard<std::recursive_mutex> guard(lock);
          if (!initialized || generation != contextGeneration) return;
          for (const auto &target : callResults) if (target.call == event.call && target.type == event.type) results.push_back(target);
        }
        for (const auto &target : results) {
          std::lock_guard<std::recursive_mutex> guard(lock);
          if (!initialized || generation != contextGeneration) return;
          const auto current = std::find_if(callResults.begin(), callResults.end(), [&target](const CallResult &value) { return value.object == target.object && value.call == target.call; });
          if (current == callResults.end()) continue;
          callResults.erase(current);
          auto **table = *static_cast<void ***>(target.object);
          const auto size = reinterpret_cast<int (*)(void *)>(table[2])(target.object);
          if (size != static_cast<int>(event.bytes.size())) continue;
          // Listener may destroy itself here; do not access it afterwards.
          reinterpret_cast<void (*)(void *, void *, bool, u64)>(table[1])(target.object, const_cast<unsigned char *>(event.bytes.data()), event.failed, event.call);
        }
        continue;
      }
      for (const auto &target : targets) {
        if (target.type != event.type) continue;
        std::lock_guard<std::recursive_mutex> guard(lock); if (!initialized || generation != contextGeneration) return; if (std::none_of(callbacks.begin(), callbacks.end(), [&target](const Callback &current) { return current.object == target.object && current.type == target.type; })) continue;
        auto **table = *static_cast<void ***>(target.object);
        const auto size = reinterpret_cast<int (*)(void *)>(table[2])(target.object);
        if (size != static_cast<int>(event.bytes.size())) continue;
        reinterpret_cast<void (*)(void *, void *)>(table[0])(target.object, const_cast<unsigned char *>(event.bytes.data()));
      }
    }
}
API void SteamAPI_Shutdown() {
    std::lock_guard<std::recursive_mutex> guard(lock);
    for (const auto &callback : callbacks) static_cast<unsigned char *>(callback.object)[8] &= static_cast<unsigned char>(~1);
    callbacks.clear(); callResults.clear(); events.clear(); manualResults.clear(); manualCurrent.clear(); manualHasCurrent=false; manualMode=false; leaderboards.clear(); warningHook=nullptr; screenshotsHooked=false; if (stateFd >= 0) close(stateFd); stateFd = -1; application = 0; initialized = false; ++contextGeneration;
}
API const char *MacLauncher_OfflineABI_Version() { return "maclauncher-offline-abi-0.5.0-universal"; }

// Flat-C contracts are independently expressed from the compiled managed
// consumer's argument and result widths. Unsupported services have no export.
static bool isObject(Object *object,Family family) {
    if(!initialized||!object)return false;
    if(family==Family::Client)return object==&client||object==&modernClient||object==&flatClient;
    if(family==Family::User)return object==&user||object==&modernUser;
    if(family==Family::Friends)return object==&friends||object==&modernFriends;
    if(family==Family::Utils)return object==&utils||object==&modernUtils;
    if(family==Family::Apps)return object==&apps;
    if(family==Family::Stats)return object==&stats||object==&intermediateStats||object==&modernStats;
    if(family==Family::Storage)return object==&storage||object==&modernStorage;
    return object==serviceObject(family);
}
template<Family family> static void *flatProvider(Object *object,int userHandle,int pipeHandle,const char *version) {
    return isObject(object,Family::Client)&&userHandle==1&&pipeHandle==1 ? factory(version,family) : nullptr;
}
#define CLIENT_GETTER(name,family) API void *SteamAPI_ISteamClient_GetISteam##name(Object *object,int userHandle,int pipeHandle,const char *version){return flatProvider<Family::family>(object,userHandle,pipeHandle,version);}
CLIENT_GETTER(User,User) CLIENT_GETTER(Friends,Friends) CLIENT_GETTER(Matchmaking,Matchmaking) CLIENT_GETTER(MatchmakingServers,MatchmakingServers)
CLIENT_GETTER(UserStats,Stats) CLIENT_GETTER(Apps,Apps) CLIENT_GETTER(Networking,Networking) CLIENT_GETTER(RemoteStorage,Storage) CLIENT_GETTER(Screenshots,Screenshots)
CLIENT_GETTER(GameSearch,GameSearch) CLIENT_GETTER(HTTP,HTTP) CLIENT_GETTER(Controller,Controller) CLIENT_GETTER(UGC,UGC) CLIENT_GETTER(Music,Music) CLIENT_GETTER(MusicRemote,MusicRemote)
CLIENT_GETTER(HTMLSurface,HTML) CLIENT_GETTER(Inventory,Inventory) CLIENT_GETTER(Video,Video) CLIENT_GETTER(ParentalSettings,Parental) CLIENT_GETTER(Input,Input) CLIENT_GETTER(Parties,Parties) CLIENT_GETTER(RemotePlay,RemotePlay)
#undef CLIENT_GETTER
API void *SteamAPI_ISteamClient_GetISteamUtils(Object *object,int pipeHandle,const char *version){return isObject(object,Family::Client)&&pipeHandle==1 ? factory(version,Family::Utils):nullptr;}
API u32 SteamAPI_ISteamUtils_GetAppID(Object *object){return isObject(object,Family::Utils)?application.load():0;}
API bool SteamAPI_ISteamUtils_IsOverlayEnabled(Object *){return false;}
API bool SteamAPI_ISteamUtils_BOverlayNeedsPresent(Object *){return false;}
API void SteamAPI_ISteamUtils_SetOverlayNotificationPosition(Object *,int){}
API const char *SteamAPI_ISteamApps_GetCurrentGameLanguage(Object *object){return isObject(object,Family::Apps)?language.c_str():"";}
API const char *SteamAPI_ISteamApps_GetAvailableGameLanguages(Object *object){return SteamAPI_ISteamApps_GetCurrentGameLanguage(object);}
API bool SteamAPI_ISteamApps_BIsSubscribed(Object *object){return isObject(object,Family::Apps);}
API bool SteamAPI_ISteamApps_BIsSubscribedApp(Object *object,u32 id){return isObject(object,Family::Apps)&&id==application;}
API bool SteamAPI_ISteamApps_BIsDlcInstalled(Object *,u32){return false;}
API int SteamAPI_ISteamApps_GetDLCCount(Object *){return 0;}
API bool SteamAPI_ISteamUser_BLoggedOn(Object *){return false;}
API u64 SteamAPI_ISteamUser_GetSteamID(Object *object){return isObject(object,Family::User)?localUser:0;}
API const char *SteamAPI_ISteamFriends_GetPersonaName(Object *object){return isObject(object,Family::Friends)?"Player":"";}
API bool SteamAPI_ISteamUserStats_RequestCurrentStats(Object *object){return isObject(object,Family::Stats)&&requestStats(object);}
API bool SteamAPI_ISteamUserStats_GetStatInt32(Object *object,const char *name,std::int32_t *value){return isObject(object,Family::Stats)&&getStatInt(object,name,value);}
API bool SteamAPI_ISteamUserStats_GetStatFloat(Object *object,const char *name,float *value){return isObject(object,Family::Stats)&&getStatFloat(object,name,value);}
API bool SteamAPI_ISteamUserStats_SetStatInt32(Object *object,const char *name,std::int32_t value){return isObject(object,Family::Stats)&&setStatInt(object,name,value);}
API bool SteamAPI_ISteamUserStats_SetStatFloat(Object *object,const char *name,float value){return isObject(object,Family::Stats)&&setStatFloat(object,name,value);}
API bool SteamAPI_ISteamUserStats_GetAchievement(Object *object,const char *name,bool *achieved){return isObject(object,Family::Stats)&&getAchievement(object,name,achieved);}
API bool SteamAPI_ISteamUserStats_SetAchievement(Object *object,const char *name){return isObject(object,Family::Stats)&&setAchievement(object,name);}
API bool SteamAPI_ISteamUserStats_ClearAchievement(Object *object,const char *name){return isObject(object,Family::Stats)&&clearAchievement(object,name);}
API bool SteamAPI_ISteamUserStats_StoreStats(Object *object){return isObject(object,Family::Stats)&&storeStats(object);}
API bool SteamAPI_ISteamUserStats_ResetAllStats(Object *object,bool achievements){return isObject(object,Family::Stats)&&resetStats(object,achievements);}
API u64 SteamAPI_ISteamUserStats_FindOrCreateLeaderboard(Object *object,const char *name,int sort,int display){return isObject(object,Family::Stats)?findOrCreateLeaderboard(object,name,sort,display):0;}
API u64 SteamAPI_ISteamUserStats_GetNumberOfCurrentPlayers(Object *object){return isObject(object,Family::Stats)?currentPlayers(object):0;}
API bool SteamAPI_ISteamRemoteStorage_FileWrite(Object *object,const char *name,const void *bytes,int size){return isObject(object,Family::Storage)&&fileWrite(object,name,bytes,size);}
API int SteamAPI_ISteamRemoteStorage_FileRead(Object *object,const char *name,void *bytes,int size){return isObject(object,Family::Storage)?fileRead(object,name,bytes,size):0;}
API bool SteamAPI_ISteamRemoteStorage_FileExists(Object *object,const char *name){return isObject(object,Family::Storage)&&fileExists(object,name);}
API bool SteamAPI_ISteamRemoteStorage_FileDelete(Object *object,const char *name){return isObject(object,Family::Storage)&&fileDelete(object,name);}
API int SteamAPI_ISteamRemoteStorage_GetFileSize(Object *object,const char *name){return isObject(object,Family::Storage)?fileSize(object,name):0;}
API bool SteamAPI_ISteamRemoteStorage_IsCloudEnabledForAccount(Object *){return false;}
API bool SteamAPI_ISteamRemoteStorage_IsCloudEnabledForApp(Object *){return false;}
API void SteamAPI_ISteamRemoteStorage_SetCloudEnabledForApp(Object *,bool){}
API bool SteamAPI_ISteamRemoteStorage_GetQuota(Object *,u64 *total,u64 *available){if(total)*total=0;if(available)*available=0;return false;}
API void SteamAPI_ManualDispatch_Init(){std::lock_guard<std::recursive_mutex>guard(lock);if(initialized&&!manualMode){manualMode=true;enqueueStats(1101);}}
API void SteamAPI_ManualDispatch_RunFrame(int){}
API bool SteamAPI_ManualDispatch_GetNextCallback(int pipe,void *output){
    std::lock_guard<std::recursive_mutex>guard(lock);
    if(!initialized||!manualMode||pipe!=1||!output||manualHasCurrent||events.empty())return false;
    Event event=std::move(events.front());events.erase(events.begin());int type=event.type;
    if(event.call){
        if(manualResults.size()>=256)return false;
        manualCurrent.assign(16,0);const u32 size=static_cast<u32>(event.bytes.size());
        std::memcpy(manualCurrent.data(),&event.call,8);std::memcpy(manualCurrent.data()+8,&type,4);std::memcpy(manualCurrent.data()+12,&size,4);
        manualResults.push_back(std::move(event));type=703;
    }else manualCurrent=std::move(event.bytes);
    const int userHandle=1,size=static_cast<int>(manualCurrent.size());const void *data=manualCurrent.data();auto *bytes=static_cast<unsigned char *>(output);
    // Both measured CPU slices use these offsets; write only the20known bytes.
    std::memcpy(bytes,&userHandle,4);std::memcpy(bytes+4,&type,4);std::memcpy(bytes+8,&data,8);std::memcpy(bytes+16,&size,4);manualHasCurrent=true;return true;
}
API void SteamAPI_ManualDispatch_FreeLastCallback(int pipe){std::lock_guard<std::recursive_mutex>guard(lock);if(pipe==1){manualHasCurrent=false;manualCurrent.clear();}}
API bool SteamAPI_ManualDispatch_GetAPICallResult(int pipe,u64 call,void *output,int size,int type,bool *failed){
    std::lock_guard<std::recursive_mutex>guard(lock);if(failed)*failed=true;
    if(!initialized||!manualMode||pipe!=1||!call||!output||!failed)return false;
    const auto event=std::find_if(manualResults.begin(),manualResults.end(),[call](const Event &value){return value.call==call;});
    if(event==manualResults.end()||event->type!=type||size!=static_cast<int>(event->bytes.size()))return false;
    std::memcpy(output,event->bytes.data(),event->bytes.size());*failed=event->failed;manualResults.erase(event);return true;
}
