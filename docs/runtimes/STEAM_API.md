# Steam API support

A game that uses the Steam API either loads its own Steam library, which talks to a running Steam client, or uses MacLauncher's included offline Steam API helper, which provides local Steam state without a client. This page covers both cases and when Play starts the Steam client.

## Native Mac games from a Steam library

A native Mac app imported from an installed game in `steamapps/common` uses the matching Steam application manifest and the game's original Steam libraries. It keeps the publisher's runtime unless another runtime is selected. Play supplies the application ID without changing game files, and the per-game ReShade settings remain available.

A game that requires Steam needs the Steam client running under the same macOS user and signed in to an account that owns the game, while a game with optional Steam support can keep its offline behavior. Authentication and DRM checks are left to Steam and the game, and publisher launchers and additional DRM keep their own requirements for starting through Steam.

## Starting the Steam client

Only the game's own Steam API connects to the Steam client. Play can start the Mac Steam client when it is not running, but only for a game identified by an application manifest in a `steamapps` library, and only in one of these cases:

- The game is a native Mac app whose installation ships the macOS Steam API (`libsteam_api.dylib` or a `steam_api.bundle`). Native apps always run their original library.
- The game uses an engine runtime, and Play's Steam API setup, which all engines share, selects the game's own library.
- The game is a Windows game in CrossOver, Sikarugir or WineCX that uses the [Steam client bridge](WINDOWS_STEAM.md). In this case, a completed MacLauncher Steam download also identifies the game.

When the Steam API setup selects the included helper instead, Steam is not started, whatever the engine or runtime. A DRM-free copy outside a Steam library never starts Steam, even when it bundles Steamworks. Detection, status, library scans, runtime selection and other actions never start Steam either.

Play starts Steam through Launch Services as a separate application, hidden and without activation where Steam allows it. Steam therefore runs outside the game's process tree, and the game's network setting does not apply to it. Steam can still show or activate its window while it starts. Play then waits up to 60 seconds for the client process and for a completed sign-in in Steam's connection log. After a timeout or a failed start, the game starts anyway and its details show a notice; cancelling Play stops the wait. A Steam client that is already running is used as it is.

### Steam client on Play

The **Steam client on Play** setting in **Settings** has three values, and the inspector can override it for each game:

- **Ask**, the default, shows **Play with Steam?** with **Play with Steam** and **Play Without Steam** before startup when Steam is not running, because the Steam client connects to the Internet. **Play Without Steam** starts the game without starting Steam or waiting for it. When the same Play already asked **Play with Steam?** for the [Steam client bridge](WINDOWS_STEAM.md#play) and received **Play with Steam**, Steam starts without this second question.
- **Don't start** behaves like declining, without a prompt.
- **Start automatically** gives consent to start Steam for later Plays.

A setting saved as **On** by an earlier version becomes **Ask**. With every value, the game keeps its own Steam API. When Steam's process state cannot be checked, Play neither asks nor starts Steam, and the game's details show a notice. On the command line, Play asks **Play with Steam?** in a terminal, and `--yes` gives consent; without a terminal and without `--yes`, the game launches without starting Steam.

### Network isolation

With network access off, the game's own Steam API can still reach a running Steam client through the client's local endpoints, whatever the startup setting. [Network isolation](NETWORK_ISOLATION.md) lists the endpoints. The game's other network and loopback connections stay blocked, and the Steam client keeps its own connection.

### Windows games

Windows games that ship `steam_api.dll` or `steam_api64.dll` run in CrossOver, Sikarugir or WineCX environments, which the Steam client for Mac does not serve on its own. The optional [Steam client bridge](WINDOWS_STEAM.md) connects them to it, and Play asks to start Steam only when it prepares the bridge for a game. Without the bridge, Play does not start Steam for a Windows game. A Windows game that requires Steam then needs a compatible Windows Steam installation and a launch method that its publisher supports.

## Offline Steam API helper

Play detects compatible native code that calls the Steam API and supplies the included offline API to it automatically. The game's own files are not replaced, and each game gets separate local state. A matching native library from the game takes priority, and a game without a Steam dependency gets no Steam setup at all.

The included helper is version `0.5.1`, licensed under MIT, and runs on Apple silicon and Intel with macOS 13 or later. Within fixed limits, it provides local application information, language, achievements, statistics, opaque file storage, and native and manual callbacks. It implements the offline interface versions it declares; online Steam services come only from a game's own native libraries. To choose interface versions, Play checks the exported functions and virtual-call layouts that the game's original Steam-calling code expects.

Some wrapper libraries have compatibility profiles of their own: [LuaSteam](https://github.com/uspgamedev/luasteam), [steamworks4j](https://github.com/code-disaster/steamworks4j), [Greenworks](https://github.com/greenheartgames/greenworks), legacy GameMaker wrappers and .NET (managed) wrappers. Each profile specifies the CPU, the interfaces and the helper version, and for a wrapper with a separate bridge library also the bridge version. The helper's source and binary checksums are recorded once, in its package record. A profile for a .NET wrapper also requires exact assembly bytes and import tables, while other assemblies still get the full check of their native exports.

In **Automatic** mode, Greenworks uses a second included helper, the `0.1.1` ticket loader, which provides the library exports Greenworks requires and rejects ticket checks and decryption. **Native** mode uses imported SDK libraries instead. Neither included helper needs an SDK, a compiler, a download or an installation step.

## Catalogs and source

The [API catalog](../../src/modules/shared/runtime/steamworks/versions.json), the [compatibility profiles](../../src/modules/shared/runtime/steamworks/profiles.json) and the [ticket catalog](../../src/modules/shared/runtime/steamworks/ticket-versions.json) list the exact versions and interface definitions. Each compatibility profile selects the helper version and checksums that it declares. Profile IDs from earlier versions still refer to the same requirements, and a helper version that was chosen explicitly stays as chosen.

The [API helper](../../src/modules/shared/runtime/steamworks/native/offline-0.5.0) and [ticket loader](../../src/modules/shared/runtime/steamworks/native/ticket-0.1.0) folders each hold a `contracts.json` file with the fixed-width ABI definitions, along with the MIT notices. MacLauncher Builds compiles the standalone [API source](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/shared/runtime/steamworks/native/offline-0.5.0/source/offline.cpp) and [ticket source](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/shared/runtime/steamworks/native/ticket-0.1.0/source/ticket.cpp) according to their helper profiles, sets both deployment targets explicitly, and records the checksums of the source and the native binaries. [Development](../development/DEVELOPMENT.md) covers rebuilding the included helpers.
