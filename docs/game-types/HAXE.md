# Haxe native build

[Haxe's C++ target](https://haxe.org/manual/target-cpp-getting-started.html) compiles game logic into platform-specific machine code through [hxcpp](https://github.com/HaxeFoundation/hxcpp). A Windows build made with the [Lime](https://lime.openfl.org/docs/project-files/xml-format/) framework ships as a native executable with Lime support libraries such as `lime.ndll`. MacLauncher identifies Windows builds of this kind, inspects them and plays them through a Windows runtime.

| Runtime | Description |
| --- | --- |
| Native build inspection (default) | Detection and binary inspection; does not launch the game |
| CrossOver, Sikarugir (Wine) | Run the original Windows executable |

A Windows executable cannot be converted into a Mac game by replacing `lime.ndll` with a Mac library. Native playback on macOS needs a macOS, Flash, HTML5 or HashLink export of the game. HashLink bytecode exports are a separate game type, [HashLink (Haxe bytecode)](HASHLINK.md).

## Detection and versions

Detection distinguishes this target by the native PE and CFFI exports and the CPU types of the executable and its libraries. Only after that structural check can OpenFL class metadata identify the framework, and detection starts no runtime or compiler.

Lime supports several separate compilation targets. Its native libraries can contain Neko and HashLink adapters without the game itself being in either bytecode format, and embedded Flash clips can be supporting assets rather than a playable Flash export.

Available hxcpp versions are read from build strings in the support library and reported explicitly, and missing metadata stays unknown. These versions describe the C++ support library and do not identify the Haxe compiler, the OpenFL release or the game's patch level. The inspector shows the target, the CPU and the support status.

## Binary inspection

**Inspect binary** uses the [Rizin / Ghidra tools](../tools/NATIVE_INSPECTION.md) to export native metadata and C pseudocode without running the game. The pseudocode is not the original Haxe source.

## Runtimes

### Native build inspection

Native build inspection, the default runtime, provides detection, version information and **Inspect binary** but cannot launch the game.

### CrossOver and Sikarugir (Wine)

Play runs a Windows hxcpp/Lime build through a registered [CrossOver](../runtimes/CROSSOVER.md) application when one is available, and otherwise through [Sikarugir (Wine)](../runtimes/SIKARUGIR.md). Detection and **Inspect binary** stay available with either runtime.
