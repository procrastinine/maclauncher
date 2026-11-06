# Windows Steam games

CrossOver and Sikarugir share an optional Steam client bridge. While a Windows game runs, the bridge connects the game's original Steam API to the Steam client for Mac, so account, ownership and ticket requests are answered by Steam itself.

## Play

The bridge applies to a game that includes `steam_api.dll` or `steam_api64.dll` and whose app ID is recorded in a local Steam library manifest or in a completed MacLauncher Steam download. The Steam client for Mac must also be installed. Play does not offer the bridge for any other game.

When the bridge package or its Windows Steam client files are missing, Play asks one question for the game, in one of two ways:

- When no other download is needed, the game gets its own **Play with Steam?** dialog. The dialog names what **Play with Steam** downloads: the Steam client bridge and the Windows Steam client files from Valve, and says that Steam starts when it is not running. **Play with Steam** downloads them and continues to the game, starting Steam for that Play without a second question unless the game's **Steam client on Play** preference is **Don't start**. **Play Without Steam** runs the game through the ordinary route.
- If Play also downloads another component for the same launch, such as a Wine engine, that download's dialog lists the bridge with its version and size and adds an **Also connect to Steam** checkbox, selected by default. With the checkbox selected, approving the dialog has the same effect as **Play with Steam**. Clearing it declines only the bridge, and Play continues with the other download. The dialog keeps that download's own buttons, such as **Download and Play** and **Cancel**, and has no **Play Without Steam** button. **Cancel** stops the Play.

Sizes appear when they are known offline: the bridge's size from its last catalog refresh, and an approximate total for the Windows Steam client files from the last completed download. The Valve total includes every archive downloaded before the client files were found. Without that total, no Valve download size is shown. Neither is read from the network before consent.

**Play Without Steam**, a cleared checkbox or a failed bridge download is kept for that game, and later Plays start it without asking. A Refresh keeps the choice. Installing the bridge in **Runtimes → Steam client bridge** makes every Windows Steam game eligible again, and the dialog states this.

After the bridge is installed, later Plays use it without a dialog while Steam is running. When Steam is not running, Play follows the per-game **Steam client on Play** preference described in [Steam API support](STEAM_API.md#steam-client-on-play). With **Ask**, Play shows the same **Play with Steam?** question with **Play with Steam** and **Play Without Steam**. **Play Without Steam**, or the **Don't start** preference, starts the game through the ordinary route without the bridge.

## Runtimes and inspector

**Runtimes → Steam client bridge**, under the Compatibility heading, lists the installed and downloadable bridge versions with the usual install and uninstall actions. The section has no default version, because Play uses the newest installed one, and no custom registration, because Play uses only installed bridge packages. Its **Components** card lists the **Windows Steam client files**, with the first twelve characters of their content address once they are installed. Installing a bridge version, from Runtimes or from Play, also installs these files. Uninstalling the last bridge version removes them, and the next eligible Play offers both again.

After a Play that used the bridge, the game's inspector shows a **Steam** row naming the bridge version, for as long as that version stays installed. A game whose last Play did not use the bridge shows no row.

## Downloads and verification

Client discovery and installed status are offline. The Runtimes status reads only the recorded file sizes. A consented component installation reads Valve's current download metadata and verifies the selected archive against its publisher-supplied content address, and the verified files are kept for offline use. The bridge does not require a particular Steam client version, and it does not compare that client's files with a hash list.

## Implementation

The game runs in the selected CrossOver bottle or Sikarugir environment. The bridge and Windows Steam client files remain in MacLauncher's managed runtime directories outside that environment. Wine loads them through managed paths, `WINEDLLPATH` and launch-specific DLL overrides. An owned helper writes only the Steam discovery entries under `HKCU\Software\Valve\Steam`, including its own active process ID, the managed client DLL paths, `SteamPath` and `SteamExe`, and stays alive as the game's parent. The bridge creates no environment copy and installs no files into `drive_c`. Ordinary Wine settings and game drive mappings use the selected environment. An owned loader maps the original Windows Steam client DLL without running its Windows initialization, then redirects its shared exports to `lsteamclient`, which loads the native Mac client library. Unsupported executable exports stop the owned process. The loader does not alter the game, its Steam API or its DRM, and it does not modify the installed Wine runtime or the Steam client for Mac. The initial executable's TLS callbacks can run before the child loader is installed.

The package supplies Windows i386 and x86_64 components and native x86_64 and arm64 components. Native path conversion uses the selected Wine runtime's exported functions, including the Wine 10 interface. A missing package, client or native architecture disables bridge preparation. Native API failures remain subject to the game's client-error handling. Existing copies under `steam-environments` are preserved and no longer selected by the bridge. They may contain saves and are not removed automatically.

Steam and the game's own checks determine whether a title can start. A successful client connection does not establish compatibility with a game's other Windows APIs, graphics or anti-cheat requirements.
