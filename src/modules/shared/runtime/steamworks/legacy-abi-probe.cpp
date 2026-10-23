// Legacy factory, callback and local persistence smoke; requires the pinned SDK headers.
#include "steam/steam_api.h"
#include "steam/isteamclient017.h"
#include "steam/isteamuser018.h"
#include "steam/isteamfriends015.h"
#include "steam/isteamutils007.h"
#include "steam/isteamapps007.h"
#include "steam/isteamuserstats011.h"
#include "steam/isteamremotestorage013.h"
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>
#include <dlfcn.h>
#include <unistd.h>

static int failures = 0;
static void check(bool ok, const char *what) {
    std::printf("%s %s\n", ok ? "PASS" : "FAIL", what);
    std::fflush(stdout);
    if (!ok) ++failures;
}
static void pump(int ms) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    while (std::chrono::steady_clock::now() < deadline) {
        SteamAPI_RunCallbacks();
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
}
class StatsCallback {
public:
    int count = 0;
    void receive(UserStatsReceived_t *event) { if (event->m_eResult == k_EResultOK) ++count; }
    CCallback<StatsCallback, UserStatsReceived_t> callback;
    StatsCallback() : callback(this, &StatsCallback::receive) {}
};
struct LegacyClientAccess : ISteamClient017 {
    using ISteamClient017::DEPRECATED_GetISteamUnifiedMessages;
};
int main(int argc, char **argv) {
    const bool verify = argc > 1 && std::strcmp(argv[1], "--verify") == 0;
    check(!SteamAPI_RestartAppIfNecessary(480), "no Steam restart request");
    auto initialize = reinterpret_cast<bool (*)()>(dlsym(RTLD_DEFAULT, "SteamAPI_InitSafe"));
    const bool initialized = initialize && initialize();
    check(initialized, "SteamAPI_InitSafe");
    if (!initialized) return 2;
    auto legacyClient = reinterpret_cast<void *(*)()>(dlsym(RTLD_DEFAULT, "SteamClient"));
    void *searched = std::getenv("MACLAUNCHER_STEAM_SETTINGS") ? dlopen("/maclauncher-missing/Contents/MacOS/libsteam_api.dylib", RTLD_NOW | RTLD_LOCAL) : nullptr;
    if (std::getenv("MACLAUNCHER_STEAM_SETTINGS")) check(searched && dlsym(searched, "SteamClient") == reinterpret_cast<void *>(legacyClient), "child DYLD_LIBRARY_PATH resolves an absolute missing library path");
    auto *client = legacyClient ? reinterpret_cast<ISteamClient017 *>(legacyClient()) : nullptr;
    auto *explicitClient = reinterpret_cast<ISteamClient017 *>(SteamInternal_CreateInterface("SteamClient017"));
    check(client && client == explicitClient, "legacy SteamClient017 default factory");
    if (!client || client != explicitClient) return 3;
    const HSteamUser userHandle = SteamAPI_GetHSteamUser();
    const HSteamPipe pipeHandle = SteamAPI_GetHSteamPipe();
    check(userHandle && pipeHandle, "legacy user/pipe handles");
    auto *user = reinterpret_cast<ISteamUser018 *>(client->GetISteamUser(userHandle, pipeHandle, "SteamUser018"));
    auto *friends = reinterpret_cast<ISteamFriends015 *>(client->GetISteamFriends(userHandle, pipeHandle, "SteamFriends015"));
    auto *utils = reinterpret_cast<ISteamUtils007 *>(client->GetISteamUtils(pipeHandle, "SteamUtils007"));
    auto *apps = reinterpret_cast<ISteamApps007 *>(client->GetISteamApps(userHandle, pipeHandle, "STEAMAPPS_INTERFACE_VERSION007"));
    auto *stats = reinterpret_cast<ISteamUserStats011 *>(client->GetISteamUserStats(userHandle, pipeHandle, "STEAMUSERSTATS_INTERFACE_VERSION011"));
    auto *storage = reinterpret_cast<ISteamRemoteStorage013 *>(client->GetISteamRemoteStorage(userHandle, pipeHandle, "STEAMREMOTESTORAGE_INTERFACE_VERSION013"));
    check(user && friends && utils && apps && stats && storage, "legacy primary interface factories");
    check(user && !user->BLoggedOn(), "offline user status");
    check(friends && std::strcmp(friends->GetPersonaName(), std::getenv("MACLAUNCHER_STEAM_SETTINGS") ? "Player" : "MacLauncher Test") == 0, "legacy Friends015 persona vtable");
    check(utils && utils->GetAppID() == 480, "legacy Utils007 app identity vtable");
    check(apps && std::strcmp(apps->GetCurrentGameLanguage(), "english") == 0, "legacy Apps007 language vtable");
    check(client->GetISteamNetworking(userHandle, pipeHandle, "SteamNetworking005"), "Networking005 factory");
    check(client->GetISteamScreenshots(userHandle, pipeHandle, "STEAMSCREENSHOTS_INTERFACE_VERSION002"), "Screenshots002 factory");
    check(client->GetISteamHTTP(userHandle, pipeHandle, "STEAMHTTP_INTERFACE_VERSION002"), "HTTP002 factory");
    check(reinterpret_cast<LegacyClientAccess *>(client)->DEPRECATED_GetISteamUnifiedMessages(userHandle, pipeHandle, "STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001"), "UnifiedMessages001 factory");
    check(client->GetISteamController(userHandle, pipeHandle, "SteamController003"), "Controller003 factory (stub)");
    check(client->GetISteamUGC(userHandle, pipeHandle, "STEAMUGC_INTERFACE_VERSION007"), "UGC007 factory");
    check(client->GetISteamAppList(userHandle, pipeHandle, "STEAMAPPLIST_INTERFACE_VERSION001"), "AppList001 factory");
    check(client->GetISteamMusic(userHandle, pipeHandle, "STEAMMUSIC_INTERFACE_VERSION001"), "Music001 factory");
    check(client->GetISteamMusicRemote(userHandle, pipeHandle, "STEAMMUSICREMOTE_INTERFACE_VERSION001"), "MusicRemote001 factory");
    check(client->GetISteamHTMLSurface(userHandle, pipeHandle, "STEAMHTMLSURFACE_INTERFACE_VERSION_003"), "HTMLSurface003 factory");
    check(client->GetISteamInventory(userHandle, pipeHandle, "STEAMINVENTORY_INTERFACE_V001"), "Inventory001 factory");
    check(client->GetISteamVideo(userHandle, pipeHandle, "STEAMVIDEO_INTERFACE_V001"), "Video001 factory");
    if (!stats || !storage) return 4;
    StatsCallback receiver;
    check(stats->RequestCurrentStats(), "legacy UserStats011 async request");
    pump(500);
    check(receiver.count > 0, "legacy callback register/dispatch ABI");
    constexpr const char *achievement = "MACLAUNCHER_NATIVE_API_PROBE";
    constexpr const char *file = "maclauncher-probe.txt";
    constexpr const char payload[] = "legacy ABI local persistence";
    if (verify) {
        bool achieved = false;
        check(stats->GetAchievement(achievement, &achieved) && achieved, "achievement persists across process restart");
        char restored[sizeof(payload)] = {};
        check(storage->FileRead(file, restored, sizeof(restored)) == sizeof(payload) &&
              std::memcmp(restored, payload, sizeof(payload)) == 0, "RemoteStorage013 local file persists across process restart");
    } else {
        check(stats->SetAchievement(achievement) && stats->StoreStats(), "legacy UserStats011 local achievement write");
        check(storage->FileWrite(file, payload, sizeof(payload)), "legacy RemoteStorage013 local file write");
        pump(300);
    }
    std::printf("READY_FOR_SOCKET_CHECK pid=%d failures=%d\n", getpid(), failures);
    std::fflush(stdout);
    std::this_thread::sleep_for(std::chrono::seconds(5));
    SteamAPI_Shutdown();
    check(true, "SteamAPI_Shutdown");
    return failures ? 1 : 0;
}
