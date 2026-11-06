# Windows Steam games

CrossOver and Sikarugir share an optional Steam client bridge. While a Windows game runs, the bridge connects the game's original Steam API to the Steam client for Mac, so account, ownership and ticket requests are answered by Steam itself.

## Play

The bridge applies to a game that includes `steam_api.dll` or `steam_api64.dll` and whose app ID is recorded in a local Steam library manifest or in a completed MacLauncher Steam download. The Steam client for Mac must also be installed. Play does not offer the bridge for any other game.

When the bridge package or its Windows Steam client files are missing, Play asks before downloading them, in one of two ways:

- If Play also downloads another component for the same launch, such as a Wine engine, the bridge is one more line in that download's dialog, with its version, size and purpose.
- Otherwise the bridge has its own dialog, which asks to download Steam client bridge with its version number and names what the download contains. **Download and Play** installs it, and **Play Without It** starts the game through the ordinary route.

After a consented download, preparation continues to the game without another action. A declined or failed download is remembered for that game, and later Plays start it without asking. The game becomes eligible again after an explicit Refresh in the CrossOver, Sikarugir or Steam client bridge section of **Runtimes**, or after the bridge is installed there.

The bridge also needs a running Steam client. When Steam is not running, Play uses the separate **Start Steam for this game?** consent and the per-game startup preference described in [Steam API support](STEAM_API.md#steam-client-on-play). With **Launch without Steam**, or with the **Don't start** setting, the game starts through the ordinary route without the bridge.

## Runtimes and inspector

**Runtimes → Steam client bridge**, under the Compatibility heading, lists the installed and downloadable bridge versions with the usual install and uninstall actions. The section has no default version, because Play uses the newest installed one, and no custom registration, because Play uses only installed bridge packages. Its **Components** card lists the **Windows Steam client files**, with the first twelve characters of their content address once they are installed. Installing a bridge version, from Runtimes or from Play, also installs these files. Uninstalling the last bridge version removes them, and the next eligible Play offers both again.

After a Play that used the bridge, the game's inspector shows a **Steam** row naming the bridge version, for as long as that version stays installed. A game whose last Play did not use the bridge shows no row.

## Downloads and verification

Client discovery and installed status are offline. The Runtimes status reads only the recorded file sizes. A consented component installation reads Valve's current download metadata and verifies the selected archive against its publisher-supplied content address, and the verified files are kept for offline use. The bridge does not require a particular Steam client version, and it does not compare that client's files with a hash list.

## Implementation

The bridge installs into a private Windows environment. An owned helper registers its prefix-local Steam directory and stays alive as the game's parent. An owned loader maps the original Windows Steam client DLL without running its Windows initialization, then redirects its shared exports to `lsteamclient`, which loads the native Mac client library. Unsupported executable exports stop the owned process. The loader does not alter the game, its Steam API or its DRM, and it does not modify the installed Wine runtime or the Steam client for Mac. The initial executable's TLS callbacks can run before the child loader is installed.

The package supplies Windows i386 and x86_64 components and native x86_64 and arm64 components. Native path conversion uses the selected Wine runtime's exported functions, including the Wine 10 interface. A missing package, client or native architecture disables bridge preparation. Native API failures remain subject to the game's client-error handling. An external Windows environment that is already running keeps its existing launch route, while a stopped external environment uses a private clone for the bridge.

Steam and the game's own checks determine whether a title can start. A successful client connection does not establish compatibility with a game's other Windows APIs, graphics or anti-cheat requirements.
