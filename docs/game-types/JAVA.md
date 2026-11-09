# Java

Java games are distributed as executable JAR files. MacLauncher runs them with an [Eclipse Temurin](https://adoptium.net/) Java runtime, keeping the original JAR and its `-jar` launch, and can decompile them with [Vineflower](https://github.com/Vineflower/vineflower).

## Detection

Import accepts a `.jar` file or a folder that contains one. To choose a Java version, detection reads the JAR, the JARs named by its manifest `Class-Path`, and native libraries up to three folders below the JAR. Versioned classes under `META-INF/versions` do not count as evidence.

The library icon comes from PNG resources in the JAR, read within size limits. If one image is invalid, later candidates are tried, and the icon cache is refreshed when the archive changes.

## Temurin

**Runtimes → Java (Temurin)** has a section for each Java LTS line (8, 11, 17, 21 and 25), an **Other** section for Adoptium's other feature releases, and a **Vineflower** section for the decompiler.

### Java lines and versions

The game's **Line** control offers Java 8, 11, 17, 21 and 25, plus other feature releases present in installed runtimes or loaded catalogs, independently of the detected version. A saved exact version also keeps its line available before discovery. Its **Version** control lists the installed versions of the selected line, and **Reload** in **Runtimes** loads that line's available downloads. The selected JVM determines whether the JAR's bytecode can run.

Without a line chosen for the game, Play uses the line the JAR recommends, then the saved default line, otherwise Java 21. Within that line, the version chosen for the game comes first, then the line's default.

A line chosen for the game always takes precedence, including an older line for a game that needs older Java APIs. A version chosen for the game keeps its line, including Java 8 when detection recommends Java 21. When the selected line changes, including when **Auto** follows a changed JAR requirement, a saved version from another line is ignored, so that an installed JVM on the new line can be reused without a download.

Installing a release from **Runtimes** that is newer than its line's default makes it that line's default.

### Recommended line

Bytecode that needs Java 9 through 25 recommends the lowest compatible named LTS line. Bytecode requiring a later release recommends that feature release itself: Java 26 bytecode selects Java 26 rather than Java 25. These releases appear in **Other**, whose **Reload** reads the available feature releases from Adoptium. Play looks up only the line the game needs.

Bytecode for Java 8 or older recommends Java 21, for two reasons: the Temurin Java 8 builds are Intel-only on Apple silicon, and JDK 8 double-encodes escaped characters, such as a space in the game folder's path, in ZIP file system URIs.

Such a JAR recommends Java 8 instead when it depends on the Java 8 platform:

- Its classes use a Java 8 API that Java 21 lacks and the JAR does not bundle. These APIs include JAXB, JAX-WS, SOAP and activation, CORBA, Nashorn, Pack200, RMI activation, `com.apple.eawt` and `com.apple.eio`, `com.sun.awt`, and `sun.misc.BASE64Encoder` and `Decoder`.
- Its classes look up a `javax.script` engine and the JAR bundles no engine.
- One of its classes references both `ClassLoader.getSystemClassLoader` and `java.net.URLClassLoader`, the pattern that treats the system class loader as a `URLClassLoader`. That cast fails from Java 9 on.
- It ships macOS native libraries and none of them has an arm64 slice.

JavaFX is not part of the Temurin Java 8 or Java 21 builds.

### CPU architecture

Automatic CPU selection prefers the Mac's native architecture. On Apple silicon, installations prefer `arm64` and fall back to `x64` under Rosetta when no arm64 build exists, so Intel-only Java 8 packages use Rosetta. Games with native JNI libraries also require the JVM CPU those libraries need.

The variant controls follow what each line offers. If Adoptium lists no assets for one architecture, such as Java 8 `aarch64`, that variant is unavailable and the other variants remain usable. When only one variant exists, as for Java 8 on Apple silicon, the UI uses it directly.

### Catalog and installation

Temurin versions come from the Adoptium API (`/v3/assets/feature_releases/<line>/ga`), using JDK assets, and releases install under `userData/runtimes/java/<line>/<version>/<variant>/`.

### Settings

| Setting | Values |
| --- | --- |
| **JVM arguments** | One argument per line |
| **Application arguments** | One argument per line |
| **Working directory** | Jar directory (default) or game directory |

## Decompilation

**Decompile Java** recovers Java source from the JAR's class files with Vineflower, and **Reveal** opens the output. The class version of the Vineflower release chooses a compatible Java host, independently of the game's Java line.

Vineflower releases come from GitHub (`Vineflower/vineflower`) and install as `userData/runtimes/vineflower/<version>/vineflower.jar`. Vineflower keeps its own version selection, and a newer installed Vineflower becomes its default.

Obfuscation and compiler transformations can make the output harder to read, and native JNI libraries stay native code.

## Steam integration

Some Java games use [steamworks4j](https://github.com/code-disaster/steamworks4j) for Steam. The game's actual bytecode calls are inspected, and a game that uses Steam gets a matching steamworks4j JNI and the shared native [Steam API](../runtimes/STEAM_API.md) helper automatically. Games that do not use Steam get no Steam setup.

| Original wrapper | Included JNI | JVM CPU | Java requirement |
| --- | --- | --- | --- |
| 1.9.0 | `1.9.0-MCLv1` | Intel; Rosetta on Apple Silicon | Java 8 or later |
| 1.10.0 | `1.10.0-MCLv1` | Apple Silicon or Intel | Java 8 or later |

[versions.json](../../src/modules/java/runtime/steamworks/versions.json) lists the exact wrapper class hashes, publisher JAR and JNI hashes, source revisions, interface versions and loader hashes. A newer JNI is never substituted for an older wrapper. Games with an Intel-only wrapper get a matching Intel JVM, which runs under Rosetta; installing it leaves the global Java defaults for other games unchanged. A JVM version and CPU chosen for the game are kept, and a choice that does not match the wrapper fails before launch.

### Detecting Steam use

Steam use is detected by `consumer.js`, which reads archive directories and class files within fixed limits, follows local manifest class paths inside the game folder and caches its results until those files change. A file name or an unused bundled wrapper does not make a game a Steam user. The application ID comes from metadata in the game or from a direct integer argument to `SteamAPI.restartAppIfNecessary`, and conflicting IDs are refused.

### Launch

A small Java agent included with MacLauncher serves as the loader: its `premain` loads the unchanged matching JNI before the game's main method runs and leaves initialization, callbacks and shutdown to the game. Each game gets private settings, save state and loader configuration. Native bridges are hard-linked; when the app bundle is protected or on another volume, only the small JNI file is cloned or copied. The Steam API helper, the JRE and the original game are shared.

The JNI depends on `@loader_path/libsteam_api.dylib`, which the per-game layout supplies. Its publisher install name is kept, and the loader opens the verified JNI by its actual path. The module's `nativeHostDependencies()` metadata ties this dependency to the exact JNI checksum and API helper version.

Shared graphics follows the same installed JRE and its native CPU, including Intel JVMs running under Rosetta, and graphics preparation does not change the chosen Java version or variant.

### Offline Steam API

The [offline Steam API helper](../runtimes/STEAM_API.md#offline-steam-api-helper) has its own version history. For steamworks4j, each profile names the included bridge, whose package record holds the checksum of each original JNI and loader. It supports the client interfaces for initialization, apps, friends, utils, user, user stats, callback delivery and shutdown. Other Steam interface families, online services and other wrapper versions need their own native implementations.

### Bridge contents

Each included bridge contains the unchanged publisher JNI, two matching deterministic Java 8 builds of the loader, the loader's source, a hash inventory and the upstream MIT notices. The bridges are included with MacLauncher without patching any upstream source, and Valve's official Steam API and ticket binaries are not included. [Development](../development/DEVELOPMENT.md) covers rebuilding included helpers.
