# LÖVE

Import accepts `.love` archives, Windows or Linux fused executables and source folders. MacLauncher selects the detected [LÖVE](https://github.com/love2d/love) version and offers to download a missing runtime. Explicit runtime choices remain exact. Releases retain the complete GitHub release history; main-branch Nightlies have a separate artifact catalog and version/hash labels.

**Export source** copies Lua text and recovers compiled scripts into the game's
private source folder. It reads source folders, `.love` archives and fused
executables, including the packaged game inside native apps and AppImages.
Plain Lua text exports offline without a decompiler. LuaJIT 2.0/2.1 bytecode uses
managed [LJD](https://github.com/dol/luajit-decompiler); standard Lua 5.0–5.4
bytecode uses managed [unluac](https://sourceforge.net/projects/unluac/).
Missing tools download after consent; **Runtimes → LÖVE** manages their versions under **LJD** and **unluac**. LJD uses the
included Python; unluac shares managed Temurin. Original bytecode, individual
recovery failures and logs remain in the export. Stripped or optimized bytecode
can lose names or code structure; an export is for inspection rather than a
playback conversion. Original game files remain unchanged.

Nightly catalog refresh and downloads use an authenticated GitHub CLI (`gh`).
MacLauncher checks the process PATH and standard Homebrew and MacPorts locations,
including when opened from Finder or the Dock. Authentication failures are reported
separately from a missing executable; `gh auth login --hostname github.com` restores
GitHub authentication. Opening Settings never queries these catalogs.

Linux AppImages are extracted into per-game application data when necessary. Archives with a single nested game folder are prepared in per-game application data, preserving the original archive, working directory and default save identity. Archives containing multiple independent games require a separate game archive or folder. Root-level archives and source folders launch from their original location.

Library metadata reads literal `t.window.title` and `t.window.icon` values from `conf.lua`, with `t.title` and `t.icon` accepted for older projects. Source folders, `.love` archives and fused ZIP exports support PNG and WebP artwork. Archive metadata uses the same game root as launch preparation; nested libraries and examples do not replace a root project. Inspection reads selected bounded resources without executing Lua or modifying the source. Computed values retain the existing filename or bundle metadata and icon fallback.

Shared graphics reads the selected LÖVE bundle's native executable architecture and retains its Rosetta requirement. Universal bundles use the native host slice; older Intel bundles select compatible Intel graphics providers.

## Steam bridge

The fixed included Steam bridge has no management tab or download step. Its profile is `4.0.2-MCLv1`, based on [LuaSteam v4.0.2](https://github.com/uspgamedev/luasteam/tree/v4.0.2) at `fbb72bd22c0c526f4276800024967323acd9d10d`. It binds the lowercase LuaSteam API to the selected host's Lua 5.1 C API, with LÖVE 11.5 compatibility on Apple Silicon and Intel.

Play activates this bridge when bounded original Lua source and native imports identify a required compatible LuaSteam dependency, with an explicit game-local Steam application ID. The shared Steam API service prefers a matching native game library; its included offline alternative uses the separate `luasteam-4.0.2-sdk1.63-ml1-offline-abi0.5.0` interface profile. Optional `pcall(require, "luasteam")` code retains its existing fallback, including when no application ID is available. DLC numbers are not treated as application IDs. [Steam support](STEAM_API.md) describes helper versions and limits.

The bridge executes from read-only app resources. Per-game symlinks and child-only library paths connect it to the selected host and shared Steam API library; game files, shared runtimes and the launcher's environment are unchanged. The included bridge needs no SDK, compiler, additional installation or game copy. Existing bridge selections remain compatible and never change the selected LÖVE release or nightly.

The selected Steam API supplies `luasteam.so`'s
`@loader_path/libsteam_api.dylib` dependency. Lua 5.1 symbols come from the LÖVE
host. Module-owned `nativeHostDependencies()` metadata binds the Steam dependency
to the exact bridge checksum and API helper version.

The lowercase LuaSteam profile covers local client initialization, typed interface calls, callbacks, shutdown and garbage collection through the included offline Steam API owner.

## Bridge source

The included bridge is built from these exact source inputs:

| Input | Exact revision | Role |
| --- | --- | --- |
| [LuaSteam](https://github.com/uspgamedev/luasteam) | `fbb72bd22c0c526f4276800024967323acd9d10d` | MIT bridge source |
| [LuaJIT](https://github.com/LuaJIT/LuaJIT) | `45b771bb2c693a4cc7e34e79b7d30ab10bb7776a` | MIT Lua C API headers; no embedded Lua VM |
| [Steamworks SDK header checkout](https://github.com/rlabrecque/SteamworksSDK) | `494c2d680b9e47bbc369496b57568f44ef2f6796` | Proprietary SDK 1.63 developer input |

SDK materials remain subject to [Valve's developer terms](https://partner.steamgames.com/documentation/sdk_access_agreement). Their headers and proprietary libraries are excluded from this bridge's included source archive. The archive contains the MIT bridge, Lua C headers, notices, build tools and exact external input hashes.

Both native slices resolve Lua functions from the selected host, avoiding an incompatible second Lua VM. [Development](../DEVELOPMENT.md) covers rebuilding included helpers.

`luasteam-versions.json` and `distribution-supplementals.json` bind the exact source, native library, archive, manifest and license notices. Package metadata records the complete inventory, CPU slices, macOS floor and code signature.
