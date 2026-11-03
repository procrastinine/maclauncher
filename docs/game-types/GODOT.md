# Godot

[Godot](https://godotengine.org/) is an open-source game engine. MacLauncher runs Godot games with a matching official Godot release, or with a Mac app supplied with the game, and recovers projects and scripts with [GDRE Tools](https://github.com/GDRETools/gdsdecomp).

## Detection

Import accepts:

- an exported pack (`.pck`)
- a Windows, Linux or Mac export, with the pack embedded in the executable or next to it, in the imported folder or one of its immediate subfolders
- a source project folder with `project.godot`, `project.binary`, `engine.cfg` or `engine.cfb`

The engine version comes from the pack header or the project configuration. GDRE Tools can also detect the version and bytecode revision on request with **Detect version**.

A release folder can keep its export in a subfolder beside a small launcher. When the executables of one export share a pack, detection records the Windows executable. Exports with different packs are ambiguous, and the folder is not detected as a Godot game.

A customized engine can rename the pack's magic, and number its own pack format, while keeping one of Godot's pack layouts. Detection reads such a pack through each standard layout and accepts it as Godot only when one of them yields a plausible engine version and a readable directory whose first entry names a valid resource path with data inside the pack. An encrypted directory cannot be checked this way, so such a pack is not recognized. No stock Godot release can read a customized pack, and its game runs in the [Windows runtimes](#runtimes) with the engine build that the release includes. Recognition depends only on this structure and never on one customization's bytes.

Exported packs supply their declared application title and supported icon resources during import and metadata refresh. Windows exports prefer a declared native ICO icon and fall back to the general project icon. PNG, WebP and size-limited self-contained SVG artwork use the same icon validation and cache as source projects. Custom library titles and icons are kept.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Godot (default) | Official Godot release from **Runtimes → Godot** |
| Game's macOS app | A compatible Mac app supplied with the game |
| CrossOver, Sikarugir (Wine) | Windows runtimes for the game's Windows executable |

### Versions

A game's Godot version defaults to the detected engine version, although explicit game and global choices take precedence over detection. A detected base version maps to the archive catalog at installation; `3.4.1`, for example, maps to the latest `3.4.1-*` release when one exists. An installed `x.y` release also satisfies a detected `x.y.0` through the usual version grouping. When only a major version is detected, MacLauncher picks the latest compatible installed version for that major version and variant before consulting the archive.

Without a detected version or an explicit choice, a single compatible installed runtime is used; otherwise **Runtimes** asks for a version choice.

### Standard and .NET variants

Godot 3 and later releases have a Standard and a .NET variant, and Godot 1 and 2 have only Standard. A .NET build also runs GDScript games. Play picks the variant in this order:

1. .NET, when the game needs it. An exported game needs .NET when its pack declares C# or Mono content, such as C# scripts, a `.mono` folder or .NET project settings, or when a `data_*` folder beside the pack holds `.dll` assemblies. A `.csproj` or `.sln` file or a `.mono` or `GodotSharp` folder beside the pack, or in a source project's folder, has the same effect. DLLs placed directly beside the executable, such as GDExtension or Steam libraries, are native libraries and do not count.
2. The variant chosen for the game.
3. The variant already installed for the Godot version that Play uses, with Standard preferred when both are installed.
4. Standard, which Play downloads when neither variant of that version is installed.

The inspector's **Variant** menu names the result of this order without a game choice as **Default (Standard)** or **Default (.NET)**, so the label changes when a build is installed or removed. For a game that needs .NET, the menu shows **Default (.NET)** unless .NET itself is chosen. **Standard** is disabled in that menu, and the note "This game uses C#, so it needs the .NET build." appears under it. A Standard choice saved for such a game stays in the game's settings and does not apply. **Install** beside the version menu installs the variant that Play uses. A custom runtime selected for the game runs with its own variant, so a game that needs .NET requires a .NET custom runtime. The game's C# assemblies must match the selected Godot API and, where required, have compatible macOS native dependencies.

### Catalog and installation

Godot versions are listed from the [Godot download archive](https://godotengine.org/download/archive/), and **Reload** loads stable and development releases with usable 64-bit macOS builds. The base 1.x and 2.0 releases have only 32-bit Mac players and are left out. Later 2.0 patch builds use the publisher's 64-bit or multi-architecture ("fat") archive, and outdated 2.1 download links are replaced by the publisher's fat archive. Installation checks the architecture of the actual executable before it replaces an installed app and extracts the selected Standard or .NET build to `userData/runtimes/godot/<version>/<variant>/`.

## Preparation

Packs with a standard trailer are opened directly from the original executable. Packs found only as an executable section are copied to per-game storage with their resource offsets adjusted, so they can load as standalone packs.

Godot 4 source projects without an existing resource cache are imported with the selected engine before Play, in the original project folder. Godot creates its `.godot` cache and resource `.import` sidecars there. Assets, working directories and ordinary user-data paths stay in their original locations. Existing imported resources and completed script-only editor indexes are reused without copying or scanning the source tree. Packed games skip this import step.

Godot 3 .NET games use their original project or pack and the original game folder as the working directory. Godot refreshes its API assemblies in the project's `.mono` folder from the selected runtime. Exported managed assemblies stored in Release folders or beside a pack are added to the original `.mono/temp/bin/Debug` folder when the editor player needs them. Debug assemblies that are already there take precedence and are never replaced by this preparation.

A pack containing Debug API assemblies needs a filtered copy so that packed assemblies cannot override Godot's API refresh. This copy stays in per-game storage with its adjacent `override.cfg`, while ordinary file reads and writes still use the original game folder. Other game assets are not copied. Private game copies made by earlier MacLauncher versions, and any data stored in them, stay untouched; Play neither moves nor removes them.

## Graphics

Godot 4.4 and later 4.x releases include a camera helper for shared graphics effects on the Metal Forward+ renderer. Play loads it only when the game's saved graphics plan uses it: an enabled temporal upscaling row, frame generation that reads scene data, an effect that reads scene inputs such as depth or surface normals, or a changed **Game resolution**. Every other launch starts the original project or pack directly.

The helper is an autoload, and Godot reads `override.cfg` only beside a project folder or main pack. A launch that uses the helper therefore starts from a per-game folder that holds the combined `override.cfg` and links to the original pack or to every project entry, the `.godot` import cache included. Reads and writes reach the original files, and the working folder stays the game's own. The game's files, autoloads and save settings stay unchanged, with either the Godot runtime or a recognized native Mac app. An effect that needs the helper and is selected while the game runs without it applies on the next launch.

Single-view perspective scenes supply the actual frame projection, depth and motion inputs, and the **Game default** option restores the game's original viewport scaler. The [camera integration reference](../../src/modules/godot/graphics/README.md) describes the rendering requirements and the included helper.

## Tools

The inspector's tools use GDRE Tools:

| Group | Actions | Output |
| --- | --- | --- |
| Project | **Recover project**, **Recover project again…**, **Detect version**, **List packed files**, **Reveal**, **Refresh status**, **Remove extracted files** | A recovered project and resources, and an inventory of packed files |
| Resources | **Decompile GDScript…**, **Convert resources to text…**, **Convert resources to binary…** | Readable GDScript, where the selected GDRE release supports the bytecode, and converted resources |

Encrypted packs require the matching key. Native GDExtensions and C# assemblies are separate code formats, and project recovery does not reconstruct native extension source.

**Reload** only checks local status. GDRE Tools releases come from [GitHub](https://github.com/GDRETools/gdsdecomp/releases) and install under `userData/runtimes/gdsdecomp/<version>/`; the versions appear in the GDRE Tools section of **Runtimes → Godot**, where a newer installed version becomes the default.

The **Prefer extracted project** setting (off by default) launches the recovered project files when they are available.
