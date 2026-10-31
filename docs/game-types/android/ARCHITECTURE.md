# Android runtime architecture

MacLauncher Android runs Android applications with one of two execution
engines. The JVM engine converts DEX bytecode with dex2jvm and runs it on
Java 21 together with the complete AOSP Java framework. The ART engine runs the
original DEX on Android's own runtime with a matching Android framework and
native system image. Both engines share the same application services and the
same macOS implementations of windows, graphics, audio, input, storage and
networking, and Java, NDK and XR entry points reach those same implementations.

This page describes the runtime's components and how they connect.
[Android native code](NATIVE_CODE.md) covers native library loading, the Bionic
ABI, instruction adaptation and ARM32 execution. The
[Android game type](../ANDROID.md) describes user-visible behavior and settings.
The last section covers the optional Mac.apk and AIM runtimes.

Terms used on this page:

- *Original* code is the unmodified upstream implementation, such as AOSP,
  Bionic or AIM, built from an exact upstream commit.
- *Guest* code is the Android code that runs under the adapters, such as
  application ELF libraries, Bionic and ART. The *host* is the macOS side.
  *Physical* resources are the real Mac windows, displays, threads, devices and
  process IDs behind Android's virtual ones.
- A *binding* is an engine-specific adapter. The JVM binding and the ART binding
  connect the same shared services to their engine.
- A *launcher profile* is one MacLauncher data folder.
- The *process authority* is the launcher profile's supervisor that
  authenticates each Android process and hands out its service capabilities.
  Registering a process with it is called *enrollment*.
- *Profile services* are Android system services that run once per launcher
  profile and are shared by its applications, such as the account service,
  KeyStore and the shared system process.
- A *supplier* is the package or build output that provides a component. The
  common JVM package supplies the shared services, and the *ART supplier* is the
  directory of ART components, with its manifest, from which the ART package is
  assembled.
- A *generation* is one published, immutable version of prepared files. A new
  generation leaves the files that running processes use unchanged.
- A *lease* is a held reference that keeps a shared resource, such as a prepared
  package, a service or a file, alive while it is in use.

## Components

| Component | Role | How it connects |
| --- | --- | --- |
| Uninstrumented Robolectric `android-all` | Executable AOSP framework classes and resources | Original classes, descriptors and portable implementations are all present; only exact JVM and native dependencies are adapted to the platform |
| Robolectric native runtime and ICU data | Graphics, resources, text, database and other native implementations | Original JNI declarations and exported implementation tables |
| Java 21 | Bytecode execution, object identity, compilation and garbage collection | Android-specific JDK calls are adapted where Android and JDK representations differ |
| dex2jvm | Conversion of application DEX and dynamically loaded DEX | Uses the same framework hierarchy and JVM normalization as the host |
| ART and matching Android image | Original DEX execution, libcore and native Android object representations | AIM supplies Linux and ELF execution; thin JNI and host-call bindings connect to the shared platform services |
| Klepton | ELF loading, ARM64 execution, Bionic ABI adaptation and XR integration | Shared native import dispatcher and JNI adapter |
| Dynarmic | ARM32 and Thumb execution | AAPCS32, pointer and record conversion into the shared ARM64 platform boundary |
| AOSP native modules | Binder, libcore, cryptography, media formats, fonts and portable algorithms | Original implementation units with Darwin adaptations maintained by MacLauncher |
| macOS and ANGLE | Windows, input, graphics execution, audio, devices and network transport | Native platform operations below Android's public APIs |

Robolectric supplies only executable framework and native artifacts. Its test
runner, shadow dispatch, sandbox class loader and simulated services are not
part of the application runtime. Framework assembly adds the complete original
Apache HTTP and StatsD implementation modules, with their source groups selected from the original Blueprint files. Each class has exactly one supplier: identical copies
of a class are merged, and conflicting implementations need an explicitly
resolved supplier.

The supplied framework's optional Zstandard and LZMA compile-time placeholders remain declarations and are not executable platform classes. Applications keep their complete compression SDKs and native libraries, and a different implementation of those classes in the supplied framework stays executable as usual. Original Android framework classes
and their API declarations remain present.

The framework and compatible native artifacts supply original implementations.
Additional portable components come from complete upstream modules and everything they depend on, with source groups selected by the original `Android.bp` build files. The native package includes the Binder RPC, KeyStore, libcore,
Conscrypt/BoringSSL, media-format, NDK bitmap and alarm implementations
alongside their macOS bindings.

Platform adaptations connect each Android operation to the Mac resource behind
it and keep the original API and the portable code around that operation.
Adaptations keep the original public and private descriptors. An exact native
binding or JVM call replacement changes one method's platform dependency without
removing other methods or replacing the surrounding framework class. Tests,
outside the runtime class loader, check that APIs and method bodies are
preserved. ART's build-time DEX platform delegates use dexlib2 to preserve
original members, hidden-API metadata and resources. The WebView provider factory
delegates to the shared WebKit provider, while the original provider access and
lifecycle checks stay in Android's calling framework.

Component source builds and their incremental caches are separate from whole
Android product builds. Upstream source inventories document suppliers and
licenses; they are not lists of which application classes or methods are
allowed.

## Execution engines

JVM is the default execution engine. One Android package contains both engines,
their adapters and shared host services. Existing separate `android-art`
installations keep their original version choices and storage locations. In Runtimes, the ART view lists those installations and the ART default, and
names MacLauncher Android as the runtime whose downloads provide ART.
[`art/package.mjs`](../../../src/modules/android/art/package.mjs) packages the adapter's native libraries with their dependencies, together with its framework and boot files, and
[`art/build-image-extractor.mjs`](../../../src/modules/android/art/build-image-extractor.mjs)
builds AIM's original image reader. The original SDK system image is downloaded from upstream and is never part of the distributed Android package. `system-image.js` verifies the archive and content checksums and keeps one shared, immutable, case-sensitive, read-only image under Application Support, while application data stays private.

The ART supplier can include a boot image compiled by its matching `dex2oat64`.
AIM's original boot-image build step receives the complete runtime boot class path, including the adapted framework, services and platform delegates. A built image is reused while its compiler, ART libraries, class-path bytes and image profiles stay the same. Its image and code files are mapped read-only into each
application session, while application data and process identity stay private to
that session. At startup, the runtime uses the supplied image without running a
compiler or reading the build inputs.

Both engines share APK inspection, private installation, resource extraction
and cache management. ART keeps and runs the original DEX, and its preparation
uses package metadata tools without opening converter libraries. Only the JVM engine locates and runs dex2jvm.

Common Java adapters live in the native `java` source group. ART compiles that
complete group with its own entry sources against the supplied Android core
declarations before DEX conversion. HotSpot-specific implementations live in
`java-jvm`, and the JVM build compiles both groups. The full original Android
framework and core libraries come from the selected runtime.

The JVM framework JAR and ART framework DEX remain distinct executable
representations. JVM portability adaptations apply to Java class files; ART
uses the matching Android DEX, services and boot files. Packaging both engines
together shares common files and native dependencies without replacing either
framework representation.

## Application preparation

### Installation and caches

MacLauncher's backend prepares an application and then starts a separate Java process, while the launcher's Electron renderer never runs application code and never performs
blocking conversion or native compilation. Prepared application code is cached
separately from persistent application data.

APK inspection reads binary XML declaration, namespace, resource-map and
character-data chunks using Android's resource layouts. Character data keeps the
element hierarchy and does not replace manifest attributes or declarations.
Launch labels, icons and activity window policy are cached by the verified APK
contents, including the ordered split package set, the locale and the resource
reader implementation. Moving the original inputs or replacing an equivalent
prepared generation keeps those cached resources.

Prepared APKs, converted archives, extracted assets and Android native ELF files
can share verified immutable content between preparations and applications.
Original imports and writable application data keep their own storage. Compact
candidate hints point to possible matches, and the exact content and file mode
are verified under the package preparation locks before anything is shared.
Busy or stale candidates are skipped. Mach-O libraries keep their own separate files so that loader-relative dependency resolution works. Removing a
retired preparation keeps files that another active preparation links to.

New preparation generations request native copy-on-write copies through the
macOS system copy utility, and fall back to ordinary copying on filesystems that
cannot clone. Imports keep their own writable files. Copies are staged
privately and published without replacing existing files, after the original source file and the complete APK hashes are verified. Cancellation removes
incomplete staged copies.

Prepared APKs keep the package's resources and split names, and native libraries keep their installed executable modes. Each generation of APK code includes its execution format, while the installation and its private application data keep the same storage.

Profile services hold installed APK generations through the same package source
manager. Independent installed packages prepare in parallel up to a fixed limit,
and each package keeps its own preparation lock, UID and caller data scope.
Process declarations keep catalog order, and a failed preparation waits for the work it started to finish before releasing its source generations. When application or
optional service code is missing, its installation metadata is removed while its
UID and saved files are kept. Concurrent discovery keeps newly published source
generations. Google service packages selected for a launch keep their installation record and report missing source files.

### Split APKs

Feature APKs join the original cluster parse, including their activities,
aliases, services, providers and receivers. Launcher inspection applies the base
application and SDK defaults while collecting split declarations in Android's
split-name order. Split application attributes do not replace the base
defaults, and the original parser decides the definitive component metadata, including each component's split. Signature, dependency and native-ABI validation covers the
complete package set.

For isolated splits, the base loader contains only the base APK, and the
original `LoadedApk` and `ApplicationLoaders` build the declared split
dependency hierarchy. `ContextImpl` supplies split resources and component
contexts. Initial Activities and local Services use the original split loader,
and providers and receivers follow ActivityThread's split routing.

### DEX conversion

APK preparation for the JVM indexes the complete DEX class set and records each
class's source APK and order. Original AOSP DEX and package class loaders
request converted class bytes as needed. A resident dex2jvm subprocess shares
its parsed DEX and constructor-resolution plan across those requests, and
converter dependencies stay out of the game JVM. Dynamically loaded DEX goes
through the same path. Prepared bytes can be shared without sharing defining
loaders. When a later APK contains a duplicate class, it uses the original
per-APK converter so that sibling definitions stay distinct.

Converted bytes are immutable cache entries. Their cache key covers the DEX,
the converter, the framework hierarchy and the actual parent-loader types that
conversion consulted, so native implementation changes and installation paths
do not invalidate them. Complete conversion metadata stays available in its
original ordered archive. When a parent lookup cannot be resolved, the exact
metadata class resource used as the fallback is recorded, including an absent
result. Changes to those consulted resources invalidate the affected
conversion, while unrelated metadata additions keep the cached class bytes.
Demand indexes use the recorded digest of the original ordered DEX, so repacking the ZIP does not invalidate them. Converter tools are
identified by their complete content hashes.

Requested class bytes go straight into the process's size-limited cache. One
background writer publishes immutable archives and maintains persistent storage.
Its queue refers to existing cache entries instead of holding another copy of
the bytes, and class readers never wait for the writer's publication or pruning
lease. Writer queues and artifact leases are independent of the byte-cache map
lock, and filesystem publication and deletion run outside that lock. Pending
persistence counts against the persistent cache's byte budget. A busy writer
defers further cache writes, while converted class bytes stay usable
immediately.

Classes share immutable facts about their parent hierarchy until the converter
asks for a new fact. Each snapshot has one context digest and is charged to
cache memory once, and hierarchy encoding follows the actual defining class
without holding on to loaders. Mutable delegating parents are resolved again
during validation, while the fixed boot and framework parent reuses its verified
snapshot. Persistent entries keep their original facts and checksums when the
context digest changes, and writer budgets include both class bytes and
hierarchy metadata. Maintenance reads each entry's timestamp once, removes
directories atomically under the shared mutation lease, and deletes their
contents after releasing the lease.

### JVM class loading and memory

Archives that an earlier preparation converted in full (eager archives) remain usable. Resource lookup and defining-class
identity stay with the original Android loaders, so separate loaders can share
class bytes while each defines its own classes. The original DEX loader
hierarchy registers for HotSpot's parallel class loading, with a definition lock
per class name. A cold conversion serializes only its module's converter
protocol, so warm class lookups proceed independently. Within one JVM session,
successful class-header lookups through the immutable platform loader share a
size-limited memory cache. Delegating loaders and metadata fallbacks keep their
normal validation, and shutdown releases the lookup cache.

The JVM entry point accepts Android internal class names and primitive,
reference and multidimensional array descriptors. Array components resolve
through the requesting original loader without class initialization, and
ordinary classes keep the original parent and shared-library delegation order.
The process and cache managers shut down conversion workers and
temporary inputs, protect live readers and limit reusable cache storage.

Converted calls to Android's `ClassLoader.getSystemClassLoader()` return the
immutable Android platform loader, which carries the full framework class path.
Original module filters therefore share only the application classes that their
own delegation rules select. Host JDK system lookups separately keep application
handlers, services, resources and instrumentation through the JVM system loader.

Android direct buffers use the JVM's shared memory scopes. Byte buffers, slices,
read-only views and typed views share revocation and reopening, while the
original MediaCodec code keeps control of buffer dequeue and release. The
mapping keeps native addresses and existing allocators, and existing
foreign-memory scopes keep their original lifetime. Framework calls and
converted DEX calls go through the same NIO portability boundary.

## Processes and identity

### Process authority

The process authority authenticates each process through inherited Unix sockets
and the actual operating-system process identity. Android application UIDs are
separate from macOS user credentials.

One profile-wide native lease manager hands out Android process and thread IDs
to both engines and to native libraries of either width, including the compact
IDs that original 32-bit Bionic synchronization uses. Physical macOS PIDs stay
separate and are used for inherited-channel authentication, ancestry, signals
and window and clipboard ownership. The retained child mappings exclude the
current process and keep a child's identity while it is a zombie, until it is
reaped. The physical-PID index selects the same numeric lease and checks its
recorded PID against the live kernel lock; it stores no identity or lifetime of
its own. Stable numeric lease files prevent inode and lock reuse races, and
reusing a retired slot removes its former reverse name. Older live processes
without an index entry can still be found by directory lookup, and a successful
discovery publishes their reverse name.

Command discovery asks the parent supervisor for a fresh kernel snapshot of the
processes holding the same private namespace directory. JVM, ART, application,
account and platform-service launches all use one inherited query channel
adapter, and the child cannot choose another directory. The native lease manager
resolves candidates through the index, checks their live leases and
reads Android command metadata from those leases. When the snapshot is
unavailable, it falls back to a complete namespace lookup. Sandboxed
applications gain no permission to inspect host processes.

Descriptors for new ID leases come from the executing VM's private descriptor allocator before publication or POSIX locking. The resulting handle stays the
same until its lease is released, and the application cannot close it by
replacing descriptors. The JVM keeps its own native descriptor ownership.

The authority protocol publishes both identities, Android and physical, before
the application receives its service capabilities. Platform service processes
hold profile-wide system state and KeyStore state, and installed application
services keep their package identity and data directories. Binder RPC carries
the original AIDL contracts, references and descriptors between these
processes. Each connection is closed by the same process and transport that
established it.

During an incoming transaction, Binder reports the authenticated Android
caller's process and user IDs. Outside a transaction, and after
`clearCallingIdentity`, it reports the current Android process identity, and
`restoreCallingIdentity` restores the saved caller through the original native
Binder token. Native Binder permission caching, debug process IDs and
transaction-error callbacks use the same Android identity. Socket
authentication and native connection thread keys stay with the host transport.
The Binder JNI library registers CursorWindow parcel operations after the
original Parcel metadata initialization, and inline and mapped windows both keep
the original Android serialization format and descriptor ownership.

Identity enrollment stays pending while its process and authority channel are
alive. Closing that channel or ending the process cancels enrollment, and no
separate initialization timer terminates a live application.

The runtime package's manifest declares its process-identity protocol. Active profile
services keep that protocol until their client leases close. If an incompatible
runtime is selected, running games keep their services, and a service is
replaced once nothing uses it. An acquired controller keeps its service during
application preparation, before process enrollment. Shutting a controller down
waits for in-flight process registration, and cancellation stops registration
before it moves on to another service. Queued requests from a closed controller
do not acquire package sources or create new enrollments, and an enrollment
already submitted to its service is withdrawn before its source leases are
released.

The runtime package's manifest also declares support for late service connections, and older packages keep their bootstrap connection protocol. Both engines start the
authority reader before constructing the application, and losing the authority
releases pending service requests without relying on the application's Looper.

The first authenticated packet supplies the profile's boot counter before the
application or any content provider is constructed. Launch and system-service
supervisors use the same private counter transaction and kernel lock, and
restarting a process neither increments the counter nor starts a service just
for metadata. Only the Android counter crosses the authority channel; the Mac's own boot identifier stays in private launcher-profile storage.

Provider startup diagnostics record the initialization stage and exception type
before the provider's authority descriptor is closed. Exception messages and
account values are excluded from these structural records. Requests keep the
connection's first terminal outcome, including its service role and whether it
was released, timed out or closed by its peer. Each descriptor transfer has its own receipt pipe, on which the receiver acknowledges the transferred descriptors. Closing a receipt leaves both the data connection it adopted and the parent authority stream intact, because the receipt is responsible for neither.

### Profile services

Profile services start when a process requests one of their declared endpoints.
Queries for declared endpoints and for the service list read metadata without starting the account service, KeyStore or the shared system process. KeyStore's endpoint declarations are generated from the original Rust and C++ code that publishes its services, and they keep the original AIDL descriptors. The requesting process holds its authenticated connection and controller lease. Releasing them ends that enrollment and lets the supervisor
stop a helper that is no longer used.

ART composition keeps only the system services it actually uses. Its Binder,
presenter, linker and original graphics services initialize alongside the
profile system process. The native window executable loads during system service
initialization and publishes its actual process identity. Exact endpoint grants
come before readiness, and authenticated system credentials reach the window
over its inherited launcher pipe only after readiness and process enrollment are
complete.

Package catalog updates and prepared-source leases use the system kernel lock,
with a holder that is released at EOF. Acquiring or releasing a source lease
starts no additional JavaScript VM, and when the controller exits, its pipe
releases the holder.

A profile service lease keeps one verified Java and native implementation while
applications use it. ART and JVM containers with the same common supplier share
that service. ART selects the verified common JVM package for these shared services independently of its additional execution image. The selection is identified by its complete file list and provider catalog. A different supplier
or process-identity protocol can neither replace nor reuse a leased service, so
changing either requires the existing applications to close. An idle service
shuts down under the profile's kernel lock before its replacement opens
persistent data.

Platform services identify their JVM supplier by the verified common file inventory, the runtime profile (the package's runtime ID, Java version and supported feature versions), native architecture requirements and the digests of the complete supplied platform image and package catalog. Image content, paths, symlinks and modes are recorded when the supplier is built. Assemblies that keep an explicit immutable image component reuse that image's recorded digest, and catalogs keep their own content digest, so launches read this metadata without hashing image files. ART execution versions are identified separately, and changing only those additions reuses the same platform process. Changes to common Java or native files, the runtime profile or the launcher adapter location replace an idle platform service through its kernel lease, while active controllers keep the current one until they shut down.

### Signals, scheduling and memory

Both engines apply the shared isolation policy to signals sent to the process
itself and to its children, including suspended-child startup and reaping. Java
`Process` signal methods and native signal imports resolve their targets
through the same retained Android child leases before signaling a macOS process.
AIM's namespace and terminal managers check both the kernel start time and the
process state. An exited child awaiting reaping therefore no longer counts as
live, and its terminal manager can close inherited output descriptors promptly.

JVM thread nice values map to Mach CPU precedence for both the current thread
and registered application threads. Java and native clients query the same
kernel priority, and CPU nice requests do not add Darwin background I/O
throttling. ART uses AIM's Linux scheduling adapter: raised display and audio
priorities map to Darwin thread scheduling, and background policies use Darwin
QoS. A change made by another thread takes effect at the target's next system
call.

Native process-memory vector operations resolve Android IDs through the same
live process leases and enforce the enrolled application identity before using
Mach memory copies. Invalid buffers return native errors without being
dereferenced in the adapter, and completed vector ranges keep their partial byte
count. ARM32 self-process vectors use the address-space manager for
both local and remote byte addresses. ART keeps AIM's original process-memory
syscall implementation and its authenticated remote-process transport.

ART's `smaps` and `smaps_rollup` views use the VM-map data and Darwin
page counts. Resident usage follows the mapped pages, and proportional and
shared usage approximate Linux accounting from Darwin's VM-object references.
Remote reads keep the original process credential checks. Memory queries use
each engine's native memory accounting and a shared ActivityManager threshold
calculation, and the ART process keeps its original Bionic system-information
interface.

### Process shutdown

The JVM's native layer also handles process shutdown. Its shutdown hook stops
new Binder transports, drains existing native sessions and releases native
service caches while Java callbacks are still available. Its terminal VM event
releases JNI metadata and prevents native threads from attaching afterward.
Original AOSP Binder objects keep their reference counting and destructors.

JVM processes install the standard JNI Invocation API exit callback before
creating the VM. HotSpot completes Java shutdown hooks, VM-death notifications
and VM cleanup before the callback applies Android's terminal process-exit
behavior. An existing VM exit callback runs first, and explicit guest libc
finalization keeps its original ownership and order. An explicit guest libc exit
uses Bionic's original recursive exit handling: it runs the calling thread's
destructors before the global guest destructors and then terminates with the
requested status through `_exit`.

Process shutdown attempts service, composition and profile cleanup
independently, even when an earlier step fails. After the authority channel
reaches EOF, the process gets its usual grace interval before a forced shutdown
with a time limit. The first failure is the reported result. Prepared inputs,
session files and composition descriptors are kept while a process has not
confirmed its exit. JVM Stop waits for the same shutdown sequence used for
window closure and process exit, including service and native composition
cleanup, and the backend stays available until that sequence finishes.

After each renderer drains its own surfaces and callbacks, the common
application manager shuts down services, providers, broadcasts, network and
location observation, permission registrations, resources and context state. A
partial ART startup uses the same path. The original failure stays primary,
later cleanup failures are attached to it as suppressed exceptions, and
repeating the shutdown has no further effect. Native composition and application
processes share one termination manager. Session files and descriptors stay
available until the process exits, including after forced termination, and
graphics publishers shut down concurrently. ART launch contexts can observe
named shutdown stages through `onRuntimeRetirementStage`. A failing observer
does not change the cleanup result, and ordinary launches have no observer.

Host runtime session mounts, Binder state and IPC live beside the application's
Android data directory. They are outside its data mount and are not part of
initializing imported Android files. Closing the runtime removes these session
files after its native processes and service leases have settled. Directory
removal runs asynchronously, with a limited number of filesystem retries for
native socket-inode bookkeeping that finishes during removal.

## Application lifecycle

Both engines share the application bootstrap, Activity lifecycle, context
services and application job initializer. The original ActivityThread,
LoadedApk and Instrumentation records share initialization and shutdown.
Application services have one initializer and lifetime manager for both
engines: physical window and audio services are supplied through typed
bindings, while service registration and the job lifecycle are common code.

The original process bind record, package context and services are published
before the APK's component factory initializes, and the factory's original
class-loader factory supplies the loader for the Application and the initial
Activity. Application and initial Activity construction call original
Instrumentation, including the APK's `AppComponentFactory`, the original
exceptions and a single application attachment. Activities created by the
factory keep the resolved Android component and its original `ActivityInfo`
during attachment.

Provider publication uses the same verified preference lease and happens before
the original Application `onCreate` callback. Process selection uses parsed
component metadata. The original `ActivityThread` chooses each provider's
context from its `ApplicationInfo`, and still creates a package context when an
Application overrides its reported package name. Disabled components stay
excluded through Android's component state and enabled flags. Activity
attachment and local service routing use the installed component's package, UID
and process instead of the package name a Context reports, and remote service
requests use the configured process principal as their caller. The original
`LoadedApk.AppComponentFactory` creates ordinary and job services with the
application loader, and substituted classes keep their declared service name
during the original `Service.attach` and lifecycle callbacks.

Supplied provider APKs are indexed from their original manifests. Providers in the Android system shared user load lazily in the shared system process,
through the original package parser and the ActivityThread provider lifecycle.
A synchronous local acquisition from another thread waits for the main-thread
attachment. Concurrent requests share one installation, and a provider's
reentrant lookup during startup reaches the same instance. Remote holders keep
Android's asynchronous publication callback and the original caller permission
checks. Lazy system-server service constructors run on their main Looper, even when the first request arrives on a Binder worker, so provider
construction and its reentrant Settings reads stay on the original system
thread.

### Activities and tasks

Both engines keep one `HostActivity` task manager across navigation and
configuration relaunches. Closing the task shuts down its current Activity stack
on the manager's thread, while the output and display source stay available to
the original pause, stop and destroy callbacks. Initial and navigated Activities
use the original `ActivityThread` destruction, which marks an Activity as
finishing before its pause, stop and destroy callbacks. Task removal follows the
original root-only and always-remove modes, and an ordinary Activity finish
keeps the remaining task records.

An accepted local Activity launch keeps its queued handoff until its main-thread callback completes, so a display turn between finishing a launcher Activity and
creating its successor does not shut down their shared output. Task-empty
notifications run after queued Activity requests and check the current task
against the same window again, so a launcher can also finish before starting its
successor without shutting down the successor's output. Up navigation uses the
same task manager and keeps the original destination Intent, caller result and
launch mode: reusable parents receive a new Intent, and standard parents go
through ordinary Activity creation and replacement.

Remote service binding and Activity launches wait for process publication
through the destination's asynchronous readiness future, and the calling Android
Looper keeps running while the destination starts. Original Binder service
callbacks report connection, null binding and process death, and unbinding
cancels pending and connected requests together. A connection that completes
after cancellation is released immediately. Publication and shutdown callbacks
run outside the process-directory lock.

### Pending intents and broadcasts

A single build-time binding, `PendingIntentCalls`, redirects the original PendingIntent service destinations in classfiles and DEX to `HostPendingIntentDispatch`.
Android's original controller and record keep token identity, flags, options,
result handling and cancellation, and the shared activity, broadcast, service
and alarm managers receive the original call arguments. Shutting down the queue
cancels the original PendingIntent tokens before unpublishing the AlarmManager
their controller uses, and an explicit application cleanup removes that
subscription.

Remote broadcast routing uses the same reusable daemon executor in both engines.
The original `LoadedApk` and `ActivityThread` deliver receivers, and the
broadcast manager keeps result ordering and shuts down its executor with the
application.

### Compatibility changes

Original Android compatibility callbacks receive the complete generated change
configuration for the application's target SDK, and the platform compatibility
policy keeps upstream SDK-dependent behavior for older and current
applications. The shared compatibility service reads the JVM's packaged
generated definitions, or ART's matching system and active APEX definitions,
through the original Android configuration parser, so both paths apply the same
target-SDK and permission logic.

The original service is prepared before package shared-library policy runs. Its
process-wide ApplicationSharedMemory instance is initialized before
configuration loading invalidates the original compatibility cache. Shared nonce
mappings, change notifications and read-only client permissions keep their
Android APIs. Application binding then activates the original package receiver
and installs compatibility callbacks for the parsed target SDK.

## Platform services

### Packages and device features

Native package clients use the complete `IPackageManagerNative` Binder contract
over the same parsed installations as `IPackageManager`. UID names, target SDKs,
versions, signing certificates, package flags, audio-capture policy and hardware
features come from the same sources in both. Module metadata comes from
Android's configured resource. Runtime updates come from MacLauncher and create no staged APEX sessions, and the endpoint keeps ordinary observer registration and Binder
cleanup.

Package queries and original manifest parsing read named device features from
one source, so feature-conditioned permissions follow the same virtual
touchscreen, pointer input, audio output, orientations and RAM class that
applications see. Graphics versions come from the selected driver's actual
capabilities, and host capture devices remain separate permissions. A named
hardware-feature query evaluates the matching device capability without
initializing unrelated graphics suppliers. Full feature enumeration and device
configuration keep the actual EGL version query, whose cache does not depend on
process state or importance queries.

### Permissions and application operations

The platform process declares the sensor-privacy endpoint without starting its
service. The first lookup starts the original service, including its state
controller, persistence, permission checks and listeners; ordinary display and
media startup do not initialize it. The platform process also hosts the original
telephony event registry, whose internal user and application-operation calls
use the profile's identity and policy services.

Native audio permission updates use Android's original
`AudioServerPermissionProvider` with the same package catalog and permission
decisions. Native composition services register in the same service directory
under their authenticated process scope, with the shared profile services as
parent entries. Each live native audio-policy service receives the original
provider's package and grant updates, and ending a process removes only that
process's endpoints. Native audio initialization joins the original
permission-update barrier after policy publication and then commits the shared
stream ranges. Application construction waits for this initial audio readiness,
while other native services and process setup start concurrently.

After context setup, an application publishes its complete local service
directory over its existing authenticated connection. Sensitive permission
checks query that application's original `IPermissionManager`, which accounts
for its manifest, explicit device selections and macOS authorization. Original
permission listeners pass changes to the profile provider, and connection or
Binder death releases the corresponding transport leases. Local checks stay in
the app process, and reverse calls run outside directory and permission locks.
Authenticated process enrollment gives the system catalog the installed APK set before accepting the process, and the system sandbox reads installed code
without access to app data. UID state queries aggregate live, authenticated
process activations instead of macOS user identifiers.

Permission checks keep the original process-wide `SystemConfig` instance. Its
UID grants and split-permission declarations stay in force across repeated
checks without re-entering its system-server caller diagnostics. Package
metadata calculates requested permission grants only for `GET_PERMISSIONS`.
Signature grants keep full original APK verification. Grant enumeration
snapshots the requested permission set before verification or remote queries,
so unrelated local permission checks can proceed.

The private Android user keeps its original full-user classification. Android's own user-profile and icon-badging clients use that user without adding a managed (work) profile.

The all-files access Settings intents open an embedded Android settings window
for the calling application. Its toggle stores `OP_MANAGE_EXTERNAL_STORAGE`
through the permission-decision store, and the original
`Environment.isExternalStorageManager()` reads that AppOps state. Access covers
the application's existing Android storage volume and exposes no additional Mac
folders. Closing the settings window delivers the ordinary Activity result and
resumes the caller on its Android main Looper.

Application operation starts keep their client Binder, UID, package and
attribution. Nested starts balance their finishes, and the last finish, client
death or application shutdown releases the operation's death subscription. UID
and package mode changes require Android's application-operation management
permission and use the same persisted permission-decision store. Switch
operations share their mode, unchanged writes do not notify watchers, and raw
queries keep foreground-only modes; Activity state determines the effective
mode. Watchers keep their original registration flags: specific operations
report their own code, legacy switch callbacks report the switch, and package
watchers receive the switch family. Foreground transitions notify only matching
foreground watchers. IGNORED mode pauses started operations, ERRORED leaves their
started state unchanged, and other written modes resume them subject to the
original package and restriction guards. Nesting and Binder ownership survive
pauses. Android mode choices never grant physical device access.

### Settings and shared memory

The JVM package includes the original AOSP SettingsProvider APK, its resources
and its Apache notice, independently of optional Google integration or an ART
image. `platform/packages.json` locates these supplied APKs, while an ART image
keeps its original provider catalog. The component's binary definition records its checksum, its source reference and the system image it came from separately.
SettingsProvider keeps Android's permission checks, aliases, defaults,
mutations, change generations and persistent settings files. Application
Android IDs keep the installation's existing random identifier, and neither
these settings nor the identifiers read macOS settings or hardware identity.

Shared settings generations use the original AIM ashmem inode representation
across native and Android processes. Original MemoryIntArray clients keep their
parcel, atomic access, protection and close behavior. Anonymous backing files
issue an exact-file sandbox capability before they are unlinked. Native
descriptor attachments carry that capability, and its lease and auxiliary
handles follow the existing file description or AIM descriptor through
duplication, fork, exec and final close. The capability covers only the received
file, so neighboring private files stay isolated.

Native shared-memory protection accepts the original READ, WRITE and EXECUTE bit
combinations, including an empty mask. Protection changes can only remove bits.
New mappings are checked against that shared mask and report native mapping
errors. Removing WRITE adds a write seal to the native descriptor, and existing mappings stay valid.

### Accounts and KeyStore

The account service has one profile-wide database. Google integration is chosen
per game: disabled, installed services without an account, or an existing
selected account. Authenticator applications run as their own packages.
Explicit sign-in uses network access and keeps the account service's database
across games.

The verified Google provider's service broker keeps its original callback
contracts. Noninteractive game requests receive `SIGN_IN_REQUIRED` without the
optional account-resolution PendingIntent, both during service binding and in
the later Games Connect sign-in result. Other connection metadata, successful
service responses and explicit account-tool resolutions are unchanged. The
provider's original Parcelable creators read connection metadata and sign-in
status.

Startup failures keep their original exception type and location while the
service shuts down its processes, and lifecycle diagnostics exclude provider
output and account values. Account bootstrap failures also record the original
initialization phase before the service adapter returns, including failures
before a JVM starts. Lifecycle records include recognized operating-system and
account-service error codes, without error messages or filesystem paths. Native
execution records window-loop failures before Activity teardown starts,
including when an application's destruction callback terminates its process.

Android Conscrypt and BoringSSL provide Android's cryptography and TLS, while
JDK callers keep their JDK providers. The supplied trust data and service identities are recorded with the exact inputs they come from. KeyStore links the original
service implementations to the shared Binder and cryptography code. The shared
application bootstrap installs the original Android KeyStore provider before
component factories and application code run, and key operations go through the
authenticated profile service under the application's Android UID. KeyStore
keeps its database in the profile's private service data directory,
independently of the selected runtime version or the process that runs it.

### Power and sleep

Both engines report the same virtual Android battery: 100%, on AC power, fully
charged and healthy, with battery saver off and nominal thermal status. These
values live in the common Android service implementation, and no Mac battery or
thermal observers or notification threads run. Android battery clients and
internal controls keep their original contracts. Game wake locks are logical
tokens owned by the app. They create no Mac power assertions, do not reset the
idle timer and do not wake the computer.

Mac sleep and wake notifications enter the window event queue and the
original Activity pause and resume path. Focus restoration stays suspended while
the computer sleeps, and on wake only the current surviving Activity resumes.

## Windows and graphics

### Mac application and windows

Both engines use the same signed Mac application entry, Android label and
rendered icon, IconServices operation, shader-cache access and LaunchServices
bundle grants. The shared native application layer handles SDL and AppKit
startup, Dock identity, icon assignment, foreground eligibility and shutdown,
while engine adapters pass identity data and keep their own VM references.
Background launches do not activate the application, and windowed applications
remain ordinary Dock applications. Game windows use the launcher's dimensions
and do not take part in macOS saved-window restoration: the shared application
layer sets SDL's state-restoration policy before AppKit processes the initial
launch event.

| Platform responsibility | Shared implementation | Engine-specific boundary |
| --- | --- | --- |
| App name, icon and Mac bundle | `package-metadata.js`, `application.js`, `application-platform.h` | JVM entry or native ART presenter executable |
| Window, drawable and lifetime | `window-physical.h`, `session-core.c` | VM surface references and original producer transport |
| Android surface composition | Original `Surface` and `SurfaceControl` APIs | JVM `HostSurface`/`HostSurfaceControl` adapters; ART original SurfaceFlinger |
| Keyboard, composition, pointer and scrolling | `window-input.h`, `HostInput`, `HostScrollInput` | JNI delivery or the ART input pipe |
| Audio devices, PCM mixing and volume | `audio-device.c`, `audio-pcm.c`, `audio-volume.c`, original Klepton audio source | Original Android media/AAudio transport |
| Physical network state and ad policy | `connectivity-core.h`, `network-policy.c` | JNI notification or ART host-call notification |
| Google integration and account selection | `launch-policy.js`, `service-processes.js`, `google-accounts.js`, account service | APK process execution |
| App files and process identity | `storage.js`, `storage-namespace.json`, installed-package services, `ProcessAuthority` | JVM path translation or original ART VFS mounts and native IPC |
| Application and initial Activity creation | `HostApplication`, `HostActivity`, original `Instrumentation` and `AppComponentFactory` | Application class loader |
| Provider startup | Original manifest parser and `ActivityThread`, `HostPlatformPackages`, `HostContextServices.installProviders`, verified provider preference lease | Application class loader or lazy shared system process |

The shared Activity manager chooses a typed physical window binding for the
initial Activity and for later launches. The JVM binding uses its native window
session, and ART uses original Android surfaces that belong to the existing output.
Cross-process Activity options carry a scoped output capability. Child surfaces
keep the same display and input handling, and closing a child returns input to
its parent. Initial attachment and resizing carry the committed output's screen
identity, extent, refresh rate and density while keeping Android's default
display ID. The capability carries physical focus, sleep and wake, and shutdown
to the child Activity.

Wheel and text intents enter the same shared Android input handling in the
receiving process, and input completion keeps the original ViewRoot handled
result. ART delivers pointer and key events through original Android input
channels, including their size-limited socket queue and completion protocol. The
physical input capability follows the application window across Activity
replacement, so events reach the current Android input handler instead of a
destroyed Activity's view.

Activity orientation requests follow one output policy. The JVM applies it
through its native window session, and ART selects an actual native window mode
through the original SurfaceComposerClient and Composer3 interfaces. A shared
Mac placement routine fits each orientation to the screen. Original rendered
buffers commit the display dimensions and pointer coordinate extent together,
and physical pointer positions map from Mac window points into that committed
Android display extent. Window selection and local coordinates use the original
ViewRoot's screen frame, and Android applies window compatibility scaling and
view scrolling through its original input stages.

One build-time list of UI callbacks generates both the JVM bytecode and the ART DEX bindings. The original `ViewRootImpl` attachment, detachment, input
completion and input-token methods keep their implementations, and both bindings
notify the same window and input handlers. The DEX encoder uses dexlib2 to
relocate branches, handlers and debug positions around those callbacks.

Android windows initialize touch mode from the platform resource. The original
ViewRoot input stages keep keyboard navigation, focus highlights and the switch
between navigation and touch mode on pointer input.

The JVM window pump yields between completed Android callbacks once a physical
display interval has elapsed. Native input and Canvas frame publication can
progress while animations keep the original queue busy, and callback execution,
message order, barriers, native descriptor events and idle handlers stay with
Android's original Looper.

### Window shutdown

Both window bindings tell the shared process authority about an explicit native
close before running Android teardown. Input transport shutdown and process
failure are kept distinct from a requested close. JVM Activity cleanup keeps the
physical output through pause, stop and destroy, and the central window manager
detaches presentation before removing display callbacks. The initial ART output
and service Activity outputs use the same window shutdown sequence. Activity
teardown failures keep the first exception while compositor detachment and
window cleanup continue. Display callbacks stop after compositor detachment, and
an active producer keeps its window through the native close barrier.

When a window closes, ready callbacks up to an asynchronous marker in the
original message queue are drained before the output lease is released. Later
callbacks, synchronization barriers and the surviving application's Looper stay
with Android, and the JVM window pump keeps its own nonblocking native-poll
deadline handling. Closing a window leaves the application and its Binder
services running. Native display shutdown services the Android-side queue while
callbacks are executing, and waiting for its dispatcher thread to exit does not
start unrelated application messages.

Window teardown waits at most one second for submitted Metal work. Completed and
failed command buffers both allow resources to be released. The first rendering
exception stays available while EGL surfaces, fences and presenter references
are released, and work still in flight keeps its dependent resources for a later
attempt. Device initialization publishes its queue and shared events only after
all allocations succeed.

### Composition and presentation

One native window and surface layer connects Canvas, GLES, video and native
activities to the physical Mac display. Presentation uses the committed backing
extent and the producer's actual content dimensions, and graphics settings
attach to the same launch and presentation paths. Canvas overlays use the native
producer's actual pixel origin before the common presenter applies its display
transform, so top-left Vulkan images and bottom-left GLES images get the same
Android UI placement. Canvas changes are also redrawn over a completed GPU
snapshot of the native image, so text and controls update independently of the
game's frame rate. The same size-limited image pool and common graphics
presenter handle these redraws, and empty overlays add no native image copy.
Audio, video, image storage and JNI references keep their original ownership
through asynchronous work and shutdown.

Typed physical bindings choose the native surface representation, the shared
audio device and optional sensor publication, while service policy stays in the
common implementation. The native presenter reports buffer release independently
of physical display, including for occluded windows. ART passes its present-fence
observer to the shared graphics library through
`rsSubmitFramePresenterObserved`, with separate callbacks for source-buffer
release and presentation shutdown.

On the JVM, `HostSurfaceControl` implements the `SurfaceControl` transaction
boundary. Transaction completion follows `HostSurface.Target.onFrameCompleted`
when the output accepts the Android frame. `CanvasFrameSource` holds
one copied latest image with its frame identity and latch timestamp, and a newer
image can coalesce earlier transactions before physical display. Mac window
visibility, drawable availability and physical display completion do not delay
that Android latch. Original `TransactionStats` objects expose the latch
timestamp and an empty present fence when the output exports no Android fence
descriptor. Physical presentation timing and dropped-frame metrics are tracked
separately. Transaction sanitization checks the process-private transaction
capability, and local layer transforms keep their meaning. This scene has no
global Android display or input-command authority and cannot address another
process's layers. ART keeps its matching native SurfaceControl and SurfaceFlinger
implementation.

ART composition waits for native services to publish through the original
`IServiceManager::waitForService` registration callbacks. Each wait belongs to
the composition session and ends on launch cancellation or service-process
failure. Directory startup uses an original Binder transaction that tolerates a
missing SurfaceFlinger before its process starts. Native service startup checks
the original Binder directory with a single `checkService` transaction before
starting the graphics services, and each required service then gets its own
registration check. Startup does not enumerate unrelated services or request
their interface descriptions.

The window executable loads and publishes its actual process identity alongside
composer and SurfaceFlinger initialization. Its inherited startup channel stays
blocked until those services publish and the process authority registers that identity, and only then does window initialization contact platform and display
services. The original system-suspend, media-metrics and audio HAL publishers
initialize concurrently, and a combined registration wait keeps their individual
process dependencies before audioserver starts.

Original SurfaceFlinger and media services keep Android's composition and media
state, while typed physical operations use the shared Mac session, display
clock, presenter, text input and PCM output. Native Choreographer deadlines and
physical display timestamps share the same uptime clock, so time the Mac spends
asleep does not postpone frame callbacks. Generated surface timestamps and timed
video release use the same clock, while media presentation timestamps stay as
the decoder or producer supplied them. Bionic native Choreographer calls use the
complete typed NDK family and the same thread-local Looper as Java queues and
native descriptor events. Frame, vsync and refresh callbacks keep their calling
image's identity and run on that Looper's physical thread. Queued callbacks end
with the original native frame source, and native C threads keep their existing
Java attachment state.

Both engines use one native frame-timing reporter with a size-limited history.
Records separate application production from original SurfaceFlinger
composition, with separate accepted and macOS-presented rates, frame intervals,
submission time and source and output extents. Frame records go to the retained
Android log destination even when the application redirects or closes its
standard streams. The native presentation service log keeps a startup segment
and two recent segments.

### Surfaces, buffers and video

PixelCopy reads the raw submitted surface before effects and scaling, even when
its producer is idle. Native drawables, EGL window buffers, projection slots and
decoded frames keep their source leases through GPU readback. EGL windows keep a
stable surface identity while rotating through up to three backing images, and
an image is not reused until its readers finish. Swaps copy the preceding
contents only when preserved-buffer behavior is explicitly selected. Directly
writable hardware-buffer sources use a three-image GPU snapshot pool capped at
128 MiB per process, inside the producer fence.

Planar video uses the same CoreImage conversion source for both engines. The
original ART allocator supplies the NV12, NV21, YV12 or P010 plane offsets,
strides and color metadata. Its EGL image registry keeps the mapped
buffer, and acquiring an image refreshes its Metal texture through the original
external-texture binding. Acquire and read fences protect CPU-accessible plane
views, and Metal shared events order the converted pixels before sampling.
CoreVideo consumes NV12 and P010 directly, and Accelerate normalizes NV21 and
YV12 chroma ordering without replacing the decoder or BufferQueue. Releasing an
image waits for pending source reads before releasing the original mapping. The
GLES driver and GPU host-call implementation are delivered together with their
matching protocol version.

The ART EGL window surface holds a dequeued producer buffer before drawing and
sizes its framebuffer from that buffer's extent. Consumer default dimensions stay
available through the original native window queries. Queueing a buffer
transfers the copy fence, resizing follows the next acquired buffer, and
destroying the surface cancels an unused buffer before releasing the native
window.

ART window presentation resolves multisampled color into a single-sample
attachment before applying orientation or scaling. That attachment shares the
existing imported image and GL context lifetime, and the application's
framebuffer, renderbuffer and scissor state stay intact. Framebuffer operations
use the original OES entry points for an ES1 context and the core entry points
for ES2 or later, keeping the application's GL error state during presentation.
Legacy contexts use the advertised NV framebuffer blit extension for reversed or
scaled destination bounds, with the same Android row origin as core ES3
presentation. Multisampled sources are resolved with identical bounds before
either transformation.

`ANativeWindow_fromSurface` and `ANativeWindow_toSurface` keep the same buffer
consumer. A returned Java `Surface` has its own wrapper ownership, so releasing
earlier Java wrappers keeps an acquired native window usable. The last native
reference releases the consumer after the window lock is dropped.

On the JVM, the ImageReader boundary keeps the original ImageReader, Image and
plane objects over the shared Surface and HardwareBuffer handling. Acquired
images and returned hardware buffers hold their own buffer references.
App-controlled producers replace the queued frame without waiting for their own
consumer, and maxImages limits acquired Images until they are closed, including
detached Images. Direct producer buffers keep their actual dimensions, format and
dataspace. The original PublicFormatUtils APIs use Android's device mappings
between public formats, HAL storage formats and dataspaces, including encoded and
depth data. Native storage supplies packed RGB, FP16, flexible YUV420,
P010/P210, monochrome, RAW16 and encoded BLOB planes with their actual row and
pixel strides. PRIVATE images keep opaque producer storage and expose no CPU
planes. Encoded and raw formats need the corresponding producer bytes.
RAW10/RAW12, RAW_PRIVATE, NV16, NV21 and YV12 allocation paths are not
supported. A failed native video delivery clears its own JNI exception so later
frames can still be delivered.

On the JVM, fences use the complete original `SyncFence` JNI unit, the `libui`
`Fence` implementation and the `libsync` module, together with the shared Binder descriptor handling. JNI exports come from the original registration
table. Android keeps reference counting, descriptor ownership, waits and Parcel
serialization, and Darwin supplies descriptor polling and closing. Linux
sync-file ioctls keep their original declarations and normal descriptor errors.

The generated guest library that forwards EGL and GLES calls keeps the complete NDK and ANGLE extension declarations. Callback functions and user pointers stay associated with their
original graphics context, and destroying the context releases their native
holders after active callbacks complete.

## Input and text

Original Android input connections receive native text composition and keyboard
operations. Explicit copy and paste gestures transfer text through the launcher,
and background clipboard reads are kept apart from Android's private clipboard
state. Closing a native connection ends its matching composition session. The
original editor's cursor anchor and view transform position macOS input
composition next to the Android caret. The physical window maps Android render
pixels to logical window points, including Retina scaling and resolution
multipliers. Geometry updates follow the active connection and stop when its
editor detaches.

When the physical window runs in a separate process, its process identity, which the supervisor manages, authorizes clipboard gestures for that application. Closing
either process ends that relationship, and enrollment never reads the clipboard.

Per-game keyboard touch controls can map WASD, arrow keys or both to a virtual
joystick. Its center is measured as percentages of the display width and height,
and its radius as a percentage of the shorter dimension. Movement keeps one
stable finger while the mouse operates another, using original Android
multi-pointer events and view-root dispatch. WASD mapping is on by default,
pauses during text editing, leaves Command shortcuts to the keyboard, and
releases its contacts when focus changes or the Activity ends. Controllers and
wheel and trackpad scrolling keep their own input paths. Touch-joystick and
manual-motion settings go through one application configuration reader and the
same input handlers, including position and radius validation.

Keyboard construction uses the same complete character-map resource and device
registration in both engines, and each engine invokes its original Android
native parser. Android's resource configuration reports an exposed QWERTY
keyboard for the SDL keyboard source.

Manual motion has one descriptor, keyboard and controller input, and sampling
implementation in `HostSensors`. The JVM's sensor queues read it directly.
Original ART native clients use the image's SensorService and AIM's original AIDL sensor HAL, whose physical source reads the same descriptors and samples
through a per-application shared-memory publication. Only the interactive
process publishes that source, and its service processes share the native
service. The original HAL keeps Binder, activation, flush and FMQ delivery, and
original FMQ storage uses the memfd implementation.

## Audio and media

Both engines compile the same CoreAudio device discovery, format, latency,
route-monitor lifetime, PCM mixing, volume and pause implementation. JNI and the
original audio-ring host-call protocol only translate their own transport
records and callbacks. Shared stream-activity policy queries the executing
engine's audio implementation through the same volume and activity binding: ART
uses the original `AudioSystem` and native audio policy service, and the JVM
uses its existing physical player activity.

The physical PCM output exposes one optional filter for the life of the process,
applied after mixing and Android stream gain. It receives the original rendered
samples on the CoreAudio callback. Filter implementations keep their
code loaded until the process exits and do no blocking work on that callback.

The JVM decoder and player binding is separate from ART's original media
clients. Decoded MediaPlayer and SoundPool clips share immutable PCM samples
while keeping independent playback clocks, looping, rate, seek and channel gains
in the same mixer. Copies keep their samples through playback and release and do
not open a separate Mac audio player.

The JVM's native MediaCodec layer uses VideoToolbox for AVC and HEVC and the decoder-only libvpx library for VP8 and VP9 profile 0. Both decoders
deliver retained CVPixelBuffers to the same input and output leases, callbacks,
timestamps and Surface handling beneath the original AOSP Java and NDK clients.
libvpx I420 planes are copied directly into a size-limited NV12 pool, keeping
color attachments and using the same byte-buffer stride and native Surface
presentation paths. Software decode discovery reports its 4096 × 2304 limit and
supported profile, and other VP9 profiles return the ordinary unsupported-format
error.

Runtime profiles with AAudio support map `libaaudio.so` to a generated guest library that implements the complete typed NDK API over the native Mac PCM stream. Builder callbacks are copied into each opened
stream and stay valid after the builder is deleted. Native audio feeder
callbacks keep authenticated application-image ownership and one original Bionic
pthread until the stream shuts down, with Java attachment controlled through the
original VM APIs. Releasing a stream joins the feeder before freeing its
buffers, and closing it then releases the stream object. Capture follows the
selected-input and microphone-permission policy of the native audio device.
Stream attributes keep their adopted values, and hardware queries read the live
native PCM format. Compressed offload and stream presentation timestamps return
`AAUDIO_ERROR_UNIMPLEMENTED`.

Output AAudio streams report consumed frames in the stream's sample-rate domain.
The original PCM writer publishes each stream's committed range, and getters
read atomic snapshots without taking producer, device or stream locks. Callback
frames that were not submitted do not count as consumed. Counters stay
independent and monotonic, carry actual consumed progress across device cursor
resets, and keep their final values after the stream is released.

OpenSL ES player and recorder configuration uses the original Wilhelm value,
size-query and object-state algorithms in the shared stream implementation.
Playback stream types and recording presets are per stream, and performance
queries report the shared buffered CoreAudio path after realization.

Explicit microphone and camera selection goes through the same launcher
permission request, sandbox capabilities and capture implementation. Engine
bindings marshal device identities and PCM or camera buffers, while the shared
physical capture layer handles capture conversion, device authorization, stream
tokens and shutdown. Microphone resampling and anti-alias state use Klepton's
original conversion code in that same layer, shared by the AAudio and media
input bindings. The media platform component manages selected devices, capture
authorization, microphone stream lifetime and camera sessions; engine adapters
marshal strings, tokens and sample buffers and keep no media policy of their
own.

## Storage and files

### Storage namespace

Each application has private persistent files, preferences and caches under the
selected launcher profile, and temporary launcher profiles use separate storage.

Java and native I/O share explicit application storage aliases, including scoped
external paths built from the application's canonical private-files root. Each
alias resolves once to the storage it belongs to, and device-protected storage
and other packages keep their separate paths. The common storage namespace maps
private credential-protected and device-protected data, external files, cache,
expansion assets and media to the existing installation. The JVM bindings
translate host paths, while ART exposes the same aliases through its original VFS and keeps native Android partition and session roots. JVM `File`, stream and
NIO path operations also use the native layer for virtual `/proc` and
`/sys` files, keeping the original JDK descriptors and errors.

Fused module archive names come from one planner over the original parsed
`ApplicationInfo` metadata and split catalog. JVM path mappings and ART read-only
VFS binds reference the containing APK, and real installed splits take
precedence. Both paths keep the original inode and package identity without
copying archives or registering additional packages. Installed base, config and
asset-pack APK names are preserved in native filesystem mappings and
class-loader source paths.

Original Linux descriptors keep their opened mount in the descriptor table. Proc-fd paths follow the current vnode name within that mount across
duplication, renaming, fork and exec, which keeps Bionic's canonical-path
behavior when several Android aliases refer to the same storage. Synthesized
proc files keep their canonical virtual name in the same descriptor metadata.
Native maps snapshots record their origin on the snapshot inode, so duplication,
fork, exec and later snapshot replacement keep the opened file's name
independently of its temporary storage.

Native files keep allocation, positioned I/O and mapping operations after the
shared descriptor table adopts them, and their original access modes apply.

### Sandbox and installed code

Path translation and the process sandbox confine file access to the
application's grants and the shared read-only runtime inputs. Explicit file
import copies the selected file into application-owned storage. Empty filesystem
or executable capability collections grant no access.

The JVM sandbox allows execute-permission checks on verified, read-only installed
ARM ELF files through exact-file capabilities, and excludes host binaries,
scripts and writable paths. Shared ELF files keep these capabilities only when
all their hard links belong to verified prepared inputs outside writable
storage. This does not let the JVM execute Linux ELF child processes.

App and provider processes have distinct mount views but share the session's
native descriptor metadata, so Binder transfers keep socket and file ownership
across processes. Executable access follows immutable installed-code roots, and
writable app data stays separate. Authenticated installed-package records supply
exact read-only APK, split and native-code mappings. The package-code initializer sets their Android root ownership and readable modes, and other
packages' private data roots stay unmapped. Native IPC uses directory-relative
sockets inside the private session directory, so launcher profiles with long filesystem paths work.

ART's default installed-code view is root-owned and readable. Executable files
get guest mode `0755` while explicit guest metadata and the host's private
permissions are kept, and mutable application files keep their guest owners and
modes. Native code metadata initialization uses the same per-package kernel lock
as APK verification and publication. Reusing a prepared generation keeps its
existing inode attributes and digest-cache identity. Initialization declares each
installed-code root without walking its descendants, standalone code files record
their metadata once, and writable application data keeps its separate import
policy.

The installed-code initializer covers each mapped package and native directory,
keeping host-private modes and explicit guest inode records. The macOS sandbox
permits ownership-attribute reads on those exact directory nodes without
granting access to their contents or to adjacent package files. The original
linker checks and selects existing library search directories; configuring a
search path does not grant access to a library.

ART reads assets directly from the original APKs, while JVM filesystem asset
consumers use extracted inputs. Unused extracted ART assets are removed by the
package preparation manager once its generation readers release them, keeping
APK paths and native library inodes.

### ART file ownership

Imported application trees declare their default Android owner on the root
inode. ART's original inode metadata layer fills in missing fields when a file is
first used and keeps explicit ownership and modes. Files created by the guest go
through the original creation path. When inode metadata is recorded, the
physical host owner keeps the access it needs to store that metadata, and
Android sees the requested mode under its umask, including mode `000` followed
by `fchmod`. Default lookup stays inside the writable VFS area.

Enrolled installed-code files and directories use the same import default, with
root ownership, directory mode `0755` and file mode `0644` plus any existing
execute bits. The original VFS synthesizes missing code fields without writing
descendant metadata, and explicit inode fields and original image metadata take
precedence. Read-only aliases use the same declared physical owner.

Published mounts bind each existing host root to its physical path once while
keeping the guest path. Imported-owner lookup compares containing host paths
before checking mount visibility or reading an import declaration. Canonical
roots reuse the original VFS path cache, and dynamic aliases and later symlink
targets keep their original namespace behavior. Links keep the same inode
metadata, and directory moves carry the import default to descendants. Launch
setup does not enumerate application data, and its cancellable subprocesses
leave the backend control loop free.

## Network and web content

Network permission is chosen per game and applies to JVM, native and embedded
web requests, and Android connectivity state follows it. Advertising policy and
external-link requests are handled at the host network and intent boundaries,
without removing Android framework APIs. External browser navigation requires
an explicit approved action. Location is supplied only when requested and
manually configured.

Connectivity uses the same passive Mac route observer and application network
identity in both engines. Under ART, the matching image's original DNS resolver
keeps its query, cache and Binder interfaces, and its physical policy interface
applies the same per-app network isolation and advertising policy. Resolver
addresses and search domains come from the Mac's current network configuration,
with no added public DNS fallback. ART service lookup errors keep the original
service-manager transaction status, so an absent connectivity service can be
told apart from an IPC failure.

`HostTrafficStats` supplies mocked accounting: device, interface and per-UID
byte and packet counters remain zero. Usage sessions return empty summaries,
histories and UID lists. The service reads no host counters and uses no native
accounting entry point. Its shared socket tagger completes tag and untag requests
as no-ops, preserving descriptor ownership without labeling Mac traffic.

The ART Linux socket layer keeps the multicast scalar and membership record
layouts. UDP pending-byte queries return the native payload count of the first
datagram, excluding source-address and control storage and leaving queued
packets in place, and stream queries return the native readable-byte count.
Datagram receives keep Linux's full-length `MSG_TRUNC` results. A receive across processes is accepted only with the socket's allocation receipt, a trusted record that travels with the socket. Readiness waits happen outside that check and keep nonblocking mode, receive timeouts and zero
descriptor limits. IPv4 TTL and loopback values are adapted to Darwin's byte
records, and IPv6 keeps integer values. Interface selections and group
memberships resolve through the same Linux device layer and physical network as
other native sockets.

### Browser links

Original package resolution handles installed Android activities first. An
unresolved `ACTION_VIEW` with an HTTP or HTTPS URL can request the Mac browser
through the shared approval step, and Android package, component, MIME type and
category metadata do not prevent that fallback. Network isolation and
advertising policy apply before browser approval, and approval never gives
Android code direct browser access. The Java bridge uses the JDK URL parser for
explicit ports, internationalized hostnames and IPv6 addresses, and the host
broker normalizes the destination before requesting approval. External HTTP and
HTTPS links use the same inherited request channel and launcher confirmation policy in both engines.

### WebView

Embedded browsing uses one `WebKitFactory` Android provider and one physical
WebKit operation family in `native/webkit-platform.mm`. The common portable JNI
adapter handles Java references, resource callbacks, JavaScript interfaces,
dialogs and snapshot delivery in either engine. The JVM calls the physical
WebKit layer directly, and ART carries the same typed requests and callbacks to its Mac window thread. Void notifications stay ordered on the Android
window queue without making the shared physical window thread wait for that
queue. Resource bytes, navigation decisions and JavaScript interface results
keep synchronous replies and reentrant client calls, and reentrant client calls
keep the window thread's browser ownership.

The ART reader keeps native transport state separate from Android callback
references. An explicit session close joins the reader and releases those
references on the Android thread. Native process teardown signals shutdown
without waiting under the loader lock, and the platform DSO stays mapped for the
life of the process while the reader releases its descriptors.

Browser storage is scoped to the enrolled application, and the launcher supplies
each process's storage capability and the provider's runtime archive path. The
same package metadata uses the JVM host archive or its mapped ART DEX archive,
regardless of how the engine represents protection domains. The original
`WebViewFactory` checks remain around the native provider-selection step. The
JVM entry and ART's Mac window process use the same private-storage adapter for
Darwin temporary-directory queries, so WebKit's rule compiler keeps its scratch
files inside that process's private temporary directory, and native shader cache
ownership is unchanged. Both entries also share the WebKit process-service
capabilities needed to load local documents. HTTP, WebSocket and FTP requests
follow the application's network policy independently of those local service
connections.

The WebKit provider forwards page and subframe navigation through the original
Android `WebViewClient` request overload, keeping URL, frame, gesture, redirect,
method and header metadata, and Android's original overload dispatch keeps older
string-based clients working. Application-initiated loads keep their separate
identity. Local scheme messages use the same callbacks, while network isolation
applies to actual network operations.

## Logging and diagnostics

Android native logging has one physical output shared by both engines. The
output descriptor is held before application native code is entered. Android log
writes and variadic formatting use that descriptor, while ordinary application
stdout and stderr keep normal redirection and closing semantics, so redirecting
those streams does not send Android logs into an application's logging pipe.
Size-limited Java failure reports use the original Android log line writer at
the same destination. Before native logging is registered, reports fall back to
ordinary stderr, and reporting keeps the original throwable and cleanup. Each
engine publishes that logger after the original native initialization, through its usual registration or process binding, and the ART RPC component links
the logger component directly.

The ART output transport uses INFO as its initial persistent log priority when
the original process priority is unset. Original `liblog` keeps per-tag
properties and later application priority selection, and reinitializing the
transport keeps an explicit application priority. Warnings and errors keep their
original reporting paths.

Both engines use the same launch timing recorder. Logs name an operation before
awaiting it and record its duration once it completes. Package preparation,
installed packages, service connections, graphics, isolation and process startup
are timed separately, and native composition has its own span.

[Android native code](NATIVE_CODE.md#fault-reports-and-tracing) describes fatal
native reports, syscall tracing and opt-in fault diagnostics.

## ART supplier

Recipes for building the ART supplier live in `src/modules/android/art`. The build consumes a matched
Android image, ART and libcore binaries and the original framework DEX, together with AIM's Linux ABI and ELF support. It does not convert application DEX
or apply HotSpot framework rewrites, and D8 packages the launcher's Java
integration classes separately. The JVM remains the default execution engine.

An optional complete HWUI component is supplied as `hwuiLibrary`, with its
`hwuiNotices` directory. The shared launch layout binds that immutable file
read-only at `/system/lib64/libhwui.so` for composition and application
processes, and the acquired system image and its recorded content identity stay
unchanged. Component notices, with paths relative to the supplier, are kept in the ART package manifest. The optional build in `native/hwui` compiles the complete Android 16 HWUI, Skia and static dependency targets against the image's private
ABI. Its CommonPool adaptation keeps the original class layout and API, wakes
and joins workers before their synchronization storage is destroyed, and safely
shuts down partially constructed pools. Source, generator and compiler inputs
are explicit, and original sources stay read-only. This build keeps the original exports, shared dependencies, release settings and sanitizer policy. `buildArt({hwui})` selects it; without that input, the image's
original library is used.

AIM overlays maintained by MacLauncher include the RGBX framebuffer projection
and its IOSurface implementation. Source export applies those overlays without
depending on an enclosing Git checkout, and compiler products stay in the build
cache. The Linux device layer supplies the original DMA heap allocation,
descriptor metadata, buffer synchronization and mapping operations that Codec2
uses, and media services keep the matching Android image's buffer-pool
configuration. Native display-mode operations use a separate protocol extension
next to the upstream text-input operations, and editor state stays with the
shared Android input handling.

The supplier manifest records relative component paths and identifies the Android image. Fields in the Android package manifest select optional behavior:

- `artExecutionVersion: 1` selects a supplied ART entry. This field is independent of the JVM's conversion contract versions.
- `binderSenderIdentityVersion: 1` uses authenticated process credential
  transitions to update the original Binder transaction sender UID. The opening
  security credentials stay fixed, and a pending transition has no active sender
  identity until the native credential layer confirms the new UID. The original
  window and service caller checks keep their enrolled identities.
- `frameworkResourcePreinitVersion: 1` initializes the original system
  AssetManager and image overlays before application setup. This stage runs
  with a minimal Linux startup identity and then permanently replaces the real,
  effective, saved and filesystem UID and GID values with the enrolled
  application identity and clears the capability sets and bounds. APK loading,
  application native constructors and process enrollment validation come after
  that drop. The selected immutable boot class path and guest libraries supply
  the initialization code. Suppliers without this field start directly as the application UID.

The optional `ptyHolder` component maps to `host/aim-pty-holder`, next to
`host/linux-run`, following AIM's original host-node dependency declaration in
`crates/aim-build/src/cargo.rs`. Original Linux terminal operations start that
native process through the runner's sibling path, and its process records stay
in private session state outside the guest filesystem.

ART's Binder integration reuses the complete shared RPC, Parcel and authenticated
peer implementation, and JNI object conversion uses the matching original
Android runtime. Local native Binder callers enter the VM attachment manager before dispatching to the original endpoint. When a thread exits,
Android's native thread-local detacher releases only attachments that manager
created, and callers that were already attached keep their original lifetime and
Binder identity. Application processes use the same profile-service enrollment and account and clipboard authorization channels.

## Builds and source inputs

A normal build reuses the supplied executable framework, native runtime, ANGLE
and portable codec artifacts, and compiles MacLauncher's adaptations and the
selected original native implementation modules. It does not run a full Android
product build. The original Blueprint parser resolves source groups for the
compiled modules without Soong or Kati product evaluation.

`framework-binary.json` identifies supplied artifacts and their checksums.
`source-pins.json` and the component source catalogs record the exact upstream revisions used. The immutable build snapshot records MacLauncher's sources and
compiler inputs. Java assembly, DEX conversion, native objects and builds of external components are reused independently, so an unrelated native edit keeps
unchanged application and framework bytecode.

`buildArtGuest` builds the original Binder library and the native application components in one build. Its optional `targets` selects complete output
components and their link dependencies; without it, every output is built.
Binder-only builds keep the original module's complete source set and reuse cached Clang and Ninja objects without requiring the resolver or WebKit builds.
`buildGraphicsLibrary` supplies the complete JVM graphics object and link inputs
for full and component builds, including the original framework GLES JNI
bindings and the typed guest ABI adapters. Component builds regenerate the same
Ninja graph from those inputs before reusing cached objects.
`art/build-arm32.mjs` compiles the shared ARM32 JNI source with the selected NDK,
and `art/build-ffi.mjs` builds Android's libffi dependency with the
upstream configure and Make rules. Clang depfiles track incremental header
dependencies, and the shared CPU archive comes from the normal Dynarmic target.

Developer builds accept explicit upstream source, image, generated AIDL,
compiler and exported-header inputs. ART Java compilation uses the matching
Android SDK's `core-for-system-modules.jar` as its compiler system image
alongside complete framework headers, and those compile-only classes never enter
the runtime image. Clang, Ninja and Cargo keep ordinary incremental products.
`artSupplierComponents` gives the component build scripts and reassembly tools their output destinations. Supplier assembly copies those outputs and writes a relocatable manifest; it neither installs the runtime nor writes application data. Acquiring and redistributing an Android image follows that image's
license. The original image redirect tool applies the shared Binder watchdog
operation to the matching service DEX, and the remaining service code and all
hook DEX files stay in their complete containers.

Compiler prefix maps keep developer paths out of delivered binaries. Published
native libraries use relocatable loader paths, and notices record source
revisions and licenses. Runtime staging installs a complete version and updates its runtime manifest atomically.

The Android build records the native adapters, runtime profile, shared build helpers and the ART build-script sources it used. Staging verifies that fixed snapshot and its relative source paths, including the ART source-staging helpers that the Bionic build imports, so later checkout changes cannot replace a completed build's source inputs. The MacLauncher Builds tag's source tree contains the production adapters, required helpers, the ART supplier's upstream revisions and license notices. Delivered runtime packages contain binaries, required data, notices and directly used metadata, without source archives. The shared runtime-content rules leave separate test and fixture trees out of these packages.

The [native host reference](../../../src/modules/android/native/README.md)
documents developer build arguments and source catalogs.

## Mac.apk and AIM

MacLauncher's Android module handles package inspection, provider selection, private storage, virtual device configuration and launch confinement, through the same module registry and runtime contracts as other game types.

| Component | Responsibility |
| --- | --- |
| Android module | Detect APK package sets, read manifests and resources, keep original inputs and select the runtime |
| Mac.apk provider | Resolve a publisher release and launch its Android application host |
| AIM provider | Launch the adapted AIM host with its separately downloaded compatible Android image |
| Shared macOS sandbox | Confine files, child processes and optional network access to the declared launch resources |
| Per-provider application root | Hold writable Android data, home, caches and temporary files for one game and provider |

### Delivery and images

The optional runtime IDs are `macapk` and `aim`; `klepton` is the ID of the
default runtime. Mac.apk installs the publisher's own releases, so a new upstream version can be used without rebuilding MacLauncher.

AIM is built from an exact upstream commit, tracked as a Git submodule, and MacLauncher's patches stay outside the read-only upstream checkout. Its manager installs versioned MacLauncher Builds packages that record binary checksums, CPU architecture, minimum macOS, the source revision and license notices.

Guest control commands keep the resident Android image, authenticated mount
namespace, Binder namespace and display endpoint. Original Android tools reach
the resident display's input devices through the same Linux device layer as
application processes.

The AIM Android image is downloaded and stored separately from the host. It is not
included in distributed runtime packages, and selecting AIM requests the image download. A native host and its Android image must have compatible versions.

### Files and processes

MacLauncher's Android module stores each provider's data under
`userData/android/apps/<gameId>/providers/<runtimeId>/`. Each provider gets its
own Android root, home, cache and temporary directories. Shared binaries are
read-only and contain no per-game state. Changing the provider does not merge
its files, account stores or saves with another provider's.

Legacy application storage stays separate and is kept for explicit data
migration or export. Launcher records stay in `userData/games/<gameId>/`.
Removing a library entry follows the module's storage cleanup contract.

Launches run the selected host directly inside the declared process policy.
Network isolation is on by default and applies to the game process and its
children. If confinement cannot be established, the game does not launch. AIM
requires macOS 26.0 or later and confines application processes to offline
operation without Google account integration.

The Mac.apk provider creates a per-game application bundle with the game's name
and launcher icon. Its native executable is cloned from the selected installed version, given the game's embedded macOS name and identifier, and signed
locally. Libraries, framework JARs and the Java runtime stay shared links to the
selected installation. The publisher's JIT and native ABI entitlements are kept,
and declared launcher graphics adapters can load after the process sandbox is in
place.

Mac.apk Google credentials are kept in one place,
`userData/android/profiles/macapk-google-v1/`. The provider calls the selected
runtime's original account store and authentication client in confined
processes. Account metadata and scoped authorization replies cross the
authenticated per-launch broker, and games cannot read that directory. Original
APK signatures are verified with the included Android APK verifier before the
package name and certificate identity are bound. Token requests keep that
verified identity and the selected account, and guest identity fields cannot
override them. Per-application and per-request tokens are not placed in a shared
scope cache.

### Virtual device and host access

Both providers receive the Pixel Tablet device profile: 2560 × 1600 at 320 dpi,
with an initial 1280 × 800 landscape window. Virtual device values stay the
same across providers and do not expose physical Mac device telemetry.

File access is limited to explicit imports and private application storage.
Network, clipboard, location, camera, microphone and account integration each
need their own supported policy and an explicit selection, and selecting a
runtime grants no host capabilities. Provider-native graphics, input and audio
stay with the upstream implementation below this launcher boundary.
