# LÖVE

Import a `.love`, Windows fused executable, Linux fused executable or source folder, then choose Play. MacLauncher selects the detected [LÖVE](https://github.com/love2d/love) version and offers to download a missing runtime. Explicit runtime choices remain exact. Releases retain the complete GitHub release history; main-branch Nightlies have a separate artifact catalog and version/hash labels.

Linux AppImages are extracted into per-game application data when necessary. Other supported inputs launch from their original location.

## Steam bridge

The LÖVE runtime page includes a **Steam bridge** section. Its included profile is `luasteam-4.0.2-ml1-lua51-universal`, based on [LuaSteam v4.0.2](https://github.com/uspgamedev/luasteam/tree/v4.0.2) at `fbb72bd22c0c526f4276800024967323acd9d10d`. It binds the lowercase LuaSteam API to the selected host's Lua 5.1 C API, with LÖVE 11.5 compatibility on Apple Silicon and Intel.

Play activates this bridge when bounded original Lua source and native imports identify a required compatible LuaSteam dependency, with an explicit game-local Steam application ID. The shared Steam API service prefers a matching native game library; its included offline alternative uses the separate `luasteam-4.0.2-sdk1.63-ml1-offline-abi0.5.0` interface profile. Optional `pcall(require, "luasteam")` code retains its existing fallback, including when no application ID is available. DLC numbers are not treated as application IDs. See [Steam support](STEAM_API.md) for helper versions and limits.

The bridge executes from read-only app resources. Per-game symlinks and child-only library paths connect it to the selected host and shared Steam API library; game files, shared runtimes and the launcher's environment are unchanged. The included bridge needs no SDK, compiler, additional installation or game copy. Choosing a Steam bridge never changes the selected LÖVE release or nightly.

The profile covers client initialization, typed interface calls, callbacks, shutdown and garbage collection. Online authentication, multiplayer, the Steam overlay and server APIs are unsupported. PascalCase LuaSteam APIs and unknown native API contracts require another explicit bridge profile.

## Maintainer build

`src/modules/love/runtime/luasteam-build.js` exports the optional `buildFromSource` entry. It validates these read-only source inputs before and after the build:

| Input | Exact revision | Role |
| --- | --- | --- |
| [LuaSteam](https://github.com/uspgamedev/luasteam) | `fbb72bd22c0c526f4276800024967323acd9d10d` | MIT bridge source |
| [LuaJIT](https://github.com/LuaJIT/LuaJIT) | `45b771bb2c693a4cc7e34e79b7d30ab10bb7776a` | MIT Lua C API headers; no embedded Lua VM |
| [Steamworks SDK header checkout](https://github.com/rlabrecque/SteamworksSDK) | `494c2d680b9e47bbc369496b57568f44ef2f6796` | Proprietary SDK 1.63 developer input |

SDK materials remain subject to [Valve's developer terms](https://partner.steamgames.com/documentation/sdk_access_agreement). Their headers and proprietary libraries are excluded from this bridge's included source archive. The archive contains the MIT bridge, Lua C headers, notices, owned build/probe code and exact external input hashes.

For a maintainer source build, Apple's Command Line Tools are installed with `xcode-select --install`; the builder invokes the supplied compiler through `/usr/bin/xcrun`. Normal packaged launches do not run a compiler. Both native slices resolve Lua functions from the selected host, avoiding an incompatible second Lua VM.

`luasteam-package.js` stages a new immutable profile from pinned bytes and an explicit source allowlist. `luasteam-versions.json` and `distribution-supplementals.json` bind the exact source, native library, archive, manifest and license notices. Release validation checks the complete inventory, CPU coverage, macOS floor and code signature.
