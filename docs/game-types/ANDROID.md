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
compiled resources are kept inside their APKs. Detection and the reading of an
app's name and icon take the uncompressed APKs of a package archive from where
they are stored. After their checksums are verified, each APK's temporary file
receives only the parts that are read: its archive directory and manifest, and
for the name and icon also its resource table and the files the table names. A
compressed APK, or one whose checks do not hold, is copied in full instead.

To inspect a package, MacLauncher reads the original binary manifest, resources
and archive directory without starting Java or running application code.
Localized names and icons come from the original base and split APKs through a
native resource reader included with MacLauncher, so this step needs no Android
or Java runtime either.

## Inspector tools

For Android games, the inspector groups its actions as **APK tools** (**Inspect Android
package**, **Decompile APK…**, **Decode APK** and **Reveal decompiled APK**),
**Files** (**Import files…**) and **Google Play** (**Add to Google Play
library**).

### Package inspection

**Inspect Android package** shows the package name, version, activity,
permissions, DEX and native architecture information for every supplied ABI.
Because it reads the local package, no Android game runtime needs to be
installed. The APK signature verifier is likewise included with MacLauncher and
does not depend on any runtime installation; when a check needs it, Java runs
the verifier from a verified file on disk.

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
license for the imported package and never requests a paid purchase. The action
needs network access, a selected account and a stopped game. A licensed reply
can describe an entitlement the account already has, although whether the app
is available still depends on Google Play, the package and the account.
Afterward, the account provider's preference for acquiring free apps
automatically is restored, even when the request was interrupted.

## Virtual device

Every runtime presents the same virtual device by default: a Pixel Tablet with a
2560 × 1600 pixel display at Android's 320 dpi logical density. This reference
display matches the
[Android Studio tablet profile recorded by Chromium](https://chromium.googlesource.com/chromium/src/tools/android/+/77d4c8dd8a136fa6ba61f403e1fb8da0e82935c5/avd/proto_creation/android_35_google_apis_tablet_x64.textpb).
On the Mac, the window first opens in landscape at 1280 × 800 points. Because
these values describe the virtual Android device, they stay the same across
runtimes and report nothing about the Mac's own hardware. Device branding is
generic Android, and the runtime profile records the Android API level and
native ABI. AIM also reports the tablet's SoC and density in place of the Mac's
hardware.

## Storage and saves

Each runtime keeps its own application data. MacLauncher Android stores it under
`~/Library/Application Support/maclauncher/android/apps/<gameId>/`, where
prepared code, application files, downloaded assets, caches, no-backup files and
temporary files each have their own location. Saves and downloaded assets are
therefore stored apart from prepared code. The runtime's two execution engines,
JVM and ART, use the same per-game data, so saves, preferences, databases and
downloaded assets stay available when the engine changes; only the generated
JVM and ART code is cached separately. The engines run a game one at a time in
its existing container.

Mac.apk and AIM keep their writable data in a folder of their own,
`~/Library/Application Support/maclauncher/android/apps/<gameId>/providers/<runtimeId>/`,
which holds the runtime's Android root, home, cache and temporary files. Shared
runtime binaries are kept apart from this application data.

Switching to another runtime keeps the existing application directories, but
their saves, downloaded assets and accounts are not imported into the new
runtime automatically.

## Settings

**Settings → Android** shows the options and accounts of the selected runtime,
and each game's runtime settings can override these defaults. Every field is
listed in the [settings reference](../runtimes/SETTINGS_REFERENCE.md#android).
MacLauncher Android and Mac.apk both have **Initial width** and **Initial
height** settings for the first window size, as well as a **Network access**
setting. AIM always runs offline. The remaining settings are described in the
runtime sections below.

## Google accounts

MacLauncher Android and Mac.apk can give games a Google account, and each keeps
its own account store for it; AIM has no account controls. **Settings →
Android** has an account panel for each of the two runtimes, and both panels
sign in through the browser by default. Each panel's account table scrolls, with
a refresh icon and **Sign in in browser** in its toolbar. Saved accounts appear
immediately, without starting an Android runtime. Refresh reads the account
provider (microG or Mac.apk) again, and the list also updates after sign-in and
account changes without the window being reopened. An account that the provider
already has can be selected without opening Android sign-in. **External →
Android** can use these provider accounts too, or a remembered browser sign-in,
again without starting Android.

Signing in opens a native Google account window, where Google itself handles
passwords and account challenges; closing the window cancels the attempt.
Launcher preferences record which accounts are selected, never passwords or
tokens. Remembering the browser authorization is optional, and a remembered
authorization is kept in the launcher's encrypted session storage. As a result,
**Use saved sign-in** can reuse it after a restart, even though the browser
window keeps its cookies only in memory. Removing an Android account also
disconnects a matching External selection and leaves the provider's other
accounts alone.

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
Android 16 Java framework and Android's native framework libraries. Its two
execution engines, JVM and ART, share the same framework, services and macOS
integration. The [architecture reference](android/ARCHITECTURE.md) describes
these components in detail.

#### Versions and downloads

MacLauncher Builds publishes the JVM and ART engines together in one Android
package, which is downloaded separately from the app. Because both engines use
the same installed package and shared native dependencies, Runtimes has a
single version selection for both. Otherwise,
[version selection](../runtimes/README.md#versions) and
[downloads](../runtimes/README.md#downloads-and-offline-use) work as for other
runtimes.

The JVM engine needs Java 21. It uses the Java 21 version set as the default
under Temurin in Runtimes when that version is installed, and otherwise the
newest installed Apple Silicon Java 21. If no Java 21 is installed at all, Play
offers to download that default or the newest listed Java 21 release.

The ART engine instead uses the package's ART components with the original
Android 16 system image, which is downloaded under the Android SDK license.
This image is stored once, in a case-sensitive, read-only system-image cache,
and a matching image already downloaded for AIM can be reused. The Android
package and writable application data are kept apart from the image. JVM
builds that require an original system image use the same shared cache and
download the image during Play or account setup.

**Runtimes → Tools → Android system images** lists the images published in the
Android SDK repositories after Refresh. Each image can be installed or removed,
and an installed version can be set as the default. A complete extracted image
root, or its system linker file, can be registered in its original location.
Required guest ELF files determine the image's CPU. Android absolute symlinks
are resolved within the guest image. A runtime uses a default or custom image
only when its complete content matches that runtime's required original image.
The Android image reader is managed separately in Tools and is acquired with
the image when the selected runtime does not already provide it.

Play reuses a compatible installed image without Refresh or another download
dialog. AIM lists the original image and its reader in the runtime download
consent, including the Android SDK terms.
Earlier automatic copies retire when unused; explicit installations, defaults,
custom roots and images in use remain protected. Image storage is shared with
the existing read-only cache rather than copied into another runtime folder.

Before the application's mounts are attached, the runtime prepares Android's
original linker configuration. Shared platform files stay read-only, and each
application's native code is confined to the same private storage as its Java
code.

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
version codes and signing lineages. The original signed APKs are installed as
separate files so that resources load in order: the base is named `base.apk`,
and each split's filename keeps its manifest split name. Packages prepared with
an earlier layout move to this one without their bytecode being converted
again.

Apps can also deliver features as separate split APKs. MacLauncher Android
accepts ordinary feature splits that declare activities, activity aliases,
services, providers and receivers. Inspection combines their launcher and
component metadata with the base application's defaults, and Android's original
package parser then registers the installed components. How a split's classes
load depends on whether the split is isolated. Non-isolated splits share the
application class loader, whereas isolated splits use Android's original
dependency loaders, so each feature inherits its declared parent and the base
classes while sibling features keep their classes and resources apart. Each
component's context stays with the split that declares it.

ARM64 native libraries are preferred, but a runtime that contains the ARM32
execution component selects `armeabi-v7a` or `armeabi` libraries when
appropriate. Dynarmic translates their ARM32 instructions into ARM64 code, which
reaches the same Klepton native services through adapters between 32-bit and
64-bit interfaces, while the JVM and AOSP framework stay 64-bit. The
[ARM32 component reference](../../src/modules/android/native/arm32/README.md)
describes the instruction, ELF and JNI boundaries.

For the JVM engine, DEX code is converted to Java classes, and all of the
engine's DEX preparation shares one conversion session. Android's original
application and split loaders load the converted classes over the complete
executable framework, and Android's original DEX loaders keep their class
delegation, resource lookup and added paths. When isolated APKs define the same
class separately, each APK keeps its own code through the original per-APK
conversion path. DEX code that an app loads at run time goes through the same
converter and JVM. Packages that declare `hasCode=false`, such as resource-only
packages and framework NativeActivity applications, need no DEX conversion.

Shared libraries and compatibility settings also come from Android's own code.
Platform shared-library declarations are read from Android's original
SystemConfig, and Android's original package compatibility rules fill in the
package state and ApplicationInfo. The compatibility service is already
available during package inspection, and application callbacks use the parsed
target SDK. Both engines use LoadedApk's canonical shared-library loaders,
dependency graph and ordering around application classes.

Assets of up to 64 KiB are decoded in memory within a fixed size limit and
written to disk asynchronously, while larger assets and libraries are streamed
to disk.

Prepared results are cached under a key made from the APK contents, the
converter's content hash and the framework class declarations. As long as those
declarations stay the same, converted classes are reused even when adapter
implementations change; a change to the declarations or to the converter's
inputs invalidates the matching cache entries. Archives of converted classes
can use ZIP64 directories. For preparation files that have not changed,
verified digests are reused across launcher processes. Every launch still
checks each file's device and inode numbers, size and mode along with its
nanosecond modification and change times, and any input that has changed is
read and verified again.

Only the current prepared version stays cached, although older versions are
kept until every process using them has released them. Installed APKs are
copied with filesystem copy-on-write where it is available, and each base or
split package keeps one canonical name. These installed archives supply
Android's resources and the signatures that identify the package. Launcher
workers take a shared kernel lock to select a prepared version, add a new one
or evict an old one, and active readers hold filesystem leases that keep their
files in place. Installed services keep the immutable prepared version they
selected, independently of the conversion cache.

Authenticated application processes read shared package metadata that points to
the canonical prepared files, and concurrent processes of the same package share
it. When the last of them exits, this temporary metadata and the converted-code
lookup built from it are removed. Metadata for installed services, by contrast,
is kept with the service installation. Repairs and changes to installed paths
write a separate version of the files, so running games and services keep
their original files, and path changes reuse converted content through
filesystem copies, with copy-on-write where it is available.

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
report coordinate ranges for the display size currently in effect. The size
actually rendered can differ, because it depends on how the native window fits
the screen and on Retina backing. When the window is resized or an app requests
a new orientation, the original VirtualDisplay keeps the device profile's
density, and Android keeps applying its density-compatibility policy for
applications. If the package's activity metadata declares a fixed orientation,
that orientation is applied before the Mac window first opens and before any
application callback runs. Both engines use the same orientation policy, and
later requests follow Android's window lifecycle.

The mouse acts as a finger: clicks and drags become touches, while captured
mouse movement keeps relative mouse behavior. Mouse wheels and trackpads scroll
in both directions. Apps that handle scrolling receive normal Android scroll
events, and touch-only content receives a continuous swipe instead, including
trackpad momentum. Acknowledgements for native input return asynchronously to
their Looper, even while a synchronization barrier for layout traversal is
pending. For native input and for the swipe that stands in for scrolling,
Android keeps each event's ID and completion callback.

Keyboard input and text composition go to the focused Android input connection,
including in embedded web content. Within Android, Cmd-A selects text and Cmd-X
cuts it. Cmd-C and Cmd-V transfer plain text between the foreground app and the
Mac clipboard, but only through that explicit shortcut; ordinary Android
clipboard access stays within the Android session. A transfer also requires the
app to be in the foreground and the shortcut to be pressed on the Mac keyboard,
and each key press allows one transfer. Under the JVM, the input bridge returns
clipboard replies asynchronously on Android's main queue, so layout traversal
barriers do not delay an accepted paste. Text input goes through the included
[text input component](../../src/modules/android/text-input.js), which keeps the
original Android input connection and native text interfaces. Its JAR is
compiled from the MacLauncher Android framework's
[HostTextInput source](https://github.com/procrastinine/maclauncher-android/blob/main/src/modules/android/native/java/maclauncher/android/framework/HostTextInput.java),
whose MIT license is included with it.

By default, the WASD keys control a virtual touch joystick. The per-game
**Keyboard touch joystick** setting selects WASD, arrow keys, both, or Off, and
the joystick's center and radius can be configured. The mouse meanwhile stays an
independent touch for buttons and other controls. Key mapping pauses while an
Android text editor is active.

For games that read motion sensors, **Manual tilt** provides virtual sensors
that are controlled from the keyboard or a controller. In keyboard mode, Q and E
tilt left and right and R recenters; Option + arrow keys also tilt, and
Option + 0 recenters. A controller uses its right stick instead. Movement keys
stay separate, and Cmd and Control shortcuts pass through. While an Android text
editor is active, it receives the typing keys, and keyboard game controls are
suspended. With manual tilt off, Q, E and R keep their ordinary game behavior.

#### Graphics

Everything an Activity draws reaches the Mac window through a single presenter,
which handles Canvas, GLES and native SurfaceView output for the whole life of
the Activity. Canvas output is uploaded through a fixed-size pool of reusable
images, while native surfaces submit GPU textures together with synchronization
events. Android's SurfaceControl ordering and transforms place Android controls
over native game frames, and an overlay that has not changed is neither
uploaded nor composited again. When the presenter combines these layers, it
keeps the texture origin of the game's native rendering and maps the Canvas's
top-left coordinates into it, even when the render size and layout size differ.
For planar video, conversion keeps the source's row and column order in the
shared Metal texture, and Android's original buffer consumer applies its own
texture transforms and display rotation.

Under ART, SurfaceFlinger starts together with its hardware composer. Original
Binder clients wait for these dependencies, and both services register before
the application window is registered with the launcher. Readiness is checked by
native queries through the original Binder service manager, which run in a
small process with no window, audio or resolver dependencies. The composer and
SurfaceFlinger are awaited in parallel, and the lifetimes of both original
services are watched before the window is registered.

Both engines provide OpenGL ES through ANGLE and store its serialized shaders
and programs in the same native cache format. Each application's cache stays in
that application's storage, while ART's immutable native services share one
native cache for the launcher. Binaries for different drivers and macOS
versions are kept apart in the cache, and on a cache miss the original compiler
runs.

**Settings → Android** sets the default **OpenGL ES backend** and **Vulkan
implementation**. Each game's runtime settings can override them, and changes
take effect on the next launch. ANGLE uses Metal by default, and the backend
list shows the backends included in the installed Android runtime. **Vulkan
implementation** appears when the OpenGL ES backend is Vulkan, because that
backend then uses the same Vulkan implementation as native Vulkan apps. Hidden
backend, joystick and account fields keep their saved values.

Some APKs require a newer OpenGL ES version than the default Metal backend
supports. For these, the launch selects ANGLE's Vulkan backend on an installed
Vulkan implementation, and native execution uses MoltenVK for its shared Android
buffers. A saved backend choice takes precedence over this automatic selection,
which only provides OpenGL ES and does not switch an application to its own
Vulkan rendering mode. The OpenGL ES version that an app sees, including the
minor version, comes from creating a context on the selected backend. GLES and
EGL symbols resolve within the selected ANGLE libraries and their procedure
table, and desktop OpenGL libraries never provide Android entry points. With
native execution, shared buffers and planar video images for OpenGL ES on
Vulkan require MoltenVK's Metal texture attachment interface. The Android
compositor itself stays on Metal while application contexts use the selected
OpenGL ES backend.

Apps that render with Vulkan themselves use the selected MoltenVK or
KosmicKrisp library. Their Android window surfaces map to Metal surfaces on the
same native window, and the driver handles swapchain creation, image acquisition
and presentation synchronization. The driver's Metal textures then join Android
controls and graphics effects in the shared presenter. PackageManager reports
the Vulkan version and hardware level of that same selected physical device.
These hardware levels follow Android's required Vulkan feature sets, and in both
engines, feature enumeration and version checks read the same capability data.

Android frames go through the same [graphics chain](../graphics/README.md) as
other runtimes, with ReShade effects, spatial scaling and LSFG settings in the
game inspector. An optional resolution multiplier lowers the render target while
keeping the window or fullscreen output size. At 2×, for example, a 1920 × 1080
output uses a 960 × 540 source, and Android layout and touch coordinates follow
that source size. The multiplier's Auto setting keeps the application's
requested render resolution.

Apps that copy their own frames use PixelCopy, with the original Surface,
SurfaceView, Window, region and request APIs. An explicit request copies the
app's own native surface to a mutable bitmap, with scaling and an asynchronous
result. Ordinary presentation never reads frames back to the CPU.

MacLauncher Android records frame-time history for every run, including normal
launches without a profiler. For each surface, the records separate the source,
accepted, actually presented and generated frame rates, and they include
frame-interval percentiles, submission time, queue occupancy and render and
output dimensions. Because the counters are taken from the existing
presentation calls, they need no GPU readback and no waits for completion. The
history is written to two rotating files in the app's private storage, which
together hold at most 256 KiB and survive a quit or crash.

Display callbacks, window buffers and native frame sources live as long as the
objects they belong to. When an Activity pauses, stops or is destroyed, its
surface stays available while rendering callbacks finish, and only then do the
display and presentation shut down. While the native window thread waits in
Android's message queue, it also dispatches AppKit events.

#### Audio, video and capture

AudioTrack accepts PCM writes as bytes, shorts, floats and direct buffers, with
static buffers, looping, playback position and rate conversion, and CoreAudio
plays the result on the Mac's current output device. Android stream volume and
mute controls apply software gain inside the application, so the Mac's system
volume stays unchanged. When the output device changes, Android's route-change
callbacks update its existing device cache.

MediaPlayer reads and decodes the selected source either on its calling thread
or on an asynchronous worker. Each player has its own operation lock, so reset
and release cancel only that player's work. Prepared next-player transitions,
completion listeners, pause, restart, looping and stereo balance all use the
same native audio path. A file-descriptor range stays open as long as the
source that reads it.

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
preview. Video comes from OBS Virtual Camera, and audio from the separately
selected input. Applications receive them as PCM16 mono or stereo AudioRecord
data and as legacy NV21 camera callbacks.

Captured audio passes through a preallocated, fixed-size FIFO with a single
CoreAudio writer and serialized Android readers. The CoreAudio callback makes
new frames available without taking a reader lock. When the FIFO is full, it
keeps the frames already queued and discards the incoming excess. Before
capture shuts down, pause, flush and close wake any blocked reads.

#### Power, alarms and location

To apps, power queries describe a fully charged Android device on AC power, with
battery saver off and nominal thermal status. Wake locks keep Android's token
and callback handling inside the app, but they neither prevent the Mac from
sleeping nor reset its idle timer. When the Mac sleeps, the current Activity is
paused, and waking resumes it if it still exists. Alarms deliver callbacks and
pending intents through the running application's Android queue. JobScheduler
runs application-lifetime jobs on the same queue, with namespaces,
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
chooses an account. Accounts are added and removed in
**Settings → Android → Google accounts**, where they are shared by all games,
and each game's options then choose which account, if any, the game sees.
Network access is a separate per-game setting. All three settings (network
access, Google integration and account selection) take effect when the game
starts, so changing them while the game runs requires a restart. Turning off
Google integration for one game keeps the shared accounts and other games'
selections. Applications with Google integration share one Android account
service, and anonymous mode hides Google accounts while using the same service
and process boundary.

All accounts are held by one original AccountManagerService, which keeps the
launcher's account database and authenticator sessions. Authenticators run in
separate processes, each under its verified package name and signature.
Listing accounts only reads installed files and authorizes no network
requests. Signing in from Settings or External opens the same native Google
account window, but the result is used differently: External uses the
exchanged authorization directly for Google Play, whereas Settings registers it
with microG through the original AccountManager APIs, acting as microG's
verified package. Neither a game nor a background provider request can open
interactive Google sign-in by itself, even when no account is selected.

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

For recognized microG Services and Companion packages, Google integration shows
Google client libraries the compatibility certificate that the package
declares. Signature permissions and account-data access, however, still check
the actual verified publisher and signing lineage, and Google certification,
Play Integrity and store entitlements remain under the publisher's control.

The account service, KeyStore and the other Android system services that games
share are started and supervised by one common process broker, and each service
role is guarded by its own kernel lock. A process that uses a service
authenticates first and holds a reference to it, and service processes that no
longer have users are retired. Games receive only the public Binder listener;
the account and KeyStore databases, the capabilities for controlling services
and the sockets for registering processes stay outside storage that games can
read. KeyStore reports software-level security and stores opaque keys through
the original software KeyMint.

#### Installed services

Installed service APKs, such as microG, go through the same signature checks,
preparation and private storage as games, and each keeps the UID and signing
lineage recorded for its package across launches. Their components start on
demand in the processes that their manifests declare and use the original
ActivityThread, LoadedApk, AIDL and content-provider dispatch. Activity startup
requests the shared Settings process while graphics and package records are
still initializing. Acquiring a content provider waits, through the original
Android content-provider path, for the provider's authenticated directory.

Inside an application, ActivityManager clients keep their local context through
receiver cleanup, while observation of shared UIDs goes through the
authenticated shared system service. Running-service queries return snapshots
of the services that processes currently run, including start and binding
state, foreground status and the Android process each one runs in. An
application provider that cannot start returns Android's unavailable-provider
result, and its process lifetime is separate from the local ActivityManager.
Service lifecycle records keep a limited set of process outcomes,
initialization phases and failure codes, and they leave out raw account-process
output and account values.

#### Network, ads and web content

**Network access** is the same per-game setting that other runtimes use, and
the [process-level network policy](../runtimes/NETWORK_ISOLATION.md) enforces
it. With access on, the game can make connections, bind local sockets and
accept incoming traffic. With access off, IP and DNS traffic is blocked for the
game and its child processes, and Android reports no usable route. When a
service handles a request for an application, an authenticated grant holds the
service's traffic to that application's policy, and private Unix sockets stay
available for runtime services.

To report connectivity, MacLauncher Android observes macOS routes without
sending a network probe. A dedicated native queue copies route, interface and
DNS information into snapshots, and Android's network service reads the
matching revisions without running host configuration queries on the system
looper. Whether a network counts as metered follows the macOS route's cost, and
macOS Low Data Mode is reported separately.

Traffic accounting is simulated: device, interface and per-UID byte and packet
counters stay at zero, and usage queries return empty summaries and histories.
Accounting reads no Mac network counters and no traffic from other
applications. Socket tagging and untagging succeed without changing or closing
the application's socket.

Under ART, apps use Android's original DNS resolver with the Mac's configured
DNS servers. The resolver's native service gives each application ownership of
its route-probe sockets through Android's `CAP_CHOWN`. That capability exists
only inside Android and is separate from Mac credentials and application
processes.

By default, known advertising and tracking destinations are filtered. One
shared host list applies to native and Java DNS, embedded WebView requests and
external browser links. Blocked WebView navigation stays blank, and blocked
external links produce no prompt. **Allow ads** in **Settings → Android** sets
the Android default, each game's runtime settings can override it, and changes
apply on the next launch. Allowing ads turns the filter off for the session,
including rewarded-ad connections. The filter works independently of network
isolation and leaves application SDKs and rewards alone, while direct-IP traffic
and content served from a game's own shared host follow the ordinary network
setting.

An external HTTP or HTTPS link opens only after confirmation with **Open
Browser**, which appears beside the game window that requested it. Canceling is
the default, and closing the game removes its prompt. Approving a link grants
no Mac file or application-launch permissions. When confirmation is declined,
network access is off or the channel for browser requests has closed, no
browser window opens, but a valid browser intent still counts as handled, so
the application receives no activity-not-found error.

WebView is implemented with an embedded WebKit view in the existing game window.
Cookies and website storage belong to the application session and are discarded
when it ends, and cookie reads use the current WebKit cookie store, including
changes made by page scripts. Navigation callbacks, text input and Canvas
composition stay with Android. Because page rendering follows Android view
visibility, covering the Mac window does not pause a visible WebView's
animations. Document dimensions are kept separate from the captured viewport,
and text zoom changes text layout independently of page zoom and display
density. For editing, Android's original input connection handles text
replacement, composing spans, selection and surrounding-text queries, and the
document editor receives the resulting UTF-16 ranges. Copy and paste follow
explicit clipboard actions.

#### Sandbox

Every app runs inside a mandatory macOS file sandbox, which covers Java, native
code and child processes. The sandbox allows access to the application's
container, read-only runtime files, the selected service packages and required
system resources. The application gets private home and temporary directories,
and no filesystem proxy or virtual machine is involved. Installed service APKs
can be read through the package catalog, but their writable application data
stays private. Native text editing uses the macOS completion and spelling
services under the same file and network policy.

#### Diagnostics

Runtime diagnostics are written to the game's `runtime.log`. Within 32 KiB, the
log keeps the first Java or native failure and recent shutdown details,
including fatal reports that are followed by an application exit code of zero.
While messages arrive, the log is updated at most once per second, and once
more at exit. The running indicator clears when the process exits, and an older
process cannot replace a newer launch's diagnostics. After a requested Stop,
earlier diagnostics stay in the log, and an ordinary SIGTERM or Java shutdown
status 143 is not treated as a new failure. Fatal runtime reports and crash
signals during shutdown, however, still count as failures.

Both engines write Android native logs to the same underlying log output,
independently of the application's standard streams. An app can therefore
redirect or close stdout and stderr while Android log callbacks keep writing to
the log.

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
while the JDK provides the Java boot classes and manages the JVM's memory and
thread lifecycle.

Each Android process or thread ID is reserved by a POSIX `fcntl` write lock on
its own numbered lease file, and the IDs of ended processes and threads are
reused before higher IDs are allocated. Releasing an ID closes its lease
descriptor, and when a process exits, macOS releases any lease locks that the
process still holds.

Shared JVM launch options expose the JDK collection delegates and monitor
fields that Android's desugared Java library wrappers use, so those wrappers
keep the original collection contents and synchronization behavior. When an
application looks up a system class, the JVM checks the host class path first
and then delegates to the APK's current defining loader. Original JDK logging
handlers, resource enumeration and service providers follow the same lookup,
while instrumentation agents stay on the host class path. Dex-load reports go
to Android's original dex manager and usage records, which are stored with the
installation.

Each process reaches the process authority, the launcher's supervisor that
authenticates every Android process, over its own channel, and its messages and
descriptor transfers share that channel's queue. Closing a channel rejects its
pending transfers, while other processes keep their own service registrations
and held resources.

In both engines, a launch prepares installed packages in parallel with display
metadata and graphics setup. If the launch fails, it waits for any pending
preparation before it releases its hold on the package.

Both engines use the same private application data, and an app can reach the
same file through more than one path. Android storage aliases and absolute
paths saved inside that data resolve to the same files, including nested
expansion, cache and media directories, whether a path uses Android's private
form or the real Mac location of the application's data. Other applications'
data and the host's parent directories stay outside the app's namespace.

Under the JVM, memory maps of native libraries carry
`/data/app/<package>/lib/<instruction-set>` names, while the native loader opens
the original immutable files. Ordinary `File` metadata, directory operations
and stream opens use the same aliases at the native filesystem boundary, and JDK
files and descriptors keep their original I/O behavior. In JVM processes, Java
and native libc also receive the same scoped Android partition and storage
environment. NIO file metadata and ownership changes use the same Android UID
and GID mapping as libcore, while files on the Mac keep their original
ownership. Android's original `SystemCleaner` delegates to the JDK's shared
cleaner through the same JVM configuration, so a single cleaner handles
resource cleanup.

The NDK asset and configuration functions share Java's original AssetManager.
Prepared loose assets and slices of expansion files reach Android's
AssetsProvider as file descriptors that it takes over, together with byte
ranges. Android's original asset code then handles reading, seeking, mappings
and duplicated descriptors, and generated NDK declarations connect ARM32
callers to the same implementation.

### Mac.apk

[Mac.apk](https://github.com/kksimp/Mac.apk) is an alternative runtime for ARM64
Android apps, with optional Google sign-in. Its versions are the publisher's own
releases. When a release is installed, MacLauncher reads its macOS requirement
from the downloaded app's `LSMinimumSystemVersion` and finds the runtime
wherever the download places the app.

For Mac.apk, MacLauncher uses its own small Java libraries (JAR files) for
launch arguments, policy, text input and account control. They come from the
`android-launcher` package, which is built on GitHub with a signed record of the
build and is included in the app. The app records which release of this package
it includes, together with the package's checksum.

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
need it. In the Mac.apk account panel, **Sign in in browser** opens the shared
Google browser window and registers the result through Mac.apk's supported
account bridge. Before any account access, the game's package name and
signature are verified. Games then receive the selected account information and
the authorization tokens they request, while the account credential store stays
outside the game's file access.

Mac.apk application windows and Dock entries use the game's name.

### AIM

[AIM](https://github.com/hahnlee/aim) runs applications with Android services
and original ART, without booting a Linux kernel or a virtual machine, and it
requires macOS 26.0 or later. MacLauncher's adapted build of AIM starts from an
exact upstream commit, and MacLauncher Builds publishes it as the `android-aim`
package. The package is built on GitHub with a signed record of the build and
is installed from Runtimes instead of being included in the app. Upstream AIM
binaries cannot stand in for this adapted runtime.

Besides the AIM host, the package contains a small controller program.
MacLauncher starts each AIM application through the controller of the selected
runtime version, and Stop also goes through this controller.

AIM also needs a matching Android system image, which is downloaded separately
under its publisher's terms and is not included in MacLauncher's app or source
archives. In **Runtimes → Downloads**, an image download can be canceled until
checksum verification and preparation finish, and a downloaded image is reused.
A prepared image is shared by host versions with identical system-image and
overlay inputs, so selecting another compatible host keeps the existing image
storage and application data.

Extraction and overlay writes require a mounted image volume. For this reason,
preparation moves aside any nonempty mount folder that is not a mounted volume
before it attaches an image, while volumes that are already mounted stay
attached. Storage upkeep later removes the moved folders while the launcher is
idle, and it keeps disk-image backing files and application data.

AIM applications run offline and without Google account integration. AIM also
behaves as follows:

- Declared launcher components, including activity aliases, are kept.
- The display accepts client connections before its initial blank draw, and
  compiling graphics effects neither changes the normal rendering path nor
  delays display readiness.
- AIM waits for the Android user to unlock during initialization and
  installation, so configured Android screen-lock credentials are still
  required.
- An activity wait can finish while startup is still pending. MacLauncher
  reports that state and keeps the Android process running until it exits or
  Stop is selected. An actual activity launch error ends the launch and
  includes Android's original result.
- Shared-memory files are created in the application's temporary directory and
  unlinked after opening, and applications receive read-only descriptors.
- Native lock workers close through their controller and release their locks
  when that controller exits, independently of signals to Android process
  groups.
- Stop requests shutdown through the controller that started the application,
  and the controller waits until AIM's resident process has finished its
  service and data cleanup. If shutdown fails, the failure is reported and the
  data stays attached to the Android system that is still running.

With MacLauncher's adapted builds, the Dock shows the game's name and icon, and
the display window uses the game's name. AIM's native package resource reader
prepares the icons without a Java host.

### Files and host access in Mac.apk and AIM

Each Mac.apk or AIM game has a small macOS application entry, while runtime
libraries and Android images are shared across games. The entry's artwork comes
from the package's launcher resources where this is supported, and custom
library artwork takes precedence.

File access is limited to the installed packages, the selected runtime and the
runtime's private application directories for the game. Selecting a runtime
grants no access to the host clipboard, location, camera, microphone or
accounts, and the runtimes' own integrations stay within the same limits.
Plain-text clipboard transfer uses explicit Android clipboard gestures, and
native WebView editing has no direct access to the Mac clipboard.

Each runtime keeps its startup output and recent output, up to a fixed size, in
`runtime.log`, `runtime.log.head` and `runtime.log.previous`. When a runtime
exits unexpectedly, its error includes the available runtime details once the
output streams have finished draining.

The [architecture reference](android/ARCHITECTURE.md#macapk-and-aim) explains
how these runtimes are kept separate, and the
[native code reference](android/NATIVE_CODE.md#process-startup) covers
constructor arguments. Which runtimes are included in the app and which are
downloaded is set out in the
[distribution policy](../runtimes/RUNTIME_DISTRIBUTION.md).
