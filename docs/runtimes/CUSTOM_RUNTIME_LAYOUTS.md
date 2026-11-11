# Custom runtime layouts

A custom runtime is a runtime or tool registered from a local path instead of downloaded. Each runtime list in **Runtimes** that accepts local runtimes has a **Register custom…** control next to its installed versions, shared by all of that list's download sources. Registered paths appear in the ordinary global and per-game version selectors, and a path that is no longer available reports a local error. Engine families that are not compatible with each other keep separate registrations and defaults.

A custom runtime stays in its selected location, and removing its registration leaves the files in place. The registration is identified by its absolute path, and the engine's version metadata is recorded separately.

## Accepted selections

| Runtime | Accepted selections |
| --- | --- |
| Ren'Py SDK | A complete SDK directory, or an application, script or executable inside that SDK. The SDK includes `renpy.sh`, `renpy.py`, `renpy`, `launcher`, and compatible macOS `renpy` and `python` executables. Its version metadata decides whether it belongs to the Ren'Py 7 or the Ren'Py 8 list. |
| Ruffle | A native executable, a Ruffle application, or a directory containing `ruffle`, `Ruffle`, `bin/ruffle` or `Ruffle.app`. |
| Godot | A native executable, a Godot application, or a directory containing the application or `Godot`, `godot` or `bin/godot`. Applications keep their bundled resources, including GodotSharp for .NET runtimes. |
| Godot RE Tools | A native executable, a GDRE application, or a directory containing the application or `gdre_tools`, `GDRE_tools` or `bin/gdre_tools`. |
| Java | A Java executable, a JDK bundle, or a Java home containing `bin/java` and a `release` file. The recorded Java major version decides its runtime line. |
| Vineflower and Java tools | An application JAR or a complete tool directory. The expected main class and the relative Java dependencies must be present. Vineflower includes `ConsoleDecompiler`. |
| LÖVE | A native executable, application or runtime directory. LÖVE 11 and LÖVE 12 use separate lists, and the application metadata identifies the engine family. |
| LuaSteam | A compatible Lua 5.1 native library and the libraries it depends on. |
| NW.js | A native executable, application or runtime directory. The Chromium application version is recorded separately from the NW.js runtime version. |
| Greenworks | A complete directory of JavaScript and native modules with matching NW.js version metadata. |
| MKXP-Z | A complete application, the directory that contains it, or an executable inside the application. Ruby, configuration and library resources stay part of the application. |
| Flash Player | A native projector executable, application or runtime directory. Intel executables use Rosetta on Apple silicon. |
| ONScripter Yuri | A native executable or application for the Mac list, or an extracted HTML, JavaScript and WebAssembly runtime for the Web list. |
| Browser Woditor | A complete directory containing `index.html`, the public assets and `BrowserWoditor.dat`. |
| nxnative | A complete upstream source folder or its preparation script. The native tools it needs are downloaded when needed, and existing complete runtime packages are also accepted. |
| AnyPS5 and Android packages | A complete compatible runtime package, or a program inside it. The package's own metadata names the tools, libraries, resources and CPU architecture it needs. |
| FNA, Unity and GameMaker | A complete native runtime directory with its framework or player version metadata and the files it depends on. Unity keeps its exact player-version matching. |
| CrossOver and Sikarugir | A complete CrossOver application, or a Sikarugir runtime with its Wine engine, support libraries and the metadata that lists them. |
| WineCX | None; WineCX has no Register custom… control. WineCX versions come only from its managed downloads, whose installation records the sealed file inventory that each launch checks. |
| HashLink | An Intel VM with its native modules and version header, or a complete runtime package. Bytecode versions and native primitive signatures decide compatibility. |
| ILSpy | A DLL, an app host, or a directory containing `ilspycmd`, `ICSharpCode.Decompiler`, the runtime configuration, dependency metadata and referenced assemblies. The shared .NET host that MacLauncher installs stays available. |
| Native runtimes and tools | A compatible native executable, application or runtime directory with its libraries and data. Windows tools keep their PE executable format. |
| Python tools | A complete source package with the configured script or module entry point and its required files. The launcher supplies Python. |
| Vulkan | A compatible dynamic library or runtime directory. KosmicKrisp also requires its Vulkan loader, and MacLauncher KosmicKrisp keeps its package metadata. |
| Graphics models | A compatible Lossless Scaling DLL or a complete neural model bundle. Registration reads the existing model formats and keeps the original weights and resources. |
| Shader collections | A complete compatible collection directory with its shader sources, includes and textures. |

## Inspection of registered runtimes

Registration and runtime status never run the selected program. Local inspection reads executable headers, SDK layouts and application metadata. A standalone Godot executable without application version metadata reports its version during Play.

Native executables registered for the native engines go through the shared `local-native.js` checks. The path must be absolute and executable, and the file must be a thin or universal 64-bit Mach-O executable whose slices fit within fixed limits and include one that the host CPU supports. Shell scripts, ELF and PE files, and Mach-O libraries are rejected as executables. x86_64-only builds on Apple silicon run through Rosetta. Arguments go directly to the process launcher, without a shell.
