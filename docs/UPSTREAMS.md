# Maintaining upstream adaptations

[The source inventory](../scripts/upstream-overlays.json) records the exact Git revisions, repository URLs, nested dependencies, license files, owned adaptations, apply entry points, build recipes and focused checks. It covers every configured submodule, including reference projects and tools that are not playable runtimes. Versioned MacLauncher native helpers are recorded separately from upstream Git identities. Native package versions and distribution methods are listed separately in [Runtime distribution](runtimes/RUNTIME_DISTRIBUTION.md).

Every consumed Git source is tracked as a pinned submodule, including small tools, build dependencies and nested sources. Upstream updates are compared against that exact commit and the module-owned adaptations; checkouts remain read-only. Reference-only submodules can remain uninitialized and are excluded from the app. Binary-only runtime downloads retain explicit versions and checksums without requiring a source checkout.

Initialize source dependencies with the same command used by CI:

```sh
node scripts/init-submodules.cjs
```

The initializer uses exact Gitlinks. `.gitmodules` sets `maclauncher-recursive = false` for primary-only sources and `maclauncher-init = false` for optional references; other sources include their pinned nested dependencies. `--dry-run` lists the plan without fetching, `-- PATH ...` selects declared top-level paths, and `--all` includes references while preserving primary-only policy. Recorded public mirrors are used for acquisition and retain their exact source pins. Initialization leaves tracked local edits intact and never follows a moving branch. After pulling launcher changes with `git pull --no-recurse-submodules`, run the initializer again to acquire updated pins.

Run the source audit from the repository root:

```sh
node scripts/check-upstream-overlays.cjs
node scripts/check-upstream-overlays.cjs --json
```

This is an offline check. It compares the Git index, checked-out revisions, module/catalog pins, adaptation versions, archive pins, owned file hashes and declared source guards. New submodules and owned overlays require inventory entries. Uninitialized dependencies are reported separately; the audit does not fetch, initialize or modify them. Git's automatic fetching of missing partial-clone objects is disabled. An unresolved license remains a distribution limitation.

Array catalog references select an exact version record, independently of order. Missing or duplicate records fail the audit; adding a new version does not change an earlier version's identity.

An explicitly recorded public checkout mirror is recorded independently from the repository URL declared by upstream. Both origins and the exact commit remain checked; a mirror entry does not permit arbitrary origin changes. Explicit candidate fetching uses that recorded mirror, while ordinary checks remain offline.

To check a candidate already present in a local checkout, specify its full commit and a new absolute work directory:

```sh
node scripts/check-upstream-overlays.cjs \
  --project impacto \
  --candidate ba51381fb65da70697be29e6a817dc4af5c98d19 \
  --work-dir "$PWD/.local/upstream-maintenance/impacto-candidate" \
  --recipe impacto-windows
```

The command reads Git objects into an isolated source copy, invokes the declared backend apply routine, and writes `candidate-report.json` there. Pinned original/adapted hashes are enforced, including new-file absence checks; the report includes conflicts, source scope and required build/tests. Ramen/CoreAudio output copies are checked separately. Vendored checkout HEAD, index and tracked-file status are compared before and after. Source-only checks do not compile or launch third-party code.

Use `--source /absolute/local/checkout` for a separate checkout. Recipes with extra Git inputs accept `--dependency project-id=/absolute/local/checkout`; OpenGMK, for example, requires its pinned Ramen and Udon inputs. `--fetch` explicitly fetches only the requested commit into the new owned directory. It never updates a vendored checkout or follows a moving branch. Missing nested commits need a complete local checkout; there is no implicit nested fetch.

`sourceScopes` limits each Git input to the files its apply routine needs. A scope may select a file inside a nested submodule: the copier checks the parent Gitlink, the nested origin and its exact commit before copying that file. Unselected files are omitted. Scope selection never weakens source or adapted-file checksum checks.

A changed upstream file can conflict with the current hash guards. Rebase the module-owned adaptation, update its declared guards, run its focused checks and rebuild the complete native package. Changed bytes or semantics require a new version; existing seals and source identities remain unchanged. Component licenses still govern distribution.

Build-only recipes and runtime shims are labeled explicitly. Their source snapshot can be checked, but an empty apply routine does not certify an updated native runtime. The Bink 2 adaptation targets the separately SHA-pinned FFmpeg source archive; the [Impacto builder](../src/modules/mages/native/build.js) verifies all original/adapted patch hashes and probes the compiled decoder. Binary-only SDK and MKXP releases remain in their runtime catalogs. RLVM uses its unmodified published Mac app: the [catalog](../src/modules/siglus/runtime/rlvm-catalog.js) records the release commit, asset identity and SHA-256. Its small owned [Cocoa adapter](../src/modules/siglus/resources/rlvm-adapter/adapter.m) selects the imported game automatically; [the manifest](../src/modules/siglus/resources/rlvm-adapter/manifest.json) records source/binary hashes and the exact universal-library build command. No RLVM source build or checkout is needed.

The [RPGMakerDecrypter builder](../src/modules/rgss/runtime/decrypter-build.js) compiles unmodified upstream code with owned MSBuild properties and dependency locks. Its source check verifies all 33 selected upstream files remain identical in the configured copy. The pinned source archive, .NET SDK/runtime and NuGet inputs are recorded in [its build inputs](../src/modules/rgss/runtime/decrypter-source.json). A rebuild must retain the neutral source path map and explicit upstream identity, independent of the parent Git repository, and pass the decryption checks before replacing the bundled tool.

The [LuaSteam source recipe](../src/modules/love/runtime/luasteam-source-overlay.js) checks the selected LuaSteam sources, LuaJIT API headers and Steamworks SDK headers independently, then stages their exact bytes in an owned build directory. The bridge binds the host's Lua 5.1 C API; it does not link a second Lua VM. Its [source package](../src/modules/love/runtime/luasteam-package.js) includes the MIT inputs and their notices, while recording the separately licensed Valve SDK inputs by revision and hash. SDK headers, SDK Readme and proprietary SDK libraries are excluded from that package. A new bridge version must retain the host Lua contract and pass the declared ABI checks before its catalog entry changes.

The inventory groups adaptations as follows. Exact revisions, nested dependencies, file hashes and test paths are in the JSON; this table describes their purpose.

| Projects | Owned integration or adaptation | Apply/build entry |
| --- | --- | --- |
| [Kawariki](https://github.com/Orochimarufan/Kawariki), [rpgmakermlinux-cicpoffs](https://github.com/bakustarver/rpgmakermlinux-cicpoffs) | Web compatibility scripts and RGSS Ruby overlay | [Web host](../src/modules/shared/web/runtime/nwjs-patched-launcher.js), [RGSS assets](../src/modules/rgss/assets.js) |
| [evbunpack](https://github.com/mos9527/evbunpack) | Packed executable extraction reference | [Packed RGSS](../src/modules/rgss/packaged.js) |
| MacLauncher [MKXP configuration helper](../src/modules/rgss/overlays/mkxpz-config.c) | Versioned per-launch configuration/CWD isolation; shared publisher runtime remains unchanged | [Builder](../scripts/stage-mkxpz-config-helper.cjs), [Loader/declaration](../src/modules/rgss/runtime/mkxpz-config-helper.js) |
| [RPGMakerDecrypter](https://github.com/uuksu/RPGMakerDecrypter) | Unmodified source; deterministic build properties, explicit version and neutral source paths | [Builder/source preparation](../src/modules/rgss/runtime/decrypter-build.js), [Build properties](../src/modules/rgss/runtime/decrypter-build.props) |
| [rpatool](https://codeberg.org/shiz/rpatool), [unrpyc](https://github.com/CensoredUsername/unrpyc), its [legacy branch](https://github.com/CensoredUsername/unrpyc/tree/legacy), [UnRen Gideon](https://github.com/VepsrP/UnRen-Gideon-mod-) | Python archive/decompiler compatibility shims | [UnRen imports](../src/modules/renpy/resources/unren/vendor.py) |
| [Universal RenPy Walkthrough](https://github.com/BCassO/universal-renpy-walkthrough) | Offline updater override | [RenPy actions](../src/modules/renpy/main.js) |
| [Butterscotch](https://github.com/ButterscotchRunner/Butterscotch) | AppKit build configuration; owned OpenGL helper | [Builder](../src/modules/gamemaker/runtime/butterscotch.js) |
| MacLauncher [graphics helper](../src/modules/gamemaker/overlays/software-opengl-v2.m) | Versioned software OpenGL helper for pinned official GameMaker runners | [Builder/adapter](../src/modules/gamemaker/runtime/opengl-fallback.js), [Version catalog](../src/modules/gamemaker/runtime/opengl-helper-versions.json) |
| MacLauncher offline Steam API and encrypted-ticket loader | Independent MIT implementations; fixed-width native/manual callbacks, local state and exact consumer contracts; ticket operations remain unavailable | [API source/build](../src/modules/shared/runtime/steamworks/native/offline-0.5.0), [Ticket source/build](../src/modules/shared/runtime/steamworks/native/ticket-0.1.0), [Catalogs and limits](runtimes/STEAM_API.md) |
| [OpenGMK](https://github.com/OpenGMK/OpenGMK), [Ramen](https://github.com/viriuwu/ramen), [Udon](https://github.com/Adamcake/udon) | AppKit/OpenGL/CoreAudio, file/save/window compatibility, native extension guard, decompiler workspace | [Shared source recipe](../src/modules/gamemaker/overlays/opengmk-macos/source-build.js) |
| [UndertaleModTool](https://github.com/UnderminersTeam/UndertaleModTool), [GameMaker HTML5](https://github.com/YoYoGames/GameMaker-HTML5) | Decompiler integration and export/version references | [GameMaker tools](../src/modules/gamemaker/tools.js), [HTML5 detection](../src/modules/gamemaker-html5/detect.js) |
| [goldberg-mac](https://github.com/squareloopthings/goldberg-mac), [gbe_fork](https://github.com/Detanup01/gbe_fork), [Abseil](https://github.com/abseil/abseil-cpp) | Legacy developer adaptation; SDK-based packages are excluded from the app distribution | [Source overlay](../src/modules/shared/runtime/steamworks/source-overlay.js), [Offline builder](../src/modules/shared/runtime/steamworks/build.js) |
| [LuaSteam](https://github.com/uspgamedev/luasteam), [LuaJIT](https://luajit.org) | Host Lua 5.1 linkage and exact native Steam bridge; proprietary SDK headers are separate developer inputs, excluded from its source package | [Source overlay](../src/modules/love/runtime/luasteam-source-overlay.js), [Builder](../src/modules/love/runtime/luasteam-build.js) |
| [krkrsdl2](https://github.com/krkrsdl2/krkrsdl2), [KAG3](https://github.com/krkrsdl2/kag3) | Native storage/font/monitor bridge and bounded script integration | [Native bridge](../src/modules/kirikiri/native-compat.js), [Builder](../src/modules/kirikiri/build.js) |
| [system3-sdl2](https://github.com/kichikuou/system3-sdl2), [xsystem35-sdl2](https://github.com/kichikuou/xsystem35-sdl2), [xsystem4](https://github.com/nunuhara/xsystem4) | SDL runtime portability, executable-relative resources and versioned Mac graphics/shader adaptations | [System3 portable builder](../src/modules/alicesoft/system3-portable.js), [System3.5 portable builder](../src/modules/alicesoft/system35-portable.js), [System4 portable builder](../src/modules/alicesoft/system4-portable.js) |
| [sys3c](https://github.com/kichikuou/sys3c), [xsys35c](https://github.com/kichikuou/xsys35c) | Owned CMake tool build | [Decompiler builder](../src/modules/alicesoft/decompiler-build.js) |
| [FNA](https://github.com/FNA-XNA/FNA) and its nested libraries | Native OpenGL policy, ABI forwarders and generic managed host | [Builder](../src/modules/fna/runtime/build.js) |
| [HashLink](https://github.com/HaxeFoundation/hashlink), [SDL](https://github.com/libsdl-org/SDL), [OpenAL Soft](https://github.com/kcat/openal-soft) | Current upstream build plus separately pinned 1.9 codec/native compatibility | [Current builder](../src/modules/hashlink/runtime/build.js), [Legacy builder](../src/modules/hashlink/runtime/legacy-build.js) |
| [ONScripter-EN](https://github.com/Galladite27/ONScripter-EN) | Owned CMake/Cocoa Mac entry | [Builder](../src/modules/nscripter/runtime/onscripter-en-build.js) |
| [ai5-sdl2](https://github.com/nunuhara/ai5-sdl2) and libai5 | Managed saves/graphics, archive/disc access and pinned portable dependencies | [Portable builder/applier](../src/modules/ai5/runtime/portable-build.js), [earlier source adapter](../src/modules/ai5/runtime/build.js) |
| [libnpengine](https://github.com/FGRE/libnpengine), [libnpa](https://github.com/FGRE/libnpa) | Mac entry, private storage, NSS compiler/interpreter/object compatibility | [Builder/applier](../src/modules/nitroplus/runtime/build.js) |
| [GemRB](https://github.com/gemrb/gemrb) | Native CLI entry, shared scripting references and pinned SDL2/audio/Python closure | [Portable builder](../src/modules/gemrb/runtime/portable-build.js), [guarded overlay](../src/modules/gemrb/runtime/portable-overlay.js), [legacy builder](../src/modules/gemrb/runtime/build.js) |
| [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE) | Bundled compiled Lua profile and owned runtime wrappers | [Profile verification/preparation](../src/modules/vnds/prepare.js) |
| [siglus_rs](https://github.com/xmoezzz/siglus_rs) | Upstream native runtime and pinned published assets | [Catalog](../src/modules/siglus/runtime/catalog.js) |
| [OpenBGI](https://github.com/Cytlan/openbgi) | Archive and compiled-program tools; not yet supported for play | [VN engine notes](runtimes/VN_ENGINES.md) |
| [ReMinori](https://github.com/luoyily/ReMinori) | Original PAZ/PE profiles, macOS platform integration, private saves and versioned movie bridge | [Source overlay](../src/modules/minori/runtime/overlay.js), [native builder](../src/modules/minori/runtime/build.js), [movie builder](../src/modules/minori/runtime/movie-build.js) |
| [FelineSystem2](https://github.com/kokseen1/FelineSystem2) | Diagnostic Mac source adaptation; unresolved upstream license | [Diagnostic applier](../src/modules/catsystem2/runtime/port.js) |
| [Impacto](https://github.com/CommitteeOfZero/impacto), [avcpp](https://github.com/h4tr3d/avcpp), [LibAtrac9](https://github.com/Thealexbarney/LibAtrac9), [magic_enum](https://github.com/Neargye/magic_enum), [FFmpeg](https://ffmpeg.org), [Bink 2 patch](https://github.com/sharpemu/ffmpeg-core) | Windows resource/script support, Mac portability, exact decoder ABI and pinned dependency overlays | [Builder](../src/modules/mages/native/build.js), [Impacto applier](../src/modules/mages/native/adapter.js), [Dependency patch applier](../src/modules/mages/native/source-patches.js) |

Some apply checks intentionally stage only their declared source files and nested inputs. The report records that scope; a complete rebuild remains required. The VNDS source is MoonScript, while the shipped profile is compiled Lua: changing its source pin requires recompilation and regeneration of the profile manifest as well as its wrapper checks.

Node.js and Git are needed for these developer checks; their normal executables may be on `PATH`. End users running packaged runtimes need neither tool. Build prerequisites belong to each linked backend recipe, and are separate from this audit.
