# Android applications

MacLauncher prepares original Android packages locally. The default
**MacLauncher Android** runtime uses JVM execution: the adapted Klepton host,
the complete AOSP Android 16 Java framework and Apple Silicon Java 21. Java versions are managed under
Temurin in Runtimes; Play offers
a download when Java 21 is absent. Android runtime packages are managed through
MacLauncher Builds, separately from the launcher. Runtimes offers compatible
builds through Refresh, Install and version-selection actions. Play downloads
missing selected runtime packages after confirmation, then resumes preparation.
Existing explicit versions stay selected across Refresh.

Installed JVM and ART builds remain available in the version picker
for offline selection. A per-application version choice leaves the global default unchanged;
explicit global and per-application choices remain selected across Refresh.
Missing selected versions require installation; another version is never substituted.

Runtimes groups JVM and ART packages under **MacLauncher Android**; **Mac.apk**
and **AIM** have separate entries.

The **Execution** setting also selects ART, Android's original runtime, for the
next launch. Play obtains consent for any required ART package or Android 16
system image download under the Android SDK license. The original image is
stored once in a case-sensitive, read-only system-image cache; matching images
already acquired for AIM can be reused. The ART package and writable application
data remain separate from that image. JVM remains selected when no execution
preference is stored.

JVM builds that require an original system image obtain the same download consent
and shared cache during Play or account setup. Downloads shows transfer and
preparation progress with cancellation; metadata and account enumeration remain offline.
These packages prepare Android's original linker configuration before application
mounts are attached. Shared platform files remain read-only, and each application's
native code uses the same private storage boundary as its Java code.

Runtime selection also includes managed [Mac.apk](https://github.com/kksimp/Mac.apk)
and the adapted [AIM](https://github.com/hahnlee/aim) host. Mac.apk requires macOS 26.4 or later; AIM requires macOS
26.0 or later. Runtime-specific settings and application data remain separate.

## Packages and preparation

Import accepts `.apk`, a folder containing a base APK and its splits, or an
`.xapk`, `.apkm` or `.apks` archive. Selecting a split APK locates its package set
in the same folder by package name and complete version code. Other versions
remain separate. Inspection reads the original binary manifest, resources and
archive directory without starting Java or executing application code.

Preparation verifies APK signatures, package names, version codes and signing
lineages. Original signed APKs remain separate for ordered resource loading;
the installed base uses `base.apk` and split filenames retain their manifest
identities. Existing prepared packages adopt this layout without reconverting
their bytecode. OBB expansion files beside an
APK or inside a package archive enter the application's private expansion storage.
Application downloads and updates remain there across runtime changes.

The default Android runtime accepts ordinary feature splits declaring activities,
activity aliases, services, providers and receivers. Inspection combines their
launcher and component metadata with the base application's defaults; Android's original package parser
registers the installed components. Non-isolated splits share the application
class loader. Isolated splits use Android's original dependency loaders: each
feature inherits its declared parent and base classes, with separate sibling
classes and resources. Component contexts retain their declared split.

ARM64 native libraries are preferred. A runtime containing the ARM32 execution
component selects `armeabi-v7a` or `armeabi` libraries when appropriate. ARM32
instructions become ARM64 code through Dynarmic and reach the same Klepton native
services through width adapters. The JVM and AOSP framework stay 64-bit. The
[ARM32 component reference](../../src/modules/android/native/arm32/README.md)
describes the instruction, ELF and JNI boundaries.

DEX preparation shares one conversion session. Converted classes use Android's
original application and split loaders over the complete executable framework.
Separate definitions of the same class in isolated APKs retain their own code
through the original per-APK conversion path. Original DEX loaders retain
class delegation, resource lookup and added paths; dynamic DEX code uses the same
converter and JVM. Packages declaring `hasCode=false`, including resource-only
packages and framework NativeActivity applications, need no DEX conversion.

Platform shared-library declarations come from Android's original SystemConfig.
Original package compatibility rules populate the package state and
ApplicationInfo. The compatibility service is available during package inspection;
application callbacks use the parsed target SDK. Both execution modes use
LoadedApk's canonical shared-library loaders, dependency graph and ordering around
application classes.

Preparation caches are keyed by APK contents, converter identity and framework
class declarations. Adapter implementation changes reuse converted classes when
those declarations remain the same. Changed declarations or converter inputs
invalidate the corresponding cache. Archives support ZIP64 class directories.
Unchanged preparation files reuse verified digests across launcher processes.
File identities and nanosecond modification and change times are checked on
every launch; changed inputs are read and verified again.
Only the current prepared version remains cached; active versions stay retained
until their owners release them. Installed APKs use filesystem copy-on-write
where available and retain one canonical name for each base or split package.
These archives supply Android's resources and signed package identity.
Package selection, publication and eviction
share a kernel lock across launcher workers, while filesystem leases preserve
active readers. Installed service catalogs retain their selected immutable
source generation independently of the conversion cache. Shared package
metadata retains its canonical prepared source while authenticated application
processes use it. Concurrent processes with identical package identity share
that source; the final process retirement removes transient metadata and its
derived converted-code lookup. Installed service metadata remains owned by the
service installation. Repairs and installed-path updates publish a separate
generation, so running games and services keep their original files. Path updates
reuse converted content through filesystem copies with copy-on-write where
available. Saves and downloaded assets are stored separately.

Concurrent launches of the same runtime share one off-thread verification.
Each launch retains its own cancellation; canceling the last waiting launch
retires that work while other selected runtime versions continue independently.
Child account services retain the selected runtime's manifest identity, so
selecting another runtime build leaves an in-flight launch consistent.

Package sets have limits of 64 APKs and 4 GiB of extracted data. Assets up to
64 KiB use bounded decoding and asynchronous file writes; larger assets and
libraries stream to disk. Import retains Android's case-sensitive compiled
resources inside their APKs and validates archive paths, ranges and checksums.

## Framework and native mappings

The [architecture reference](ANDROID_ARCHITECTURE.md) defines component ownership.
The runtime uses original portable framework behavior and adapts actual platform
operations at JNI, Binder, device and ABI boundaries.

| Android interface | Implementation and macOS connection |
| --- | --- |
| Framework classes, utility collections, Activity, View, Resources and package parsing | Complete uninstrumented AOSP framework supplied by Robolectric's `android-all`; JVM portability hooks connect JDK-owned operations |
| Bitmap, Canvas, Paint, text, fonts and resource decoding | Matching native framework graphics/resource library, original Android fonts and ICU data; output joins the shared window presenter |
| NDK bitmap, asset and configuration APIs | Original AOSP implementations over the same native resources and AssetManager used by Java |
| SQLite, cursors and ContentValues | AOSP database implementation and native SQLite/CursorWindow engines over application-private files |
| Binder, Parcel and AIDL | Original AOSP Binder RPC, Parcel JNI and dispatchers; authenticated Unix-socket connections between declared application processes |
| Native libraries and JNI | Klepton's shared image registry, dependency loading and constructors; Android ABI representations map to Darwin and the existing JVM |
| GLES and EGL | Complete AOSP Java classes and generated JNI adapters over the selected ANGLE provider |
| ANativeWindow, Surface and SurfaceControl | Native surface owners, layer composition and the shared Metal presenter |
| MediaPlayer and AudioTrack | Original media services, AudioFlinger and AudioPolicy over the CoreAudio device boundary |
| Java and NDK MediaExtractor | Original Android extractor implementations and shared Binder services |
| Java and NDK MediaCodec | Original codec sessions, buffers and Codec2 components; VideoToolbox hardware decoding and original software codecs |
| AndroidKeyStore | Original Android KeyStore service and software KeyMint, with private profile storage |
| AccountManager | Original AccountManagerService, installed authenticators and one profile account owner |
| URI permissions | Original UriGrantsManagerService, authenticated callers and persistent grants in private profile storage |
| App shortcuts | Original ShortcutService, package checks, quotas, XML and icon storage in the shared profile owner; pinning requires an Android HOME-role launcher |
| App widgets | Original AppWidgetServiceImpl and AppWidgetManager retain provider discovery, bindings and widget state in the profile owner; widget display uses Android widget hosts |
| Statistics registration | Original StatsD Java services; native collection remains unavailable without its collector |
| Connectivity and sockets | macOS route observation, native resolver and socket operations with Android family, flag and error translation |
| FileObserver and native inotify | Shared libinotify-kqueue event ownership and runtime I/O boundary notifications |
| Process IDs, thread IDs, scheduling and signals | Runtime process authority and live native thread identities; Linux/Darwin layouts and values are translated at the platform boundary |
| Native scheduling-policy requests | Original AOSP SchedulingPolicyService and AIDL retain caller checks and Binder lifetime; JNI maps thread task profiles and scheduler requests to Darwin kernel policy |
| Sensor privacy | Original SensorPrivacyService, state controller and listener protocol over the profile's user, permission and application-operation owners |
| Telephony event listeners | Original TelephonyRegistry with Android's modem/subscription availability and callback permission checks |
| Keyguard and trust | Original clients use the profile's unsecured Android device state, permission checks and Binder listener lifetime; Mac credentials remain separate |

Robolectric supplies framework and native artifacts. Its test runner, shadows and
simulated service environment are separate from the game runtime. Klepton and
upstream native implementations share the same graphics, audio, storage and
process owners. The JDK owns Java boot classes and the JVM's memory and thread
lifecycle. Shared JVM launch options expose the JDK collection delegates and
monitor fields used by Android's desugared Java library wrappers, so those
wrappers keep the original collection contents and synchronization behavior.
JVM application system-class lookups delegate to the APK's current defining
loader after checking the host class path. Original JDK logging handlers,
resource enumeration and service providers share that application definition;
instrumentation agents remain on the host class path. Dex-load reports use
Android's original dex manager and usage records with installation-owned storage.
Authority writes and descriptor transfers share each process's channel queue.
Closing a channel rejects its pending transfers while other processes retain
their own service registrations and leases.
JVM and ART launch preparation overlap installed-package preparation with independent
display metadata and graphics setup. A failed launch joins pending preparation
before releasing its package lease.
Both engines use the same private application data. Android storage aliases and
retained absolute paths inside that data resolve to the same files; other
applications' data and host parent directories remain outside the app's namespace.
The shared alias rules cover nested expansion, cache and media directories in
both Android private paths and retained physical application paths.
JVM native memory maps use `/data/app/<package>/lib/<instruction-set>` names while native loading resolves the original immutable files.
On the JVM, ordinary `File` metadata, directory operations and stream opens use
the same aliases at the native filesystem boundary. JDK files and descriptors
retain ownership of their original I/O behavior.
Java and native libc receive the same scoped Android partition and storage
environment in JVM processes.
NIO file metadata and ownership changes use the same Android UID/GID mapping as
libcore, while the Mac retains its original file ownership.
Android's original `SystemCleaner` delegates to the JDK's shared cleaner through
the same JVM configuration, preserving one owner for resource cleanup.

The NDK asset and configuration families share Java's original AssetManager.
Prepared loose assets and expansion-file slices enter Android's AssetsProvider
as owned file descriptors and byte ranges. Original Android assets retain
ownership of reading, seeking, mappings and duplicated descriptors; generated
NDK declarations connect ARM32 callers to the same implementation.

## Windows, rendering and input

Original PhoneWindow and ViewRoot connect Android content and input to the native
window. Window dimensions supply Android layout bounds, display metrics and touch
coordinates. Native input devices report coordinate ranges from the committed
display extent. The default tablet profile uses the Pixel Tablet reference
display of 2560 × 1600 pixels at Android's 320 dpi logical density, with an
initial Mac window request of 1280 × 800 points. Native screen fitting and
Retina backing determine the actual render extent. The original VirtualDisplay
retains the profile density through resizing and app-requested orientation;
Android retains its application density-compatibility policy. The reference
matches the [Android Studio tablet profile recorded by Chromium](https://chromium.googlesource.com/chromium/src/tools/android/+/77d4c8dd8a136fa6ba61f403e1fb8da0e82935c5/avd/proto_creation/android_35_google_apis_tablet_x64.textpb).
Original package activity metadata selects a declared fixed orientation before
the initial physical window and application callbacks. Both execution bindings
use the same orientation policy; later requests retain Android's window lifecycle.
Mouse clicks and drags become finger-touch events; captured mouse
movement uses relative mouse semantics. Mouse wheels and trackpads scroll in both
directions. Apps that handle scrolling receive normal Android scroll events;
touch-only content receives a continuous swipe, including trackpad momentum.
Native input acknowledgements return asynchronously to the original owning
Looper, including while a layout traversal synchronization barrier is pending.
Android retains event identities and completion callbacks for native input and
the touch-scroll fallback.
Keyboard input and composition use the
focused Android input connection, including embedded web content. Cmd-A selects
text and Cmd-X cuts within Android. Cmd-C and Cmd-V transfer plain text between
the foreground app and the Mac clipboard for that explicit shortcut. Ordinary
Android clipboard access stays within the Android session.
The JVM input bridge returns clipboard replies asynchronously on Android's main
queue, so layout traversal barriers do not delay an accepted paste. Foreground
ownership and a single-use physical shortcut still authorize each Mac clipboard
transfer. The included [text input component](../../src/modules/android/text-input.js)
retains the original Android input connection and native text interfaces; its
[Java source](../../src/modules/android/text-input/java/maclauncher/android/framework/HostTextInput.java)
and MIT license accompany the included JAR.

WASD controls a virtual touch joystick by default. The per-game keyboard touch
joystick setting selects WASD, arrow keys, both, or Off, with a configurable
center and radius. The mouse remains an independent touch for buttons and
other controls. Mapping pauses while an Android text editor is active.

Manual tilt can supply virtual motion sensors from the keyboard or a controller.
Keyboard mode uses Q/E for left/right tilt and R to recenter. Option + arrow
keys also control tilt, with Option + 0 to recenter; the controller uses its
right stick. Movement keys remain separate, and Cmd/Control shortcuts pass
through. Android text editors receive typing keys while keyboard game controls
are suspended. With manual tilt off, Q/E/R retain their ordinary game behavior.

One presenter handles Canvas, GLES and native SurfaceView output throughout an
Activity's lifecycle. Canvas uploads reuse a bounded image pool; native surfaces
submit GPU textures and synchronization events. SurfaceControl ordering and
transforms compose Android controls over native game frames. An unchanged overlay
requires neither another upload nor another composition pass.
Composition retains the native producer's texture origin and maps the Android
Canvas's top-left coordinates into that origin, including independent render and
layout extents.
ART starts SurfaceFlinger alongside its hardware composer. Original Binder clients
wait for their dependencies; both services register before application window
enrollment.
Native readiness queries use the original Binder service manager in a small
process without window, audio or resolver dependencies. Composer and
SurfaceFlinger publication are awaited together, with both original service
lifetimes observed before window enrollment.
Both execution engines retain ANGLE's serialized shaders and programs in the
same native cache format. Application caches stay inside each application's
storage; ART's immutable native services share the profile's native cache.
Driver and macOS identities separate incompatible binaries, and a cache miss
uses the original compiler.
Planar video conversion preserves the producer's row and column order in the
shared Metal texture. Android's original consumer retains its texture transforms
and display rotation.

MacLauncher Android settings begin with **Execution**, selecting JVM (the default)
or ART for the next launch. Global defaults and per-game overrides use the same
selector. Vulkan implementation appears when the OpenGL ES backend is Vulkan;
hidden backend, joystick and account fields retain their saved values.

Settings → Android → runtime settings sets the OpenGL ES backend and Vulkan
implementation defaults; each game's runtime settings can override them. ANGLE
uses Metal by default. The OpenGL ES backend list reflects the backends included
in the installed Android runtime. The Vulkan backend uses the same selected
Vulkan implementation as native Vulkan apps. Changes apply on the next launch.
When an APK requires a newer OpenGL ES version than the default Metal provider,
launch selects ANGLE's Vulkan backend through an installed Vulkan implementation.
Native execution uses MoltenVK for its shared Android buffers; a missing MoltenVK
version follows the download consent flow. Saved backend choices take precedence.
This selection supplies OpenGL ES and does not enable an application's native
Vulkan rendering mode.
The reported OpenGL ES version comes from context creation on the selected
backend, including its supported minor version.
GLES and EGL symbols resolve within the selected ANGLE libraries and their
procedure table. Desktop OpenGL dependencies do not supply Android entry points.
With native execution, Vulkan OpenGL ES shared buffers and planar video images
require MoltenVK's Metal texture attachment interface. The Android compositor keeps its Metal
backend while application contexts use the selected OpenGL ES backend.

Vulkan uses the selected MoltenVK or KosmicKrisp library. Android window surfaces
map to Metal surfaces on the same native window lease; the driver retains
swapchain creation, image acquisition and presentation synchronization. Its Metal
textures enter the shared presenter with Android controls and graphics effects.
PackageManager's Vulkan version and hardware level come from the same selected
physical device. Hardware levels use Android's required Vulkan feature sets;
feature enumeration and version checks share the same capability data in both VMs.

Android frames use the same [graphics pipeline](GRAPHICS.md) as other runtimes.
ReShade effects, spatial scaling and LSFG settings belong to the game inspector.
The optional resolution multiplier reduces the render target while retaining the
window or fullscreen output dimensions. At 2×, a 1920 × 1080 output uses a
960 × 540 source; Android layout and touch coordinates follow that source extent.
Auto preserves the application's requested render resolution.

PixelCopy retains the original Surface, SurfaceView, Window, region and request
APIs. Explicit requests copy an owned native surface to a mutable bitmap with
scaling and asynchronous results. Ordinary presentation does not read frames
back to the CPU.

Android keeps bounded frame-time history throughout each run, including normal
launches without a profiler. Per-surface records distinguish source, accepted,
real presented and generated frame rates, frame-interval percentiles, submission
time, queue occupancy and render/output dimensions. These counters use existing
presentation calls without GPU readback or completion waits. Two rolling files
in the app's private storage retain at most 256 KiB across quit or crash.

Display callbacks, window buffers and native producers share their owners'
lifetimes. Activity pause, stop and destruction retain the surface while producer
callbacks finish, followed by display and presentation retirement. Android message
queue waits on the native window thread also dispatch AppKit events.

## Audio, camera, power and location

AudioTrack accepts PCM byte, short, float and direct-buffer writes, with static
buffers, looping, playback position and rate conversion. CoreAudio owns the
actual output route. Android stream volume and mute controls apply software gain
inside the application and preserve the Mac's system volume. Route-change
callbacks update Android's existing device cache.

MediaPlayer preparation reads and decodes the selected source on its calling
thread or an asynchronous worker. Reset and release cancel that player's work;
players have independent operation locks. Prepared-next-player transitions,
completion listeners, pause, restart, looping and stereo balance use the same
native audio owner. File-descriptor ranges retain their source lifetime.

MediaExtractor exposes AVFoundation tracks, formats and compressed samples from
local paths, file-descriptor ranges and MediaDataSource callbacks. JVM MediaCodec
uses VideoToolbox for H.264/H.265 and libvpx for VP8 and VP9 profile 0. Both
backends share synchronous buffers, asynchronous callbacks, format changes,
end-of-stream draining and Surface presentation. Software VP8/VP9 decoding
produces NV12 frames up to 4096 × 2304; the original Android capability APIs
report these dimensions, software decoding and supported profiles.

Per-game **Audio input** and **Camera** selections default to Off. Play requests
macOS permission for selected devices; capture begins when the application starts
recording or camera preview. OBS Virtual Camera supplies video, while audio uses
the separately selected input. The capture adapters provide PCM16 mono/stereo
AudioRecord and legacy NV21 camera callbacks. Audio capture uses a preallocated bounded
FIFO with one serial CoreAudio producer and serialized Android readers. The
callback publishes available frames without taking a reader lock; a full FIFO
retains queued frames and discards incoming excess. Pause, flush and close wake
blocked reads before retiring the capture owner.

Power queries describe a fully charged, AC-connected Android device with battery
saver off and nominal thermal status. Wake locks retain Android token and
callback ownership within the app. They do not prevent Mac sleep or reset its
idle timer. Mac sleep pauses the current Activity; wake resumes the surviving
current Activity. Alarms deliver callbacks and pending intents through the
running application's Android queue.
JobScheduler runs application-lifetime jobs on that queue, including namespaces,
cancellation, delayed/periodic requests, completion and retry backoff.

Location starts empty. An application location request opens a manual
latitude/longitude sheet. **Share** supplies those coordinates as a mock location
for that application session; **Cancel** supplies none. Coordinates are not saved
between launches. Permission and AppOps queries use the same device and location
owners without independently requesting access.

## Installed services and Google accounts

Installed service APKs use the same signature checks, preparation and private
storage as games. A persistent package identity supplies the UID and signing
lineage. Components start on demand in their manifest-declared processes and use
original ActivityThread, LoadedApk, AIDL and content-provider dispatch.
Activity startup requests the shared Settings process while graphics and package
records initialize. Provider acquisition waits for its authenticated directory
through the original Android content-provider path.
Application ActivityManager clients retain their local context owner through
receiver cleanup; shared UID observation uses the authenticated profile owner.
Running-service queries return snapshots of the existing process-owned services,
including start and binding state, foreground status and Android process identity.
An application provider that cannot start returns Android's unavailable-provider
result; its process lifetime is separate from the local ActivityManager.
Service lifecycle records retain bounded process outcomes, initialization phases
and failure code identities. Raw account-process output and account values are
excluded from those records.

Each game's inspector and Settings distinguish three Google integration choices:

| Selection | Behavior |
| --- | --- |
| **No microG** | **Use microG** is unchecked; Google service packages are disabled for the game |
| **microG without an account** | **Use microG** is checked and the account selector retains its anonymous entry |
| **microG with an account** | **Use microG** is checked and a shared account identity is selected |

Integration defaults to Off. Enabling it neither signs in nor chooses an account.
**Settings → Android → Google accounts** manages shared account identities; game
options select which identity, if any, is visible. Network access remains a
separate per-game setting.
Network access, Google integration and account selection apply when the game
starts. Changing them while a game is running requires restarting that game.
Disabling Google integration keeps shared accounts and other games' selections.
Accounts appear in a scrollable table with a refresh icon and **Sign in in browser**
in its toolbar. Browser sign-in is the default in both Settings → Android and
External → Android; both windows use the same shared account list. Existing
provider accounts remain selectable without opening Android sign-in.
Saved account identities appear immediately without starting an Android runtime.
Refresh reads the original provider again. The list updates after sign-in and
account changes without reopening the window.

One original AccountManagerService owns the profile account database and
authenticator sessions. Authenticators retain their verified package identities
and separate processes. Account enumeration uses installed files and does not
authorize network requests. Sign in from Settings or External opens the same
native Google account window. Google handles passwords and account challenges;
the authenticated result is registered with microG through the original
AccountManager APIs under its verified package identity. Missing account runtime,
Java and microG packages follow the download consent flow. Game and background
provider requests cannot open interactive Google sign-in automatically, including
when no account is selected. Closing a sign-in window cancels
that attempt.
Launcher preferences store selected account identities, never passwords or tokens.
Optional remembered browser authorization uses the launcher's encrypted session
storage. Removing an Android account also disconnects a matching External
selection; other provider accounts remain separate.

**Add to Google Play library** requests a free license for the imported package
through the installed Google service. It requires network access, a selected
account and a stopped game. Paid purchases are never requested. A licensed reply
may describe an existing entitlement; availability still depends on Google Play,
the package and the account. The provider's automatic free-acquisition preference
is restored after this action, including recovery after an interrupted request.

For recognized microG Services and Companion packages, Google integration exposes
the provider's declared compatibility certificate to Google client libraries.
Signature permissions and account-data access still use the actual verified
publisher and signing lineage. Google certification, Play Integrity and store
entitlements remain publisher-controlled properties.

Profile services use one common process broker with a kernel lock per role,
authenticated controller leases and process retirement. Games receive only the
public Binder listener. Account and KeyStore databases, controller capabilities
and enrollment sockets remain outside game-readable storage. KeyStore reports
software security and stores opaque keys through the original software KeyMint.

## Storage and network policy

Android application storage lives under
`~/Library/Application Support/maclauncher/android/apps/<gameId>/`. Prepared
code, application files, downloaded assets, caches, no-backup files and temporary
files have separate locations. Imported files are copied into the application's
container; original Mac files remain unchanged. **Import files** accepts up to
128 regular files, 1 GiB per file and 4 GiB in total.

JVM and ART use the same per-game application data: saves, preferences,
databases and downloaded assets remain available when the execution engine
changes. Generated JVM and ART code uses separate caches. The engines run the
same game sequentially, sharing its existing container.

The mandatory macOS file sandbox covers Java, native code and child processes.
It permits the application's container, read-only runtime artifacts, selected
service packages and required system resources. It uses private home and temporary
directories without a filesystem proxy or VM. Installed service APKs may be read
through the package catalog; their writable application data stays private.
Native text editing uses macOS completion and spelling services within the same
file and network policy.
Google-enabled applications share one Android account service. Anonymous mode
keeps Google accounts hidden while retaining the same service and process boundary.

**Network access** uses the shared game setting and
[process-level network policy](NETWORK_ISOLATION.md). Enabled access permits
connections, local socket binding and incoming game traffic. Disabled access
blocks IP and DNS traffic, including descendants, and reports no usable Android
route. Authenticated process grants keep service traffic within the requesting
application's policy. Private Unix sockets remain available for runtime services. Connectivity
observes macOS routes without sending a network probe. A dedicated native queue
collects route, interface and DNS facts into copied snapshots. Android's network
owner consumes matching revisions without running host configuration queries on
the system looper. Route cost controls metering; macOS Low Data Mode remains a
separate fact.

ART uses Android's original DNS resolver with the Mac's configured DNS servers.
Its native service owner retains per-application route-probe socket ownership
through Android's `CAP_CHOWN`; guest capabilities remain separate from Mac
credentials and application processes.

Known advertising and tracking destinations are filtered by default. **Allow ads**
in **Settings → Android → runtime settings** sets the Android default; each game's
runtime settings can override it. Changes apply on the next launch. Enabling ads
disables that filter for the session, including rewarded-ad connections. The shared host list covers native and Java
DNS, embedded WebView requests and external browser links. Blocked WebView
navigation stays blank and blocked external links produce no prompt. The filter
is independent of network isolation and leaves application SDKs and rewards alone.
Direct-IP traffic and content served from a game's own shared host follow the
ordinary network setting.

External HTTP/HTTPS links require **Open Browser** confirmation beside the
requesting game window. Cancellation is the default, and closing the game retires
its prompt. Link approval grants no Mac file or application-launch permissions.
Valid browser intents remain handled when confirmation is declined, network access
is disabled or the browser request channel has closed. These decisions create no
browser window and do not throw an activity-not-found error into the application.
WebView uses an embedded WebKit view in the existing game window; cookies and
website storage share the application session and are discarded at its end.
Android retains navigation callbacks, text input and Canvas composition. Cookie
reads use the current WebKit cookie store, including changes made by page scripts.
Android view visibility also controls page rendering; covering the Mac window
does not suspend a visible Android WebView's animations.
Document dimensions remain separate from the captured viewport, and text zoom
changes text layout independently of page zoom and display density.
Android's original input connection handles text replacement, composing spans,
selection and surrounding-text queries. The document editor receives the resulting
UTF-16 ranges, and copy and paste follow explicit clipboard actions.

## Inspection, diagnostics and builds

**Inspect Android package** displays local package, version, activity, permission,
DEX and native architecture information for every supplied ABI without installing
an Android game runtime. The included APK signature verifier is shared independently
of runtime installations and extracted to a verified physical file when needed by
Java. An included native resource reader extracts localized names and icons from
the original base and split APKs without an Android or Java runtime. Device branding is generic Android;
the runtime profile records the Android API level and native ABI.

Runtime diagnostics use the game's `runtime.log`, retaining the first Java or native
failure and recent shutdown details within 32 KiB, including fatal reports followed
by an application exit code of zero. Output updates at most once per
second while messages arrive and once at exit. The running indicator clears when
the process exits; an older process cannot replace a newer launch's diagnostics.
Requested Stop keeps earlier diagnostics in that log without treating ordinary
SIGTERM or Java shutdown status 143 as a new failure. Fatal runtime reports and
crash signals remain failures during shutdown.

Both execution backends send Android native logs through the same physical log
destination, retained independently of application standard streams. An app can
redirect or close stdout and stderr while Android log callbacks continue to use
that destination.

Opt-in native ANGLE shader diagnostics report failed shader compilation and
program linking with bounded compiler output. The original GL error state and
application debug callback remain with the game; ordinary rendering uses direct
ANGLE entry points.

The [native host reference](../../src/modules/android/native/README.md) documents
build inputs, generated bindings and low-level platform mappings.
[Upstream sources](../UPSTREAMS.md) and [attributions](../ATTRIBUTIONS.md) record
source identities and licenses.

## APK decompilation

**Decompile APK…** in the Android inspector exports Java source from original
DEX bytecode and decodes Android manifests and resources with
[JADX](https://github.com/skylot/jadx). The action works independently of the
selected Android runtime. It does not launch the application or prepare an
Android system image. Base and matching split APKs remain together, including
architecture and resource splits; package archives are unpacked temporarily
without copying application saves or expansion data.

JADX is managed under **Runtimes → Tools**. Refresh lists compatible publisher
releases, and Install and version selection remain explicit. The first
decompilation offers a download when JADX or its managed Temurin Java host is
missing. Installed tools work offline, with no background update checks. JADX
1.5.6 or later uses the cross-platform Java release; MacLauncher supplies its
managed Java 17 or later host for the upstream Java 11+ requirement.

The folder chooser selects an output parent. Each export creates a separate
folder, preserving earlier exports; **Reveal decompiled APK** opens the latest
result in Finder. Cancellation removes incomplete staged output. When JADX
cannot reconstruct some code but produces useful files, the result is labeled
**Partial output**, with details in `decompile.log`. Decompiled source may differ
from the original source, especially for optimized or obfuscated code. Native
ARM libraries remain binaries; JADX does not reconstruct their C or C++ source.

## Mac.apk and AIM delivery

**Mac.apk** versions download from the publisher after an explicit installation
or a Play download confirmation. Refresh checks the publisher's releases only
when requested. Installed versions remain available offline.
Refresh lists publisher releases for installation; explicit runtime selections
remain unchanged, and installed versions remain available offline.

Mac.apk's **Graphics backend** setting selects **Automatic**, **Metal** or
**Vulkan (MoltenVK)**. Each game retains its own selection.

**AIM** uses a pinned source revision with MacLauncher-owned adaptations. Its
native host is managed through MacLauncher Builds, while the matching Android system image is acquired
separately after confirmation. The image retains its publisher's terms and is
excluded from MacLauncher app and source archives. AIM runs applications offline
without Google account integration. Runtimes retains installed builds and
offers compatible MacLauncher builds through explicit Refresh, Install and
version-selection actions. Arbitrary upstream AIM binaries do not replace the
adapted runtime.
AIM runs applications with Android services and original ART. It does not boot a
Linux kernel or a virtual machine.
Image preparations are shared across host versions with identical system-image
and overlay inputs; selecting another compatible host preserves existing image
storage and application data.
AIM shared-memory files use the application's temporary directory and are
unlinked after opening; applications receive read-only descriptors.
System-image downloads appear in **Runtimes → Downloads** with progress and
**Cancel** through checksum verification and preparation; acquired images are reused.

Runtime versions and requirements remain visible in the inspector. Settings
contains provider options; ordinary playback uses Import → Play and requests any
missing download before starting the application.
AIM preserves declared launcher components, including activity aliases.
AIM's display accepts client connections before its initial blank draw; graphics
effect compilation retains the normal rendering path without delaying display readiness.
AIM waits for the Android user to unlock during initialization and installation.
Configured Android screen-lock credentials remain required.
Activity startup timeouts retain Android's original result in the launch error.
AIM's native lock workers close through their controller and release their locks
when that controller exits, independently of guest process-group signals.
Stop requests shutdown through the retained controller, which waits for its
resident's service and data cleanup. A failed shutdown is reported without
detaching data from a live guest.

Mac.apk application windows and Dock entries use the game's name. Adapted AIM
builds use the game's name and icon in the Dock and the game's name for its
display window. Package launcher resources supply artwork
when supported; custom library artwork takes precedence. Each game has a small
macOS application entry, with runtime libraries and Android images shared across
games. AIM's native package resource reader prepares icons without a Java host.

## Device and privacy

The default virtual device is Pixel Tablet: 2560 × 1600 pixels at 320 dpi, with
an initial 1280 × 800 landscape window. These values describe the virtual Android
device rather than the physical Mac.
AIM also presents the tablet's SoC and density instead of the Mac's hardware.

Mac.apk network access is disabled by default. Enabling **Network access** applies
to the selected game's next launch. AIM application processes remain offline.
Mac.apk keeps its shared-volume migration, Mac folder mapping and Now Playing
integration disabled. Android files remain in the game's private provider
directory, and offline launches do not run App Links network verification.
Runtime downloads follow their separate, explicit confirmation flow. File access is limited to the installed packages,
selected runtime and provider's private application directories. Host clipboard,
location, camera, microphone and account access are not granted by selecting a
runtime. Provider integrations remain subject to those same boundaries.
Plain-text clipboard transfer uses explicit Android clipboard gestures. Native
WebView editing has no direct access to the Mac clipboard.

Settings → Android shows options and accounts for the selected runtime.
The default Android runtime and Mac.apk retain separate provider account stores,
with browser sign-in as the default for both panels. These accounts are also
available through External → Android. AIM has no account controls.

In the Mac.apk panel, **Sign in in browser** opens the shared Google browser
window and registers the result through Mac.apk's supported account bridge. Google integration is off for each game until enabled; an enabled game
can use anonymous services or one selected account. Network access remains a
separate choice and is required for authentication requests.

The game's signed package identity is verified before account access. Games
receive selected account information and requested authorization tokens; the
account credential store remains outside the game's file access.

## Storage

Mac.apk and AIM keep writable data under
`~/Library/Application Support/maclauncher/android/apps/<gameId>/providers/<runtimeId>/`.
The directory contains that provider's Android root, home, cache and temporary
files. Shared runtime binaries remain separate from application data.
Each provider retains bounded startup and recent output in `runtime.log`,
`runtime.log.head` and `runtime.log.previous`. Unexpected exits include the
available runtime error details after output streams finish draining.

Existing Android application directories are preserved when switching providers.
Their saves, downloaded assets and accounts are not automatically imported into a
different Android runtime. Original APKs and package archives remain unchanged.

The [architecture reference](ANDROID_ARCHITECTURE.md) describes provider ownership,
the [native startup reference](ANDROID_NATIVE_STARTUP.md) describes constructor
arguments, and the [distribution policy](RUNTIME_DISTRIBUTION.md) describes included
payloads and explicit downloads.
