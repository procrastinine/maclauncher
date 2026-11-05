# Godot

[Godot](https://godotengine.org/) is an open-source game engine. MacLauncher runs Godot games with a matching official Godot release, or with a Mac app supplied with the game, and recovers projects and scripts with [GDRE Tools](https://github.com/GDRETools/gdsdecomp).

## Detection

Import accepts:

- an exported pack (`.pck`)
- a Windows, Linux or Mac export, with the pack embedded in the executable or next to it, in the imported folder or one of its immediate subfolders
- a source project folder with `project.godot`, `project.binary`, `engine.cfg` or `engine.cfb`

The engine version comes from the pack header or the project configuration. GDRE Tools can also detect the version and bytecode revision on request with **Detect version**.

A release folder can keep its export in a subfolder beside a small launcher. When the executables of one export share a pack, detection records the Windows executable. Exports with different packs, however, make the folder ambiguous, so it is not detected as a Godot game.

Some games ship a customized engine, which can rename the pack's magic and number its own pack format while keeping one of Godot's pack layouts. To recognize such a pack, detection reads it through each standard layout and accepts it as Godot only when one of them yields a plausible engine version and a readable directory whose first entry names a valid resource path with data inside the pack. Recognition therefore depends only on this structure, never on the bytes of one particular customization. An encrypted directory cannot be checked this way, so a pack with one is not recognized. Because no stock Godot release can read a customized pack, its game runs in the [Windows runtimes](#runtimes) with the engine build that the release includes.

During import and metadata refresh, an exported pack provides its declared application title and supported icon resources. For Windows exports, a declared native ICO icon is preferred, with the general project icon as the fallback. PNG, WebP and size-limited self-contained SVG artwork go through the same icon validation and cache as for source projects. Custom library titles and icons are kept.

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

Godot 3 and later releases come in a Standard and a .NET variant, while Godot 1 and 2 have only Standard. A .NET build can also run GDScript games. Play picks the variant in this order:

1. .NET, when the game needs it. An exported game needs .NET when its pack declares C# or Mono content, such as C# scripts, a `.mono` folder or .NET project settings, or when a `data_*` folder beside the pack holds `.dll` assemblies. A `.csproj` or `.sln` file or a `.mono` or `GodotSharp` folder beside the pack, or in a source project's folder, has the same effect. DLLs placed directly beside the executable, such as GDExtension or Steam libraries, are native libraries and do not count.
2. The variant chosen for the game.
3. The variant already installed for the Godot version that Play uses, with Standard preferred when both are installed.
4. Standard, which Play downloads when neither variant of that version is installed.

When the game has no variant choice, the inspector's **Variant** menu names the result of this order as **Default (Standard)** or **Default (.NET)**, so the label changes when a build is installed or removed. For a game that needs .NET, the menu shows **Default (.NET)** unless .NET itself is chosen; **Standard** is disabled, and the note "This game uses C#, so it needs the .NET build." appears under the menu. A Standard choice that was saved for such a game stays in the game's settings but does not apply. **Install**, beside the version menu, installs the variant that Play uses. A custom runtime selected for the game, on the other hand, runs with its own variant, so a game that needs .NET requires a .NET custom runtime. The game's C# assemblies must also match the selected Godot API and, where required, have compatible macOS native dependencies.

### Catalog and installation

Godot versions are listed from the [Godot download archive](https://godotengine.org/download/archive/), where **Reload** finds the stable and development releases that have usable 64-bit macOS builds. The base 1.x and 2.0 releases are left out because they have only 32-bit Mac players. Later 2.0 patch builds use the publisher's 64-bit or multi-architecture ("fat") archive, and outdated 2.1 download links are replaced by the publisher's fat archive. Installation extracts the selected Standard or .NET build to `userData/runtimes/godot/<version>/<variant>/`, and before it replaces an installed app, it checks the architecture of the actual executable.

## Preparation

A pack with a standard trailer is opened directly from the original executable. A pack found only as an executable section, by contrast, is copied to per-game storage with its resource offsets adjusted, so that it can load as a standalone pack.

When a Godot 4 source project has no resource cache yet, the selected engine imports it before Play, working in the original project folder. Godot creates its `.godot` cache and the resources' `.import` sidecars there, while assets, working directories and ordinary user-data paths stay in their original locations. Imported resources and completed script-only editor indexes that already exist are reused without copying or scanning the source tree. Packed games skip this import step.

Godot 3 .NET games likewise run from their original project or pack, with the original game folder as the working directory. Godot refreshes its API assemblies in the project's `.mono` folder from the selected runtime. The game's exported managed assemblies, stored in Release folders or beside a pack, are added to the original `.mono/temp/bin/Debug` folder when the editor player needs them. Debug assemblies that are already in that folder take precedence, and this preparation never replaces them.

A pack that contains Debug API assemblies needs a filtered copy, because the packed assemblies could otherwise override Godot's API refresh. This copy is kept in per-game storage together with its adjacent `override.cfg`. Ordinary file reads and writes still use the original game folder, and no other game assets are copied. Private game copies made by earlier MacLauncher versions, together with any data stored in them, stay untouched: Play neither moves nor removes them.

## Graphics

Godot 4.4 and later 4.x releases include a camera helper for shared graphics effects on the Metal Forward+ renderer. Play loads this helper only when the game's saved graphics settings use it, which is the case for an enabled **Temporal upscaling** setting in the Graphics section, frame generation that reads scene data, an effect that reads scene inputs such as depth or surface normals, or a changed **Game resolution**. Every other launch starts the original project or pack directly.

The helper is an autoload, and Godot reads `override.cfg` only beside a project folder or main pack. A launch that uses the helper therefore starts from a per-game folder that holds the combined `override.cfg` along with links to the original pack, or to every project entry including the `.godot` import cache. Reads and writes still reach the original files, and the working folder remains the game's own. With either the Godot runtime or a recognized native Mac app, the game's files, autoloads and save settings stay unchanged. If an effect that needs the helper is selected while the game runs without it, the effect applies on the next launch.

Single-view perspective scenes provide the actual frame projection, depth and motion inputs through the helper, and the **Game default** option restores the game's original viewport scaler. The [camera integration reference](../../src/modules/godot/graphics/README.md) describes the rendering requirements and the included helper.

## Tools

The inspector's tools use GDRE Tools:

| Group | Actions | Output |
| --- | --- | --- |
| Project | **Recover project**, **Recover project again…**, **Detect version**, **List packed files**, **Reveal**, **Refresh status**, **Remove extracted files** | A recovered project and resources, and an inventory of packed files |
| Resources | **Decompile GDScript…**, **Convert resources to text…**, **Convert resources to binary…** | Readable GDScript, where the selected GDRE release supports the bytecode, and converted resources |

Encrypted packs require the matching key. Native GDExtensions and C# assemblies are separate code formats, and project recovery does not reconstruct native extension source.

**Reload** only checks local status. GDRE Tools releases come from [GitHub](https://github.com/GDRETools/gdsdecomp/releases) and are installed under `userData/runtimes/gdsdecomp/<version>/`. The versions appear in the GDRE Tools section of **Runtimes → Godot**, where a newer installed version becomes the default.

Once a project has been recovered, the **Prefer extracted project** setting, which is off by default, launches the recovered project files when they are available.
