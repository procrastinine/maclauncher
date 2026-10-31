# HashLink (Haxe bytecode)

[Haxe](https://haxe.org/) can compile a game to HashLink bytecode, which the [HashLink](https://github.com/HaxeFoundation/hashlink) virtual machine runs together with native modules for graphics, audio and other system access. MacLauncher runs HashLink games with the Intel HashLink VM, natively on Intel Macs and through Rosetta on Apple Silicon. Playback does not load Electron, run Windows programs or use Wine.

| Runtime | Description |
| --- | --- |
| HashLink (Intel Mac; Rosetta on Apple Silicon) (default) | Intel HashLink VM: upstream releases and development snapshots, or MacLauncher Builds 1.9 and 1.12 packages |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

Haxe games compiled to native machine code instead of bytecode are a separate game type, [Haxe native build](HAXE.md).

## Importing games

Import accepts a `.hl` file, a `hlboot.dat` file, or a folder with an unambiguous bytecode entry. The bytecode is imported together with its resources. An adjacent Windows launcher can identify `hlboot.dat` without the launcher being run.

## Detection and versions

A HashLink game needs two things from its runtime: a VM that reads its bytecode version, and native modules whose functions (primitives) match the signatures the bytecode was compiled against. MacLauncher checks the two separately.

The bytecode version, such as `HLB5`, is checked against the VM, and each native module's API is checked on its own. Bytecode can require the `std`, `fmt`, `ui`, `sdl` and `openal` modules. [HashLink 1.9](https://github.com/HaxeFoundation/hashlink/blob/1.9/libs/sdl/sdl.c) passed SDL events to the game as a typed Event argument, and [1.10 and later](https://github.com/HaxeFoundation/hashlink/blob/1.10/libs/sdl/sdl.c) changed that primitive to a dynamic argument. A newer VM that reads the same bytecode format can therefore reject bytecode that needs the older native ABI. The inspector reads the serialized argument type and tells typed Event arguments apart from dynamic ones.

Before downloading or launching, the bytecode's requirements are compared with the recorded native signatures of the selected runtime. A selected version known to be incompatible is blocked before launch, and a primitive ABI that cannot be determined is reported as unknown. MacLauncher never coerces native types.

The inspector shows the bytecode version, the bytecode file, the version source, a confidence level and the SDL primitive ABI. **Inspect bytecode**, in the inspector's **Advanced** group, uses the included metadata reader, which supports bytecode versions 2 to 6.

## Native modules

The names of the native libraries the bytecode needs are read without loading them. Standard and built-in modules come from the runtime, and other modules are looked for in the optional custom macOS module folder, the runtime folder and the bytecode folder, and launch passes those folders to the game through `DYLD_LIBRARY_PATH`.

- A missing required library, or a Windows or wrong-CPU `.hdll` file, blocks launch with a diagnostic that names the problem. Missing optional imports stay optional.
- A Mach-O library is usable only when its primitive signatures match and its own dependent libraries are present.
- Known native signatures are compared with the bytecode's requirements without running the game. Custom modules with unknown signatures are listed separately in the report.

## Preparation and saves

HashLink runs from a per-game folder in launcher data. Known static images, audio and resource packs are linked into it, and the VM reads the original bytecode directly. Configuration files and unknown writable files are copied, and Windows executables, DLLs and HDLL files are left out.

Files the game writes, including saves and configuration files at relative paths, stay in the game's private launcher data, and existing player files persist between launches. If the source bytecode's digest changes, launch and rebuilding of that folder are blocked so that unknown game saves are not discarded silently. A migration removes unchanged, obsolete copies of bytecode and native modules and keeps relative player saves. HashLink games have no common save format, so MacLauncher infers no save path or save file name.

## Settings

| Setting | Description |
| --- | --- |
| Additional macOS native modules directory | A folder of extra native modules. Modules must match the Intel HashLink runtime; Windows `.hdll` files are incompatible. |
| Application arguments | Extra arguments for the game, one per line. |

## Bytecode export

**Export bytecode**, in the inspector's **Advanced** group, uses the [hlbc](https://github.com/Gui-Yom/hlbc) tool to export metadata, function opcodes and pseudocode for the entry point, for bytecode versions 4 and 5. The pseudocode is hlbc's experimental decompiler output and does not recover a complete Haxe source project. The published hlbc command-line tool can fail on some functions or compiler output; the export then keeps the available metadata, partial listings, tool logs and explicit warnings.

hlbc is listed under **Runtimes → HashLink → hlbc** and runs in a private Windows environment through Sikarugir or CrossOver; a missing Sikarugir engine is downloaded after its own confirmation.

## Runtimes

### HashLink (Intel Mac; Rosetta on Apple Silicon)

The Intel HashLink VM is the default runtime and runs as Intel 64-bit code, using the Intel slice of universal distributions. HashLink's ARM libraries do not contain the bytecode VM, because the upstream JIT compiler emits x86 code, so an ARM HashLink/C support library cannot replace the Intel VM. On Apple Silicon the game runs under Rosetta, and shared graphics processing selects providers for the same Intel architecture.

**Runtimes → HashLink** lists published releases, development snapshots and the older Mac packages in its **Upstream**, **HashLink 1.9** and **HashLink 1.12** sections. Versions from published tags such as `1.16`, `1.15`, `1.14` and `1.12` keep the upstream tag name and record its exact commit.

#### Version selection

The game's bytecode recommends a published Intel package whose bytecode version, SDL event ABI and [primitive profile](#primitive-profiles) match, and whose macOS requirement this Mac meets. The newest matching public development snapshot comes first, and otherwise the matching MacLauncher Builds package with the newest upstream version.

- Older imports that use typed SDL Events get a 1.9 package with the `typed-1.9-macos-v2` primitive profile, when their required primitives match.
- Imports that use legacy `fmt` primitives, dynamic SDL events and OpenAL effects get a 1.12 package with the `legacy-dynamic-1.12-macos-v1` profile.
- Dynamic imports alone do not identify a compatible runtime: the names and signatures of the required primitives must match the selected native modules.

The global default applies when the bytecode gives no SDL or native primitive evidence, or when no listed package matches. The recommendation is used for preparation and launch checks but is not saved as a per-game choice.

#### Development snapshots

The [public development archive](https://github.com/HaxeFoundation/hashlink/releases/tag/latest) is published under the `latest` tag, which the HashLink project moves to each new build. Its builds report version `2.0.0`, so MacLauncher identifies each one as `2.0.0-dev-<commit>`, with the full source commit and the publisher's SHA-256. These are upstream development builds, distinct from a stable `2.0.0` release. A snapshot contains the Intel VM and the `fmt`, Heaps, SDL, OpenAL, SQLite, SSL, UI and libuv modules, and because their Mac libraries are included in the archive, Homebrew is not needed.

Refresh resolves the `latest` tag to an exact commit and selects the Intel Mac archive and its publisher digest. The current file name is preferred, and a renamed or differently packaged archive is also accepted. For a new snapshot, MacLauncher reads the reported version, the supported bytecode range and the SDL primitive declaration from that exact source revision, and it rejects a snapshot whose source does not declare these in a form it recognizes. Installation finds the VM wherever the archive places it and verifies that the native files include Intel code, that every dependent library is present, and that the required VM and SDL exports exist. The archive's own header and VM library version are recorded as found. The snapshot's minimum macOS version is the highest one its native files declare. Launch verifies the installed native files and library aliases.

#### HashLink 1.9 and 1.12 packages

MacLauncher Builds publishes two Mac packages, built from upstream HashLink 1.9 and 1.12, for games that need an older native ABI. HashLink itself publishes no such Mac releases. Each package keeps the VM and native signatures of its upstream version together with matching `fmt`, SDL and OpenAL modules.

- The 1.9 packages keep the VM, the bytecode reader and the typed SDL primitive ABI at the exact upstream 1.9 commit. The build replaces the build machine's source, build, temporary, cache, home and workspace paths with neutral names in every compiled component.
- The 1.12 packages keep the [HashLink 1.12](https://github.com/HaxeFoundation/hashlink/tree/68daa125ad115a1f1d1db65d38e6045858d55013) VM and native signatures: the older byte argument of `fmt@mp3_open`, dynamic SDL event callbacks and the complete set of OpenAL effects primitives. They include matching SDL2 and OpenAL Soft dependencies.

The newer public snapshot has different `fmt` signatures and fewer OpenAL effects primitives. Two packages that share a bytecode format or SDL event ABI are therefore not interchangeable. Automatic selection compares every required native primitive before it chooses a profile, and it never rewrites bytecode or substitutes a different native type.

Each package's MacLauncher Builds release commit contains the exact upstream commits, MacLauncher's Mac build changes, the notices and the build script.

#### Primitive profiles

A primitive profile is the exact set of native function signatures a package provides, and each profile belongs to one upstream revision:

| Profile | Upstream revision | Native ABI |
| --- | --- | --- |
| `typed-1.9-macos-v2` | `4a4cfe91f3388a0b05bf2e45e7c4e38bae686dc6` | Typed SDL Event ABI with matching fmt, SDL and OpenAL modules |
| `legacy-dynamic-1.12-macos-v1` | `68daa125ad115a1f1d1db65d38e6045858d55013` | Legacy fmt, dynamic SDL events and OpenAL effects |
| `stock-2.0.0-d049add0a84d` | `d049add0a84dc6ae43088a6c386992dbba8604dc` | Public Intel development archive `8fd6d320861c4ca149a5eaff13f3b5ccc9c35d24c8a15147a3b12e9eef4e251b` |
| `stock-2.0.0-10b77768ab91` | `10b77768ab913ab7ba4c776791d1db2d15db8db3` | Public Intel development archive `1638e5e881b4d8ef963f623c04abdf8057a88cac678960dc812d313c58b21e3d` |

#### Local builds

**Runtimes → HashLink** can import a complete matching native distribution: select its version and choose **Import local build…**. The imported Intel process runs under Rosetta on Apple Silicon, and Play can request the Rosetta installation with explicit consent to Apple's license.

### CrossOver and Sikarugir (Wine)

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). The detected engine and its inspector tools stay available with either runtime.

## Versions and installation

HashLink versions follow the [shared selection rules](../runtimes/README.md#versions), with the bytecode recommendation described under [Version selection](#version-selection). Refresh loads the official release list, up to a fixed limit, and releases install under `userData/runtimes/hashlink/<version>/`.

## Command-line inspection

`pnpm launch --game /path/to/game --inspect` inspects a game, and `--action inspectBytecode` runs the bytecode inspection.

## Source and licenses

- [HashLink bytecode reader, commit c3f2a15](https://github.com/HaxeFoundation/hashlink/blob/c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14/src/code.c)
- [HashLink native module loader](https://github.com/HaxeFoundation/hashlink/blob/c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14/src/module.c)
- [HashLink source and MIT license](https://github.com/HaxeFoundation/hashlink/tree/c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14)
