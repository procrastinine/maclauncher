# HashLink (Haxe bytecode)

[Haxe](https://haxe.org/) can compile a game to HashLink bytecode, which the [HashLink](https://github.com/HaxeFoundation/hashlink) virtual machine runs together with native modules for graphics, audio and other system access. MacLauncher runs HashLink games with the Intel HashLink VM, natively on Intel Macs and through Rosetta on Apple Silicon. Playback does not load Electron, run Windows programs or use Wine.

| Runtime | Description |
| --- | --- |
| HashLink (Intel Mac; Rosetta on Apple Silicon) (default) | Intel HashLink VM: upstream releases and development snapshots, or MacLauncher Builds 1.9 and 1.12 packages |
| CrossOver, Sikarugir | Run the original Windows executable |

Haxe games compiled to native machine code instead of bytecode are a separate game type, [Haxe native build](HAXE.md).

## Importing games

Import accepts a `.hl` file, a `hlboot.dat` file, or a folder with an unambiguous bytecode entry. In each case, the bytecode is imported together with its resources. A `hlboot.dat` file can also be identified through an adjacent Windows launcher, without the launcher being run.

## Detection and versions

A HashLink game needs two things from its runtime: a VM that reads its bytecode version, and native modules whose functions (primitives) match the signatures the bytecode was compiled against. MacLauncher checks the two separately.

The bytecode version, such as `HLB5`, is checked against the VM, while each native module's API is checked on its own. Bytecode can require the `std`, `fmt`, `ui`, `sdl` and `openal` modules, and their APIs have changed between releases. [HashLink 1.9](https://github.com/HaxeFoundation/hashlink/blob/1.9/libs/sdl/sdl.c), for example, passed SDL events to the game as a typed Event argument, whereas [1.10 and later](https://github.com/HaxeFoundation/hashlink/blob/1.10/libs/sdl/sdl.c) changed that primitive to a dynamic argument. A newer VM that reads the same bytecode format can therefore reject bytecode that needs the older native ABI. The inspector reads the serialized argument type, which tells typed Event arguments apart from dynamic ones.

Before a launch, MacLauncher reads the native signatures from the selected runtime's installed images and compares them with the bytecode's requirements. A selected version that is known to be incompatible is blocked, while a primitive ABI that cannot be determined is reported as unknown. MacLauncher never coerces native types.

The inspector shows the bytecode version, the bytecode file, the version source, a confidence level and the SDL primitive ABI. **Inspect bytecode**, in the inspector's **Advanced** group, uses the included metadata reader, which supports bytecode versions 2 to 6.

## Native modules

MacLauncher reads the names of the native libraries that the bytecode needs without loading them. Standard and built-in modules come from the runtime. Other modules are looked for in the optional custom macOS module folder, the runtime folder and the bytecode folder, and launch passes those folders to the game through `DYLD_LIBRARY_PATH`.

- A missing required library, or a Windows or wrong-CPU `.hdll` file, blocks launch with a diagnostic that names the problem. Missing optional imports stay optional.
- A Mach-O library is usable only when its primitive signatures match and its own dependent libraries are present.
- Known native signatures are compared with the bytecode's requirements without running the game. Custom modules with unknown signatures are listed separately in the report.

## Preparation and saves

HashLink reads the original bytecode and uses the folder that contains it as the working directory. Resources, relative saves and configuration therefore remain at the game's own paths, and Play creates neither a copy of the game nor links to its resources in launcher storage.

Compatible macOS native modules are searched in a fixed order: first a custom module directory, then the runtime directory and finally the game directory. Windows HDLL files cannot replace the required native modules. Because HashLink games have no common save format, MacLauncher infers no save file name.

Earlier MacLauncher versions ran HashLink games from a private folder in launcher data, where saves and configuration written at relative paths were kept. During the first startup after an upgrade, those files are recovered once into the folder that holds the original bytecode, as [Earlier private game folders](../library/GAME_PREPARATION.md#earlier-private-game-folders) describes. A file missing from the original game returns to its original relative path. An existing original file stays unchanged, however, and a private version that differs is kept beside it as `<filename>.MacLauncher-conflict-<id>`. A private folder that a save-folder override still names stays in use; Play does not read the other earlier folders.

## Settings

| Setting | Description |
| --- | --- |
| Additional macOS native modules directory | A folder of extra native modules. Modules must match the Intel HashLink runtime; Windows `.hdll` files are incompatible. |
| Application arguments | Extra arguments for the game, one per line. |

## Bytecode export

For bytecode versions 4 and 5, **Export bytecode**, in the inspector's **Advanced** group, exports metadata, function opcodes and pseudocode for the entry point with the [hlbc](https://github.com/Gui-Yom/hlbc) tool. The pseudocode is hlbc's experimental decompiler output and does not recover a complete Haxe source project. The published hlbc command-line tool can also fail on some functions or compiler output; when it does, the export keeps the available metadata, partial listings, tool logs and explicit warnings.

hlbc is listed under **Runtimes → HashLink → hlbc**. It runs in a private Windows environment through Sikarugir or CrossOver, and a missing Sikarugir engine is downloaded after its own confirmation.

## Runtimes

### HashLink (Intel Mac; Rosetta on Apple Silicon)

The Intel HashLink VM is the default runtime and runs as Intel 64-bit code, using the Intel slice of universal distributions. An ARM build cannot take its place: the upstream JIT compiler emits x86 code, so HashLink's ARM libraries do not contain the bytecode VM, and an ARM HashLink/C support library cannot replace the Intel VM. On Apple Silicon, the game therefore runs under Rosetta, and shared graphics processing selects providers for the same Intel architecture.

**Runtimes → HashLink** lists published releases, development snapshots and the older Mac packages in its **Upstream**, **HashLink 1.9** and **HashLink 1.12** sections. Versions from published tags such as `1.16`, `1.15`, `1.14` and `1.12` keep the upstream tag name and record its exact commit.

#### Version selection

The game's bytecode determines the recommended version: the newest catalog package whose declared bytecode and SDL event ABI requirements match and whose CPU and macOS requirements this Mac meets. MacLauncher keeps no list of allowed package versions or primitive profiles that would limit the catalog, and missing optional profile metadata does not hide a version. Before Play, however, the installed native modules must supply the function signatures that this game calls.

The global default applies when the bytecode gives no SDL or native primitive evidence, or when no listed package matches. The recommendation is used for preparation and launch checks but is not saved as a per-game choice.

#### Development snapshots

The [public development archive](https://github.com/HaxeFoundation/hashlink/releases/tag/latest) is published under the `latest` tag, which the HashLink project moves to each new build. Its builds report version `2.0.0`, so MacLauncher identifies each one as `2.0.0-dev-<commit>`, with the full source commit and the publisher's SHA-256. These are upstream development builds, distinct from a stable `2.0.0` release. A snapshot contains the Intel VM and the `fmt`, Heaps, SDL, OpenAL, SQLite, SSL, UI and libuv modules, and because their Mac libraries are included in the archive, Homebrew is not needed.

Because the tag moves, Refresh resolves `latest` to an exact commit and selects the Intel Mac archive with its publisher digest. The current file name is preferred, but a renamed or differently packaged archive is also accepted. For a new snapshot, MacLauncher reads the reported version, the supported bytecode range and the SDL primitive declaration from that exact source revision, and it rejects a snapshot whose source does not declare these in a form it recognizes. Installation finds the VM wherever the archive places it and verifies that the native files include Intel code, that every dependent library is present, and that the required VM and SDL exports exist. The archive's own header and VM library version are recorded as found, and the snapshot's minimum macOS version is the highest one that its native files declare. At launch, the installed native files and library aliases are verified.

#### HashLink 1.9 and 1.12 packages

Some games need an older native ABI, but HashLink itself publishes no Mac releases of those versions. For these games, MacLauncher Builds publishes two Mac packages, built from upstream HashLink 1.9 and 1.12. Each package keeps the VM and native signatures of its upstream version together with matching `fmt`, SDL and OpenAL modules.

- The 1.9 packages keep the VM, the bytecode reader and the typed SDL primitive ABI at the exact upstream 1.9 commit. The build replaces the build machine's source, build, temporary, cache, home and workspace paths with neutral names in every compiled component.
- The 1.12 packages keep the [HashLink 1.12](https://github.com/HaxeFoundation/hashlink/tree/68daa125ad115a1f1d1db65d38e6045858d55013) VM and native signatures: the older byte argument of `fmt@mp3_open`, dynamic SDL event callbacks and the complete set of OpenAL effects primitives. They include matching SDL2 and OpenAL Soft dependencies.

The newer public snapshot has different `fmt` signatures and fewer OpenAL effects primitives. Two packages that share a bytecode format or SDL event ABI are therefore not interchangeable. Launch instead compares every required native primitive with the installed modules, and it never rewrites bytecode or substitutes a different native type.

Each package's MacLauncher Builds release commit contains the exact upstream commits, MacLauncher's Mac build changes, the notices and the build script.

#### Primitive profiles

A native primitive profile records the function signatures observed in a package's installed images. Its identifier, source revision and descriptive hashes neither allow nor exclude any downloadable version, and the signature comparison itself remains specific to each game's native calls.

#### Local builds

A complete matching native distribution can also be imported in **Runtimes → HashLink** by selecting its version and choosing **Import local build…**. The imported Intel process runs under Rosetta on Apple Silicon, and Play can request the Rosetta installation with explicit consent to Apple's license.

### CrossOver and Sikarugir

Compatible x86 and x64 Windows releases can also run their original executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir](../runtimes/SIKARUGIR.md). The detected engine and its inspector tools stay available with either runtime.

## Versions and installation

HashLink versions follow the [shared selection rules](../runtimes/README.md#versions), with the bytecode recommendation described under [Version selection](#version-selection). Refresh loads the official release list up to a fixed limit, and releases are installed under `userData/runtimes/hashlink/<version>/`.

## Command-line inspection

`pnpm launch --game /path/to/game --inspect` inspects a game, and `--action inspectBytecode` runs the bytecode inspection.

## Source and licenses

- [HashLink bytecode reader, commit c3f2a15](https://github.com/HaxeFoundation/hashlink/blob/c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14/src/code.c)
- [HashLink native module loader](https://github.com/HaxeFoundation/hashlink/blob/c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14/src/module.c)
- [HashLink source and MIT license](https://github.com/HaxeFoundation/hashlink/tree/c3f2a1563cf7aa9f4076b0808a7eaf40e18e8f14)
