# Custom runtime layouts

A runtime or tool that is already on the Mac can be registered from its local path instead of being downloaded. Such a custom runtime is added with the **Register custom…** control that sits next to the installed versions in each **Runtimes** list that accepts local runtimes; one control serves all of that list's download sources. Registered paths then appear in the ordinary global and per-game version selectors, and a path that has since disappeared reports a local error. Engine families that are not compatible with each other keep separate registrations and defaults.

MacLauncher never moves a custom runtime, and removing the registration leaves the files where they are. Each registration is keyed by its absolute path, while the engine's version metadata is recorded separately.

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
| WineCX | A WineCX `Libraries` folder, the folder that contains it, or a file inside it. `Libraries/Wine` must hold the Wine loader, `wineserver` and the native Wine components that a download needs. The CPU and the macOS requirement are read from its native images, the Wine version from its `ntdll.so`, and the translator versions from its version plist. |
| MetalSharp Wine and Highball Wine | A Wine application or Wine tree of that source, or a file inside it: the folder holding `lib/wine` with a `wine` executable in `bin`, or in `MacOS` inside an application. A signed application is used with its own loaders and keeps its signature. A build that runs through another application's loader must reach that application's installed executable through its `lib/wine` Unix loader. |
| HashLink | An Intel VM with its native modules and version header, or a complete runtime package. Bytecode versions and native primitive signatures decide compatibility. |
| ILSpy | A DLL, an app host, or a directory containing `ilspycmd`, `ICSharpCode.Decompiler`, the runtime configuration, dependency metadata and referenced assemblies. The shared .NET host that MacLauncher installs stays available. |
| Native runtimes and tools | A compatible native executable, application or runtime directory with its libraries and data. Windows tools keep their PE executable format. |
| Python tools | A complete source package with the configured script or module entry point and its required files. The launcher supplies Python. |
| DXVK-NVAPI | The x64 `nvapi64.dll`, or a folder, such as an extracted release, that holds exactly one x64 DXVK-NVAPI library. The library must be a 64-bit Windows image that exports `nvapi_QueryInterface` from its code. |
| Steam client bridge | A bridge package folder in its published layout, or a file inside it. The manifest's `steamBridge` entry must match the loader paths of the running MacLauncher, and every part it names must be present. [Windows Steam games](WINDOWS_STEAM.md#runtimes-and-inspector) describes the bridge. |
| Windows Steam client files | A folder that holds `steamclient.dll`, a 32-bit Windows image, and `steamclient64.dll`, a 64-bit Windows image, or a file in it. The names match in any letter case. |
| Vulkan | A compatible dynamic library or runtime directory. KosmicKrisp also requires its Vulkan loader, and MacLauncher's KosmicKrisp build keeps its package metadata. |
| Vulkan loader | A native `libvulkan.1.dylib`, or a directory containing it at the root or under `lib`. The loader's CPU must match the process loading the Vulkan driver. |
| Graphics models | A compatible Lossless Scaling DLL or a complete neural model bundle. Registration reads the existing model formats and keeps the original weights and resources. |
| Shader collections | A complete compatible collection directory with its shader sources, includes and textures. |

## Inspection of registered runtimes

Neither registration nor the runtime status display runs the selected program. Instead, MacLauncher inspects it locally by reading executable headers, SDK layouts and application metadata. A standalone Godot executable that lacks application version metadata is the exception: its version is read when Play starts it.

For the native engines, a registered executable has to pass the shared checks in `local-native.js`. Its path must be absolute and executable, and the file must be a thin or universal 64-bit Mach-O executable whose slices fit within fixed limits, with at least one slice that the host CPU supports. Shell scripts, ELF and PE files and Mach-O libraries are rejected as executables. On Apple silicon, an x86_64-only build runs through Rosetta. Arguments are passed directly to the process launcher without a shell.
