# MAGES. tools and Windows playback

Imports accept a Windows folder, its executable or `USRDIR/script.mpk`. Detection requires valid **MPK 2.0** script/system archives and a bounded **SC3** boot program. One wrapper directory is supported; folders containing several games need a narrower input. File extensions and executable names alone do not identify the engine.

The inspector keeps original PE file/product versions separate from archive/bytecode versions. Windows HD profile detection combines MAGES. product metadata, `_STARTUP_WIN.SCX` and a Bink 2 companion; a game's product version is not a shared engine version.

## Archive and script tools

**Inspect archives** reports member counts, compression and unsupported archives. **Inspect scripts** validates SC3 label/string ranges and hashes decoded bytes. **Export compiled scripts** writes original SCX files and a hash report under `userData/games/<id>/modules/mages/exports/`. It does not decompile scripts or change game data. Partial inspection reports failed members while retaining readable scripts. No executable or game script runs during these actions.

## Windows HD runtime

The default **Impacto Windows Mac v9** runtime supports the identified Windows HD data profile on **Apple Silicon with macOS 13 or later**. It requires a supported original Windows executable layout for input tables. The Included runtime runs directly; the launcher creates only a private profile/configuration and logs under `userData/games/<id>/modules/mages/session/`. MPK archives and movies remain in their original location. Settings retains explicit version selection; this fixed backend has no Runtimes management tab.

Native windows use the game's library title.

The Windows adapter provides native input, script execution, voice, sound effects and Bink 2 video. Windows UI modes such as Help are guarded. Other MPK editions and Intel hosts retain archive/script tools with Play disabled. Save editing and cheats are unavailable.

| Mac adapter | Minimum macOS | Behavior |
| --- | --- | --- |
| `0.10.8.810-windows-v1` | 27.0 | Earlier adapter/profile identity; explicit registrations remain separate |
| `0.10.8.810-windows-v2` | 27.0 | Missing the required Bink 2 decoder; rejected before startup |
| `0.10.8.810-windows-v3` | 27.0 | Bink 2 decoder with the older dependency build |
| `0.10.8.810-windows-v4` | 13.0 | Source-built ARM dependency closure and the Windows/Bink 2 profile |
| `0.10.8.810-windows-v5` | 13.0 | Separate input profile for Windows UI modes 13 and 14; requires a supported original PE input layout |
| `0.10.8.810-windows-v6` | 13.0 | Windows voice operands with the V5 input profile |
| `0.10.8.810-windows-v7` | 13.0 | Two-byte Windows checkpoint operands |
| `0.10.8.810-windows-v8` | 13.0 | Safe handling of a disabled backlog |
| `0.10.8.810-windows-v9` | 13.0 | Default; Windows sound-effect operands and the preceding input, voice, checkpoint and backlog fixes |

V5 and later read input regions and mouse-selector behavior from the original Windows executable. The generated input table stays in the private session directory. Ambiguous or unsupported layouts fail before startup; unknown UI modes remain rejected.

[Impacto 0.10.8.810](https://github.com/CommitteeOfZero/impacto/releases/tag/0.10.8.810), revision [`ba51381fb65da70697be29e6a817dc4af5c98d19`](https://github.com/CommitteeOfZero/impacto/tree/ba51381fb65da70697be29e6a817dc4af5c98d19), publishes native ARM64/x64 packages and reads MPK 2.0. Its [upstream console profile](https://github.com/CommitteeOfZero/impacto/blob/ba51381fb65da70697be29e6a817dc4af5c98d19/profiles/sgps3/game.lua) uses different CPK mounts, big-endian layouts, 1280×720 presentation and `InstructionSet.SGPS3`. The Windows adapter supplies its own little-endian resource/voice layouts, per-script return conventions, VM/UI operands and title sprites. Original compiled scripts are read directly; this route requires no Windows DLL loading or console assets.

The [source overlay](../../src/modules/mages/native/impacto-overlay.json) records adapted source files and hashes; upstream source remains read-only. Native input retains quick taps, while the renderer composites original Bink 2 alpha frames. The codec uses [FFmpeg 7.1.2](https://ffmpeg.org/releases/), the LGPL [Bink 2 patch](https://github.com/sharpemu/ffmpeg-core/blob/3b502d4ed79ec2c14066ca09f514db1e2ebb5265/bink2.patch) and an alpha-flag correction, with YUVA420/full-range video handling.

The [runtime manager](../../src/modules/mages/native/manager.js) retains upstream release history with exact source revisions and separate Windows Mac identities. Historical source releases are not adapted Windows Mac downloads. Installation and Play validate each selected executable, dependency closure, source/overlay/profile hashes, architecture and macOS floor. Detection, status and ordinary Play are offline.

## Development build

The V4 [portable builder](../../src/modules/mages/native/portable-build.js) and [dependency catalog](../../src/modules/mages/native/portable-dependencies.json) define exact source releases, archive checksums, CPU, build options and license notices. The separate corresponding-source archive contains all dependency archives, four main Git bundles, the pinned [Catch2](https://github.com/catchorg/Catch2) submodule and an offline `rebuild.cjs` entry point. Font, audio and runtime dependencies build into new owned prefixes; Homebrew libraries are excluded from lookup. CMake dependency downloads are disabled. The optional libass header follows the configured feature guard.

The separate V5 [input builder](../../src/modules/mages/native/portable-ui-build.js) preserves that dependency and decoder closure and adds the [Windows input overlay](../../src/modules/mages/native/windows-ui-overlay.js). Its source archive contains the exact input parser, profile and native input implementation alongside all build inputs.

The current V9 [builder](../../src/modules/mages/native/portable-sfx-build.js) composes the input, [voice](../../src/modules/mages/native/windows-audio-overlay.js), [checkpoint](../../src/modules/mages/native/windows-checkpoint-overlay.js), [backlog](../../src/modules/mages/native/windows-backlog-overlay.js) and [sound-effect](../../src/modules/mages/native/windows-sfx-overlay.js) overlays. Each Mac adapter retains its own immutable profile, source and native identities. The corresponding-source archive includes every owned input, pinned dependency archive and Git bundle needed by its offline build. Builds can reuse the unchanged dependency closure.

[adapter.js](../../src/modules/mages/native/adapter.js), the earlier [build.js](../../src/modules/mages/native/build.js) and [source-patches.js](../../src/modules/mages/native/source-patches.js) retain the previous Windows/decoder behavior and identities. The V4 builder preserves the Windows profile and Bink 2 patch, applies overlays only to exported copies and requires compiled headers, descriptor and decoder to agree. Absent codecs and empty decoder results fail explicitly.

Build prerequisites and locations are in [native tool setup](NATIVE_TOOL_SETUP.md). Dependency deployment targets determine the final package's minimum macOS version. Compiler path mappings and normalized generated configuration avoid embedding private build locations.

The CLI supports bounded diagnostic sessions with `session --diagnostic-frames <1–3600> --launch`: a hidden window, silent audio and a 30-second loop limit. Optional `--diagnostic-confirm-frame <frame>` supplies a Return tap. Normal sessions use ordinary input, audio and rendering. Logging defaults to `Info`; `--log-level Trace` exposes bytecode details.

## Format bounds

Archive tools allow 64 archives, 65,535 entries per archive and 24 MiB of indexes. MPK members require valid 64-bit ranges and unique ids/names. Decoding and export reject traversal, absolute paths, ambiguous names, overlapping payloads and symlinked archives. Import reads only script/system indexes, one small boot script and bounded PE/patch metadata. Script tools allow 1,024 scripts, 32 MiB per script and 64 MiB each of stored/decoded data.

[Attributions](../ATTRIBUTIONS.md) lists source, decoder and dependency licenses.
