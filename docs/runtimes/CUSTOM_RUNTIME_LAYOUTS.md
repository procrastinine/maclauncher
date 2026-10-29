# Custom runtime layouts

Custom runtimes remain in their selected locations. The absolute selected path identifies a registration; engine version metadata remains separate. Removing a registration leaves its files in place.

**Register custom…** belongs to each compatible runtime list. Download providers share that control and the installed list. Incompatible engine families retain separate registrations and defaults. Registered paths appear in the ordinary global and per-game selectors; an unavailable path reports a local error.

| Runtime | Supported selections |
| --- | --- |
| Ren'Py SDK | A complete SDK directory, or an application, script or executable within that SDK. The SDK includes `renpy.sh`, `renpy.py`, `renpy`, `launcher`, and compatible macOS `renpy` and `python` executables. Version metadata determines compatibility with the Ren'Py 7 or Ren'Py 8 list. |
| Ruffle | A native executable, a Ruffle application, or a directory containing `ruffle`, `Ruffle`, `bin/ruffle` or `Ruffle.app`. |
| Godot | A native executable, a Godot application, or a directory containing the application or `Godot`, `godot` or `bin/godot`. Applications retain their bundled resources, including GodotSharp for .NET runtimes. |
| Godot RE Tools | A native executable, a GDRE application, or a directory containing the application or `gdre_tools`, `GDRE_tools` or `bin/gdre_tools`. |
| Java | A Java executable, JDK bundle or Java home containing `bin/java` and a `release` file. The recorded Java major determines its compatible runtime line. |
| Vineflower and Java tools | An application JAR or complete tool directory. The expected main class and relative Java dependencies remain required. Vineflower includes `ConsoleDecompiler`. |
| LÖVE | A native executable, application or runtime directory. LÖVE 11 and LÖVE 12 use separate lists; application metadata identifies the engine family. |
| LuaSteam | A compatible Lua 5.1 native library and its dependent libraries. |
| NW.js | A native executable, application or runtime directory. Chromium application version metadata remains distinct from the NW.js runtime version. |
| Greenworks | A complete JavaScript and native-module directory with matching NW.js version metadata. |
| MKXP-Z | A complete application, its containing directory or an executable inside the application. Ruby, configuration and library resources remain part of the application. |
| Flash Player | A native projector executable, application or runtime directory. Intel executables use Rosetta on Apple Silicon. |
| ONScripter Yuri | A native executable or application for the Mac list; an extracted HTML, JavaScript and WebAssembly runtime for the Web list. |
| Browser Woditor | A complete directory containing `index.html`, public assets and `BrowserWoditor.dat`. |
| nxnative | A complete upstream source folder or its preparation script; native tools download automatically when needed. Existing complete runtime packages remain supported. |
| AnyPS5 and Android packages | A complete compatible runtime package, or a program inside it. Existing package metadata binds the required tools, libraries, resources and CPU profile. |
| FNA, Unity and GameMaker | A complete native runtime directory with its framework or player version metadata and dependent files. Unity retains exact player-version matching. |
| CrossOver and Sikarugir | A complete CrossOver application, or a Sikarugir runtime with its Wine engine, support libraries and inventory metadata. |
| HashLink | An Intel VM with its native modules and version header, or a complete runtime package. Bytecode versions and native primitive signatures determine compatibility. |
| ILSpy | A DLL, app host or directory containing `ilspycmd`, `ICSharpCode.Decompiler`, runtime configuration, dependency metadata and referenced assemblies. The shared managed .NET host remains available. |
| Native runtimes and tools | A compatible native executable, application or runtime directory with its dependent libraries and data. Windows tools retain their PE executable format. |
| Python tools | A complete source package with the configured script or module entry point and its required files. The launcher supplies Python. |
| Vulkan | A compatible dynamic library or runtime directory. KosmicKrisp also requires its Vulkan loader. The GLES 3.2 profile retains its package metadata. |
| Graphics models | A compatible Lossless Scaling DLL or complete neural model bundle. Registration reads the existing model formats and preserves original weights and resources. |
| Shader collections | A complete compatible collection directory containing shader sources, includes and textures. |

Local runtime inspection reads executable headers, SDK layouts and application metadata. A standalone Godot executable without application version metadata reports its version during Play. Registration and runtime status do not execute the selected program.
