#include <steam_api.h>
#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>

// Maintainer ABI proof only. No AppKit window, game modification or network.
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    const AppId_t appId = static_cast<AppId_t>(std::strtoul(argv[2], nullptr, 10));
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) return 3;
    auto initialize = reinterpret_cast<bool (*)()>(dlsym(library, "SteamAPI_Init"));
    auto factory = reinterpret_cast<void *(*)(const char *)>(dlsym(library, "SteamInternal_CreateInterface"));
    auto findUser = reinterpret_cast<void *(*)(int, const char *)>(dlsym(library, "SteamInternal_FindOrCreateUserInterface"));
    auto shutdown = reinterpret_cast<void (*)()>(dlsym(library, "SteamAPI_Shutdown"));
    if (!initialize || !factory || !findUser || !shutdown || !initialize()) return 4;
    auto *client = static_cast<ISteamClient *>(factory("SteamClient023"));
    if (!client) return 5;
    const HSteamPipe pipe = client->CreateSteamPipe();
    const HSteamUser user = client->ConnectToGlobalUser(pipe);
    if (!pipe || !user) return 6;
    auto *steamUser = client->GetISteamUser(user, pipe, "SteamUser023");
    auto *utils = client->GetISteamUtils(pipe, "SteamUtils010");
    auto *apps = client->GetISteamApps(user, pipe, "STEAMAPPS_INTERFACE_VERSION008");
    auto *stats = client->GetISteamUserStats(user, pipe, "STEAMUSERSTATS_INTERFACE_VERSION013");
    if (!steamUser || !utils || !apps || !stats || !steamUser->GetSteamID().IsValid()) return 7;
    if (utils->GetAppID() != appId || utils->IsSteamRunningOnSteamDeck() || apps->BIsDlcInstalled(0xffffffff)) return 8;
    const char *interfaces[] = {
        "SteamUser023", "SteamFriends018", "SteamUtils010", "SteamController008", "SteamInput006", "SteamNetworking006",
        "SteamNetworkingMessages002", "SteamNetworkingSockets012", "SteamNetworkingUtils004", "SteamParties002",
        "SteamMatchMaking009", "SteamMatchMakingServers002", "STEAMAPPS_INTERFACE_VERSION008",
        "STEAMHTMLSURFACE_INTERFACE_VERSION_005", "STEAMHTTP_INTERFACE_VERSION003", "STEAMINVENTORY_INTERFACE_V003",
        "STEAMMUSIC_INTERFACE_VERSION001", "STEAMPARENTALSETTINGS_INTERFACE_VERSION001", "STEAMREMOTEPLAY_INTERFACE_VERSION003",
        "STEAMREMOTESTORAGE_INTERFACE_VERSION016", "STEAMSCREENSHOTS_INTERFACE_VERSION003", "STEAMUGC_INTERFACE_VERSION021",
        "STEAMUSERSTATS_INTERFACE_VERSION013", "STEAMVIDEO_INTERFACE_V007"
    };
    for (const char *version : interfaces) {
        if (!findUser(user, version)) { std::fprintf(stderr, "Missing interface: %s\n", version); return 9; }
        std::printf("factory=%s\n", version);
    }
    client->ReleaseUser(pipe, user);
    if (!client->BReleaseSteamPipe(pipe)) return 10;
    shutdown();
    std::puts("PASS SteamClient023 typed calls and SDK1.63 client interface factories");
    dlclose(library);
    return 0;
}
