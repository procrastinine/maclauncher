# LÖVE

[LÖVE](https://github.com/love2d/love) is a framework for 2D games written in Lua. MacLauncher runs LÖVE games with the LÖVE version that matches the game, or with a Mac app supplied with the game, and can export their Lua source.

## Detection and preparation

Import accepts `.love` archives, Windows and Linux fused executables, packaged Linux builds and AppImages, Mac app bundles and source folders, and detection identifies the LÖVE version the game was made for.

Root-level archives and source folders launch from their original location. Linux AppImages are extracted into the game's application data when necessary. An archive whose game sits in a single nested folder is prepared in the game's application data, keeping the original archive, working directory and default save identity. An archive that contains several independent games cannot be imported as one; each game needs its own archive or folder.

Library metadata reads literal `t.window.title` and `t.window.icon` values from `conf.lua`, and accepts `t.title` and `t.icon` from older projects. Source folders, `.love` archives and fused ZIP exports support PNG and WebP artwork. Archive metadata uses the same game root as launch preparation, so nested libraries and examples do not replace the root project. Inspection reads selected resources within fixed limits, without running Lua. When a value is computed by code, the existing file name or bundle metadata and the fallback icon are kept.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| LÖVE (default) | Official release or nightly build from **Runtimes → LÖVE** |
| Game's macOS app | A LÖVE app bundle imported as is |
| CrossOver, Sikarugir (Wine) | Windows runtimes for the game's Windows executable |

An imported LÖVE app bundle can switch to **Game's macOS app**. Packaged `.love` files, fused executables, packaged Linux builds and extracted AppImages use the LÖVE runtime.

### LÖVE runtime

**Runtimes → LÖVE** lists releases and nightly builds:

- Releases come from GitHub releases of `love2d/love` with 64-bit Mac players, from 0.7 onward. Each LÖVE line has its own section: **LÖVE 11**, and a section for each earlier line that is listed or installed, such as **LÖVE 0.10**. Releases install under `userData/runtimes/love/stable/<version>/`.
- **LÖVE 12 nightly** lists GitHub Actions artifacts from the `love2d/love` main-branch workflow, labeled by version and build hash, in a separate catalog. Nightlies install under `userData/runtimes/love/nightly/<buildKey>/`.

Play uses a version chosen for the game, then the detected bundle version, then the channel's default version. A manual per-game version stays exact. For a recommendation or default, an exact local copy is preferred; otherwise Play uses the newest ready installed copy in the same API family. Releases before 1.0 keep their minor line, and LÖVE 11 and 12 remain separate families. In the inspector, **Channel** can keep a game on the LÖVE 11 line or on nightly builds; the detected version then applies only when it belongs to that line, and otherwise the line's default version does. **Automatic** names the line of the version that Play uses when no channel is chosen, such as LÖVE 0.10 for a game made for 0.10.2. Choosing a LÖVE 11 release or a nightly build in the version menu also selects its channel, while a release from an earlier line leaves the channel on **Automatic**. Per-game choices are stored in `runtimeData.love.channel` and `runtimeData.love.version`.

Play reuses an installed release or nightly that matches the detected bundle version. A detected version that has not been released yet falls back to a nightly build, but an explicitly chosen release never switches channels. A saved nightly build reloads its exact artifact metadata when needed, while an unselected latest build uses a limited lookup of the latest artifact.

The nightly catalog reads GitHub's public Actions API and needs no GitHub CLI or account. Refresh lists the newest successful build, and **All versions** lists the builds among the 20 most recent successful runs. Nightly artifacts are downloaded through [nightly.link](https://nightly.link/) and checked against the digest GitHub publishes for each one. Release downloads are checked against the digest GitHub lists for the asset, or their SHA-256 is recorded at installation when GitHub lists none.

Installation checks the actual executable's CPU slices before copying the app, leaving an existing installation intact when the download cannot run. Installed app bundles are checked for broken framework aliases, and app copies keep their aliases inside the bundle after the temporary extraction is removed.

### CPU architecture

Older macOS builds of LÖVE that are x64-only are marked as needing Rosetta on Apple silicon and launch with Rosetta through the shared process launcher. Shared graphics reads the selected LÖVE bundle's executable architecture and keeps its Rosetta requirement: universal bundles use the native slice, and older Intel bundles select compatible Intel graphics providers.

## Source export

**Export source** copies Lua text and recovers compiled scripts into the game's private source folder, and **Reveal source** opens it. It reads source folders, `.love` archives and fused executables, including the packaged game inside native apps and AppImages.

| Input | Tool |
| --- | --- |
| Plain Lua text | Exported directly |
| LuaJIT 2.0 and 2.1 bytecode | [LJD](https://github.com/dol/luajit-decompiler), using the included Python |
| Standard Lua 5.0 to 5.4 bytecode | [unluac](https://sourceforge.net/projects/unluac/), using Temurin Java |

**Runtimes → LÖVE** lists the tool versions in its **LJD** and **unluac** sections. The export keeps the original bytecode, individual recovery failures and logs next to the recovered text. Other bytecode versions are not supported, and stripped or optimized bytecode can lose names or code structure. The export is for inspection and cannot be played in place of the original, and it never runs the game's Lua.

## Steam bridge

For LÖVE games that use Steam, MacLauncher includes a Steam bridge: its own build of the LuaSteam native module, `luasteam.so`, which has no tab in **Runtimes**. Its version is `4.0.2-MCLv1`, based on [LuaSteam v4.0.2](https://github.com/uspgamedev/luasteam/tree/v4.0.2) at `fbb72bd22c0c526f4276800024967323acd9d10d`. It connects the lowercase LuaSteam API to the selected host's Lua 5.1 C API and is compatible with LÖVE 11.5 on Apple silicon and Intel.

Play activates the bridge when the game's original Lua source and native imports show that it needs a compatible LuaSteam, and the game has an explicit Steam application ID of its own. The shared Steam API support prefers a matching native library from the game; its included offline helper supports the bridge through the `luasteam-4.0.2-sdk1.63-ml1-offline-abi0.5.0` compatibility profile, which fixes the bridge version, CPU and interfaces. Optional `pcall(require, "luasteam")` code keeps its existing fallback, including when no application ID is available. DLC numbers are not treated as application IDs. [Steam support](../runtimes/STEAM_API.md) describes helper versions and limits.

The bridge runs from MacLauncher's read-only app resources. Per-game symlinks and library paths, set only for the game process, connect it to the selected host and the shared Steam API library, so shared runtimes and the launcher's environment are unchanged. The bridge is selected separately from LÖVE, and its selection never changes the selected LÖVE release or nightly.

The selected Steam API supplies the `@loader_path/libsteam_api.dylib` dependency of `luasteam.so`, and the Lua 5.1 symbols come from the LÖVE host. The module's `nativeHostDependencies()` metadata ties the Steam dependency to the exact bridge checksum and API helper version.

The bridge's lowercase LuaSteam API covers local client initialization, typed interface calls, callbacks, shutdown and garbage collection through the included offline Steam API.

### Bridge source

The included bridge is built from these exact sources:

| Input | Exact revision | Role |
| --- | --- | --- |
| [LuaSteam](https://github.com/uspgamedev/luasteam) | `fbb72bd22c0c526f4276800024967323acd9d10d` | MIT bridge source |
| [LuaJIT](https://github.com/LuaJIT/LuaJIT) | `45b771bb2c693a4cc7e34e79b7d30ab10bb7776a` | MIT Lua C API headers; no embedded Lua VM |
| [Steamworks SDK header checkout](https://github.com/rlabrecque/SteamworksSDK) | `494c2d680b9e47bbc369496b57568f44ef2f6796` | Proprietary SDK 1.63 headers, used only for the build |

SDK materials remain subject to [Valve's developer terms](https://partner.steamgames.com/documentation/sdk_access_agreement). Their headers and proprietary libraries are not part of the bridge's included source archive, which contains the MIT bridge, the Lua C headers, notices, build tools and the hashes of the external build inputs.

Both native slices resolve Lua functions from the selected host, which avoids loading an incompatible second Lua VM. [Development](../development/DEVELOPMENT.md) covers rebuilding included helpers.

`luasteam-versions.json` and `distribution-supplementals.json` record which source, native library, archive, manifest and license notices belong to the bridge. Package metadata records the complete file list, CPU slices, minimum macOS version and code signature.
