# Android runtime architecture

MacLauncher Android runs Android applications on the Mac with one of two
execution engines. The JVM engine converts an application's DEX bytecode with
dex2jvm and runs the result on Java 21 together with the complete AOSP Java
framework. The ART engine instead keeps the original DEX and runs it on
Android's own runtime, with a matching Android framework and native system
image. Below the engine, both share the same application services and the same
macOS implementations of windows, graphics, audio, input, storage and
networking, and calls that arrive through Java, NDK or XR entry points reach
those same implementations.

This page describes the runtime's components and how they connect, and its last
section covers the optional Mac.apk and AIM runtimes. Native library loading,
the Bionic ABI, instruction adaptation and ARM32 execution are described in
[Android native code](NATIVE_CODE.md), and user-visible behavior and settings in
the [Android game type](../ANDROID.md) reference.

Terms used on this page:

- *Original* code is the unmodified upstream implementation, such as AOSP,
  Bionic or AIM, built from an exact upstream commit.
- *Guest* code is the Android code that runs under the adapters, such as
  application ELF libraries, Bionic and ART. The *host* is the macOS side.
  *Physical* resources are the real Mac windows, displays, threads, devices and
  process IDs behind Android's virtual ones.
- A *binding* is the adapter that connects the shared services to one engine, so
  there is a JVM binding and an ART binding.
- A *launcher profile* is one MacLauncher data folder.
- The *process authority* is a supervisor for each launcher profile. It
  authenticates every Android process and hands out the service capabilities
  that the process may use. Registering a process with it is called
  *enrollment*.
- *Profile services* are Android system services that run once per launcher
  profile and are shared by its applications, such as the account service,
  KeyStore and the shared system process.
- A *generation* is one published, immutable version of prepared files.
  Publishing a new generation leaves the files that running processes use
  unchanged.
- A *lease* is a held reference that keeps a shared resource, such as a prepared
  package, a service or a file, alive while it is in use.

## Components

| Component | Role | How it connects |
| --- | --- | --- |
| Uninstrumented Robolectric `android-all` | Executable AOSP framework classes and resources | All original classes, descriptors and portable implementations are present; only specific JVM and native dependencies are adapted to the platform |
| Robolectric native runtime and ICU data | Graphics, resources, text, database and other native implementations | Original JNI declarations and exported implementation tables |
| Java 21 | Bytecode execution, object identity, compilation and garbage collection | Android-specific JDK calls are adapted where Android and JDK representations differ |
| dex2jvm | Conversion of application DEX and dynamically loaded DEX | Uses the same framework hierarchy and JVM normalization as the host |
| ART and matching Android image | Original DEX execution, libcore and native Android object representations | AIM provides Linux and ELF execution; thin JNI and host-call bindings connect ART to the shared platform services |
| Klepton | ELF loading, ARM64 execution, Bionic ABI adaptation and XR integration | Shared native import dispatcher and JNI adapter |
| Dynarmic | ARM32 and Thumb execution | AAPCS32, pointer and record conversion into the shared ARM64 platform boundary |
| AOSP native modules | Binder, libcore, cryptography, media formats, fonts and portable algorithms | Original implementation units with Darwin adaptations maintained by MacLauncher |
| macOS and ANGLE | Windows, input, graphics execution, audio, devices and network transport | Native platform operations below Android's public APIs |

Only Robolectric's executable framework and native artifacts are used. Its test
runner, shadow dispatch, sandbox class loader and simulated services are not
part of the application runtime. When the framework is assembled, the complete
original Apache HTTP and StatsD implementation modules are added to it, with
their source groups selected from the original Blueprint files. Every class
comes from exactly one input: identical copies of a class are merged, and when
two inputs carry conflicting implementations, one of them has to be chosen
explicitly.

The framework also contains compile-time placeholders for optional Zstandard and
LZMA support. These remain declarations and are not executable platform classes,
so applications keep their complete compression SDKs and native libraries, and a
different implementation of those classes in the framework stays executable as
usual. The original Android framework classes and their API declarations all
remain present.

Most original implementations come from the framework and its compatible native
artifacts. Further portable components are built from complete upstream modules
together with everything they depend on, again with source groups selected by
the original `Android.bp` build files. The native package includes the Binder
RPC, KeyStore, libcore, Conscrypt/BoringSSL, media-format, NDK bitmap and alarm
implementations built this way, each alongside its macOS bindings.

Where an Android operation needs a real Mac resource, a platform adaptation
connects the two. The adaptation keeps the original API, the portable code
around that operation and the original public and private descriptors. A native
binding or a JVM call replacement changes the platform dependency of exactly one
method, without removing other methods or replacing the framework class around
it, and tests that run outside the runtime class loader check that the APIs and
method bodies are preserved. For ART, the platform delegates that are written
into the DEX at build time use dexlib2, so the original members, hidden-API
metadata and resources are kept. Likewise, the WebView provider factory
delegates to the shared WebKit provider, while Android's calling framework keeps
the original provider access and lifecycle checks.

Each component is built from source with its own incremental cache, separately
from any whole Android product build. The upstream source inventories record
where each component comes from and under which license; they do not restrict
which application classes or methods can run.

## Execution engines

One Android package contains both engines, their adapters and the shared host
services, and JVM is the default engine. Separate `android-art` installations
that already exist keep their original version choices and storage locations. In
Runtimes, the ART view lists those installations and the ART default, and it
names MacLauncher Android as the runtime whose downloads provide ART.

On the ART side,
[`art/package.mjs`](../../../src/modules/android/art/package.mjs) packages the
adapter's native libraries with their dependencies, together with its framework
and boot files, and
[`art/build-image-extractor.mjs`](../../../src/modules/android/art/build-image-extractor.mjs)
builds AIM's original image reader. The original SDK system image is never part
of the distributed Android package. It is downloaded from upstream, and
`system-image.js` verifies its archive and content checksums and keeps one
shared, immutable, case-sensitive and read-only copy under Application Support,
while application data stays private.

The ART components can include a boot image compiled by their matching
`dex2oat64`. AIM's original boot-image build step produces it from the complete
runtime boot class path, including the adapted framework, services and platform
delegates, and the built image is reused for as long as its compiler, ART
libraries, class-path bytes and image profiles stay the same. Each application
session maps the image and code files read-only, while its application data and
process identity stay private to that session. At startup, the runtime uses the
prebuilt image without running a compiler or reading the build inputs.

APK inspection, private installation, resource extraction and cache management
are the same for both engines. The engines differ in what happens to the DEX:
ART keeps and runs the original, so its preparation uses package metadata tools
without opening the converter libraries, and only the JVM engine locates and
runs dex2jvm.

The Java adapters that both engines use are kept in the native `java` source
group, and HotSpot-specific implementations are in `java-jvm`. The JVM build
compiles both groups. The ART build compiles the complete `java` group, with its own entry
sources, against the Android core declarations and then converts it to DEX. In
both cases, the full original Android framework and core libraries come from the
selected runtime.

The framework itself exists in two executable forms, a JAR for the JVM and DEX
for ART, and the two stay distinct. JVM portability adaptations are applied to
Java class files, whereas ART uses the matching Android DEX, services and boot
files. Packaging both engines together lets them share common files and native
dependencies while each keeps its own form of the framework.

## Application preparation

### Installation and caches

MacLauncher's backend prepares an application and then starts a separate Java
process to run it. The launcher's Electron renderer never runs application code
and never performs blocking conversion or native compilation. Prepared
application code is cached apart from persistent application data.

To inspect an APK, MacLauncher reads the declaration, namespace, resource-map
and character-data chunks of its binary XML using Android's resource layouts.
Character data stays within the element hierarchy and never replaces manifest
attributes or declarations. The launch labels, icons and activity window policy
found this way are cached, keyed by the verified APK contents, the ordered split
package set, the locale and the resource reader implementation. Moving the
original inputs, or replacing a prepared generation with an equivalent one,
therefore keeps those cached resources.

Prepared APKs, converted archives, extracted assets and Android native ELF files
can share verified, immutable content between preparations and between
applications, whereas original imports and writable application data always keep
their own storage. Compact hints point to candidate files that may match. Before anything
is shared, the exact content and file mode are verified while the package
preparation locks are held, and candidates that are busy or stale are skipped.
Mach-O libraries are not shared and keep separate files, so that their
loader-relative dependency resolution keeps working. When a retired preparation
is removed, files that another active preparation links to stay in place.

A new preparation generation copies its files with native copy-on-write through
the macOS system copy utility and falls back to ordinary copying on filesystems
that cannot clone; imports keep their own writable files. Each copy is first
written to a private location. Only after the original source file and the
complete APK hashes are verified is it moved into place, and existing files are
never replaced. Canceling removes copies that are still incomplete.

Prepared APKs keep the package's resources and split names, and native libraries
keep the executable modes they were installed with. Each generation of APK code
includes its execution format, whereas the installation and its private
application data keep the same storage across generations.

Profile services hold their installed APK generations through the same package
source manager that applications use. Installed packages that do not depend on
each other are prepared in parallel, up to a fixed limit, and each package has
its own preparation lock, UID and caller data scope. Process declarations stay
in catalog order. If a preparation fails, it waits for the work it started to
finish before it releases its source generations.

When the code of an application or of an optional service is missing, its
installation metadata is removed, but its UID and saved files are kept.
Discovery that runs at the same time keeps source generations that were just
published. Google service packages that are selected for a launch keep their
installation record and report the missing source files instead.

### Split APKs

Feature split APKs are parsed together with the base APK by Android's original
cluster parser, so the parse includes their activities, aliases, services,
providers and receivers. When the launcher inspects a package, it collects the
split declarations in Android's split-name order and applies the base
application's and the SDK's defaults to them. Application attributes in a split
do not replace the base defaults, and the definitive component metadata,
including the split that each component belongs to, comes from the original
parser. Signature, dependency and native-ABI validation covers the complete
package set.

For isolated splits, the base loader contains only the base APK, and the
original `LoadedApk` and `ApplicationLoaders` build the split dependency
hierarchy that the package declares. `ContextImpl` provides split resources and
component contexts. Initial Activities and local Services load through the
original split loader, and ActivityThread's split handling decides where
providers and receivers load.

### DEX conversion

For the JVM engine, DEX classes are converted when they are first needed.
Preparation indexes the complete DEX class set and records each class's source
APK and order, and the original AOSP DEX and package class loaders then request
converted class bytes as they load classes. These requests go to a resident
dex2jvm subprocess, which keeps its parsed DEX and constructor-resolution plan
from one request to the next and keeps the converter's dependencies out of the
game's JVM. DEX that the application loads dynamically goes through the same
path.

Converted bytes can be shared between loaders while each loader still defines
its own classes. When a later APK contains a duplicate class, that APK uses the
original per-APK converter so that the sibling definitions stay distinct.

Converted bytes are stored as immutable cache entries. An entry's key covers the
DEX, the converter, the framework hierarchy and the parent-loader types that the
conversion actually consulted, so changes to native implementations or to
installation paths do not invalidate it. Converter tools are identified by
hashes of their complete contents. The complete conversion metadata stays
available in its original ordered archive. When a parent lookup cannot be
resolved, the exact metadata class resource used as the fallback is recorded,
including an absent result. A change to any of the consulted resources
invalidates the affected conversion, whereas unrelated additions to the metadata
leave the cached class bytes valid. The on-demand indexes use the recorded
digest of the original ordered DEX, so repacking the ZIP does not invalidate
them either.

Newly converted class bytes go straight into a size-limited cache in the process
and can be used at once. Writing them to disk is left to a single background
writer, which publishes immutable archives and maintains the persistent storage.
Its queue refers to the existing cache entries instead of holding another copy
of the bytes. Class readers never wait for the writer's publication or for its
pruning lease, and the writer queues and artifact leases are also independent of
the lock on the byte-cache map, with files published and deleted outside that
lock. Bytes that are still waiting to be written count against the persistent
cache's byte budget, and while the writer is busy, it defers further cache
writes.

The converter also needs facts about each class's parent hierarchy. Classes
share these immutable facts in a snapshot until the converter asks for one the
snapshot does not have yet. Each snapshot has one context digest and is counted
against cache memory once, and the hierarchy encoding follows the class that
actually defines each type without holding on to loaders. During validation,
delegating parents that can change are resolved again, while the fixed boot and
framework parent reuses its verified snapshot. When the context digest changes,
persistent entries keep the facts and checksums they were written with, and the
writer's budget counts hierarchy metadata as well as class bytes. Cache
maintenance reads each entry's timestamp once and removes directories atomically
while it holds the shared mutation lease; the contents of those directories are
deleted after the lease is released.

### JVM class loading and memory

Archives that an earlier preparation converted completely in advance (eager
archives) remain usable. The original Android loaders handle resource lookup and
decide which loader defines a class, so separate loaders can share class bytes
while each defines its own classes. The original DEX loader hierarchy is
registered for HotSpot's parallel class loading, with a definition lock for each
class name. A cold conversion serializes only the converter protocol of its own
module, so lookups of classes that are already converted proceed independently.
Within one JVM session, successful class-header lookups through the immutable
platform loader share a size-limited memory cache, which is released at
shutdown, and delegating loaders and metadata fallbacks keep their normal
validation.

The JVM entry point accepts class names in Android's internal form as well as
primitive, reference and multidimensional array descriptors. An array's
component type is resolved through the original loader that requested it,
without initializing the class, and ordinary classes keep the original parent
and shared-library delegation order. The process and cache managers shut down
conversion workers and temporary inputs, protect live readers and limit how much
reusable cache storage is kept.

In converted code, a call to Android's `ClassLoader.getSystemClassLoader()`
returns the immutable Android platform loader, which carries the full framework
class path. As a result, the original module filters share only the application
classes that their own delegation rules select. System lookups by the host JDK
take a separate path: they reach application handlers, services, resources and
instrumentation through the JVM system loader.

Android's direct buffers are mapped onto the JVM's shared memory scopes. A byte
buffer and its slices, read-only views and typed views are revoked and reopened
together, while the original MediaCodec code still decides when buffers are
dequeued and released. The mapping keeps native addresses and the existing
allocators, and foreign-memory scopes that already exist keep their original
lifetime. Framework calls and converted DEX calls both go through the same NIO
portability boundary.

## Processes and identity

### Process authority

The process authority authenticates each process through the Unix sockets that
the process inherits when it starts and through its actual operating-system
process identity. The Android application UIDs it works with are separate from
macOS user credentials.

Android process and thread IDs come from a single native lease manager for the
whole launcher profile. It serves both engines and native libraries of either
width, and it also hands out the compact IDs that original 32-bit Bionic
synchronization uses. Physical macOS PIDs are kept separately and are used for
inherited-channel authentication, ancestry, signals, and deciding which process
a window or a clipboard request belongs to. The lease manager also keeps a
mapping of child processes, which excludes the current process and keeps a
child's IDs while it is a zombie, until it is reaped.

A lookup by physical PID goes through an index that leads to the same numeric
lease and checks the PID recorded in that lease against the live kernel lock;
the index stores no IDs or lifetimes of its own. Lease files keep stable numeric
names, so inode and lock reuse cannot race, and when a retired slot is reused,
its former index entry (its reverse name) is removed. Older live processes that
have no index entry can still be found by a directory lookup, which then adds
their reverse name.

When an application looks up processes and their commands, the native lease
manager asks the parent supervisor for a fresh kernel snapshot of the processes
that hold the same private namespace directory. It resolves those candidates
through the index, checks their live leases and reads the Android command
metadata from them, and when no snapshot is available, it falls back to a
complete lookup in the namespace. JVM, ART, application, account and
platform-service launches all use one inherited query-channel adapter for this,
and the child cannot choose another directory. Sandboxed applications gain no
permission to inspect host processes.

The file descriptor for a new ID lease is taken from the running VM's private
descriptor allocator before the lease is published or locked with POSIX locks.
That handle then stays the same until the lease is released, and the application
cannot close it by replacing descriptors. The JVM keeps control of its own
native descriptors.

Before an application receives its service capabilities, the authority records
both of its process IDs, the Android one and the physical one. Platform service
processes hold the system state and KeyStore state for the whole profile, while
installed application services keep their own package name, signing lineage and
data directories. Binder RPC carries the original AIDL interfaces, references
and descriptors between these processes, and each connection is closed by the
same process and transport that opened it.

During an incoming transaction, Binder reports the authenticated Android
caller's process and user IDs. Outside a transaction, and after
`clearCallingIdentity`, it reports the current process's own Android IDs, and
`restoreCallingIdentity` restores the saved caller through the original native
Binder token. Native Binder permission caching, debug process IDs and
transaction-error callbacks use the same Android IDs, whereas socket
authentication and the thread keys of native connections remain part of the host
transport. The Binder JNI library registers the CursorWindow parcel operations
after the original Parcel metadata has been initialized, and inline and mapped
windows both keep Android's original serialization format and descriptor
handling.

An enrollment stays pending for as long as its process and its authority channel
are alive. Closing the channel or ending the process cancels it, and no separate
initialization timer terminates a live application.

A launch reaches each profile service through a controller, which is a client
connection to the service's control socket. Each runtime package's manifest
declares the protocol version it uses to register processes, and a running
profile service keeps its protocol until its client leases close. As a result,
when an incompatible runtime is selected, running games keep their services, and
each service is replaced once nothing uses it. A controller keeps the service it
acquired through application preparation, before the process is enrolled.
Shutting a controller down waits for any process registration in progress, and
canceling stops registration before it moves on to another service. Queued
requests from a closed controller do not acquire package sources or create new
enrollments, and an enrollment that was already submitted to its service is
withdrawn before its source leases are released.

The manifest also declares whether the package supports late service
connections; older packages keep their bootstrap connection protocol. Both
engines start reading from the authority before they construct the application,
and losing the authority releases pending service requests without relying on
the application's Looper.

The profile's Android boot counter arrives in the first authenticated packet,
before the application or any content provider is constructed. Launch
supervisors and system-service supervisors access it through the same private
counter transaction and kernel lock, and restarting a process neither increments
the counter nor starts a service only to read metadata. Only the Android counter
travels over the authority channel, while the Mac's own boot identifier stays in
private launcher-profile storage.

During provider startup, diagnostics record the initialization stage and
exception type before the provider's authority descriptor is closed. These
records describe structure only, so exception messages and account values are
left out. Each request keeps the first final outcome of its connection,
including the service role and whether the connection was released, timed out or
closed by its peer. Every descriptor transfer has its own receipt pipe, on which
the receiver acknowledges the descriptors it received. Closing a receipt leaves
both the data connection it adopted and the parent authority stream intact,
because the receipt is responsible for neither.

### Profile services

A profile service starts when a process requests one of the endpoints it
declares. Asking which endpoints are declared, or listing the services, only
reads metadata and does not start the account service, KeyStore or the shared
system process. KeyStore's endpoint declarations are generated from the original
Rust and C++ code that registers its services, so they keep the original AIDL
descriptors. While a process uses a service, it holds its authenticated
connection and a controller lease; releasing them ends that enrollment, and the
supervisor can then stop a helper that is no longer used.

Under ART, composition keeps only the system services it actually uses. Its
Binder, presenter, linker and original graphics services initialize together
with the profile's system process, and the native window executable is loaded
while the system services initialize and reports its actual process ID. Grants
for its specific endpoints are made before the services report readiness, and
authenticated system credentials reach the window over the launcher pipe it
inherited only after readiness and process enrollment are complete.

Package catalog updates and leases on prepared sources are serialized by the
system kernel lock. The lock is taken through a holder that is released at
end-of-file on its pipe, so the holder is also released when the controller
exits. Acquiring or releasing a source lease starts no additional JavaScript VM.

While applications use a profile service, their lease keeps one verified Java
and native implementation of it in place. ART and JVM containers that use the
same common package share that service. For these shared services, ART selects
the verified common JVM package independently of its own additional execution
image, and this selection is identified by its complete file list and provider
catalog. A leased service can be neither replaced nor reused by a different
common package or process-registration protocol, so changing either requires the
applications that use it to close. An idle service shuts down under the
profile's kernel lock before its replacement opens any persistent data.

To recognize which JVM package a platform service came from, MacLauncher records
the verified common file inventory, the runtime profile (the package's runtime
ID, Java version and supported feature versions), the native architecture
requirements and the digests of the complete platform image and package catalog.
The image's content, paths, symlinks and modes are recorded when the package is
built. Assemblies that keep an explicit immutable image component reuse that
image's recorded digest, and catalogs keep their own content digest, so a launch
reads this metadata without hashing image files. ART execution versions are
identified separately, and changing only those ART additions reuses the same
platform process. A change to the common Java or native files, the runtime
profile or the location of the launcher adapter replaces an idle platform
service through its kernel lease, whereas active controllers keep the current
service until they shut down.

### Signals, scheduling and memory

In both engines, the shared isolation policy applies to signals that a process
sends to itself and to its children, and it also covers starting a child
suspended and reaping it. Java `Process` signal methods and native signal
imports resolve their targets through the same retained Android child leases
before a macOS process is signaled. AIM's namespace and terminal managers check
the process state as well as the kernel start time, so a child that has exited
and is waiting to be reaped no longer counts as live, and its terminal manager
can close the inherited output descriptors promptly.

Under the JVM, thread nice values map to Mach CPU precedence, both for the
current thread and for registered application threads. Java and native clients
read the same kernel priority, and a CPU nice request does not also apply
Darwin's background I/O throttling. ART uses AIM's Linux scheduling adapter
instead, which maps raised display and audio priorities to Darwin thread
scheduling and background policies to Darwin QoS. There, a change made by
another thread takes effect at the target thread's next system call.

Native process-memory vector operations resolve Android IDs through the same
live process leases and check them against the enrolled application before they
use Mach memory copies. An invalid buffer returns a native error without being
dereferenced in the adapter, and ranges that were completed keep their partial
byte count. When ARM32 code targets its own process, both local and remote byte
addresses go through the address-space manager. ART keeps AIM's original
process-memory system call implementation and its authenticated transport to
remote processes.

Under ART, the `smaps` and `smaps_rollup` views are built from VM-map data and
Darwin page counts. Resident usage follows the mapped pages, while proportional
and shared usage approximate Linux accounting from Darwin's VM-object
references, and reading another process's views keeps the original process
credential checks. Memory queries use each engine's native memory accounting
together with a shared ActivityManager threshold calculation, and the ART
process keeps its original Bionic system-information interface.

### Process shutdown

Under the JVM, process shutdown is handled by the native layer. Its shutdown
hook stops new Binder transports, drains the existing native sessions and
releases native service caches while Java callbacks are still available, and the
final VM event releases JNI metadata and prevents native threads from attaching
afterward. Original AOSP Binder objects keep their reference counting and
destructors.

Before creating the VM, a JVM process installs the standard JNI Invocation API
exit callback. HotSpot completes Java shutdown hooks, VM-death notifications and
VM cleanup first, and only then does the callback apply Android's process-exit
behavior; an exit callback that was already installed runs before it. Explicit
guest libc finalization is still performed by the original code, in the original
order. An explicit guest libc exit uses Bionic's original recursive exit
handling, which runs the calling thread's destructors before the global guest
destructors and then terminates with the requested status through `_exit`.

At shutdown, services, composition and the profile are each cleaned up even
when an earlier step fails, and the first failure is the one reported. After the authority channel reaches EOF, the process gets its usual
grace interval before it is shut down forcibly within a time limit. Prepared
inputs, session files and composition descriptors are kept until the process
confirms its exit. Under the JVM, Stop waits for the same shutdown sequence that
closing the window or exiting the process uses, including service and native
composition cleanup, and the backend stays available until that sequence
finishes.

Each renderer first drains its own surfaces and callbacks. The common
application manager then shuts down services, providers, broadcasts, network and
location observation, permission registrations, resources and context state, and
an ART startup that did not complete takes the same path. The original failure
remains the primary error, later cleanup failures are attached to it as
suppressed exceptions, and repeating the shutdown has no further effect. Native
composition and application processes share one termination manager, and
graphics publishers shut down concurrently. Session files and descriptors stay
available until the process exits, even after a forced termination. ART launch
contexts can observe the named shutdown stages through
`onRuntimeRetirementStage`; ordinary launches have no observer, and an observer
that fails does not change the cleanup result.

Each runtime session also keeps host-side files for its mounts, Binder state and
IPC beside the application's Android data directory. They lie outside the
application's data mount and play no part in initializing imported Android
files. When the runtime closes, these session files are removed after its native
processes and service leases have settled. The directories are removed
asynchronously, with a limited number of filesystem retries, because bookkeeping
for native socket inodes can still finish during removal.

## Application lifecycle

Both engines share the application bootstrap, the Activity lifecycle, context
services and the application job initializer, and initialization and shutdown go
through the original ActivityThread, LoadedApk and Instrumentation records.
Application services likewise have one initializer and lifetime manager for both
engines. Service registration and the job lifecycle are common code, and only
the window and audio services backed by the Mac come from each engine's typed
bindings.

The original process bind record, package context and services are published
before the APK's component factory initializes, and the factory's original
class-loader factory provides the loader for the Application and the initial
Activity. Both are constructed through the original Instrumentation, which
includes the APK's `AppComponentFactory`, the original exceptions and a single
application attachment. An Activity created by the factory keeps the resolved
Android component and its original `ActivityInfo` while it is attached.

Content providers are published before the original Application `onCreate`
callback, under the verified provider preference lease. The process each component
runs in is chosen from the parsed component metadata. The original
`ActivityThread` chooses each provider's context from its `ApplicationInfo`, and
it still creates a package context when an Application overrides the package
name it reports. Disabled components stay excluded through Android's component
state and enabled flags. When an Activity is attached or a local service request
is dispatched, the installed component's package, UID and process are used
rather than the package name that a Context reports, and remote service requests
carry the configured process principal as their caller. The original
`LoadedApk.AppComponentFactory` creates ordinary and job services with the
application loader, and a substituted class keeps its declared service name
during the original `Service.attach` and lifecycle callbacks.

Provider APKs that come with the runtime are indexed from their original
manifests. Providers that belong to the Android system shared user load lazily
in the shared system process, through the original package parser and the
ActivityThread provider lifecycle. When another thread acquires such a provider
synchronously and locally, it waits until the provider is attached on the main
thread. Concurrent requests share one installation, and a reentrant lookup by
the provider during its own startup reaches the same instance. Remote holders
keep Android's asynchronous publication callback and the original caller
permission checks. System-server services that are constructed lazily run their
constructors on their main Looper, even when the first request arrives on a
Binder worker, so provider construction and the Settings reads it makes along
the way stay on the original system thread.

### Activities and tasks

Both engines keep a single `HostActivity` task manager across navigation and
configuration relaunches. Closing the task shuts down its current Activity stack
on the manager's thread, and the output and display source stay available until
the original pause, stop and destroy callbacks have run. The initial Activity
and those reached by navigation are all destroyed through the original
`ActivityThread` path, which marks an Activity as finishing before those
callbacks. Task removal follows the original root-only and always-remove modes,
while an ordinary Activity finish keeps the remaining task records.

Once a local Activity launch is accepted, its queued handoff is kept until its
main-thread callback completes. A display turn between finishing a launcher
Activity and creating its successor therefore does not shut down the output they
share. Task-empty notifications also run only after queued Activity requests and
check the current task against the same window again, so a launcher Activity can
finish even before it starts its successor without shutting down the successor's
output. Up navigation goes through the same task manager and keeps the original
destination Intent, caller result and launch mode: a reusable parent receives a
new Intent, and a standard parent goes through ordinary Activity creation and
replacement.

When a service in another process is bound or an Activity is launched there, the
request waits on the destination's asynchronous readiness future until that
process is published, while the calling Android Looper keeps running. Original
Binder service callbacks report connection, null binding and process death.
Unbinding cancels pending and connected requests together, and a connection that
completes after cancellation is released at once. Process publication and
shutdown callbacks run outside the process-directory lock.

### Pending intents and broadcasts

PendingIntents reach the shared services through a single build-time binding,
`PendingIntentCalls`, which redirects the original PendingIntent service
destinations in class files and DEX to `HostPendingIntentDispatch`. Android's
original controller and record keep token identity, flags, options, result
handling and cancellation, and the shared activity, broadcast, service and alarm
managers receive the original call arguments. When the queue shuts down, it
cancels the original PendingIntent tokens before it withdraws the AlarmManager
that their controller uses, and an explicit application cleanup removes that
subscription.

Broadcasts from other processes are dispatched on the same reusable daemon
executor in both engines. The original `LoadedApk` and `ActivityThread` deliver
them to receivers, and the broadcast manager keeps result ordering and shuts its
executor down with the application.

### Compatibility changes

Original Android compatibility callbacks receive the complete generated change
configuration for the application's target SDK, and the platform compatibility
policy keeps the upstream SDK-dependent behavior for older and current
applications. The shared compatibility service reads its definitions through the
original Android configuration parser, either from the generated definitions
packaged for the JVM or from ART's matching system and active APEX definitions,
so both engines apply the same target-SDK and permission logic.

The original compatibility service is prepared before the package shared-library
policy runs, and its process-wide ApplicationSharedMemory instance is
initialized before configuration loading invalidates the original compatibility
cache. Shared nonce mappings, change notifications and read-only client
permissions keep their Android APIs. Binding the application then activates the
original package receiver and installs the compatibility callbacks for the
parsed target SDK.

## Platform services

### Packages and device features

Native code queries packages through the complete `IPackageManagerNative` Binder
interface, which reads the same parsed installations as `IPackageManager`. UID
names, target SDKs, versions, signing certificates, package flags, audio-capture
policy and hardware features therefore come from the same sources in both.
Module metadata comes from Android's configured resource. Runtime updates come
from MacLauncher and never create staged APEX sessions, and the endpoint keeps
ordinary observer registration and Binder cleanup.

Package queries and the original manifest parser also read named device features
from one source, so permissions that depend on a feature follow the same virtual
touchscreen, pointer input, audio output, orientations and RAM class that
applications see. Graphics versions come from the actual capabilities of the
selected driver, while capture devices on the Mac remain separate permissions. A
query for one named hardware feature evaluates the matching device capability
without initializing unrelated graphics providers. Full feature enumeration and
device configuration keep the actual EGL version query, whose cache does not
depend on process state or importance queries.

### Permissions and application operations

The platform process declares the sensor-privacy endpoint without starting its
service, so ordinary display and media startup do not initialize it. The first
lookup starts the original service, with its state controller, persistence,
permission checks and listeners. The platform process also hosts the original
telephony event registry, whose internal calls about users and application
operations go to the profile's user and policy services.

Native audio receives permission updates through Android's original
`AudioServerPermissionProvider`, which uses the same package catalog and
permission decisions. Native composition services register in the same service
directory under their authenticated process scope, with the shared profile
services as parent entries. Every live native audio-policy service receives the
original provider's package and grant updates, and ending a process removes only
that process's endpoints. During initialization, native audio joins the original
permission-update barrier after the audio policy is published and then commits
the shared stream ranges. Application construction waits for this initial audio
setup, while other native services and process setup start concurrently.

Once its context is set up, an application publishes its complete local service
directory over its existing authenticated connection. Sensitive permission
checks then query that application's original `IPermissionManager`, which takes
into account its manifest, explicit device selections and macOS authorization.
The original permission listeners pass changes on to the profile provider, and
when a connection closes or a Binder dies, the matching transport leases are
released. Local checks stay in the application's process, and calls in the
reverse direction run outside the directory and permission locks. Before a
process is accepted at enrollment, the system catalog receives its installed APK
set, and the system sandbox can then read that installed code without access to
application data. UID state queries are answered from live, authenticated
process activations rather than from macOS user identifiers.

Permission checks use the original process-wide `SystemConfig` instance, whose
UID grants and split-permission declarations stay in force across repeated
checks without re-entering its system-server caller diagnostics. Package
metadata calculates the grants of requested permissions only for
`GET_PERMISSIONS` queries, and signature grants still go through the
original full APK verification. Grant enumeration takes a snapshot of the
requested permission set before any verification or remote query, so unrelated
local permission checks can proceed in the meantime.

The private Android user keeps its original classification as a full user, and
Android's own user-profile and icon-badging clients use that user without adding
a managed (work) profile.

The Settings intents for all-files access open an embedded Android settings
window for the calling application. Its toggle stores
`OP_MANAGE_EXTERNAL_STORAGE` through the permission-decision store, and the
original `Environment.isExternalStorageManager()` reads that AppOps state. The
access covers the application's existing Android storage volume and exposes no
further Mac folders. Closing the settings window delivers the ordinary Activity
result and resumes the caller on its Android main Looper.

A started application operation (AppOps) keeps its client Binder, UID, package
and attribution. Nested starts are balanced by their finishes, and the last
finish, the client's death or application shutdown releases the operation's
death subscription. Changing a UID or package mode requires Android's
application-operation management permission and is saved in the same persistent
permission-decision store. Switch operations share their mode, writes that
change nothing do not notify watchers, and raw queries keep foreground-only
modes, while the Activity state determines the effective mode.

Watchers keep their original registration flags: watchers of a specific
operation are told that operation's code, legacy switch callbacks are told the
switch, and package watchers receive the whole switch family. Foreground
transitions notify only matching foreground watchers. IGNORED mode pauses
started operations and ERRORED leaves their started state unchanged, while any
other mode that is written resumes them, subject to the original package and
restriction checks. A pause keeps the nesting count and the Binder that holds
the operation. No Android mode choice grants access to a physical device.

### Settings and shared memory

Android's system settings are stored by the original AOSP SettingsProvider. The
JVM package includes its APK, resources and Apache notice regardless of whether
Google integration is used or an ART image is present. `platform/packages.json`
locates these included APKs, while an ART image keeps its original provider
catalog. The component's binary definition records its checksum, its source
reference and, separately, the system image it came from. SettingsProvider keeps
Android's permission checks, aliases, defaults, mutations, change generations
and persistent settings files. Each application's Android ID keeps the random
identifier that the installation already has, and neither these settings nor the
identifiers read macOS settings or hardware identifiers.

Settings generations are shared between native and Android processes through the
original AIM ashmem inode representation, and the original MemoryIntArray
clients keep their parcel, atomic access, protection and close behavior. Before
an anonymous backing file is unlinked, a sandbox capability for exactly that
file is issued. Native descriptor attachments carry the capability, and its
lease and auxiliary handles follow the existing file description or AIM
descriptor through duplication, fork, exec and the final close. Because the
capability covers only the received file, neighboring private files stay
isolated.

Native shared-memory protection accepts the original combinations of the READ,
WRITE and EXECUTE bits, including an empty mask, and a protection change can
only remove bits. New mappings are checked against that shared mask and report
native mapping errors. Removing WRITE adds a write seal to the native
descriptor, while existing mappings stay valid.

### Accounts and KeyStore

The account service keeps one database for the whole launcher profile, while
Google integration is chosen per game: disabled, installed services without an
account, or a selected existing account. Authenticator applications run as their
own packages. An explicit sign-in uses network access, and the account service's
database is kept across games.

The verified Google provider's service broker keeps its original callbacks.
Noninteractive requests from games receive `SIGN_IN_REQUIRED` without the
optional account-resolution PendingIntent, both while the service is being bound
and later in the Games Connect sign-in result. Other connection metadata,
successful service responses and explicit resolutions through the account tool
are unchanged, and the provider's original Parcelable creators read the
connection metadata and sign-in status.

When the account service fails to start, the failure keeps its original
exception type and location while the service shuts down its processes.
Lifecycle diagnostics leave out provider output and account values. Failures
during account bootstrap also record the original initialization phase before
the service adapter returns, including failures that occur before a JVM starts,
and lifecycle records include recognized operating-system and account-service
error codes without error messages or filesystem paths. Native execution records
window-loop failures before Activity teardown starts, including when an
application's destruction callback terminates its process.

Android's cryptography and TLS come from Android Conscrypt and BoringSSL, while
JDK callers keep their JDK providers. The trust data and service identities that
come with the runtime are recorded together with the exact inputs they derive
from. KeyStore links the original service implementations to the shared Binder
and cryptography code. The shared application bootstrap installs the original
Android KeyStore provider before component factories and application code run,
and key operations then go through the authenticated profile service under the
application's Android UID. KeyStore keeps its database in the profile's private
service data directory, independently of the selected runtime version or the
process that runs the service.

### Power and sleep

Both engines report the same virtual Android battery: 100%, on AC power, fully
charged and healthy, with battery saver off and nominal thermal status. These
values are set in the common Android service implementation, and no Mac battery
or thermal observers or notification threads run. Android battery clients and
internal controls keep their original interfaces. A game's wake locks are
logical tokens held within the app. They create no Mac power assertions, do not
reset the idle timer and do not wake the computer.

Mac sleep and wake notifications arrive through the window event queue and take
the original Activity pause and resume path. Focus restoration stays suspended
while the computer sleeps, and on wake only the current Activity resumes, if it
still exists.

## Windows and graphics

### Mac application and windows

Both engines use the same signed Mac application entry, Android label and
rendered icon, IconServices operation, shader-cache access and LaunchServices
bundle grants. A shared native application layer handles SDL and AppKit startup,
how the application appears in the Dock, icon assignment, foreground eligibility
and shutdown, while the engine adapters pass in the data that identifies the
application and keep their own VM references. A launch in the background does
not activate the application, and windowed applications remain ordinary Dock
applications. Game windows use the launcher's dimensions and are excluded from
macOS saved-window restoration, because the shared application layer sets SDL's
state-restoration policy before AppKit processes the initial launch event.

| Platform responsibility | Shared implementation | Engine-specific boundary |
| --- | --- | --- |
| App name, icon and Mac bundle | `package-metadata.js`, `application.js`, `application-platform.h` | JVM entry or native ART presenter executable |
| Window, drawable and lifetime | `window-physical.h`, `session-core.c` | VM surface references and original producer transport |
| Android surface composition | Original `Surface` and `SurfaceControl` APIs | JVM `HostSurface`/`HostSurfaceControl` adapters; ART original SurfaceFlinger |
| Keyboard, composition, pointer and scrolling | `window-input.h`, `HostInput`, `HostScrollInput` | JNI delivery or the ART input pipe |
| Audio devices, PCM mixing and volume | `audio-device.c`, `audio-pcm.c`, `audio-volume.c`, original Klepton audio source | Original Android media/AAudio transport |
| Mac network state and ad policy | `connectivity-core.h`, `network-policy.c` | JNI notification or ART host-call notification |
| Google integration and account selection | `launch-policy.js`, `service-processes.js`, `google-accounts.js`, account service | APK process execution |
| App files and process identity | `storage.js`, `storage-namespace.json`, installed-package services, `ProcessAuthority` | JVM path translation or original ART VFS mounts and native IPC |
| Application and initial Activity creation | `HostApplication`, `HostActivity`, original `Instrumentation` and `AppComponentFactory` | Application class loader |
| Provider startup | Original manifest parser and `ActivityThread`, `HostPlatformPackages`, `HostContextServices.installProviders`, verified provider preference lease | Application class loader or lazy shared system process |

For the initial Activity and for later launches, the shared Activity manager
chooses a typed binding to the physical window. The JVM binding uses its native
window session, while ART uses original Android surfaces that belong to the
existing output. When an Activity is launched from another process, its options
carry a scoped output capability, which also passes window focus, sleep and
wake, and shutdown on to the child Activity. Child surfaces keep the same
display and input handling, and closing a child returns input to its parent.
When an Activity is first attached and whenever it is resized, it receives the
current output's screen, size, refresh rate and density, while Android's default
display ID stays the same.

Scroll-wheel and text input enter the same shared Android input handling in the
receiving process, and input completion keeps the original ViewRoot's handled
result. ART delivers pointer and key events through original Android input
channels, including their size-limited socket queue and completion protocol. The
capability for physical input follows the application window when one Activity
replaces another, so events reach the current Android input handler instead of
the view of a destroyed Activity.

Orientation requests from Activities follow one output policy. The JVM applies
it through its native window session, whereas ART selects an actual native
window mode through the original SurfaceComposerClient and Composer3 interfaces,
and in both cases a shared Mac placement routine fits each orientation to the
screen. Each rendered buffer commits the display dimensions and the pointer
coordinate range together, and pointer positions are mapped from Mac window
points into the Android display size committed this way. Window selection and
local coordinates use the original ViewRoot's screen frame, and Android applies
window compatibility scaling and view scrolling through its original input
stages.

The shared window and input handlers learn about view events through UI
callbacks added at build time. One list of these callbacks generates both the
JVM bytecode bindings and the ART DEX bindings, so both notify the same window
and input handlers, while the original `ViewRootImpl` attachment, detachment,
input-completion and input-token methods keep their implementations. For DEX,
the encoder uses dexlib2 to relocate branches, handlers and debug positions
around the added callbacks.

Android windows take their initial touch mode from the platform resource, and
the original ViewRoot input stages handle keyboard navigation, focus highlights
and the switch between navigation and touch mode on pointer input.

Under the JVM, the window pump yields between completed Android callbacks once a
display interval of the real screen has passed. Native input and Canvas frame
publication can therefore progress while animations keep the original queue
busy, and callback execution, message order, barriers, native descriptor events
and idle handlers stay under the control of Android's original Looper.

### Window shutdown

When a window is closed explicitly, both window bindings report the close to the
shared process authority before Android teardown runs, and a requested close is
kept distinct from an input transport shutting down or a process failing. Under
the JVM, Activity cleanup keeps the physical output until pause, stop and
destroy have run, and the central window manager detaches presentation before it
removes the display callbacks. Under ART, the initial output and the outputs of
service Activities follow the same window shutdown sequence. If Activity
teardown fails, the first exception is kept while compositor detachment and
window cleanup continue. Display callbacks stop after the compositor is
detached, and a producer that is still active keeps its window until the native
close barrier.

Closing a window leaves the application and its Binder services running. Before
the output lease is released, the ready callbacks in the original message queue
are drained up to an asynchronous marker. Later callbacks, synchronization
barriers and the Looper of the application, which keeps running, stay with
Android, and the JVM window pump keeps its own nonblocking deadline handling for
native polls. While callbacks are executing, native display shutdown keeps
servicing the Android-side queue, and waiting for its dispatcher thread to exit
does not start unrelated application messages.

Window teardown waits at most one second for Metal work that was already
submitted, and resources can be released once their command buffer has either
completed or failed. The first rendering exception stays available while EGL
surfaces, fences and presenter references are released, and work that is still
in flight keeps the resources it depends on for a later attempt. Device
initialization makes its queue and shared events available only after every
allocation has succeeded.

### Composition and presentation

Everything an application draws reaches the physical Mac display through one
native window and surface layer, whether it comes from Canvas, GLES, video or a
native activity. Presentation uses the window's current backing size and the
producer's actual content dimensions, and graphics settings apply on the same
launch and presentation paths. Canvas overlays are positioned using the native
producer's actual pixel origin before the common presenter applies its display
transform, so Android UI is placed the same way over top-left Vulkan images and
bottom-left GLES images. Canvas changes are redrawn over a completed GPU
snapshot of the native image, which lets text and controls update independently
of the game's frame rate. These redraws use the same size-limited image pool and
common graphics presenter, and an empty overlay adds no native image copy.
Audio, video, image storage and JNI references stay with the code that
originally holds them throughout asynchronous work and shutdown.

Each engine's typed physical binding chooses the native surface representation,
the shared audio device and optional sensor publication, while service policy
stays in the common implementation. The native presenter reports buffer release
whether or not the frame reaches the display, including for occluded windows.
ART passes its present-fence observer to the shared graphics library through
`rsSubmitFramePresenterObserved`, with separate callbacks for the release of
source buffers and for presentation shutdown.

On the JVM, `SurfaceControl` transactions are implemented by
`HostSurfaceControl`. A transaction completes through
`HostSurface.Target.onFrameCompleted` once the output accepts the Android frame.
`CanvasFrameSource` holds one copy of the latest image with its frame ID and
latch timestamp, and a newer image can absorb earlier transactions before
anything is displayed. Neither the Mac window's visibility, nor the availability
of a drawable, nor the completion of physical display delays that Android latch.
Original `TransactionStats` objects report the latch timestamp, with an empty
present fence when the output exports no Android fence descriptor, and the
timing of physical presentation and dropped-frame metrics are tracked
separately. When transactions are sanitized, they are checked against the
process's private transaction capability, and local layer transforms keep their
meaning. This scene has no global authority over Android displays or input
commands and cannot address the layers of another process. ART keeps its
matching native SurfaceControl and SurfaceFlinger implementation.

Under ART, composition waits for native services to register through the
original `IServiceManager::waitForService` registration callbacks. Each wait is
part of the composition session and ends when the launch is canceled or a
service process fails. The service directory starts with an original Binder
transaction that tolerates SurfaceFlinger being absent before its process
starts. Before the graphics services start, native service startup checks the
original Binder directory with a single `checkService` transaction, and each
required service then gets its own registration check. Startup neither
enumerates unrelated services nor requests their interface descriptions.

The window executable loads while the composer and SurfaceFlinger initialize,
and it reports its actual process identity. Its inherited startup channel stays
blocked until those services have registered and the process authority has
recorded that identity; only then does window initialization contact the
platform and display services. The original system-suspend, media-metrics and
audio HAL services register concurrently, and one combined registration wait
still respects each of their process dependencies before audioserver starts.

Android's composition and media state stays in the original SurfaceFlinger and
media services, while typed physical operations go through the shared Mac
session, display clock, presenter, text input and PCM output. Native
Choreographer deadlines and physical display timestamps share the same uptime
clock, so time the Mac spends asleep does not postpone frame callbacks.
Generated surface timestamps and timed video release use that clock too, while
media presentation timestamps stay as the decoder or producer supplied them.
Native Choreographer calls from Bionic use the complete typed NDK family and the
same thread-local Looper as Java queues and native descriptor events. Frame,
vsync and refresh callbacks run on that Looper's physical thread and stay
attributed to the library image that registered them, and queued callbacks end
together with the original native frame source. Native C threads keep the Java
attachment state they already have.

Both engines report frame timing through one native reporter, which keeps a
size-limited history. Its records separate what the application produces from
original SurfaceFlinger composition and include accepted and macOS-presented
rates, frame intervals, submission time, and source and output sizes. The
records go to the Android log destination that the runtime keeps, even when the
application redirects or closes its standard streams. The native presentation
service's own log keeps a startup segment and two recent segments.

### Surfaces, buffers and video

PixelCopy reads a surface as it was submitted, before effects and scaling, even
when its producer is idle. Native drawables, EGL window buffers, projection
slots and decoded frames hold their source leases throughout the GPU readback.
An EGL window rotates through up to three backing images while it remains the
same surface, and an image is not reused until its readers finish. A swap copies
the previous contents only when preserved-buffer behavior is explicitly
selected. Hardware-buffer sources that can be written directly use a pool of
three GPU snapshot images, capped at 128 MiB per process, inside the producer
fence.

Planar video goes through the same CoreImage conversion source in both engines.
The original ART allocator provides the plane offsets, strides and color
metadata for NV12, NV21, YV12 or P010, and its EGL image registry keeps the
mapped buffer; acquiring an image refreshes its Metal texture through the
original external-texture binding. Acquire and read fences protect plane views
that the CPU can access, and Metal shared events order the converted pixels
before they are sampled. CoreVideo reads NV12 and P010 directly, while
Accelerate normalizes the chroma order of NV21 and YV12 without replacing the
decoder or BufferQueue. Releasing an image waits for pending source reads before
the original mapping is released. The GLES driver and the GPU host-call
implementation are delivered together with their matching protocol version.

Under ART, the EGL window surface holds a dequeued producer buffer before
drawing and sizes its framebuffer from that buffer. The consumer's default
dimensions stay available through the original native window queries. Queueing a
buffer passes on the copy fence, a resize takes effect with the next acquired
buffer, and destroying the surface cancels an unused buffer before the native
window is released.

When ART presents a window, it first resolves multisampled color into a
single-sample attachment and only then applies orientation or scaling. That
attachment lives as long as the existing imported image and GL context, and the
application's framebuffer, renderbuffer and scissor state stay intact.
Framebuffer operations use the original OES entry points in an ES1 context and
the core entry points in ES2 or later, and they keep the application's GL error
state during presentation. For reversed or scaled destination bounds, legacy
contexts use the advertised NV framebuffer blit extension, with the same Android
row origin as core ES3 presentation, and multisampled sources are resolved with
identical bounds before either transformation.

`ANativeWindow_fromSurface` and `ANativeWindow_toSurface` keep the same buffer
consumer. Each returned Java `Surface` is a wrapper held separately, so
releasing earlier Java wrappers leaves an acquired native window usable. The
last native reference releases the consumer after the window lock is dropped.

On the JVM, ImageReader keeps the original ImageReader, Image and plane objects
on top of the shared Surface and HardwareBuffer handling. Acquired images and
returned hardware buffers hold their own buffer references. A producer that the
app controls replaces the queued frame without waiting for its own consumer, and
maxImages limits the acquired Images, detached ones included, until they are
closed. Direct producer buffers keep their actual dimensions, format and
dataspace, and the original PublicFormatUtils APIs use Android's device mappings
between public formats, HAL storage formats and dataspaces, including encoded
and depth data.

Native storage provides packed RGB, FP16, flexible YUV420, P010/P210,
monochrome, RAW16 and encoded BLOB planes with their actual row and pixel
strides. PRIVATE images keep opaque producer storage and expose no CPU planes,
and encoded and raw formats need the corresponding producer bytes. Allocation is
not supported for RAW10/RAW12, RAW_PRIVATE, NV16, NV21 and YV12. When a native
video delivery fails, it clears its own JNI exception so that later frames can
still be delivered.

Fences on the JVM use the complete original `SyncFence` JNI unit, the `libui`
`Fence` implementation and the `libsync` module, together with the shared Binder
descriptor handling, and their JNI exports come from the original registration
table. Android's code keeps reference counting, descriptor ownership, waits and
Parcel serialization, while Darwin provides descriptor polling and closing.
Linux sync-file ioctls keep their original declarations and normal descriptor
errors.

EGL and GLES calls from guest code are forwarded by a generated guest library,
which keeps the complete NDK and ANGLE extension declarations. Callback
functions and user pointers stay associated with the graphics context they were
registered with, and destroying that context releases their native holders after
any active callbacks complete.

## Input and text

Text reaches applications through Android's original input connections, which
receive native text composition and keyboard operations, and closing a native
connection ends its matching composition session. The macOS composition window
is placed next to the Android caret using the original editor's cursor anchor
and view transform, and the physical window maps Android render pixels to
logical window points, taking Retina scaling and resolution multipliers into
account. Geometry updates follow the active connection and stop when its editor
detaches. Explicit copy and paste gestures transfer text through the launcher,
and clipboard reads in the background are kept apart from Android's private
clipboard state.

When the physical window runs in a separate process, that window process's
identity, as the supervisor records it, authorizes clipboard gestures for the
application. Closing either process ends that relationship, and enrollment never
reads the clipboard.

Per-game keyboard touch controls can map WASD, the arrow keys or both to a
virtual joystick. Its center is given as percentages of the display width and
height, and its radius as a percentage of the shorter dimension. Movement holds
one finger steady while the mouse operates another, using Android's original
multi-pointer events and view-root dispatch. WASD mapping is on by default. It
pauses during text editing, leaves Command shortcuts to the keyboard, and
releases its touch contacts when focus changes or the Activity ends. Controllers
and wheel and trackpad scrolling keep their own input paths. The touch-joystick
and manual-motion settings are read by one application configuration reader,
which also validates the position and radius, and they go to the same input
handlers.

Both engines build the keyboard from the same complete character-map resource
and device registration, each through its original Android native parser.
Android's resource configuration reports an exposed QWERTY keyboard for the SDL
keyboard source.

Manual motion, which provides the virtual sensors behind **Manual tilt**, is
implemented once in `HostSensors`: the sensor descriptors, keyboard and
controller input and sampling are all there. The JVM's sensor queues read it
directly. Under ART, original native clients use the image's SensorService and
AIM's original AIDL sensor HAL, whose physical source reads the same descriptors
and samples through shared memory that is published for each application. Only
the interactive process publishes that source, and the application's service
processes share the native service. The original HAL keeps Binder, activation,
flush and FMQ delivery, and the original FMQ storage uses the memfd
implementation.

## Audio and media

Both engines compile the same CoreAudio implementation of device discovery,
format, latency, route-monitor lifetime, PCM mixing, volume and pause. JNI and
the original audio-ring host-call protocol translate only their own transport
records and callbacks. The shared stream-activity policy queries the running
engine's audio implementation through the same volume and activity binding,
which uses the original `AudioSystem` and native audio policy service under ART
and the activity of the existing physical players under the JVM.

The physical PCM output offers one optional filter for the life of the process,
applied after mixing and Android stream gain. The filter receives the original
rendered samples on the CoreAudio callback, and a filter implementation keeps
its code loaded until the process exits and does no blocking work on that
callback.

Under the JVM, decoding and playback go through their own binding, separate from
ART's original media clients. Decoded MediaPlayer and SoundPool clips share
immutable PCM samples, while each keeps its own playback clock, looping, rate,
seek position and channel gains in the same mixer. A copy keeps its samples
through playback and release and does not open a separate Mac audio player.

The JVM's native MediaCodec layer decodes AVC and HEVC with VideoToolbox, and
VP8 and VP9 profile 0 with the decoder-only libvpx library. Beneath the original
AOSP Java and NDK clients, both decoders deliver retained CVPixelBuffers to the
same input and output leases, callbacks, timestamps and Surface handling.
libvpx's I420 planes are copied directly into a size-limited NV12 pool, which
keeps the color attachments and uses the same byte-buffer stride and native
Surface presentation paths. When codecs are discovered, software decoding
reports its 4096 × 2304 limit and its supported profile, and other VP9 profiles
return the ordinary unsupported-format error.

In runtime profiles that support AAudio, `libaaudio.so` maps to a generated
guest library that implements the complete typed NDK API over the native Mac PCM
stream. Builder callbacks are copied into each opened stream and remain valid
after the builder is deleted. A native audio feeder callback stays attributed to
the authenticated application image it belongs to and runs on one original
Bionic pthread until the stream shuts down, with Java attachment controlled
through the original VM APIs. Releasing a stream joins the feeder before its
buffers are freed, and closing the stream then releases the stream object.
Capture follows the native audio device's policy for the selected input and the
microphone permission. Stream attributes keep the values the stream adopted, and
hardware queries read the live native PCM format. Compressed offload and stream
presentation timestamps return `AAUDIO_ERROR_UNIMPLEMENTED`.

Output AAudio streams report consumed frames at the stream's own sample rate.
The original PCM writer publishes the range that each stream has committed, and
the getters read atomic snapshots without taking producer, device or stream
locks. Callback frames that were not submitted do not count as consumed. The
counters stay independent and monotonic, carry the frames actually consumed
across resets of the device cursor, and keep their final values after the stream
is released.

OpenSL ES players and recorders are configured with the original Wilhelm value,
size-query and object-state algorithms in the shared stream implementation.
Playback stream types and recording presets apply per stream, and once an object
is realized, performance queries report the shared buffered CoreAudio path.

Microphone and camera use starts with an explicit selection, which goes through
the same launcher permission request, sandbox capabilities and capture
implementation. The shared physical capture layer handles capture conversion,
device authorization, stream tokens and shutdown, and microphone resampling and
anti-alias state use Klepton's original conversion code in that layer, shared by
the AAudio and media input bindings. The media platform component manages
selected devices, capture authorization, microphone stream lifetime and camera
sessions. The engine bindings and adapters only marshal device identifiers,
strings, tokens and PCM, sample or camera buffers, and they keep no media policy
of their own.

## Storage and files

### Storage namespace

Each application has private persistent files, preferences and caches under the
selected launcher profile, and temporary launcher profiles use separate storage.

An Android application can reach the same file through several paths, and the
storage namespace makes those paths agree. Java and native I/O share explicit
application storage aliases, including scoped external paths built from the
application's canonical private-files root. Each alias resolves once to the
storage it belongs to, while device-protected storage and other packages keep
their own paths. The common storage namespace maps private credential-protected
and device-protected data, external files, cache, expansion assets and media to
the existing installation. The JVM bindings translate these paths to host paths,
whereas ART exposes the same aliases through its original VFS and keeps native
Android partition and session roots. JVM `File`, stream and NIO path operations
also go through the native layer for virtual `/proc` and `/sys` files, keeping
the original JDK descriptors and errors.

The archive names of fused modules come from one planner that works from the
original parsed `ApplicationInfo` metadata and split catalog. JVM path mappings
and ART's read-only VFS binds both point at the APK that contains the module,
and real installed splits take precedence. Either way, the original inode and
package are kept, without copying archives or registering additional packages.
The names of installed base, configuration and asset-pack APKs are preserved in
native filesystem mappings and class-loader source paths.

Each original Linux descriptor keeps the mount it was opened through in the
descriptor table. Its proc-fd path follows the current vnode name within that
mount across duplication, renaming, fork and exec, which preserves Bionic's
canonical-path behavior when several Android aliases refer to the same storage.
Synthesized proc files keep their canonical virtual name in the same descriptor
metadata. A native maps snapshot records its origin on the snapshot inode, so
through duplication, fork, exec and later snapshot replacement, the opened file
keeps its name regardless of the temporary storage behind it.

Native files keep their allocation, positioned I/O and mapping operations after
the shared descriptor table takes them over, and their original access modes
still apply.

### Sandbox and installed code

Path translation and the process sandbox together confine file access to what
the application has been granted and to the shared read-only runtime inputs.
Explicit file import copies the selected file into the application's own
storage, and an empty set of filesystem or executable capabilities grants no
access.

The JVM sandbox allows execute-permission checks on verified, read-only
installed ARM ELF files through capabilities for exactly those files, and it
excludes host binaries, scripts and writable paths. A shared ELF file keeps
these capabilities only when all of its hard links belong to verified prepared
inputs outside writable storage. The checks do not let the JVM execute Linux ELF
child processes.

Application and provider processes have different mount views but share the
session's native descriptor metadata, so sockets and files transferred over
Binder keep their ownership in the receiving process. Executable access is
limited to the immutable installed-code roots, and writable application data
stays separate. The authenticated records of installed packages determine
exactly which APK, split and native-code files are mapped read-only, the
package-code initializer gives them Android root ownership and readable modes,
and other packages' private data roots stay unmapped. Native IPC uses sockets
addressed relative to the private session directory, so launcher profiles with
long filesystem paths work.

Under ART, installed code appears by default as owned by root and readable.
Executable files get the guest mode `0755` while explicit guest metadata and the
host's private permissions are kept, and mutable application files keep their
guest owners and modes. Native code metadata is initialized under the same
per-package kernel lock as APK verification and publication, and reusing a
prepared generation keeps its existing inode attributes and its digest-cache
key. Initialization declares each installed-code root without walking its
descendants, standalone code files record their metadata once, and writable
application data keeps its separate import policy.

The installed-code initializer covers every mapped package and native directory
and keeps host-private modes and explicit guest inode records. On exactly those
directory nodes, the macOS sandbox permits reading ownership attributes without
granting access to their contents or to neighboring package files. The original
linker checks which library search directories exist and selects among them, and
configuring a search path does not by itself grant access to a library.

ART reads assets directly from the original APKs, whereas code under the JVM
that reads assets from the filesystem uses extracted copies. Extracted ART
assets that are not used are removed by the package preparation manager once the
readers of their generation release them, and the APK paths and native library
inodes are kept.

### ART file ownership

Imported application trees declare their default Android owner on the root
inode, and ART's original inode metadata layer fills in missing fields when a
file is first used while keeping explicit ownership and modes. Files that the
guest creates go through the original creation path. When inode metadata is
recorded, the physical owner on the host keeps the access it needs to store that
metadata, while Android sees the requested mode under its umask, including mode
`000` followed by `fchmod`. The lookup of the default owner stays inside the
writable VFS area.

Installed-code files and directories of enrolled packages use the same import
default: owned by root, with directory mode `0755` and file mode `0644` plus any
execute bits the file already has. The original VFS fills in missing fields for
code without writing metadata for descendants, and explicit inode fields and
original image metadata take precedence. Read-only aliases use the same declared
physical owner.

Published mounts bind each existing host root to its physical path once while
keeping the guest path. To find the imported owner of a file, the lookup
compares the host paths that contain it before checking mount visibility or
reading an import declaration. Canonical roots reuse the original VFS path
cache, and dynamic aliases and later symlink targets keep their original
namespace behavior. Links keep the same inode metadata, and moving a directory
carries the import default to its descendants. Launch setup does not enumerate
application data, and its subprocesses can be canceled and leave the backend
control loop free.

## Network and web content

Network access is chosen per game. The choice applies to JVM, native and
embedded web requests alike, and Android's connectivity state follows it.
Advertising policy and requests to open external links are handled at the
boundaries where Android's network traffic and intents reach the host, without
removing Android framework APIs. Opening an external browser requires an
explicit approved action, and a location is supplied only when the application
requests one and it has been configured by hand.

Both engines take connectivity from the same passive observer of Mac routes and
use the same application network identity. Under ART, the matching image's
original DNS resolver keeps its query, cache and Binder interfaces, and its
physical policy interface applies the same per-application network isolation and
advertising policy. Resolver addresses and search domains come from the Mac's
current network configuration, without an added public DNS fallback. When an ART
service lookup fails, the error keeps the original service-manager transaction
status, so a missing connectivity service can be told apart from an IPC failure.

Traffic accounting is mocked by `HostTrafficStats`: device, interface and
per-UID byte and packet counters remain zero, and usage sessions return empty
summaries, histories and UID lists. The service reads no host counters and uses
no native accounting entry point. Its shared socket tagger completes tag and
untag requests without doing anything, so the descriptors stay with the
application and no Mac traffic is labeled.

ART's Linux socket layer keeps Linux's layouts for multicast scalar values and
membership records. A query for pending UDP bytes returns the native payload
size of the first datagram, without its source-address and control storage and
without removing queued packets, while a stream query returns the native count
of readable bytes. Datagram receives keep Linux's full-length `MSG_TRUNC`
results. A receive across processes is accepted only with the socket's
allocation receipt, a trusted record that travels with the socket; readiness
waits happen outside that check and keep nonblocking mode, receive timeouts and
zero descriptor limits. IPv4 TTL and loopback values are converted to Darwin's
byte-sized fields, while IPv6 keeps integer values. Interface selections and
group memberships resolve through the same Linux device layer and physical
network as other native sockets.

### Browser links

When an application opens a link, the original package resolution first looks
for an installed Android activity. If none handles an `ACTION_VIEW` with an HTTP
or HTTPS URL, the request can go to the Mac browser through the shared approval
step instead, and Android package, component, MIME type and category metadata do
not prevent that fallback. Network isolation and advertising policy apply before
approval is requested, and approval never gives Android code direct access to
the browser. The Java bridge parses the URL with the JDK parser, which handles
explicit ports, internationalized hostnames and IPv6 addresses, and the host
broker normalizes the destination before it asks for approval. In both engines,
external HTTP and HTTPS links use the same inherited request channel and
launcher confirmation policy.

### WebView

WebView is backed by WebKit on the Mac, through one `WebKitFactory` Android
provider and one family of physical WebKit operations in
`native/webkit-platform.mm`. In either engine, a common portable JNI adapter
handles Java references, resource callbacks, JavaScript interfaces, dialogs and
snapshot delivery. The JVM calls the physical WebKit layer directly, while ART
carries the same typed requests and callbacks to its Mac window thread.
Notifications that return nothing stay in order on the Android window queue
without making the shared physical window thread wait for that queue. Resource
bytes, navigation decisions and JavaScript interface results keep their
synchronous replies and reentrant client calls, and during reentrant calls the
window thread stays in charge of the browser.

Under ART, the WebView reader keeps native transport state separate from Android
callback references. An explicit session close joins the reader and releases
those references on the Android thread. When the native process is torn down, it
signals shutdown without waiting under the loader lock, and the platform DSO
stays mapped for the life of the process while the reader releases its
descriptors.

Browser storage belongs to the enrolled application, and the launcher provides
each process's storage capability and the path of the provider's runtime
archive. The same package metadata points to the JVM host archive or to its
mapped ART DEX archive, regardless of how the engine represents protection
domains, and the original `WebViewFactory` checks still surround the native
provider-selection step. The JVM entry and ART's Mac window process answer
Darwin temporary-directory queries through the same private-storage adapter, so
WebKit's rule compiler keeps its scratch files inside that process's private
temporary directory and the native shader cache is unaffected. Both also share
the WebKit process-service capabilities needed to load local documents, while
HTTP, WebSocket and FTP requests follow the application's network policy
independently of those local service connections.

The WebKit provider forwards page and subframe navigation through the original
Android `WebViewClient` request overload, with its URL, frame, gesture,
redirect, method and header metadata, and Android's original overload dispatch
keeps older string-based clients working. Loads that the application starts
itself remain distinguishable from page navigation. Messages for local schemes
use the same callbacks, while network isolation applies to actual network
operations.

## Logging and diagnostics

Android's native log goes to one physical output that both engines share, and
the runtime holds its descriptor before any application native code runs.
Android log writes and variadic formatting use that descriptor, while the
application's ordinary stdout and stderr keep their normal redirection and
closing behavior, so redirecting those streams does not send Android logs into
an application's logging pipe. Size-limited Java failure reports are written to
the same destination with the original Android log line writer. Before native
logging is registered, these reports fall back to ordinary stderr, and reporting
keeps the original throwable and cleanup. Each engine makes the logger available
after the original native initialization, through its usual registration or
process binding, and the ART RPC component links the logger component directly.

Under ART, the output transport starts with INFO as its persistent log priority
when the original process priority is unset. The original `liblog` keeps per-tag
properties and any priority the application selects later, and reinitializing
the transport keeps a priority that the application set explicitly. Warnings and
errors keep their original reporting paths.

Both engines use the same launch timing recorder, which logs each operation's
name before waiting for it and its duration once it completes. Package
preparation, installed packages, service connections, graphics, isolation and
process startup are timed separately, and native composition has a span of its
own.

[Android native code](NATIVE_CODE.md#fault-reports-and-tracing) describes fatal
native reports, syscall tracing and opt-in fault diagnostics.

## ART components

The ART engine's components are built into a directory with its own manifest,
from which the ART part of the Android package is assembled. The recipes for
this build are in `src/modules/android/art`. Its inputs are a matching Android
image, ART and libcore binaries and the original framework DEX, together with
AIM's Linux ABI and ELF support. The build neither converts application DEX nor
applies HotSpot framework rewrites, and D8 packages the launcher's Java
integration classes separately. The JVM remains the default execution engine.

An optional, complete HWUI library can be added as the `hwuiLibrary` component,
with its `hwuiNotices` directory. The shared launch layout binds that immutable
file read-only at `/system/lib64/libhwui.so` for composition and application
processes, while the downloaded system image and its recorded content digest
stay unchanged. The component notices are listed in the ART package manifest,
with paths relative to the component directory.

The HWUI library comes from the optional build in `native/hwui`, which compiles
the complete Android 16 HWUI, Skia and static dependency targets against the
image's private ABI. `buildArt({hwui})` selects it; without that input, the
image's original library is used. The build's source, generator and compiler
inputs are explicit, original sources stay read-only, and the original exports,
shared dependencies, release settings and sanitizer policy are kept. Its
CommonPool adaptation keeps the original class layout and API, wakes and joins
workers before their synchronization storage is destroyed, and shuts down
partially constructed pools safely.

MacLauncher maintains overlays for AIM, among them the RGBX framebuffer
projection and its IOSurface implementation. Exporting the sources applies those
overlays without depending on an enclosing Git checkout, and compiler outputs
stay in the build cache. The Linux device layer provides the original DMA heap
allocation, descriptor metadata, buffer synchronization and mapping operations
that Codec2 uses, and media services keep the matching Android image's
buffer-pool configuration. Native display-mode operations use a separate
protocol extension next to the upstream text-input operations, and editor state
stays with the shared Android input handling.

The component directory's manifest records component paths relative to the
directory and identifies the Android image. Optional behavior is selected by
fields in the Android package manifest:

- `artExecutionVersion: 1` selects an ART entry point from the components. This
  field is independent of the JVM's conversion format versions.
- `binderSenderIdentityVersion: 1` updates the sender UID of the original Binder
  transaction from authenticated process credential transitions. The security
  credentials that a connection was opened with stay fixed, and while a
  transition is pending there is no active sender identity until the native
  credential layer confirms the new UID. The original window and service caller
  checks keep the IDs recorded at enrollment.
- `frameworkResourcePreinitVersion: 1` initializes the original system
  AssetManager and image overlays before the application is set up. This stage
  runs with minimal Linux startup credentials. It then permanently replaces the
  real, effective, saved and filesystem UID and GID values with those of the
  enrolled application and clears the capability sets and bounds, and APK
  loading, application native constructors and the validation of process
  enrollment all come after that drop. The initialization code comes from the
  selected immutable boot class path and guest libraries. Component builds
  without this field start directly as the application UID.

The optional `ptyHolder` component maps to `host/aim-pty-holder`, next to
`host/linux-run`, as AIM's original host-node dependency declaration in
`crates/aim-build/src/cargo.rs` specifies. Original Linux terminal operations
start that native process through its path beside the runner, and its process
records stay in private session state outside the guest filesystem.

ART's Binder integration reuses the complete shared RPC, Parcel and
authenticated peer implementation, and JNI object conversion uses the matching
original Android runtime. A local native Binder caller enters the VM attachment
manager before its call is dispatched to the original endpoint. When a thread
exits, Android's native thread-local detacher releases only the attachments that
manager created, and callers that were already attached keep their original
lifetime and Binder identity. Application processes use the same profile-service
enrollment and the same account and clipboard authorization channels.

## Builds and source inputs

A normal build reuses the prebuilt executable framework, native runtime, ANGLE
and portable codec artifacts and compiles MacLauncher's adaptations and the
selected original native implementation modules, without a full Android product
build. Source groups for the compiled modules are resolved by the original
Blueprint parser, without Soong or Kati product evaluation.

`framework-binary.json` lists the prebuilt artifacts and their checksums,
`source-pins.json` and the component source catalogs record the exact upstream
revisions used, and the immutable build snapshot records MacLauncher's own
sources and compiler inputs. Java assembly, DEX conversion, native objects and
builds of external components are each reused independently, so an unrelated
native edit leaves the application and framework bytecode unchanged.

`buildArtGuest` builds the original Binder library and the native application
components in one build. Its optional `targets` selects complete output
components and their link dependencies; without it, every output is built. A
build of Binder alone keeps the original module's complete source set and reuses
cached Clang and Ninja objects without requiring the resolver or WebKit builds.
For the JVM, `buildGraphicsLibrary` provides the complete graphics object and
link inputs for full and component builds, including the original framework GLES
JNI bindings and the typed guest ABI adapters, and component builds regenerate
the same Ninja graph from those inputs before reusing cached objects.
`art/build-arm32.mjs` compiles the shared ARM32 JNI source with the selected
NDK, and `art/build-ffi.mjs` builds Android's libffi dependency with the
upstream configure and Make rules. Clang depfiles track header dependencies for
incremental builds, and the shared CPU archive comes from the normal Dynarmic
target.

Developer builds accept explicit upstream source, image, generated AIDL,
compiler and exported-header inputs. When ART's Java code is compiled, the
matching Android SDK's `core-for-system-modules.jar` is used as the compiler's
system image alongside the complete framework headers, and those compile-only
classes never enter the runtime image. Clang, Ninja and Cargo keep their
ordinary incremental outputs. `artSupplierComponents` tells the component build
scripts and reassembly tools where to write their outputs, and assembling the
component directory copies those outputs and writes a relocatable manifest
without installing the runtime or writing application data. Obtaining and
redistributing an Android image is subject to that image's license. The original
image redirect tool applies the shared Binder watchdog operation to the matching
service DEX, and the remaining service code and all hook DEX files stay in their
complete containers.

Compiler prefix maps keep developer paths out of delivered binaries, published
native libraries use relocatable loader paths, and notices record source
revisions and licenses. Installing a built runtime puts a complete version in
place and updates its runtime manifest atomically.

The Android build records the native adapters, runtime profile, shared build
helpers and ART build-script sources it used. Before installation, that fixed
snapshot and its relative source paths are verified, including the ART helpers
that prepare sources for the Bionic build, so later changes to the checkout
cannot replace the source inputs of a completed build. The source tree of the
matching MacLauncher Builds tag contains the production adapters, the required
helpers, the upstream revisions of the ART components and the license notices.
Delivered runtime packages contain binaries, required data, notices and directly
used metadata, without source archives, and the shared runtime-content rules
keep separate test and fixture trees out of them.

The [native host reference](../../../src/modules/android/native/README.md)
documents developer build arguments and source catalogs.

## Mac.apk and AIM

Mac.apk and AIM run Android applications with their own hosts, and this section
calls each of them a *provider*. MacLauncher's Android module handles package
inspection, provider selection, private storage, virtual device configuration
and launch confinement for them, through the same module registry and runtime
interfaces as other game types.

| Component | Responsibility |
| --- | --- |
| Android module | Detect APK package sets, read manifests and resources, keep original inputs and select the runtime |
| Mac.apk provider | Resolve a publisher release and launch its Android application host |
| AIM provider | Launch the adapted AIM host with its separately downloaded compatible Android image |
| Shared macOS sandbox | Confine files, child processes and optional network access to the declared launch resources |
| Per-provider application root | Hold writable Android data, home, caches and temporary files for one game and provider |

### Delivery and images

The optional runtimes have the IDs `macapk` and `aim`, and the default runtime's
ID is `klepton`. For Mac.apk, MacLauncher installs the publisher's own releases,
so a new upstream version can be used without rebuilding MacLauncher.

AIM is built from an exact upstream commit, tracked as a Git submodule, with
MacLauncher's patches kept outside the read-only upstream checkout. Its runtime
manager installs versioned packages from MacLauncher Builds, which record the
binary checksums, CPU architecture, minimum macOS version, source revision and
license notices.

Guest control commands keep the resident Android image, the authenticated mount
namespace, the Binder namespace and the display endpoint, and original Android
tools reach the resident display's input devices through the same Linux device
layer as application processes.

AIM's Android image is downloaded and stored separately from the host and is not
included in distributed runtime packages; selecting AIM requests the image
download. The versions of a native host and its Android image must be
compatible.

The original-image manager uses the shared upstream catalog, custom-runtime,
version-selection, installation-origin and runtime-use contracts. Android SDK
metadata supplies available image versions and archive checksums. Installation
measures guest ELF files and records the complete original tree identity;
runtime preparation still compares its exact required archive and content.
Immutable originals remain in the shared image cache, while AIM's derived
overlay and writable application data retain their independent lifetimes.

### Files and processes

Each provider's data is stored under
`userData/android/apps/<gameId>/providers/<runtimeId>/`, where the provider gets
its own Android root, home, cache and temporary directories. Shared binaries are
read-only and contain no per-game state, and changing the provider does not
merge its files, account stores or saves with another provider's.

Application storage in the legacy location stays separate and is kept for
explicit data migration or export. Launcher records stay in
`userData/games/<gameId>/`, and removing a library entry follows the module's
storage cleanup rules.

A launch runs the selected host directly inside the declared process policy.
Network isolation is on by default and applies to the game process and its
children, and if confinement cannot be set up, the game does not launch. AIM
requires macOS 26.0 or later and keeps application processes offline and without
Google account integration.

The Mac.apk provider creates an application bundle for each game, with the
game's name and launcher icon. Its native executable is cloned from the selected
installed version, given the game's macOS name and identifier, and signed
locally, while libraries, framework JARs and the Java runtime remain shared
links to the selected installation. The publisher's JIT and native ABI
entitlements are kept, and declared launcher graphics adapters can load once the
process sandbox is in place.

Mac.apk keeps its Google credentials in one place,
`userData/android/profiles/macapk-google-v1/`, which games cannot read. The
provider calls the selected runtime's original account store and authentication
client in confined processes, and account metadata and scoped authorization
replies pass through the authenticated broker set up for each launch. Before a
game's package name and signing certificate are bound to its requests, the
original APK signatures are verified with the included Android APK verifier.
Token requests then carry that verified package name and certificate together
with the selected account, and fields supplied by the guest cannot override
them. Tokens for one application or one request are not placed in a shared scope
cache.

### Virtual device and host access

Both providers receive the Pixel Tablet device profile, 2560 × 1600 at 320 dpi,
with an initial 1280 × 800 landscape window. These values are the same for every
provider and expose no telemetry from the physical Mac.

File access is limited to explicit imports and private application storage.
Network, clipboard, location, camera, microphone and account integration each
need a supported policy of their own and an explicit selection, and selecting a
runtime grants no access to the host. Each provider's own graphics, input and
audio are left to its upstream implementation, below the part that MacLauncher
controls.
