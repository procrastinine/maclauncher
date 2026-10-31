# Android

Android is the game type for Android applications and games distributed as APK
packages, which MacLauncher imports, prepares locally and runs with one of three
runtimes. The default,
[MacLauncher Android](#maclauncher-android), runs the complete AOSP Android 16
framework on Apple Silicon. [Mac.apk](#macapk) and [AIM](#aim) are optional
runtimes. Each runtime has its own settings and application data.

Apps can be downloaded from Google Play, F-Droid and IzzyOnDroid in the External
window; [Android app downloads](../library/GOOGLE_PLAY.md) describes those
sources.

## Accepted inputs

Import accepts a single `.apk`, a folder containing a base APK and its split
APKs, or an `.xapk`, `.apkm` or `.apks` archive. When a split APK is selected,
MacLauncher finds the rest of its package set in the same folder by package name
and complete version code. APKs with other versions stay separate. OBB expansion
files beside an APK or inside a package archive go into the application's
private expansion storage, and downloads and updates made by the application
stay there when the runtime changes.

A package set can hold up to 64 APKs and 4 GiB of extracted data. Import
validates archive paths, ranges and checksums, and keeps Android's
case-sensitive compiled resources inside their APKs.

Inspection reads the original binary manifest, resources and archive directory
without starting Java or running application code. An included native resource
reader extracts localized names and icons from the original base and split APKs
without an Android or Java runtime.

## Inspector tools

For Android games, the inspector groups its actions as **APK tools** (**Inspect Android
package**, **Decompile APK…**, **Decode APK** and **Reveal decompiled APK**),
**Files** (**Import files…**) and **Google Play** (**Add to Google Play
library**).

### Package inspection

**Inspect Android package** shows the package name, version, activity,
permissions, DEX and native architecture information for every supplied ABI. It
reads the local package and does not need an installed Android game runtime. The
included APK signature verifier is shared independently of runtime
installations; when Java needs it, it is extracted to a verified file on disk.

### APK decompilation

**Decompile APK…** exports Java source reconstructed from the original DEX
bytecode with [JADX](https://github.com/skylot/jadx) and decodes Android
manifests and resources. It works the same whichever Android runtime is
selected, and it neither launches the application nor prepares an Android system
image. Base and matching split APKs, including architecture and resource splits,
are decompiled together. Package archives are unpacked temporarily, without
copying application saves or expansion data.

JADX versions are listed under **Runtimes → Tools**, and the first
decompilation offers to download JADX or its Temurin Java host when either is
missing. JADX 1.5.6 and later use the cross-platform Java release, which needs
Java 11 or later; MacLauncher supplies a Java 17 or later host for it.

The folder chooser selects a parent folder for the output. Each export creates
its own folder, so earlier exports are kept, and **Reveal decompiled APK** opens
the latest result in Finder. Canceling removes the incomplete staged output.
When JADX cannot reconstruct some code but still produces useful files, the
result is labeled **Partial output**, with details in `decompile.log`.
Decompiled source can differ from the original, especially for optimized or
obfuscated code. Native ARM libraries stay binaries; JADX does not reconstruct
their C or C++ source.

**Decode APK** uses [Apktool](https://github.com/iBotPeaches/Apktool) to export smali bytecode and decoded manifests and resources, in separate folders
for the base APK and each split. It complements the Java source that JADX
reconstructs. The decoded files are stored in the application's private tool
data and opened in Finder, and a failed or canceled export keeps the previous
result. Apktool also runs on a compatible Temurin Java host.

### Importing files

**Import files…** copies selected Mac files into the application's container
and leaves the originals unchanged. It accepts up to 128 regular files, with at
most 1 GiB per file and 4 GiB in total.

### Google Play library

**Add to Google Play library** asks the installed Google service for a free
license for the imported package. It requires network access, a selected account
and a stopped game. Paid purchases are never requested. A licensed reply can
describe an existing entitlement; whether the app is available still depends on
Google Play, the package and the account. The provider's automatic
free-acquisition preference is restored afterward, including after an
interrupted request.

## Virtual device

Every runtime presents the same virtual device by default: a Pixel Tablet with a
2560 × 1600 pixel display at Android's 320 dpi logical density. The Mac window
first opens in landscape at 1280 × 800 points. These values describe the virtual Android device rather than the Mac, stay
the same across runtimes and expose no physical Mac device telemetry. Device branding is generic Android, and the
runtime profile records the Android API level and native ABI. The reference
display matches the
[Android Studio tablet profile recorded by Chromium](https://chromium.googlesource.com/chromium/src/tools/android/+/77d4c8dd8a136fa6ba61f403e1fb8da0e82935c5/avd/proto_creation/android_35_google_apis_tablet_x64.textpb).
AIM also reports the tablet's SoC and density instead of the Mac's hardware.

## Storage and saves

Each runtime keeps its own application data.

MacLauncher Android stores application data under
`~/Library/Application Support/maclauncher/android/apps/<gameId>/`. Prepared
code, application files, downloaded assets, caches, no-backup files and
temporary files each have their own location. Saves and downloaded assets are
stored apart from prepared code. The runtime's JVM and ART engines use the same
per-game data, so saves, preferences, databases and downloaded assets stay
available when the execution engine changes. Generated JVM and ART code use
separate caches. The two engines run a game one at a time and share its
existing container.

Mac.apk and AIM keep writable data under
`~/Library/Application Support/maclauncher/android/apps/<gameId>/providers/<runtimeId>/`.
That directory holds the runtime's Android root, home, cache and temporary
files. Shared runtime binaries are kept apart from application data.

Switching to another runtime keeps the existing application directories, but
their saves, downloaded assets and accounts are not imported into the new runtime automatically.

## Settings

**Settings → Android** shows the options and accounts of the selected runtime,
and each game's runtime settings can override the defaults. The
[settings reference](../runtimes/SETTINGS_REFERENCE.md#android) lists every
field. MacLauncher Android and Mac.apk both have **Initial width** and **Initial
height** settings for the first window size and a **Network access** setting.
AIM always runs offline. The runtime sections below describe the
remaining settings.

## Google accounts

MacLauncher Android and Mac.apk keep separate account stores; AIM has no account
controls. Both account panels in **Settings → Android** sign in through the
browser by default, and **External → Android** uses the same shared account
list. The account table scrolls and has a refresh icon and **Sign in in
browser** in its toolbar. Saved accounts appear immediately, without
starting an Android runtime. Refresh reads the original provider again, and the
list updates after sign-in and account changes without reopening the window.
Existing provider accounts can be selected without opening Android sign-in.

Sign-in opens a native Google account window, where Google handles passwords
and account challenges; closing the window cancels the attempt. Launcher
preferences record which accounts are selected but never passwords or tokens,
and an optional remembered browser authorization is kept in the launcher's
encrypted session storage. Removing an Android account also disconnects a matching External
selection; other provider accounts are unaffected.

How games use these accounts depends on the runtime: see
[Google services](#google-services) for MacLauncher Android and
[Mac.apk](#macapk).

## Runtimes

| Runtime | Scope | Delivery | Requirements |
| --- | --- | --- | --- |
| **MacLauncher Android**, default | Android 16 apps for ARM64 and ARM32, with optional microG | One package with JVM and ART engines from MacLauncher Builds; the Android 16 system image is downloaded from upstream when needed | Apple Silicon; macOS 13.0 or later |
| **Mac.apk** | ARM64 apps, with optional Google sign-in | Publisher releases | Apple Silicon; the macOS version each release states |
| **AIM** | Original Android 16 on ART, offline and without Google accounts | Adapted host from MacLauncher Builds; separate 1.95 GB Android system image | Apple Silicon; macOS 26.0 or later |

Runtimes groups the JVM and ART engines under **MacLauncher Android**; Mac.apk
and AIM have their own entries. Each Android runtime needs Apple Silicon. On an Intel Mac, MacLauncher does not
offer them, and Android games show that requirement instead of **Play**.

### MacLauncher Android

MacLauncher Android combines an adapted
[Klepton](https://github.com/shinyquagsire23/Klepton) host, the complete AOSP
Android 16 Java framework and Android's native framework libraries. It has two
execution engines, JVM and ART, which share the same framework, services and
macOS integration. The [architecture reference](android/ARCHITECTURE.md)
describes its components in detail.

#### Versions and downloads

MacLauncher Builds publishes one Android package containing the JVM and ART
engines, separately from the app. Both engines use the same installed package
and shared native dependencies. Existing separate ART installations and saved
version choices remain available offline and can be removed in Runtimes.
[Version selection](../runtimes/README.md#versions) and
[downloads](../runtimes/README.md#downloads-and-offline-use) work as for other
runtimes.

The JVM engine runs on the Java 21 default set under Temurin in Runtimes when it
is installed, and otherwise on the newest installed Apple Silicon Java 21. When
no Java 21 is installed, Play offers to download that default or the newest
listed Java 21 release.

ART uses the package's ART components and the original Android 16 system image, which is
downloaded under the Android SDK license. The image is stored once, in a
case-sensitive, read-only system-image cache, and a matching image already
downloaded for AIM can be reused. The Android package and writable application data
stay separate from the image. JVM builds that require an original system image
use the same shared cache and download the image during Play or account setup.

The runtime prepares Android's original linker configuration before the
application's mounts are attached. Shared platform files stay read-only, and
each application's native code is held to the same private storage boundary as
its Java code.

#### Execution engines

**Execution**, the first MacLauncher Android setting, selects the engine for
the next launch, and the global default and per-game overrides use the same
selector:

- **JVM**, the default, runs the app on Apple Silicon Java 21.
  [dex2jvm](https://github.com/kksimp/dex2jvm) converts the app's DEX bytecode
  into Java classes.
- **ART** runs the original DEX on Android's original runtime with a matching
  Android 16 system image.

JVM stays selected when no execution preference is stored.

#### Preparation

Preparation verifies APK signatures, package names, version codes and signing
lineages. The original signed APKs stay separate so that resources load in
order: the installed base is named `base.apk`, and split filenames keep their manifest split names. Packages prepared with an earlier layout adopt this one
without converting their bytecode again.

MacLauncher Android accepts ordinary feature splits that declare activities,
activity aliases, services, providers and receivers. Inspection combines their
launcher and component metadata with the base application's defaults, and
Android's original package parser registers the installed components.
Non-isolated splits share the application class loader. Isolated splits use
Android's original dependency loaders: each feature inherits its declared parent
and the base classes, and sibling features keep separate classes and resources.
Component contexts keep their declared split.

ARM64 native libraries are preferred, but a runtime that contains the ARM32
execution component selects `armeabi-v7a` or `armeabi` libraries when
appropriate. Their ARM32 instructions are translated by Dynarmic into ARM64
code, which reaches the same Klepton native services through width adapters,
while the JVM and AOSP framework stay 64-bit. The
[ARM32 component reference](../../src/modules/android/native/arm32/README.md)
describes the instruction, ELF and JNI boundaries.

For the JVM engine, all DEX preparation shares one conversion session. Converted
classes load through Android's original application and split loaders over the
complete executable framework. When isolated APKs define the same class
separately, each keeps its own code through the original per-APK conversion
path. Original DEX loaders keep class delegation, resource lookup and added
paths, and dynamically loaded DEX code uses the same converter and JVM. Packages
that declare `hasCode=false`, including resource-only packages and framework
NativeActivity applications, need no DEX conversion.

Platform shared-library declarations come from Android's original SystemConfig,
and Android's original package compatibility rules fill in the package state and
ApplicationInfo. The compatibility service is available during package
inspection, and application callbacks use the parsed target SDK. Both engines
use LoadedApk's canonical shared-library loaders, dependency graph and ordering
around application classes.

Assets up to 64 KiB use bounded decoding and asynchronous file writes; larger
assets and libraries stream to disk.

Preparation caches are keyed by APK contents, the converter's content hash and framework class declarations. Changes to adapter implementations reuse the converted
classes as long as those declarations stay the same, and changed declarations or
converter inputs invalidate the matching cache. Archives support ZIP64 class
directories. Verified digests of unchanged preparation files are reused across
launcher processes. Every launch checks file identities and nanosecond
modification and change times, and changed inputs are read and verified again.

Only the current prepared version stays cached; versions still in use are kept
until their users release them. Installed APKs use filesystem copy-on-write where
available and keep one canonical name for each base or split package. These
archives supply Android's resources and signed package identity. Package selection, publication and eviction share a kernel lock across launcher workers, and active readers hold filesystem leases that keep their files in place. Installed service catalogs keep
their selected immutable source generation independently of the conversion
cache.

Shared package metadata keeps its canonical prepared source while authenticated
application processes use it. Concurrent processes with the same package
identity share that source. When the last of them exits, the transient metadata
and its derived converted-code lookup are removed. Installed service metadata
belongs to the service installation. Repairs and installed-path updates publish
a separate generation, so running games and services keep their original files.
Path updates reuse converted content through filesystem copies, with
copy-on-write where available.

Concurrent launches of the same runtime share one verification, run off the main
thread. Each launch can be canceled on its own: canceling the last waiting
launch stops the verification, while launches of other selected runtime versions
continue independently. Child account services stay with the runtime build that was selected when they started, so selecting another runtime build does not disturb a launch in progress.

#### Display and input

Android content and input reach the native window through the original
PhoneWindow and ViewRoot. The window's dimensions supply Android's layout bounds,
display metrics and touch coordinates, and native input devices report
coordinate ranges from the committed display extent. Native screen fitting and
Retina backing determine the actual render extent. The original VirtualDisplay
keeps the device profile's density through resizing and app-requested orientation
changes, and Android keeps its application density-compatibility policy. When
the package's activity metadata declares a fixed orientation, that orientation
is applied before the initial physical window opens and before application
callbacks run. Both engines use the same orientation policy, and later requests
follow Android's window lifecycle.

Mouse clicks and drags become finger touches, and captured mouse movement uses
relative mouse semantics. Mouse wheels and trackpads scroll in both directions.
Apps that handle scrolling receive normal Android scroll events, and touch-only
content receives a continuous swipe, including trackpad momentum. Native input
acknowledgements return asynchronously to the Looper that owns them, even while
a layout traversal synchronization barrier is pending. Android keeps event
identities and completion callbacks for native input and for the touch-scroll
fallback.

Keyboard input and text composition go to the focused Android input connection,
including in embedded web content. Cmd-A selects text and Cmd-X cuts within
Android. Cmd-C and Cmd-V transfer plain text between the foreground app and the
Mac clipboard, and only for that explicit shortcut; ordinary Android clipboard
access stays within the Android session. Each Mac clipboard transfer requires
foreground ownership and a single-use physical shortcut. The JVM input bridge
returns clipboard replies asynchronously on Android's main queue, so layout
traversal barriers do not delay an accepted paste. The included
[text input component](../../src/modules/android/text-input.js) keeps the
original Android input connection and native text interfaces; its
[Java source](../../src/modules/android/text-input/java/maclauncher/android/framework/HostTextInput.java)
and MIT license accompany the included JAR.

By default, WASD controls a virtual touch joystick. The per-game **Keyboard
touch joystick** setting selects WASD, arrow keys, both, or Off, and the
joystick's center and radius are configurable. The mouse stays an independent touch for buttons and other controls, and
mapping pauses while an Android text editor is active.

**Manual tilt** supplies virtual motion sensors from the keyboard or a
controller. In keyboard mode, Q and E tilt left and right and R recenters;
Option + arrow keys also tilt, and Option + 0 recenters. A controller uses its right stick instead. Movement keys stay separate, and Cmd
and Control shortcuts pass through. While an Android text editor is active, it receives typing keys and
keyboard game controls are suspended. With manual tilt off, Q, E and R keep
their ordinary game behavior.

#### Graphics

One presenter handles Canvas, GLES and native SurfaceView output for the whole
life of an Activity. Canvas uploads reuse a fixed-size image pool, and native
surfaces submit GPU textures and synchronization events. SurfaceControl ordering
and transforms place Android controls over native game frames, and an unchanged
overlay needs neither another upload nor another composition pass. Composition keeps the texture origin of the game's native rendering and maps the Android Canvas's top-left coordinates into it, including when the render and layout extents
differ. Planar video conversion keeps the source's row and column order in the
shared Metal texture, and Android's original consumer keeps its texture
transforms and display rotation.

Under ART, SurfaceFlinger starts alongside its hardware composer. Original
Binder clients wait for their dependencies, and both services register before
the application window is registered with the launcher. Native readiness queries
use the original Binder service manager in a small process with no window, audio
or resolver dependencies. Composer and SurfaceFlinger publication are awaited
together, and both original service lifetimes are observed before the window is
registered.

Both engines store ANGLE's serialized shaders and programs in the same native
cache format. Application caches stay inside each application's storage, and
ART's immutable native services share one native cache for the launcher. The cache keeps binaries for different drivers and macOS versions apart, and a cache miss uses the
original compiler.

**Settings → Android** sets the default **OpenGL ES backend** and **Vulkan
implementation**, and each game's runtime settings can override them, with changes taking effect
on the next launch. ANGLE uses Metal by default, and the backend list
shows the backends included in the installed Android runtime. **Vulkan
implementation** appears when the OpenGL ES backend is Vulkan; the Vulkan
backend uses the same Vulkan implementation as native Vulkan apps. Hidden
backend, joystick and account fields keep their saved values.

When an APK requires a newer OpenGL ES version than the default Metal provider
supports, launch selects ANGLE's Vulkan backend through an installed Vulkan
implementation. Native execution uses MoltenVK for its shared Android buffers. A saved backend
choice takes precedence over this automatic selection, which only supplies
OpenGL ES and does not turn on an application's native Vulkan rendering mode. The reported OpenGL ES version,
including the minor version, comes from context creation on the selected
backend. GLES and EGL symbols resolve within the selected ANGLE libraries and
their procedure table, and desktop OpenGL libraries never supply Android entry
points. With native execution, Vulkan OpenGL ES shared buffers and planar video
images require MoltenVK's Metal texture attachment interface. The Android
compositor stays on Metal while application contexts use the selected OpenGL ES
backend.

Vulkan apps use the selected MoltenVK or KosmicKrisp library. Android window
surfaces map to Metal surfaces on the same native window, and the driver
handles swapchain creation, image acquisition and presentation synchronization.
Its Metal textures enter the shared presenter along with Android controls and
graphics effects. PackageManager reports the Vulkan version and hardware level
of the same selected physical device. Hardware levels use Android's required
Vulkan feature sets, and feature enumeration and version checks read the same
capability data in both engines.

Android frames go through the same
[graphics chain](../graphics/README.md) as other runtimes. ReShade
effects, spatial scaling and LSFG settings are in the game inspector. The
optional resolution multiplier lowers the render target while keeping the window
or fullscreen output size. At 2×, a 1920 × 1080 output uses a 960 × 540 source,
and Android layout and touch coordinates follow that source size. Auto keeps
the application's requested render resolution.

PixelCopy keeps the original Surface, SurfaceView, Window, region and request
APIs. An explicit request copies the app's own native surface to a mutable bitmap,
with scaling and an asynchronous result. Ordinary presentation never reads
frames back to the CPU.

Android records frame-time history for every run, including normal launches
without a profiler. Per-surface records separate the source, accepted, actually
presented and generated frame rates, and include frame-interval percentiles,
submission time, queue occupancy and render and output dimensions. The counters
use the existing presentation calls, without GPU readback or waits for
completion. Two rolling files in the app's private storage keep at most 256 KiB
across a quit or crash.

Display callbacks, window buffers and native frame sources live as long as the objects that own them. When an Activity pauses, stops or is destroyed, its surface stays available while rendering callbacks finish, and the display and
presentation shut down afterward. Android message-queue waits on the native
window thread also dispatch AppKit events.

#### Audio, video and capture

AudioTrack accepts PCM writes as bytes, shorts, floats and direct buffers, with
static buffers, looping, playback position and rate conversion. CoreAudio
handles the actual output route. Android stream volume and mute controls apply
software gain inside the application and leave the Mac's system volume
unchanged. Route-change callbacks update Android's existing device cache.

MediaPlayer reads and decodes the selected source on its calling thread or on an
asynchronous worker. Reset and release cancel that player's work, and each
player has its own operation lock. Prepared next-player transitions, completion
listeners, pause, restart, looping and stereo balance use the same native audio
path. File-descriptor ranges stay open as long as their source.

MediaExtractor exposes AVFoundation tracks, formats and compressed samples from
local paths, file-descriptor ranges and MediaDataSource callbacks. Under the
JVM, MediaCodec uses VideoToolbox for H.264 and H.265 and libvpx for VP8 and VP9
profile 0. Both decoders support synchronous buffers, asynchronous callbacks,
format changes, end-of-stream draining and Surface presentation. Software VP8
and VP9 decoding produces NV12 frames up to 4096 × 2304, and Android's original
capability APIs report these dimensions, software decoding and the supported
profiles.

The per-game **Audio input** and **OBS camera** settings default to Off. Play
requests macOS permission for the selected devices, and capture begins when the
application starts recording or a camera preview. OBS Virtual Camera supplies
video; audio comes from the separately selected input. The capture adapters
provide PCM16 mono or stereo AudioRecord data and legacy NV21 camera callbacks.
Audio capture uses a preallocated, fixed-size FIFO with a single CoreAudio writer and serialized Android readers. The callback publishes available frames
without taking a reader lock. When the FIFO is full, it keeps the queued frames
and discards the incoming excess. Pause, flush and close wake blocked reads
before capture shuts down.

#### Power, alarms and location

Power queries describe a fully charged Android device on AC power, with battery
saver off and nominal thermal status. Wake locks keep Android's token and
callback handling within the app; they do not prevent Mac sleep or reset its
idle timer. Mac sleep pauses the current Activity, and waking resumes it if it
still exists. Alarms deliver callbacks and pending intents through the running
application's Android queue. JobScheduler runs application-lifetime jobs on that
queue, including namespaces, cancellation, delayed and periodic requests,
completion and retry backoff.

Location starts empty: when an application requests a location, a sheet asks
for a latitude and longitude. **Share** supplies those coordinates as a mock
location for that application session and **Cancel** supplies none, and the
coordinates are not saved between launches. Permission and AppOps queries use the same device and
location state without requesting access on their own.

#### Google services

Google integration in MacLauncher Android uses microG. Each game's inspector and
Settings offer three choices:

| Selection | Behavior |
| --- | --- |
| **No microG** | **Use microG** is unchecked, and Google service packages are disabled for the game |
| **microG without an account** | **Use microG** is checked, and the account selector keeps its anonymous entry |
| **microG with an account** | **Use microG** is checked, and a shared account is selected |

Google integration is off by default, and turning it on neither signs in nor
chooses an account. **Settings → Android → Google accounts** manages the shared accounts, and each game's options choose which account, if any, the game sees. Network access is a separate per-game setting. All three (network access,
Google integration and account selection) take effect when the game starts, so changing
them while the game runs requires a restart. Turning off Google integration
keeps the shared accounts and other games' selections. Google-enabled
applications share one Android account service. Anonymous mode keeps Google
accounts hidden but uses the same service and process boundary.

One original AccountManagerService holds the launcher's account database and
authenticator sessions. Authenticators keep their verified package identities
and run in separate processes. Listing accounts reads installed files and does
not authorize network requests. Signing in from Settings or External opens the
same native Google account window. After Google handles the password and any
challenges, the result is registered with microG through the original
AccountManager APIs under microG's verified package identity. Sign-in downloads the account runtime, Java and microG packages when they are missing. The microG Services and Companion APKs come from the newest [microG GmsCore release](https://github.com/microg/GmsCore/releases) that offers both. microG names each APK `<package>-<versionCode>.apk`. A downloaded APK must be signed with microG's certificate, have the package name and version code that its file name gives, and match the SHA-256 that GitHub publishes when there is one. The installation records each file's SHA-256 and keeps working offline. Neither a
game nor a background provider request can open interactive Google sign-in by
itself, even when no account is selected.

For recognized microG Services and Companion packages, Google integration
exposes the provider's declared compatibility certificate to Google client
libraries. Signature permissions and account-data access still use the actual
verified publisher and signing lineage. Google certification, Play Integrity and
store entitlements remain under the publisher's control.

The account service, KeyStore and the other shared Android system services run
under one common process broker. Each service role has a kernel lock,
controllers authenticate and keep a reference to each service they use, and
service processes that are no longer used are retired. Games receive only the
public Binder listener. Account and KeyStore databases, controller capabilities
and process-registration sockets stay outside game-readable storage. KeyStore
reports software security and stores opaque keys through the original software
KeyMint.

#### Installed services

Installed service APKs go through the same signature checks, preparation and
private storage as games. A persistent package identity supplies each one's UID
and signing lineage. Their components start on demand in the processes their
manifests declare and use the original ActivityThread, LoadedApk, AIDL and
content-provider dispatch. Activity startup requests the shared Settings process
while graphics and package records initialize. Provider acquisition waits for
the provider's authenticated directory through the original Android
content-provider path.

ActivityManager clients inside an application keep their local context through
receiver cleanup, and shared UID observation goes through the authenticated shared system service. Running-service queries return snapshots of the services that
processes currently run, including start and binding state, foreground status
and Android process identity. An application provider that cannot start returns
Android's unavailable-provider result; its process lifetime is separate from the
local ActivityManager. Service lifecycle records keep a limited set of process
outcomes, initialization phases and failure codes, and exclude raw
account-process output and account values.

#### Network, ads and web content

**Network access** uses the shared game setting and
[process-level network policy](../runtimes/NETWORK_ISOLATION.md). With access on,
the game can make connections, bind local sockets and accept incoming traffic.
With access off, IP and DNS traffic is blocked for the game and its child
processes, and Android reports no usable route. Authenticated process grants
keep service traffic within the requesting application's policy. Private Unix
sockets stay available for runtime services.

Connectivity observes macOS routes without sending a network probe. A dedicated
native queue collects route, interface and DNS facts into copied snapshots, and
Android's network service consumes matching revisions without running host
configuration queries on the system looper. Route cost controls metering; macOS
Low Data Mode is reported separately.

Traffic accounting is mocked. Device, interface and per-UID byte and packet
counters stay at zero, and usage queries return empty summaries and histories.
Accounting reads no Mac network counters or traffic from other applications.
Socket tagging and untagging succeed without changing or closing the
application's socket.

ART uses Android's original DNS resolver with the Mac's configured DNS servers.
Its native service keeps per-application ownership of route-probe sockets
through Android's `CAP_CHOWN`. Guest capabilities are separate from Mac
credentials and application processes.

Known advertising and tracking destinations are filtered by default. **Allow
ads** in **Settings → Android** sets the Android default, and each game's
runtime settings can override it; changes apply on the next launch. Allowing ads
turns the filter off for the session, including rewarded-ad connections. The
shared host list covers native and Java DNS, embedded WebView requests and
external browser links. Blocked WebView navigation stays blank, and blocked
external links produce no prompt. The filter works independently of network
isolation and leaves application SDKs and rewards alone. Direct-IP traffic and
content served from a game's own shared host follow the ordinary network
setting.

External HTTP and HTTPS links require confirmation with **Open Browser**, shown
beside the requesting game window. Canceling is the default, and closing the
game removes its prompt. Approving a link grants no Mac file or
application-launch permissions. Valid browser intents are still handled when
confirmation is declined, network access is off or the browser request channel
has closed: no browser window opens, and the application receives no
activity-not-found error.

WebView uses an embedded WebKit view in the existing game window. Cookies and
website storage belong to the application session and are discarded when it
ends. Android keeps navigation callbacks, text input and Canvas composition.
Cookie reads use the current WebKit cookie store, including changes made by page
scripts. Android view visibility controls page rendering, so covering the Mac
window does not pause a visible WebView's animations. Document dimensions are
separate from the captured viewport, and text zoom changes text layout
independently of page zoom and display density. Android's original input
connection handles text replacement, composing spans, selection and
surrounding-text queries. The document editor receives the resulting UTF-16
ranges, and copy and paste follow explicit clipboard actions.

#### Sandbox

A mandatory macOS file sandbox covers Java, native code and child processes. It
permits the application's container, read-only runtime artifacts, the selected
service packages and required system resources. The application gets private
home and temporary directories, with no filesystem proxy or virtual machine.
Installed service APKs can be read through the package catalog, but their
writable application data stays private. Native text editing uses the macOS
completion and spelling services under the same file and network policy.

#### Diagnostics

Runtime diagnostics go to the game's `runtime.log`. Within 32 KiB, the log keeps
the first Java or native failure and recent shutdown details, including fatal
reports that are followed by an application exit code of zero. It updates at
most once per second while messages arrive, and once at exit. The running
indicator clears when the process exits, and an older process cannot replace a
newer launch's diagnostics. A requested Stop keeps earlier diagnostics in the
log and does not treat an ordinary SIGTERM or Java shutdown status 143 as a new
failure. Fatal runtime reports and crash signals during shutdown still count as
failures.

Both engines send Android native logs to the same physical log destination,
independent of the application's standard streams. An app can redirect or close
stdout and stderr while Android log callbacks keep writing to that destination.

Opt-in native ANGLE shader diagnostics report failed shader compilation and
program linking with a limited amount of compiler output. The original GL error
state and the application's debug callback stay with the game, and ordinary
rendering calls ANGLE entry points directly.

The [native host reference](../../src/modules/android/native/README.md)
documents build inputs, generated bindings and low-level platform mappings.
[Upstream sources](../runtimes/UPSTREAMS.md) and
[attributions](../ATTRIBUTIONS.md) record the exact upstream sources and their licenses.

#### Framework and macOS mappings

MacLauncher Android runs Android's original portable framework code and adapts
the actual platform operations at the JNI, Binder, device and ABI boundaries.
The [architecture reference](android/ARCHITECTURE.md) describes each component.

| Android interface | Implementation and macOS connection |
| --- | --- |
| Framework classes, utility collections, Activity, View, Resources and package parsing | Complete uninstrumented AOSP framework from Robolectric's `android-all`; JVM portability hooks connect operations that the JDK handles |
| Bitmap, Canvas, Paint, text, fonts and resource decoding | Matching native framework graphics and resource library, original Android fonts and ICU data; output joins the shared window presenter |
| NDK bitmap, asset and configuration APIs | Original AOSP implementations over the same native resources and AssetManager that Java uses |
| SQLite, cursors and ContentValues | AOSP database implementation and native SQLite and CursorWindow engines over application-private files |
| Binder, Parcel and AIDL | Original AOSP Binder RPC, Parcel JNI and dispatchers; authenticated Unix-socket connections between declared application processes |
| Native libraries and JNI | Klepton's shared image registry, dependency loading and constructors; Android ABI representations map to Darwin and the existing JVM |
| GLES and EGL | Complete AOSP Java classes and generated JNI adapters over the selected ANGLE provider |
| ANativeWindow, Surface and SurfaceControl | Native surface handling, layer composition and the shared Metal presenter |
| MediaPlayer and AudioTrack | Original media services, AudioFlinger and AudioPolicy over the CoreAudio device boundary |
| Java and NDK MediaExtractor | Original Android extractor implementations and shared Binder services |
| Java and NDK MediaCodec | Original codec sessions, buffers and Codec2 components; VideoToolbox hardware decoding and original software codecs |
| AndroidKeyStore | Original Android KeyStore service and software KeyMint, with private launcher storage |
| AccountManager | Original AccountManagerService, installed authenticators and one shared account database |
| URI permissions | Original UriGrantsManagerService, authenticated callers and persistent grants in private launcher storage |
| App shortcuts | Original ShortcutService, package checks, quotas, XML and icon storage in the shared system service; pinning requires an Android HOME-role launcher |
| App widgets | Original AppWidgetServiceImpl and AppWidgetManager keep provider discovery, bindings and widget state in the shared system service; widgets are displayed by Android widget hosts |
| Statistics registration | Original StatsD Java services; native collection is unavailable without its collector |
| Connectivity and sockets | macOS route observation, native resolver and socket operations, with Android address families, flags and errors translated |
| FileObserver and native inotify | Shared libinotify-kqueue event handling and notifications from the runtime I/O boundary |
| Process IDs, thread IDs, scheduling and signals | The launcher's process authority, which authenticates each Android process, and live native thread IDs; Linux and Darwin layouts and values are translated at the platform boundary |
| Native scheduling-policy requests | Original AOSP SchedulingPolicyService and AIDL keep caller checks and Binder lifetime; JNI maps thread task profiles and scheduler requests to Darwin kernel policy |
| Sensor privacy | Original SensorPrivacyService, state controller and listener protocol over the shared user, permission and application-operation services |
| Telephony event listeners | Original TelephonyRegistry with Android's modem and subscription availability and callback permission checks |
| Keyguard and trust | Original clients use the shared, unsecured Android device state, permission checks and Binder listener lifetime; Mac credentials stay separate |

Robolectric supplies only the framework and native artifacts; its test runner,
shadows and simulated service environment are not part of the game runtime.
Klepton and the upstream native implementations share the same graphics, audio,
storage and process services. The JDK owns the Java boot classes and the JVM's
memory and thread lifecycle.

Shared JVM launch options expose the JDK collection delegates and monitor fields
that Android's desugared Java library wrappers use, so those wrappers keep the
original collection contents and synchronization behavior. When an application
looks up a system class, the JVM checks the host class path first and then
delegates to the APK's current defining loader. Original JDK logging handlers,
resource enumeration and service providers use that same application
definition, while instrumentation agents stay on the host class path. Dex-load
reports go to Android's original dex manager and usage records, stored with the
installation.

Messages to the process authority and descriptor transfers share each process's channel queue. Closing a channel rejects its pending transfers, while other processes keep their own service registrations and held resources. For both engines,
launch preparation runs installed-package preparation in parallel with display
metadata and graphics setup. A failed launch waits for pending preparation before releasing its hold on the package.

Both engines use the same private application data. Android storage aliases and
retained absolute paths inside that data resolve to the same files, including
nested expansion, cache and media directories in both Android private paths and
retained physical application paths. Other applications' data and the host's
parent directories stay outside the app's namespace. Under the JVM, native
memory maps use `/data/app/<package>/lib/<instruction-set>` names while native
loading resolves the original immutable files. Ordinary `File` metadata,
directory operations and stream opens use the same aliases at the native
filesystem boundary, and JDK files and descriptors keep their original I/O
behavior. Java and native libc receive the same scoped Android partition and
storage environment in JVM processes. NIO file metadata and ownership changes use
the same Android UID and GID mapping as libcore, and files on the Mac keep their
original ownership. Android's original `SystemCleaner` delegates to the JDK's
shared cleaner through the same JVM configuration, so a single cleaner handles
resource cleanup.

The NDK asset and configuration functions share Java's original AssetManager.
Prepared loose assets and expansion-file slices reach Android's AssetsProvider as
owned file descriptors and byte ranges. Android's original asset code handles
reading, seeking, mappings and duplicated descriptors, and generated NDK
declarations connect ARM32 callers to the same implementation.

### Mac.apk

[Mac.apk](https://github.com/kksimp/Mac.apk) runs ARM64 Android apps, with
optional Google sign-in; its versions are the publisher's own releases. Installation reads each release's macOS requirement from the downloaded app's `LSMinimumSystemVersion` and finds the runtime wherever the download places the app.

The **Graphics backend** setting selects **Automatic**, **Metal** or **Vulkan
(MoltenVK)**, and each game keeps its own selection.

Network access is off by default; turning on **Network access** takes effect at
the game's next launch. Mac.apk's shared-volume migration, Mac folder mapping and
Now Playing integration stay disabled. Android files remain in the game's
private provider directory, and launches without network access do not run App Links network verification.

Google integration is off for each game until it is turned on; a game with
integration on can use anonymous services or one selected account. Network
access is a separate choice and is required for authentication requests. In the
Mac.apk account panel, **Sign in in browser** opens the shared Google browser
window and registers the result through Mac.apk's supported account bridge. The
game's signed package identity is verified before any account access. Games
receive the selected account information and the authorization tokens they
request, and the account credential store stays outside the game's file access.

Mac.apk application windows and Dock entries use the game's name.

### AIM

[AIM](https://github.com/hahnlee/aim) runs applications with Android services
and original ART, without booting a Linux kernel or a virtual machine. It
requires macOS 26.0 or later. MacLauncher builds AIM from an exact upstream
commit with its own adaptations and publishes the native host through
MacLauncher Builds. Upstream AIM binaries
cannot replace the adapted runtime.

The matching Android system image is downloaded separately under its
publisher's terms and is not included in MacLauncher's app or source archives.
In **Runtimes → Downloads**, an image download stays cancelable through checksum
verification and preparation, and a downloaded image is reused. Image preparations are shared across host versions
that have identical system-image and overlay inputs, so selecting another
compatible host keeps the existing image storage and application data.

AIM applications run offline and without Google account integration. Other
behavior:

- Declared launcher components, including activity aliases, are kept.
- The display accepts client connections before its initial blank draw, and
  compiling graphics effects keeps the normal rendering path without delaying
  display readiness.
- AIM waits for the Android user to unlock during initialization and
  installation, so configured Android screen-lock credentials are still
  required.
- An activity wait can finish while startup is still pending. MacLauncher reports
  that state and keeps the Android process running until it exits or Stop is
  selected. An actual activity launch error ends the launch and includes Android's
  original result.
- Shared-memory files are created in the application's temporary directory and
  unlinked after opening; applications receive read-only descriptors.
- Native lock workers close through their controller and release their locks
  when that controller exits, independently of guest process-group signals.
- Stop requests shutdown through the retained controller, which waits for the
  resident's service and data cleanup. A failed shutdown is reported without
  detaching data from a live guest.

Adapted AIM builds use the game's name and icon in the Dock and the game's name
for the display window. AIM's native package resource reader prepares icons
without a Java host.

### Files and host access in Mac.apk and AIM

Package launcher resources supply artwork when
supported, and custom library artwork takes precedence. Each game has a small
macOS application entry, while runtime libraries and Android images are shared
across games.

File access is limited to the installed packages, the selected runtime and the
provider's private application directories. Selecting a runtime grants no access
to the host clipboard, location, camera, microphone or accounts, and provider
integrations stay within those same limits. Plain-text clipboard transfer uses
explicit Android clipboard gestures, and native WebView editing has no direct
access to the Mac clipboard.

Each provider keeps startup and recent output, up to a fixed size, in
`runtime.log`, `runtime.log.head` and `runtime.log.previous`. When a runtime
exits unexpectedly, the error includes the available runtime details once the
output streams finish draining.

The [architecture reference](android/ARCHITECTURE.md#macapk-and-aim) describes
how the providers are separated, the
[native code reference](android/NATIVE_CODE.md#process-startup) describes
constructor arguments, and the
[distribution policy](../runtimes/RUNTIME_DISTRIBUTION.md) describes which runtimes are included in the app and which are downloaded.
