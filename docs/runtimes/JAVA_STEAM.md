# Java Steam integration

Java games keep their original JAR and `-jar` launch. The Node backend inspects
actual bytecode calls, then prepares a matching [steamworks4j](https://github.com/code-disaster/steamworks4j)
JNI and the shared native Steam API service automatically. Games without a
positive Steam consumer perform no Steam setup.

| Original wrapper | Included JNI | JVM CPU | Java requirement |
| --- | --- | --- | --- |
| 1.9.0 | `1.9.0-MCLv1` | Intel; Rosetta on Apple Silicon | Java 8 or later |
| 1.10.0 | `1.10.0-MCLv1` | Apple Silicon or Intel | Java 8 or later |

The exact wrapper class hashes, publisher JAR and JNI hashes, source revisions,
interface versions and loader hashes are listed in [versions.json](../../src/modules/java/runtime/steamworks/versions.json).
A newer JNI is never substituted for an older wrapper. Intel-only consumers
select a matching managed Intel JVM and use the shared Rosetta prerequisite.
Downloading that prerequisite preserves global Java defaults for other games.
Explicit JVM versions and CPUs are retained; an incompatible choice fails
before launch.

Shared graphics follows that same installed JRE selection and its native CPU, including Intel JVMs launched through Rosetta. Graphics preparation does not change the chosen Java version or variant.

`consumer.js` reads bounded archive directories and class files, follows local
manifest classpaths within the game directory and caches facts against observed
source identities. A filename or an unused bundled wrapper does not establish
a Steam consumer. Application IDs come from game-local metadata or a direct
integer argument to `SteamAPI.restartAppIfNecessary`; conflicting identities
are refused.

The Included loader is only 5.6 KB. Its `premain` loads the unchanged
matching JNI before the original main method and leaves initialization,
callbacks and shutdown to the game. Each game receives private settings, save
state and loader configuration. Native bridges use hardlinks; where the app
bundle is protected or on another volume, only the small JNI file is cloned or
copied. The Steam API helper, JRE and original game remain shared.

The JNI's `@loader_path/libsteam_api.dylib` dependency is supplied by that
per-game layout. Its publisher install name is retained; the loader opens the
verified JNI by its actual path. Module-owned `nativeHostDependencies()` metadata
binds this relationship to the exact JNI checksum and API helper version.

The separately versioned [offline API](STEAM_API.md) uses exact successor profiles while preserving each original JNI/loader checksum. Supported client interfaces cover initialization, apps, friends, utils, user, user
stats, callback delivery and shutdown. Other Steam interface families, online
services and wrapper versions require separate native contracts.

`stage-bridge.cjs` consumes the exact publisher archives for developer updates
from the catalog, the `bin` directory of Eclipse Temurin 17.0.20.1+1 and an empty
candidate resource directory. Its output contains the unchanged JNI, two
matching deterministic Java 8 loader builds, owned source, hash inventory and
upstream MIT notices. The catalog records that inventory under a distinct
profile identity. Normal launches need no SDK, compiler or separate bridge installation.
The catalog points to binary-only upstream inputs; no upstream source is
patched. Official Valve Steam API and ticket binaries are excluded.
