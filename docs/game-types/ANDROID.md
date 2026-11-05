# Android

The Android game type covers Android applications and games distributed as APK
packages. MacLauncher imports these packages, prepares them locally and runs
them with one of three runtimes. The default runtime,
[MacLauncher Android](#maclauncher-android), runs the complete AOSP Android 16
framework on Apple Silicon, while [Mac.apk](#macapk) and [AIM](#aim) are
optional alternatives. Each runtime has its own settings and application data.

Apps can also be downloaded from Google Play, F-Droid and IzzyOnDroid in the
External window. [Android app downloads](../library/GOOGLE_PLAY.md) describes
those sources.

## Accepted inputs

Import accepts a single `.apk`, a folder containing a base APK and its split
APKs, or an `.xapk`, `.apkm` or `.apks` archive. Because an app can be split
across several APKs, selecting one split APK is enough: MacLauncher finds the
rest of its package set in the same folder by package name and complete version
code, and APKs with other versions stay separate. OBB expansion files, whether
beside an APK or inside a package archive, are placed in the application's
private expansion storage. Downloads and updates that the application makes are
kept there as well, even when the runtime changes.

A package set can hold up to 64 APKs and 4 GiB of extracted data. During import,
archive paths, ranges and checksums are validated, and Android's case-sensitive
compiled resources are kept inside their APKs.

To inspect a package, MacLauncher reads the original binary manifest, resources
and archive directory without starting Java or running application code.
Localized names and icons are extracted from the original base and split APKs
by a native resource reader that is included with MacLauncher, so this step
needs no Android or Java runtime either.

## Inspector tools

For Android games, the inspector groups its actions as **APK tools** (**Inspect Android
package**, **Decompile APK…**, **Decode APK** and **Reveal decompiled APK**),
**Files** (**Import files…**) and **Google Play** (**Add to Google Play
library**).

### Package inspection

**Inspect Android package** shows the package name, version, activity,
permissions, DEX and native architecture information for every supplied ABI.
Because it reads the local package, no Android game runtime needs to be
installed. The APK signature verifier that MacLauncher includes is likewise
shared independently of runtime installations. When Java needs the verifier, it
runs the verifier from a verified file on disk.

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
missing. JADX 1.5.6 and later versions use the cross-platform Java release.
That release needs Java 11 or later, and MacLauncher provides a Java 17 or later
host for it.

When the export starts, a folder chooser selects a parent folder for the output.
Each export then creates its own folder, so earlier exports are kept, and
**Reveal decompiled APK** opens the latest result in Finder. Canceling removes
the incomplete output. If JADX cannot reconstruct some code but still produces
useful files, the result is labeled **Partial output**, with details in
`decompile.log`. Decompiled source can differ from the original, especially for
optimized or obfuscated code. Native ARM libraries also stay binaries, because
JADX does not reconstruct their C or C++ source.

**Decode APK** complements the Java source that JADX reconstructs. It uses
[Apktool](https://github.com/iBotPeaches/Apktool) to export smali bytecode and
decoded manifests and resources, with separate folders for the base APK and
each split. The decoded files are stored in the application's private tool data
and opened in Finder; if an export fails or is canceled, the previous result is
kept. Like JADX, Apktool runs on a compatible Temurin Java host.

### Importing files

**Import files…** copies selected Mac files into the application's container
and leaves the originals unchanged. It accepts up to 128 regular files, with at
most 1 GiB per file and 4 GiB in total.

### Google Play library

**Add to Google Play library** asks the installed Google service for a free
license for the imported package; paid purchases are never requested. The
action requires network access, a selected account and a stopped game. A
licensed reply can describe an existing entitlement, but whether the app is
available still depends on Google Play, the package and the account. Afterward,
the provider's automatic free-acquisition preference is restored, even when the
request was interrupted.

## Virtual device

Every runtime presents the same virtual device by default: a Pixel Tablet with a
2560 × 1600 pixel display at Android's 320 dpi logical density. This reference
display matches the
[Android Studio tablet profile recorded by Chromium](https://chromium.googlesource.com/chromium/src/tools/android/+/77d4c8dd8a136fa6ba61f403e1fb8da0e82935c5/avd/proto_creation/android_35_google_apis_tablet_x64.textpb).
On the Mac, the window first opens in landscape at 1280 × 800 points. These
values describe the virtual Android device rather than the Mac: they stay the
same across runtimes and expose no physical Mac device telemetry. Device
branding is generic Android, and the runtime profile records the Android API
level and native ABI. AIM also reports the tablet's SoC and density instead of
the Mac's hardware.

## Storage and saves

Each runtime keeps its own application data.

MacLauncher Android stores application data under
`~/Library/Application Support/maclauncher/android/apps/<gameId>/`. Within it,
prepared code, application files, downloaded assets, caches, no-backup files and
temporary files each have their own location, so saves and downloaded assets
are stored apart from prepared code. The runtime has two execution engines, JVM
and ART, and both use the same per-game data. Saves, preferences, databases and
downloaded assets therefore stay available when the execution engine changes.
Generated JVM and ART code, however, use separate caches. The two engines run a
game one at a time and share its existing container.

Mac.apk and AIM keep their writable data in a folder of their own,
`~/Library/Application Support/maclauncher/android/apps/<gameId>/providers/<runtimeId>/`,
which holds the runtime's Android root, home, cache and temporary files. Shared
runtime binaries are kept apart from this application data.

Switching to another runtime keeps the existing application directories.
However, their saves, downloaded assets and accounts are not imported into the
new runtime automatically.

## Settings

**Settings → Android** shows the options and accounts of the selected runtime,
and each game's runtime settings can override these defaults. Every field is
listed in the [settings reference](../runtimes/SETTINGS_REFERENCE.md#android).
MacLauncher Android and Mac.apk both have **Initial width** and **Initial
height** settings for the first window size, as well as a **Network access**
setting. AIM always runs offline. The remaining settings are described in the
runtime sections below.

## Google accounts

MacLauncher Android and Mac.apk can give games a Google account, and they keep
separate account stores for it; AIM has no account controls. **Settings →
Android** has an account panel for each of the two runtimes, and both panels
sign in through the browser by default. Each panel's account table scrolls and
has a refresh icon and **Sign in in browser** in its toolbar. Saved accounts
appear immediately, without starting an Android runtime. Refresh reads the
original provider again, and the list also updates after sign-in and account
changes without the window being reopened. Existing provider accounts can be
selected without opening Android sign-in. **External → Android** can use these
provider accounts as well, or a remembered browser sign-in, again without
starting Android.

Signing in opens a native Google account window, where Google itself handles
passwords and account challenges; closing the window cancels the attempt.
Launcher preferences record which accounts are selected, but never passwords or
tokens. A remembered browser authorization is optional and is kept in the
launcher's encrypted session storage. Although the browser window keeps its
cookies only in memory, **Use saved sign-in** can reuse the remembered
authorization after a restart. Removing an Android account also disconnects a
matching External selection, while other provider accounts are unaffected.

How games use these accounts depends on the runtime, as described under
[Google services](#google-services) for MacLauncher Android and under
[Mac.apk](#macapk).

## Runtimes

| Runtime | Scope | Delivery | Requirements |
| --- | --- | --- | --- |
| **MacLauncher Android**, default | Android 16 apps for ARM64 and ARM32, with optional microG | One package with JVM and ART engines from MacLauncher Builds; the Android 16 system image is downloaded from upstream when needed | Apple Silicon; macOS 13.0 or later |
| **Mac.apk** | ARM64 apps, with optional Google sign-in | Publisher releases | Apple Silicon; the macOS version each release states |
| **AIM** | Original Android 16 on ART, offline and without Google accounts | Adapted host from MacLauncher Builds; separate 1.95 GB Android system image | Apple Silicon; macOS 26.0 or later |

In Runtimes, the JVM and ART engines are grouped under **MacLauncher Android**,
and Mac.apk and AIM have their own entries. Every Android runtime needs Apple
Silicon, so on an Intel Mac MacLauncher does not offer them, and Android games
show that requirement instead of **Play**.

### MacLauncher Android

MacLauncher Android combines an adapted
[Klepton](https://github.com/shinyquagsire23/Klepton) host, the complete AOSP
Android 16 Java framework and Android's native framework libraries. It has two
execution engines, JVM and ART, which share the same framework, services and
macOS integration. The [architecture reference](android/ARCHITECTURE.md)
describes its components in detail.

#### Versions and downloads

MacLauncher Builds publishes the JVM and ART engines together, in one Android
package that is separate from the app. Both engines use the same installed
package and shared native dependencies, so Runtimes has a single version
selection for both. Otherwise,
[version selection](../runtimes/README.md#versions) and
[downloads](../runtimes/README.md#downloads-and-offline-use) work as for other
runtimes.

The JVM engine needs Java 21. It runs on the Java 21 version set as the default
under Temurin in Runtimes when that version is installed, and otherwise on the
newest installed Apple Silicon Java 21. If no Java 21 is installed at all, Play
offers to download that default or the newest listed Java 21 release.

The ART engine, by contrast, uses the package's ART components together with the
original Android 16 system image, which is downloaded under the Android SDK
license. This image is stored once, in a case-sensitive, read-only system-image
cache, and a matching image that was already downloaded for AIM can be reused.
The Android package and writable application data stay separate from the image.
JVM builds that require an original system image use the same shared cache, and
they download the image during Play or account setup.

Before the application's mounts are attached, the runtime prepares Android's
original linker configuration. Shared platform files stay read-only, and each
application's native code is held to the same private storage boundary as its
Java code.

#### Execution engines

**Execution**, the first MacLauncher Android setting, selects the engine for
the next launch. The global default and per-game overrides use the same
selector:

- **JVM**, the default, runs the app on Apple Silicon Java 21. For this,
  [dex2jvm](https://github.com/kksimp/dex2jvm) converts the app's DEX bytecode
  into Java classes.
- **ART** runs the original DEX on Android's original runtime, with a matching
  Android 16 system image.

When no execution preference is stored, JVM stays selected.

#### Preparation

Before an app runs, preparation verifies its APK signatures, package names,
version codes and signing lineages. The original signed APKs stay separate so
that resources load in order: the installed base is named `base.apk`, and split
filenames keep their manifest split names. Packages that were prepared with an
earlier layout adopt this one without their bytecode being converted again.

Apps can also deliver features as separate split APKs. MacLauncher Android
accepts ordinary feature splits that declare activities, activity aliases,
services, providers and receivers. Inspection combines their launcher and
component metadata with the base application's defaults, and Android's original
package parser then registers the installed components. How a split's classes
load depends on whether it is isolated. Non-isolated splits share the
application class loader, whereas isolated splits use Android's original
dependency loaders: each feature inherits its declared parent and the base
classes, and sibling features keep separate classes and resources. Component
contexts keep their declared split.

ARM64 native libraries are preferred, but a runtime that contains the ARM32
execution component selects `armeabi-v7a` or `armeabi` libraries when
appropriate. Their ARM32 instructions are translated by Dynarmic into ARM64
code, which reaches the same Klepton native services through width adapters,
while the JVM and AOSP framework stay 64-bit. The
[ARM32 component reference](../../src/modules/android/native/arm32/README.md)
describes the instruction, ELF and JNI boundaries.

The JVM engine runs converted DEX code, and all DEX preparation for it shares
one conversion session. The converted classes load through Android's original
application and split loaders over the complete executable framework. When
isolated APKs define the same class separately, each keeps its own code through
the original per-APK conversion path. Android's original DEX loaders also keep
class delegation, resource lookup and added paths, and DEX code that the app
loads dynamically goes through the same converter and JVM. Packages that declare
`hasCode=false`, including resource-only packages and framework NativeActivity
applications, need no DEX conversion.

Platform shared-library declarations are read from Android's original
SystemConfig, while Android's original package compatibility rules fill in the
package state and ApplicationInfo. The compatibility service is already
available during package inspection, and application callbacks use the parsed
target SDK. Both engines use LoadedApk's canonical shared-library loaders,
dependency graph and ordering around application classes.

When assets are written out, those up to 64 KiB use bounded decoding and
asynchronous file writes, while larger assets and libraries are streamed to
disk.

Prepared results are cached, keyed by the APK contents, the converter's content
hash and the framework class declarations. As long as those declarations stay
the same, the converted classes are reused even when adapter implementations
change; changed declarations or converter inputs invalidate the matching cache.
Archives support ZIP64 class directories. For unchanged preparation files,
verified digests are reused across launcher processes. Every launch still
checks file identities and nanosecond modification and change times, and inputs
that have changed are read and verified again.

Only the current prepared version stays cached, although versions that are
still in use are kept until their users release them. Installed APKs are copied
with filesystem copy-on-write where it is available, and each base or split
package keeps one canonical name. These installed archives provide Android's
resources and the signed package identity. Package selection, publication and
eviction share a kernel lock across launcher workers, and active readers hold
filesystem leases that keep their files in place. Installed service catalogs
keep their selected immutable source generation independently of the
conversion cache.

While authenticated application processes use shared package metadata, that
metadata keeps its canonical prepared source, and concurrent processes with the
same package identity share it. When the last of them exits, the transient
metadata and the converted-code lookup derived from it are removed. Installed
service metadata, on the other hand, belongs to the service installation.
Repairs and installed-path updates publish a separate generation of the files,
so running games and services keep their original files. Path updates reuse
converted content through filesystem copies, with copy-on-write where it is
available.

When several launches of the same runtime overlap, they share one verification,
which runs off the main thread. Each launch can still be canceled on its own:
canceling the last waiting launch stops the verification, while launches of
other selected runtime versions continue independently. Child account services
stay with the runtime build that was selected when they started, so selecting
another runtime build does not disturb a launch in progress.

#### Display and input

Android content and input reach the native window through Android's original
PhoneWindow and ViewRoot. Android's layout bounds, display metrics and touch
coordinates are taken from the window's dimensions, and native input devices
report coordinate ranges from the committed display extent. The actual render
extent, however, depends on native screen fitting and Retina backing. Through
resizing and app-requested orientation changes, the original VirtualDisplay
keeps the device profile's density, and Android keeps its application
density-compatibility policy. When the package's activity metadata declares a
fixed orientation, that orientation is applied before the initial physical
window opens and before application callbacks run. Both engines use the same
orientation policy, and later requests follow Android's window lifecycle.

The mouse acts as a finger: clicks and drags become touches, while captured
mouse movement uses relative mouse semantics. Mouse wheels and trackpads scroll
in both directions. Apps that handle scrolling receive normal Android scroll
events, and touch-only content receives a continuous swipe instead, including
trackpad momentum. Native input acknowledgements return asynchronously to the
Looper that owns them, even while a layout traversal synchronization barrier is
pending, and Android keeps event identities and completion callbacks for native
input and for the touch-scroll fallback.

Keyboard input and text composition go to the focused Android input connection,
including in embedded web content. Within Android, Cmd-A selects text and Cmd-X
cuts it. Cmd-C and Cmd-V transfer plain text between the foreground app and the
Mac clipboard, but only for that explicit shortcut; ordinary Android clipboard
access stays within the Android session. Each Mac clipboard transfer also
requires foreground ownership and a single-use physical shortcut. The JVM input
bridge returns clipboard replies asynchronously on Android's main queue, so
layout traversal barriers do not delay an accepted paste. Text input is handled
by the included
[text input component](../../src/modules/android/text-input.js), which keeps the
original Android input connection and native text interfaces. Its
[Java source](../../src/modules/android/text-input/java/maclauncher/android/framework/HostTextInput.java)
and MIT license are included with its JAR.

By default, the WASD keys control a virtual touch joystick. The per-game
**Keyboard touch joystick** setting selects WASD, arrow keys, both, or Off, and
the joystick's center and radius can be configured. Meanwhile, the mouse stays
an independent touch for buttons and other controls. Mapping pauses while an
Android text editor is active.

For games that read motion sensors, **Manual tilt** provides virtual sensors
that are controlled from the keyboard or a controller. In keyboard mode, Q and E
tilt left and right and R recenters; Option + arrow keys also tilt, and
Option + 0 recenters. A controller uses its right stick instead. Movement keys
stay separate, and Cmd and Control shortcuts pass through. While an Android text
editor is active, it receives the typing keys, and keyboard game controls are
suspended. With manual tilt off, Q, E and R keep their ordinary game behavior.

#### Graphics

Android output is shown by a single presenter, which handles Canvas, GLES and
native SurfaceView output for the whole life of an Activity. Canvas uploads
reuse a fixed-size image pool, while native surfaces submit GPU textures and
synchronization events. SurfaceControl ordering and transforms place Android
controls over native game frames, and an unchanged overlay needs neither
another upload nor another composition pass. Composition keeps the texture
origin of the game's native rendering and maps the Android Canvas's top-left
coordinates into it, including when the render and layout extents differ. For
planar video, conversion keeps the source's row and column order in the shared
Metal texture, and Android's original consumer keeps its texture transforms and
display rotation.

Under ART, SurfaceFlinger starts alongside its hardware composer. Original
Binder clients wait for their dependencies, and both services register before
the application window is registered with the launcher. To check that the
services are ready, native queries use the original Binder service manager in a
small process with no window, audio or resolver dependencies. The publication of
the composer and of SurfaceFlinger is awaited together, and both original
service lifetimes are observed before the window is registered.

OpenGL ES is provided through ANGLE in both engines, and both store ANGLE's
serialized shaders and programs in the same native cache format. Application
caches stay inside each application's storage, while ART's immutable native
services share one native cache for the launcher. Binaries for different drivers
and macOS versions are kept apart in the cache, and a cache miss uses the
original compiler.

**Settings → Android** sets the default **OpenGL ES backend** and **Vulkan
implementation**. Each game's runtime settings can override them, and changes
take effect on the next launch. ANGLE uses Metal by default, and the backend
list shows the backends included in the installed Android runtime. **Vulkan
implementation** appears when the OpenGL ES backend is Vulkan, and that backend
then uses the same Vulkan implementation as native Vulkan apps. Backend,
joystick and account fields that are hidden keep their saved values.

Some APKs require a newer OpenGL ES version than the default Metal provider
supports. For these, launch selects ANGLE's Vulkan backend through an installed
Vulkan implementation, and native execution uses MoltenVK for its shared Android
buffers. A saved backend choice takes precedence over this automatic selection.
The automatic selection only provides OpenGL ES; it does not turn on an
application's native Vulkan rendering mode. The reported OpenGL ES version,
including the minor version, comes from context creation on the selected
backend. GLES and EGL symbols resolve within the selected ANGLE libraries and
their procedure table, and desktop OpenGL libraries never provide Android entry
points. With native execution, Vulkan OpenGL ES shared buffers and planar video
images require MoltenVK's Metal texture attachment interface. The Android
compositor stays on Metal while application contexts use the selected OpenGL ES
backend.

Apps that render with Vulkan themselves use the selected MoltenVK or
KosmicKrisp library. Their Android window surfaces map to Metal surfaces on the
same native window, and the driver handles swapchain creation, image acquisition
and presentation synchronization. The driver's Metal textures then enter the
shared presenter along with Android controls and graphics effects.
PackageManager reports the Vulkan version and hardware level of the same
selected physical device. These hardware levels follow Android's required
Vulkan feature sets, and in both engines, feature enumeration and version checks
read the same capability data.

Android frames go through the same [graphics chain](../graphics/README.md) as
other runtimes, with ReShade effects, spatial scaling and LSFG settings in the
game inspector. An optional resolution multiplier lowers the render target while
keeping the window or fullscreen output size. At 2×, for example, a 1920 × 1080
output uses a 960 × 540 source, and Android layout and touch coordinates follow
that source size. The multiplier's Auto setting keeps the application's
requested render resolution.

Apps that copy their own frames use PixelCopy, which keeps the original
Surface, SurfaceView, Window, region and request APIs. An explicit request
copies the app's own native surface to a mutable bitmap, with scaling and an
asynchronous result. Ordinary presentation, by contrast, never reads frames back
to the CPU.

Android records frame-time history for every run, including normal launches
without a profiler. For each surface, the records separate the source,
accepted, actually presented and generated frame rates, and they include
frame-interval percentiles, submission time, queue occupancy and render and
output dimensions. The counters use the existing presentation calls and need
no GPU readback or waits for completion. The history is kept in two rolling
files in the app's private storage, which hold at most 256 KiB across a quit or
crash.

Display callbacks, window buffers and native frame sources live as long as the
objects that own them. When an Activity pauses, stops or is destroyed, its
surface stays available while rendering callbacks finish, and only then do the
display and presentation shut down. On the native window thread, waits in
Android's message queue also dispatch AppKit events.

#### Audio, video and capture

AudioTrack accepts PCM writes as bytes, shorts, floats and direct buffers, with
static buffers, looping, playback position and rate conversion, and CoreAudio
handles the actual output route. Android stream volume and mute controls apply
software gain inside the application, so the Mac's system volume stays
unchanged. Route-change callbacks update Android's existing device cache.

MediaPlayer reads and decodes the selected source either on its calling thread
or on an asynchronous worker. Each player has its own operation lock, and reset
and release cancel that player's work. Prepared next-player transitions,
completion listeners, pause, restart, looping and stereo balance all use the
same native audio path. File-descriptor ranges stay open as long as their
source.

MediaExtractor provides tracks, formats and compressed samples read through
AVFoundation, from local paths, file-descriptor ranges and MediaDataSource
callbacks. Under the JVM, MediaCodec then decodes H.264 and H.265 with
VideoToolbox and VP8 and VP9 profile 0 with libvpx. Both decoders support
synchronous buffers, asynchronous callbacks, format changes, end-of-stream
draining and Surface presentation. Software VP8 and VP9 decoding produces NV12
frames up to 4096 × 2304, and Android's original capability APIs report these
dimensions, the software decoding and the supported profiles.

Capture is controlled by the per-game **Audio input** and **OBS camera**
settings, which default to Off. Play requests macOS permission for the selected
devices, and capture begins once the application starts recording or a camera
preview. Video comes from OBS Virtual Camera, while audio comes from the
separately selected input. The capture adapters provide PCM16 mono or stereo
AudioRecord data and legacy NV21 camera callbacks.

Captured audio passes through a preallocated, fixed-size FIFO, which has a
single CoreAudio writer and serialized Android readers. The callback publishes
available frames without taking a reader lock. When the FIFO is full, it keeps
the frames already queued and discards the incoming excess. Before capture shuts
down, pause, flush and close wake any blocked reads.

#### Power, alarms and location

To apps, power queries describe a fully charged Android device on AC power, with
battery saver off and nominal thermal status. Wake locks keep Android's token
and callback handling within the app, but they do not prevent Mac sleep or
reset its idle timer. When the Mac sleeps, the current Activity is paused, and
waking resumes it if it still exists. Alarms deliver callbacks and pending
intents through the running application's Android queue, and JobScheduler runs
application-lifetime jobs on that same queue, including namespaces,
cancellation, delayed and periodic requests, completion and retry backoff.

No location is set at first. When an application requests one, a sheet asks for
a latitude and longitude: **Share** passes those coordinates to the application
as a mock location for that session, and **Cancel** passes none. The
coordinates are not saved between launches. Permission and AppOps queries use
the same device and location state, without requesting access on their own.

#### Google services

MacLauncher Android provides Google integration through microG. Each game's
inspector and Settings offer three choices for it:

| Selection | Behavior |
| --- | --- |
| **No microG** | **Use microG** is unchecked, and Google service packages are disabled for the game |
| **microG without an account** | **Use microG** is checked, and the account selector keeps its anonymous entry |
| **microG with an account** | **Use microG** is checked, and a shared account is selected |

Google integration is off by default, and turning it on neither signs in nor
chooses an account. The shared accounts are managed in
**Settings → Android → Google accounts**, and each game's options then choose
which account, if any, the game sees. Network access is a separate per-game
setting. All three settings (network access, Google integration and account
selection) take effect when the game starts, so changing them while the game
runs requires a restart. Turning off Google integration keeps the shared
accounts and other games' selections. Applications with Google integration share
one Android account service; anonymous mode keeps Google accounts hidden but
uses the same service and process boundary.

Accounts are held by one original AccountManagerService, which keeps the
launcher's account database and authenticator sessions. Authenticators keep
their verified package identities and run in separate processes. Listing
accounts reads installed files and does not authorize network requests. Signing
in from Settings or External opens the same native Google account window.
External then uses the exchanged authorization directly for Google Play. In
Settings, the result is instead registered with microG through the original
AccountManager APIs, under microG's verified package identity. Neither a game
nor a background provider request can open interactive Google sign-in by
itself, even when no account is selected.

Settings sign-in downloads the account runtime, Java and microG packages when
they are missing. The microG Services and Companion APKs come from the newest
[microG GmsCore release](https://github.com/microg/GmsCore/releases) that
offers both, and microG names each APK `<package>-<versionCode>.apk`. A
downloaded APK must be signed with microG's certificate, have the package name
and version code that its file name gives, and match the SHA-256 that GitHub
publishes when there is one. The installation records each file's SHA-256 and
keeps working offline.
[Storage upkeep](../development/DATA_MODEL.md#derived-data-upkeep) keeps the
selected microG release and every release whose APKs are still installed, and
it removes other recognized releases while the launcher is idle.

For recognized microG Services and Companion packages, Google integration
exposes the provider's declared compatibility certificate to Google client
libraries. Signature permissions and account-data access, however, still use
the actual verified publisher and signing lineage. Google certification, Play
Integrity and store entitlements remain under the publisher's control.

The account service, KeyStore and the other shared Android system services run
under one common process broker. Each service role has a kernel lock.
Controllers authenticate and keep a reference to each service they use, and
service processes that are no longer used are retired. Games receive only the
public Binder listener, while account and KeyStore databases, controller
capabilities and process-registration sockets stay outside game-readable
storage. KeyStore reports software security and stores opaque keys through the
original software KeyMint.

#### Installed services

Installed service APKs, such as microG, go through the same signature checks,
preparation and private storage as games. Each one gets its UID and signing
lineage from a persistent package identity. Their components start on demand in
the processes that their manifests declare, and they use the original
ActivityThread, LoadedApk, AIDL and content-provider dispatch. While graphics
and package records initialize, activity startup requests the shared Settings
process. Provider acquisition waits for the provider's authenticated directory
through the original Android content-provider path.

Inside an application, ActivityManager clients keep their local context through
receiver cleanup, while shared UID observation goes through the authenticated
shared system service. Running-service queries return snapshots of the services
that processes currently run, including start and binding state, foreground
status and Android process identity. An application provider that cannot start
returns Android's unavailable-provider result, and its process lifetime is
separate from the local ActivityManager. Service lifecycle records keep a
limited set of process outcomes, initialization phases and failure codes, but
they exclude raw account-process output and account values.

#### Network, ads and web content

**Network access** works through the shared game setting and the
[process-level network policy](../runtimes/NETWORK_ISOLATION.md). With access
on, the game can make connections, bind local sockets and accept incoming
traffic. With access off, IP and DNS traffic is blocked for the game and its
child processes, and Android reports no usable route. Authenticated process
grants keep service traffic within the requesting application's policy, and
private Unix sockets stay available for runtime services.

To report connectivity, MacLauncher Android observes macOS routes without
sending a network probe. A dedicated native queue collects route, interface and
DNS facts into copied snapshots, and Android's network service consumes matching
revisions of them without running host configuration queries on the system
looper. Metering follows the route cost, and macOS Low Data Mode is reported
separately.

Traffic accounting is mocked: device, interface and per-UID byte and packet
counters stay at zero, and usage queries return empty summaries and histories.
Accounting reads no Mac network counters or traffic from other applications.
Socket tagging and untagging succeed without changing or closing the
application's socket.

Under ART, apps use Android's original DNS resolver with the Mac's configured
DNS servers. Its native service keeps per-application ownership of route-probe
sockets through Android's `CAP_CHOWN`, and these guest capabilities are separate
from Mac credentials and application processes.

By default, known advertising and tracking destinations are filtered. The
filter's shared host list covers native and Java DNS, embedded WebView requests
and external browser links. Blocked WebView navigation stays blank, and blocked
external links produce no prompt. **Allow ads** in **Settings → Android** sets
the Android default, each game's runtime settings can override it, and changes
apply on the next launch. Allowing ads turns the filter off for the session,
including rewarded-ad connections. The filter works independently of network
isolation and leaves application SDKs and rewards alone, while direct-IP traffic
and content served from a game's own shared host follow the ordinary network
setting.

Before an external HTTP or HTTPS link opens, it needs confirmation with **Open
Browser**, which is shown beside the requesting game window. Canceling is the
default, and closing the game removes its prompt. Approving a link grants no Mac
file or application-launch permissions. A valid browser intent is still handled
when confirmation is declined, network access is off or the browser request
channel has closed: in those cases no browser window opens, but the application
receives no activity-not-found error.

WebView is implemented with an embedded WebKit view in the existing game window.
Cookies and website storage belong to the application session and are discarded
when it ends, and cookie reads use the current WebKit cookie store, including
changes made by page scripts. Android keeps navigation callbacks, text input and
Canvas composition. Page rendering follows Android view visibility, so covering
the Mac window does not pause a visible WebView's animations. Document
dimensions are separate from the captured viewport, and text zoom changes text
layout independently of page zoom and display density. For editing, Android's
original input connection handles text replacement, composing spans, selection
and surrounding-text queries, and the document editor receives the resulting
UTF-16 ranges. Copy and paste follow explicit clipboard actions.

#### Sandbox

Every app runs inside a mandatory macOS file sandbox, which covers Java, native
code and child processes. The sandbox permits the application's container,
read-only runtime artifacts, the selected service packages and required system
resources. The application gets private home and temporary directories, and no
filesystem proxy or virtual machine is involved. Installed service APKs can be
read through the package catalog, but their writable application data stays
private. Native text editing uses the macOS completion and spelling services
under the same file and network policy.

#### Diagnostics

Runtime diagnostics are written to the game's `runtime.log`. Within 32 KiB, the
log keeps the first Java or native failure and recent shutdown details,
including fatal reports that are followed by an application exit code of zero.
While messages arrive, the log is updated at most once per second, and it is
updated once more at exit. The running indicator clears when the process exits,
and an older process cannot replace a newer launch's diagnostics. After a
requested Stop, earlier diagnostics stay in the log, and an ordinary SIGTERM or
Java shutdown status 143 is not treated as a new failure. Fatal runtime reports
and crash signals during shutdown, however, still count as failures.

Both engines send Android native logs to the same physical log destination,
independently of the application's standard streams. An app can therefore
redirect or close stdout and stderr while Android log callbacks keep writing to
that destination.

When they are turned on, native ANGLE shader diagnostics report failed shader
compilation and program linking, with a limited amount of compiler output. The
original GL error state and the application's debug callback stay with the
game, and ordinary rendering still calls ANGLE entry points directly.

The [native host reference](../../src/modules/android/native/README.md)
documents build inputs, generated bindings and low-level platform mappings.
[Upstream sources](../runtimes/UPSTREAMS.md) and
[attributions](../ATTRIBUTIONS.md) record the exact upstream sources and their
licenses.

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

From Robolectric, MacLauncher Android takes only the framework and native
artifacts; Robolectric's test runner, shadows and simulated service environment
are not part of the game runtime. Klepton and the upstream native
implementations share the same graphics, audio, storage and process services,
while the JDK owns the Java boot classes and the JVM's memory and thread
lifecycle.

Each Android process or thread ID is reserved by a POSIX `fcntl` write lock on
its own numbered lease file, and the IDs of ended processes and threads are
reused before higher IDs are allocated. Releasing an ID closes its lease
descriptor; when a process exits, macOS releases any lease locks that the
process still holds.

Shared JVM launch options expose the JDK collection delegates and monitor fields
that Android's desugared Java library wrappers use, so those wrappers keep the
original collection contents and synchronization behavior. When an application
looks up a system class, the JVM checks the host class path first and then
delegates to the APK's current defining loader. Original JDK logging handlers,
resource enumeration and service providers use that same application
definition, while instrumentation agents stay on the host class path. Dex-load
reports go to Android's original dex manager and usage records, which are
stored with the installation.

Messages to the process authority and descriptor transfers share each process's
channel queue. Closing a channel rejects its pending transfers, while other
processes keep their own service registrations and held resources.

For both engines, launch preparation runs installed-package preparation in
parallel with display metadata and graphics setup. If a launch fails, it waits
for pending preparation before it releases its hold on the package.

Both engines use the same private application data, and an app can reach the
same file through more than one path. Android storage aliases and retained
absolute paths inside that data resolve to the same files, including nested
expansion, cache and media directories, in both Android private paths and
retained physical application paths. Other applications' data and the host's
parent directories stay outside the app's namespace.

Under the JVM, native memory maps use `/data/app/<package>/lib/<instruction-set>`
names, while native loading resolves the original immutable files. Ordinary
`File` metadata, directory operations and stream opens use the same aliases at
the native filesystem boundary, and JDK files and descriptors keep their
original I/O behavior. In JVM processes, Java and native libc also receive the
same scoped Android partition and storage environment. NIO file metadata and
ownership changes use the same Android UID and GID mapping as libcore, while
files on the Mac keep their original ownership. Android's original
`SystemCleaner` delegates to the JDK's shared cleaner through the same JVM
configuration, so a single cleaner handles resource cleanup.

The NDK asset and configuration functions share Java's original AssetManager.
Prepared loose assets and expansion-file slices reach Android's AssetsProvider
as owned file descriptors and byte ranges. Android's original asset code then
handles reading, seeking, mappings and duplicated descriptors, and generated NDK
declarations connect ARM32 callers to the same implementation.

### Mac.apk

[Mac.apk](https://github.com/kksimp/Mac.apk) is an alternative runtime for ARM64
Android apps, with optional Google sign-in. Its versions are the publisher's own
releases. When a release is installed, MacLauncher reads its macOS requirement
from the downloaded app's `LSMinimumSystemVersion` and finds the runtime
wherever the download places the app.

For Mac.apk, MacLauncher uses its own small Java libraries (JAR files) for
launch arguments, policy, text input and account control. They come from the
`android-launcher` package, which is built on GitHub with a signed build
attestation and included in the app. The app records which release of this
package it includes, together with the package's checksum.

To check APK signatures, MacLauncher uses Android's apksig verifier as its
publisher distributes it. The verifier is stored in the app as an ordinary
file, and Java runs it from there, so inspecting a package does not copy it
into launcher data.

Mac.apk has a **Graphics backend** setting with the choices **Automatic**,
**Metal** and **Vulkan (MoltenVK)**, and each game keeps its own selection.

Network access is off by default, and turning on **Network access** takes
effect at the game's next launch. Mac.apk's shared-volume migration, Mac folder
mapping and Now Playing integration stay disabled, and Android files remain in
the game's private provider directory. Launches without network access also do
not run App Links network verification.

Google integration is likewise off for each game until it is turned on. A game
with integration on can then use anonymous services or one selected account.
Network access remains a separate choice, although authentication requests
require it. In the Mac.apk account panel, **Sign in in browser** opens the
shared Google browser window and registers the result through Mac.apk's
supported account bridge. Before any account access, the game's signed package
identity is verified. Games then receive the selected account information and
the authorization tokens they request, while the account credential store stays
outside the game's file access.

Mac.apk application windows and Dock entries use the game's name.

### AIM

[AIM](https://github.com/hahnlee/aim) runs applications with Android services
and original ART, without booting a Linux kernel or a virtual machine. It
requires macOS 26.0 or later. MacLauncher builds AIM from an exact upstream
commit with its own adaptations, and MacLauncher Builds publishes the result as
the `android-aim` package. This package is built on GitHub with a signed build
attestation, and it is installed from Runtimes rather than included in the app.
Upstream AIM binaries cannot replace the adapted runtime.

Besides the AIM host, the package contains a small controller program.
MacLauncher starts each AIM application through the controller of the selected
runtime version, and Stop also goes through this controller.

AIM also needs a matching Android system image. This image is downloaded
separately under its publisher's terms and is not included in MacLauncher's app
or source archives. In **Runtimes → Downloads**, an image download stays
cancelable through checksum verification and preparation, and a downloaded image
is reused. Image preparations are shared across host versions that have
identical system-image and overlay inputs, so selecting another compatible host
keeps the existing image storage and application data.

Extraction and overlay writes require a mounted image volume. For this reason,
preparation moves aside any nonempty mount folder that is not a mounted volume
before it attaches an image. Volumes that are already mounted stay attached.
Storage upkeep later removes the folders that were moved aside, while the
launcher is idle, and keeps disk-image backing files and application data.

AIM applications run offline and without Google account integration. AIM also
behaves as follows:

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
- Stop requests shutdown through the controller that started the application,
  and the controller waits until AIM's resident process has finished its service
  and data cleanup. A failed shutdown is reported without detaching data from a
  live guest.

With MacLauncher's adapted builds, the Dock shows the game's name and icon, and
the display window uses the game's name. Icons are prepared by AIM's native
package resource reader, without a Java host.

### Files and host access in Mac.apk and AIM

Each Mac.apk or AIM game has a small macOS application entry, while runtime
libraries and Android images are shared across games. Its artwork comes from
the package's launcher resources where this is supported, and custom library
artwork takes precedence.

File access is limited to the installed packages, the selected runtime and the
provider's private application directories. Selecting a runtime grants no
access to the host clipboard, location, camera, microphone or accounts, and
provider integrations stay within the same limits. Plain-text clipboard transfer
uses explicit Android clipboard gestures, and native WebView editing has no
direct access to the Mac clipboard.

Each provider keeps its startup output and recent output, up to a fixed size, in
`runtime.log`, `runtime.log.head` and `runtime.log.previous`. When a runtime
exits unexpectedly, its error includes the available runtime details once the
output streams have finished draining.

The [architecture reference](android/ARCHITECTURE.md#macapk-and-aim) explains
how the providers are separated, and the
[native code reference](android/NATIVE_CODE.md#process-startup) covers
constructor arguments. Which runtimes are included in the app and which are
downloaded is set out in the
[distribution policy](../runtimes/RUNTIME_DISTRIBUTION.md).
