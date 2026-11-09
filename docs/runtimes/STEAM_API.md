# Steam API support

Games that use the Steam API either load their own Steam library, which talks to a running Steam client, or use MacLauncher's included offline Steam API helper, which supplies local Steam state without a client. This page describes both, and when Play starts the Steam client.

## Native Mac games from a Steam library

A native Mac app imported from an installed `steamapps/common` game uses the matching Steam application manifest and the game's original Steam libraries. A detected native app keeps the publisher's runtime unless another runtime is selected. Play supplies the application ID without changing game files, and per-game ReShade settings remain available.

A game that requires Steam needs the Steam client running under the same macOS user and signed in to an account that owns the game. A game with optional Steam support can keep its offline behavior. Steam and the game handle authentication and DRM checks themselves, and publisher launchers and additional DRM keep their own Steam launch requirements.

## Starting the Steam client

Only the game's own Steam API connects to the Steam client. Play can start the Mac Steam client when it is not running, but only for a game that an application manifest in a `steamapps` library identifies, and only in one of these cases:

- The game is a native Mac app whose installation ships the macOS Steam API (`libsteam_api.dylib` or a `steam_api.bundle`). Native apps always run their original library.
- The game uses an engine runtime, and the shared Steam API preparation selects the game's own library.
- The game is a Windows game in CrossOver or Sikarugir that uses the [Steam client bridge](WINDOWS_STEAM.md). For this case, a completed MacLauncher Steam download also identifies the game.

When the preparation selects the included helper instead, Steam is not started, whatever the engine or runtime. A DRM-free copy outside a Steam library never starts Steam, even when it bundles Steamworks. Detection, status, library scans, runtime selection and other actions never start Steam.

Steam starts through Launch Services as a separate application, hidden and without activation where Steam allows it. It therefore runs outside the game's process tree and outside the game's network setting. Steam can still show or activate its window while it starts. Play then waits up to 60 seconds for the client process and for a completed sign-in in Steam's connection log. After a timeout or a failed start, the game starts anyway and its details show a notice. Cancelling Play stops the wait. A Steam client that is already running is used as it is.

### Steam client on Play

The **Steam client on Play** setting in **Settings** has three values, and the inspector has a per-game override:

- **Ask**, the default, shows **Play with Steam?** with **Play with Steam** and **Play Without Steam** before startup when Steam is not running, because the Steam client connects to the Internet. **Play Without Steam** starts the game without starting Steam or waiting for it. When the same Play already asked **Play with Steam?** for the [Steam client bridge](WINDOWS_STEAM.md#play) and received **Play with Steam**, Steam starts without this second question.
- **Don't start** behaves like declining, without a prompt.
- **Start automatically** gives consent to start Steam for later Plays.

Earlier **On** settings become **Ask**. With every value, the game keeps its own Steam API. When Steam's process state cannot be checked, Play neither asks nor starts Steam, and the game's details show a notice. On the command line, Play asks **Play with Steam?** on a terminal, and `--yes` gives consent; without a terminal and without `--yes`, the game launches without starting Steam.

### Network isolation

With network access off, the game's own Steam API can still reach a running Steam client through the client's local endpoints, whatever the startup setting. [Network isolation](NETWORK_ISOLATION.md) lists the endpoints. The game's other network and loopback connections stay blocked, and the Steam client keeps its own connection.

### Windows games

Windows games that ship `steam_api.dll` or `steam_api64.dll` run in CrossOver or Sikarugir environments, which the Steam client for Mac does not serve on its own. The optional [Steam client bridge](WINDOWS_STEAM.md) connects them to it, and Play asks to start Steam only when it prepares the bridge for a game. Without the bridge, Play does not start Steam for a Windows game, and a Windows game that requires Steam needs a compatible Windows Steam installation and a launch path that its publisher supports.

## Offline Steam API helper

Play detects compatible native code that calls the Steam API, called a Steam consumer here, and supplies the included offline API automatically. The game's own files are not replaced, and each game gets separate local state. A matching native library from the game takes priority, and games without a Steam dependency get no Steam setup.

The included helper is version `0.5.1`, under the MIT license, for Apple silicon and Intel on macOS 13 or later. It supplies local application identity, language, achievements, statistics, opaque file storage, and native and manual callbacks within fixed limits. It implements the declared offline interface versions, while a game's native libraries supply their own online Steam services. Interface selection checks the exported functions and virtual-call contracts of the original consumer.

[LuaSteam](https://github.com/uspgamedev/luasteam), [steamworks4j](https://github.com/code-disaster/steamworks4j), [Greenworks](https://github.com/greenheartgames/greenworks), legacy GameMaker and .NET (managed) wrappers use separate compatibility profiles. Each profile fixes the CPU, the interfaces and the helper version, plus the bridge version for wrappers with a separate bridge. The helper's source and binary checksums are recorded once, in the helper's package record. Profiles for .NET wrappers also require exact assembly bytes and import tables, and other assemblies keep the full check of their native exports.

Greenworks **Automatic** mode uses the separate included `0.1.1` ticket loader, which supplies the required library exports and rejects ticket checks and decryption. **Native** mode uses imported SDK libraries. Neither included helper needs an SDK, a compiler, a download or an installation step.

## Catalogs and source

The [API catalog](../../src/modules/shared/runtime/steamworks/versions.json), [consumer profiles](../../src/modules/shared/runtime/steamworks/profiles.json) and [ticket catalog](../../src/modules/shared/runtime/steamworks/ticket-versions.json) list the exact versions and contracts. Consumer profiles select their declared helper version and checksums. Earlier profile IDs map to the same consumer contract; explicit helper version choices remain unchanged.

The [API contracts](../../src/modules/shared/runtime/steamworks/native/offline-0.5.0) and [ticket contracts](../../src/modules/shared/runtime/steamworks/native/ticket-0.1.0) hold the fixed-width ABI contracts and MIT notices. MacLauncher Builds compiles the standalone [API source](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/shared/runtime/steamworks/native/offline-0.5.0/source/offline.cpp) and [ticket source](https://github.com/procrastinine/maclauncher-builds/blob/main/producers/package-support/src/modules/shared/runtime/steamworks/native/ticket-0.1.0/source/ticket.cpp) from their helper profiles, sets both deployment targets explicitly and records the source and native checksums. [Development](../development/DEVELOPMENT.md) covers rebuilding the included helpers.
