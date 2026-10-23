# Android runtime architecture

The Android module separates application execution from shared platform
operations. Its Java 21 binding uses dex2jvm and the complete AOSP Java framework;
its ART binding executes original DEX with a matching Android framework and
native image. Shared application services and macOS resource implementations
serve both bindings. Java, NDK and XR entry points use those same owners.

## Execution boundaries

| Component | Responsibility | Integration boundary |
| --- | --- | --- |
| Uninstrumented Robolectric `android-all` | Executable AOSP framework classes and resources | Original classes, descriptors and portable implementations remain present; exact JVM and native dependencies receive platform adaptations |
| Robolectric native runtime and ICU data | Supplied graphics, resources, text, database and native implementations | Original JNI declarations and exported implementation tables |
| Java 21 | Bytecode execution, object identity, compilation and garbage collection | Android-specific JDK calls are adapted at their representation boundary |
| dex2jvm | Application and dynamically loaded DEX conversion | The same framework hierarchy and JVM normalization used by the host |
| ART and matching Android image | Original DEX execution, libcore and native Android object representations | AIM supplies Linux/ELF execution; thin JNI and host-call bindings connect to shared platform owners |
| Klepton | ELF loading, ARM64 execution, Bionic ABI adaptation and XR integration | Shared native import dispatcher and JNI adapter |
| Dynarmic | ARM32 and Thumb execution | AAPCS32, pointer and record conversion into the shared ARM64 platform boundary |
| AOSP native modules | Binder, libcore, cryptography, media formats, fonts and portable algorithms | Pinned original implementation units with owned Darwin adaptations |
| macOS and ANGLE | Windows, input, graphics execution, audio, devices and network transport | Native platform operations below Android's public APIs |

Robolectric supplies executable framework and native artifacts. Its test runner,
shadow dispatch, sandbox class loader and simulated services are separate from
the application runtime. Framework assembly adds the complete original Apache
HTTP and StatsD implementation modules using their pinned Blueprint source groups.
There is one owner for each class; identical class copies coalesce and conflicting
implementations require a resolved supplier.

The donor's optional Zstandard and LZMA compile placeholders remain declaration
metadata rather than executable platform classes. Applications retain their
complete compression SDKs and native libraries; a newer donor implementation
keeps its normal executable ownership. Original Android framework classes and
their API declarations remain present.

Native package clients use the complete `IPackageManagerNative` Binder contract
over the same parsed installations as `IPackageManager`. UID names, target SDKs,
versions, signing certificates, package flags, audio-capture policy and hardware
features share their existing owners. Module metadata comes from Android's
configured resource. Managed Mac runtime updates create no staged APEX sessions;
the endpoint retains ordinary observer registration and Binder retirement.

Named device features share one owner between package queries and original
manifest parsing. Feature-conditioned permissions therefore follow the same
virtual touchscreen, pointer input, audio output, orientations and RAM class
reported to applications. Graphics versions come from the selected driver's
actual capabilities; host capture devices remain separate permissions.

The JVM native owner also owns process retirement. Its shutdown hook stops new
Binder transports, drains existing native session owners and releases native
service caches while Java callbacks remain available. The same owner's terminal
VM event releases JNI metadata and prevents subsequent native thread attachment.
Original AOSP Binder objects retain their reference ownership and destructors.

JVM processes install the standard JNI Invocation API exit callback before VM
creation. HotSpot completes Java shutdown hooks, VM-death notifications and VM
cleanup before the callback applies Android's terminal process-exit behavior.
An existing VM exit callback runs first; explicit guest libc finalization keeps
its original ownership and ordering.

Explicit guest libc exit uses Bionic's original recursive exit owner, drains
the calling thread's destructors before global guest destructors and terminates
with the requested status through `_exit`.

Adaptations retain original public and private descriptors. An implemented exact
native binding or JVM call replacement changes its platform dependency without
removing other methods or replacing the surrounding framework class. API and
method-body preservation checks live in tests, outside the runtime class loader.
ART's build-time DEX platform delegates use dexlib2 to preserve original members,
hidden-API metadata and resources. The WebView provider factory delegates to the
shared WebKit provider while original provider access and lifecycle checks remain
in Android's calling framework.

The ART supplier can include a boot image compiled by its matching `dex2oat64`.
AIM's original producer receives the complete runtime boot class path, including
the adapted framework, services and platform delegates. The compiler, ART
libraries, class-path bytes and image profiles identify the reusable build
product. Its image and code files map read-only into each application session;
application data and process identity remain private to that session. Runtime
startup consumes the supplied image without invoking a compiler or traversing
the build inputs.

JVM is the default execution binding. ART uses the separately managed
`android-art` adapter alongside the common framework and host services.
[`art/package.mjs`](../../src/modules/android/art/package.mjs) seals its native
closure and framework/boot files;
[`art/build-image-extractor.mjs`](../../src/modules/android/art/build-image-extractor.mjs)
builds the original AIM image reader. The original SDK system image downloads
from upstream after explicit confirmation and remains outside adapter packages
and corresponding-source archives. `system-image.js` verifies its archive and
content identities and shares one immutable, case-sensitive, read-only image
under Application Support. Application data remains private. Adapter updates use
explicit Refresh, Install and version selection.

The Android build receipt records the native adapters, profile, shared build
helpers and consumed ART producer sources. Staging verifies that fixed snapshot
and preserves its relative source paths in the corresponding-source archive,
including the ART projection helpers imported by the Bionic producer. Later
checkout changes do not replace the completed build's source inputs. Published
source archives retain production adapters, required build helpers, supplier
pins and license notices. The shared runtime-content rules omit separate test
and fixture trees from both owned sources and embedded upstream source archives.
Codec source records retain the authenticated input archive identity alongside
the filtered publication identity; original acquisition pins remain unchanged.

The same `PendingIntentCalls` build contract binds original PendingIntent
service destinations in classfiles and DEX to `HostPendingIntentDispatch`.
Android's original controller and record retain token identity, flags, options,
result handling and cancellation; the shared activity, broadcast, service and
alarm owners receive the original call arguments.
Remote broadcast routing uses the same reusable daemon executor on both VMs.
Original `LoadedApk` and `ActivityThread` deliver receivers; the broadcast owner
retains result ordering and retires its executor during application shutdown.

One build-time UI callback declaration supplies the JVM bytecode and ART DEX
bindings. Original `ViewRootImpl` attachment, detachment, input completion and
input-token methods retain their implementations; both bindings notify the same
window and input owners. The DEX encoder uses dexlib2 to relocate branches,
handlers and debug positions around those callbacks.

Android windows initialize touch mode from the platform resource. Original
ViewRoot input stages retain keyboard navigation, focus highlights and pointer
transitions between navigation and touch mode.

Both window bindings notify the shared process authority of an explicit native
close before running Android teardown. Input transport retirement and process
failure remain separate from a requested close.

Process retirement attempts independent service, composition and profile
cleanup even when an earlier operation fails. Authority EOF retains its
graceful interval, followed by bounded forced retirement. The first failure
remains the result; prepared inputs, session files and composition descriptors
stay retained while an owned process has not confirmed its exit.
JVM Stop waits for the same retirement owner used by window closure and process
exit, including service and native composition cleanup. Backend ownership remains
available until that retirement settles.

## Application conversion

Both execution bindings share APK inspection, private installation, resource
extraction and cache ownership. ART retains and executes original DEX; its
preparation uses package metadata tools without opening converter libraries.
The JVM binding additionally identifies and invokes the dex2jvm supplier.

Launch labels, icons and activity window policy are cached by the verified APK
contents, including the ordered split package set, locale and resource reader
implementation. Moving the original inputs or replacing an equivalent prepared
generation preserves those cached resources.

APK preparation indexes the complete DEX class set and preserves each source
APK's membership and ordering. Original AOSP DEX and package class loaders request
converted class bytes as needed. A resident dex2jvm subprocess shares its parsed
DEX and constructor-resolution plan across those requests; converter dependencies
remain outside the game JVM. Dynamically loaded DEX uses the same boundary.

Converted bytes are immutable cache products identified by the DEX, converter,
framework hierarchy and the actual parent-loader types consulted by conversion.
Native implementation changes and installation paths do not invalidate them.
Complete conversion metadata remains available in its original ordered archive.
An unresolved parent lookup records the exact metadata class resource used as
its fallback, including an absent result. Changes to those consulted resources
invalidate the affected conversion; unrelated metadata additions retain cached
class bytes. Demand indexes use the recorded original ordered DEX digest, so ZIP
repacking does not change application bytecode identity. Converter tools retain
their complete content hashes.

Within one JVM session, successful class-header lookups through the immutable
platform loader share a bounded memory cache. Delegating loaders and metadata
fallbacks retain their normal validation; shutdown releases the lookup cache.

Android direct-buffer accessibility uses the JVM's shared memory scopes.
Byte buffers, slices, read-only views and typed views share revocation and
reopening while the original MediaCodec owner retains buffer dequeue and release.
The mapping preserves native addresses and existing allocation owners; existing
foreign-memory scopes retain their original lifetime. Framework and converted
DEX calls use the same NIO portability boundary.

Prepared eager archives remain usable. Resource lookup and defining-class identity
stay with the original Android loaders; separate loaders share bytes, not classes.
The original DEX-loader hierarchy registers for HotSpot's parallel class loading;
definition locks cover individual class names. A cold conversion serializes only
its module's converter protocol, leaving warm class lookups independent.
The JVM entry boundary accepts Android internal class names and primitive,
reference and multidimensional array descriptors. Array components resolve
through the requesting original loader without class initialization; ordinary
classes retain the original parent and shared-library delegation order.
The existing process and cache owners retire conversion workers and temporary
inputs, preserve live readers and bound reusable cache storage.

Both execution bindings use one native frame-timing reporter and bounded
retained history. Records distinguish application production from original
SurfaceFlinger composition, with separate accepted and macOS-presented rates,
frame intervals, submission time and source/output extents. Frame records use
the retained Android log destination independently of application standard
stream redirection or closure. The native
presentation service log retains a startup segment and two recent segments.

Android native logging has one physical output owner shared by the JVM and ART
bindings. The owner retains its output descriptor before application native
entry. Android log writes and variadic formatting use that descriptor, while
ordinary application stdout and stderr retain normal redirection and closure
semantics. Redirecting those streams does not redirect Android logs into an
application's logging pipe.
Bounded Java failure reports use the original Android log line writer at that
same destination. Before native logging registration, reports fall back to
ordinary stderr; reporting preserves the original throwable and cleanup.
Each VM publishes that logger after the original native initialization through
its existing registration or process binding. The ART RPC component directly
links that logger component.
The ART output transport uses INFO as its initial persistent-log priority when
the original process priority is unset. Original `liblog` retains per-tag
properties and later application priority selection. Reinitializing the
transport preserves an explicit application priority. Warnings and errors keep
their original reporting paths.

ARM32 translated-thread leases remain live while the shared native lifetime
owner runs application cleanup. A trivial native thread-local pointer identifies
the lease container and clears before its storage is released. Later native
TLS destructor callbacks acquire a fresh container through the same owner;
each container retires its translated stacks and leases after its callbacks.
The native build compiles the CPU and address-space implementation once into
an object target used by both the JVM adapter and a standalone CPU archive.
ART's typed host-call binding uses that same implementation; callbacks return
through the Linux execution context to the original ART JNI frame. The CPU
archive contains no VM, platform-service resolver or alternative libc.
Each CPU run holds the address space's read guard and an eight-entry borrowed
mapping cache. Dynarmic's original page table handles full writable pages and
compact buffer entries. Compact accesses check the existing mapping's exact byte
bounds and per-page permissions inline, retaining the checked byte offset for
the native access; invalid and crossing accesses retain
the original callbacks. Cache storage ends before native callbacks, protection changes or mapping retirement,
and the next run starts with a fresh cache.
Cross-width native pointer cells, records and interface tables retain their
original Clang-described extents. Physical resource release retires converted
views and native-memory aliases through the same memory owner. Allocator
reallocation publishes its new representation atomically; failure preserves the
original pointer, bytes and error. Resolver lists retire their declared linked
nodes, canonical strings and address buffers before the native resolver frees them.

Requested class bytes enter the bounded process cache directly. One background
writer publishes immutable archives and maintains persistent storage; queued work
refers to existing cache entries rather than retaining another collection of
bytes. Class readers do not wait for that writer's publication or pruning lease.
Writer queues and artifact leases are independent of the byte-cache map lock;
filesystem publication and deletion run outside that lock.
Pending persistence uses the persistent-cache byte budget. A busy writer defers
additional cache writes while converted class bytes remain immediately usable.
Classes share immutable parent-hierarchy facts until the converter requests a
new fact. Each snapshot has one context digest and one cache-memory charge;
hierarchy encoding follows the actual defining class without retaining loaders.
Mutable delegating parents are resolved again during validation. The fixed
boot/framework parent reuses its verified snapshot. Persistent entries retain
their original facts and checksums across context-digest updates, and writer
budgets include both class bytes and hierarchy metadata.
Maintenance reads each entry's timestamp once, retires directories atomically
under the shared mutation lease, and removes their contents after releasing it.

## Component sourcing

The framework and compatible native artifacts supply original implementations.
Additional portable components use complete upstream modules and their dependency
closures; original build declarations select source groups. The native payload
includes Binder RPC, KeyStore, libcore, Conscrypt/BoringSSL, media-format, NDK
bitmap and alarm implementations alongside their macOS bindings.

Platform adaptations connect Android operations to the owning Mac resource.
They retain the original API and portable code around that operation. Component
source builds and incremental caches are separate from whole Android product
builds. Upstream source inventories document suppliers and licenses; they are
not application class or method eligibility lists.

The ART loader retains original ELF bytes and program headers. When read-only
image libraries share hardlinked or translated cache bytes, each open
description retains its canonical Android pathname. Original linker namespace
checks use that opened name across descriptor duplication, fork and exec;
content-addressed code remains shared. Writable application paths retain their
existing mount and rename behavior.
ART evaluates native-library alignment across the current application's admitted
read-only code inputs, including installed providers used by its class loaders.
Android's original package policy selects Bionic's 16 KB compatibility mode;
explicit application manifest and settings overrides retain precedence. Original
ELF bytes, segment bounds, relocations and memory protections remain intact.
When Bionic's
RELRO request shares its final physical page with writable data, the native
mapping boundary preserves that data and protects the preceding RELRO pages.
This adaptation is limited to the original loader's matching ELF operation;
explicit application memory-protection requests retain their usual semantics.
The JVM native image loader applies GNU_RELRO through its existing page
permission plan after dynamic relocation and before constructors. A host page
loses write permission when all writable load-segment bytes on that page belong
to the original RELRO range; adjacent mutable data retains write access.
The ARM32 image adapter seals RELRO through the translated address space's
original 4 KB page owner at the same relocation boundary. Program headers,
load alignment and relocated pointers retain their original image ownership.

The ARM64 image adapter supports `PT_TLS`, `DTPMOD64`, `DTPREL64`, `TPREL64`
and `TLSDESC` while preserving the real Android thread pointer and original
Bionic slots. Initial-exec and dynamic references share the same per-thread
address. A demand-zero reserve supplies one MiB of fixed TLS layout with
alignment up to 64 KiB; module offsets remain reserved after unloading. New
modules initialize existing physical threads before publishing native entry
points. Modules beyond that layout retain dynamic TLS; an initial-exec reference
to one reports a loader error.

## Process and resource ownership

Prepared APKs, converted archives, extracted assets and Android native ELF files
can share verified immutable content between preparations and applications.
Original imports and writable application data retain their own storage. Compact
candidate hints identify possible matches; exact content and file mode are
verified under the package preparation locks before sharing. Busy or stale
candidates are skipped. Mach-O libraries retain separate file identities for
loader-relative dependency resolution. Removing a retired preparation preserves
files linked by another active preparation.

New Android preparation generations request native copy-on-write copies through
the macOS system copy utility, with ordinary copying on filesystems that do not
support cloning. Imports retain separate writable file identities. Copies are
staged privately and published without replacing existing files; original-source
identity and complete APK hashes are verified before publication. Cancellation
removes incomplete staged copies.

The launcher backend prepares an application and starts a separate Java process.
The Electron renderer does not execute application code or perform blocking
conversion and native compilation. Prepared application code is cached separately
from persistent application data.

A profile supervisor authenticates each process through inherited Unix sockets
and the actual operating-system process identity. Android application UIDs are
separate from macOS user credentials. One profile-wide native lease owner supplies
Android process and thread IDs to both VMs and native-library widths, including
the compact IDs used by original 32-bit Bionic synchronization. Physical macOS
PIDs remain separate for inherited-channel authentication, ancestry, signals and
window/clipboard ownership. Retained child mappings exclude the current process
and preserve a child's identity through zombie observation until reaping. The
physical-PID index selects the same numeric lease and validates its recorded PID
against the live kernel lock. It stores no separate identity or lifetime. Stable
numeric lease files prevent inode/lock reuse races; reusing a retired slot removes
its former reverse name. Older live owners without an index retain directory
lookup compatibility, and successful discovery publishes their reverse name.
Command discovery asks the parent supervisor for a fresh kernel snapshot of
processes holding the same private namespace directory. JVM, ART, application,
account and platform-service launches use one inherited query channel adapter.
The child cannot choose another directory. The native owner resolves candidates
through the existing index, checks their live leases and reads Android command
metadata from those leases. It retains complete namespace lookup when the
snapshot is unavailable; sandboxed applications gain no host process-inspection
permission.
ART thread creation preserves the shared ID owner's Linux error and converts
the physical pthread error into the same ABI. Failed creation releases the
reserved context and thread lease before returning to Bionic.
Both execution backends use the shared isolation policy for signals to the
process itself and its children, including suspended-child startup and reaping.
Java `Process` signal methods and native signal imports resolve targets through
the same retained Android child leases before signaling a macOS process.
AIM namespace and terminal owners check both the kernel start time and process
state. An exited child is no longer live while awaiting reaping, so its terminal
owner can close inherited output descriptors promptly.
New identity descriptors use the executing VM's existing private descriptor
allocator before publication or POSIX locking. The resulting handle remains
unchanged until its lease retires; application descriptor replacement cannot
close it. The JVM retains its native descriptor ownership.
The authority protocol publishes both identities
before the application receives its service capabilities. Platform service processes own profile-wide
system state and KeyStore state; installed application services retain their
package identity and data directories. Binder RPC carries original AIDL contracts,
references and descriptors between these owners. Connection retirement belongs to
the same process and transport owners that established each connection.
Binder reports the authenticated Android caller's process and user IDs during
incoming transactions. Outside a transaction, and after `clearCallingIdentity`,
it reports the current Android process identity. `restoreCallingIdentity` restores
the saved caller through the original native Binder token.
Native Binder permission caching, debug process IDs and transaction-error
callbacks use that same Android identity. Socket authentication and native
connection thread keys remain with the host transport owner.
Identity enrollment remains pending while its process and authority channel are
alive. Closing that channel or retiring the process cancels enrollment; a
separate initialization timer does not terminate a live application.
The immutable runtime declares its process-identity protocol. Active profile
services retain that protocol until their client leases close; an incompatible
runtime selection preserves those games and replaces the service when unused.
An acquired controller retains its service during application preparation,
before process enrollment. Retirement joins in-flight process registration;
cancellation stops registration before it advances to another service owner.
Queued requests from a closed controller do not acquire package sources or
create new enrollments. An enrollment already submitted to its service retires
before its source leases are released.
Profile services start when a process requests one of their declared endpoints.
Declaration and service-list queries use metadata without starting accounts,
KeyStore or the shared system process. KeyStore declarations are generated from
its original Rust and C++ publishers and retain the original AIDL descriptors.
The requesting process owns its authenticated connection and controller lease;
retirement releases that enrollment and lets the existing supervisor stop an
unused helper. ART composition retains the system services it actually consumes.
Its Binder, presenter, linker and original graphics services initialize alongside
the profile system process. The native window executable loads alongside system
service initialization and publishes its actual process identity. Exact endpoint
grants precede readiness; authenticated system credentials reach the window over
its inherited launcher pipe only after readiness and process enrollment complete.
Package catalog updates and prepared-source leases use the system kernel lock
with an EOF-bound holder. Acquiring or releasing a source lease starts no
additional JavaScript VM; controller exit releases the holder through its pipe.
Its immutable native image helpers share the original translation cache within
the launcher profile. AIM keys entries by original content and translation format,
checks the original file identity and host configuration, and authenticates
protected derivatives against the current translation of verified source bytes. App and
peer-package processes retain separate private code caches; their sandbox does
not receive the shared image-helper cache. Unrelated runner, Java archive and
packaging changes retain native cache entries.
The immutable runtime declares support for late service connections; older
payloads keep their bootstrap connection protocol. Both VMs start the authority
reader before application construction, and authority loss releases pending
service requests without relying on the application's Looper.
Profile service leases retain one verified Java/native implementation while
applications use it. ART and JVM containers with the same common supplier share
that owner. ART selects the verified included JVM closure for these shared
services independently of its additional execution image. The selected closure
retains its full file and provider-catalog identity. A different supplier or
process-identity protocol cannot replace or reuse a leased owner; changing it
requires the existing applications to close.
An idle owner retires under the profile's kernel lock before its replacement
opens persistent data.
The initial authenticated packet supplies the profile's boot counter before
application or content-provider construction. Launch and system-service
supervisors use the same private counter transaction and kernel lock; restarting
a process does not increment the counter or start a service for metadata. Only
the Android counter crosses the authority channel; the host boot identity stays
in private profile storage.
Supplied provider APKs are indexed from their original manifests. Providers in
the Android system shared user load lazily in the profile's system process,
through the original package parser and ActivityThread provider lifecycle.
Synchronous local acquisitions wait for that main-thread attachment when called
from another thread. Concurrent requests share one installation; a provider's
reentrant startup lookup retains the same owner. Remote holders retain Android's
asynchronous publication callback and original caller permission checks.
Lazy system-server service constructors run on their existing main Looper,
including first requests arriving on Binder workers. Provider construction and
its reentrant Settings reads therefore retain the original system owner.
The JVM package includes the original AOSP SettingsProvider APK, resources and
Apache notice independently of optional Google integration or an ART image.
`platform/packages.json` locates these supplied APKs; an ART image retains its
original provider catalog. The component binary definition records its checksum,
source reference and supplied-image identity separately.
SettingsProvider retains Android's permission checks, aliases, defaults,
mutations, change generations and persistent settings files. Application Android
IDs retain the installation's existing random identifier; these settings and
identifiers do not read macOS settings or hardware identity.
Shared settings generations use the original AIM ashmem inode representation
across native and Android processes. Original MemoryIntArray clients retain
their parcel, atomic access, protection and close behavior. Anonymous backing
files issue an exact-file sandbox capability before unlinking. Native descriptor
attachments carry that capability; its lease and auxiliary handles follow the
existing file-description or AIM descriptor owner through duplication, fork,
exec and final close. The capability covers the received file while neighboring private files
retain their isolation.
Native shared-memory protection accepts the original READ, WRITE and EXECUTE
bit combinations, including an empty mask. Protection changes only remove bits;
new mappings validate against that shared mask and retain native mapping errors.
Removing WRITE seals the native descriptor without revoking existing mappings.
Provider startup diagnostics retain the initialization stage and exception type
before retiring its authority descriptor. Exception messages and account values
are excluded from these structural records.
Requests preserve the connection's first terminal
outcome, including its service role and whether it was released, timed out or
closed by its peer.
Individual descriptor-transfer receipts do not own their adopted data connection
or the parent authority stream. A retired receipt leaves both independent
lifetimes intact.
The private Android user retains its original full-user classification; Android's
own profile and icon-badging clients use that identity without adding a managed profile.
JVM thread nice values map to Mach CPU precedence for both current and
registered application threads. Java and native clients query the same kernel
priority; CPU nice requests do not introduce Darwin background I/O throttling.
ART uses AIM's Linux scheduling adapter: raised display and audio priorities
map to Darwin thread scheduling, while background policies use Darwin QoS.
Changes made by another thread take effect at the target's next system call.
Native process-memory vector operations resolve Android IDs through the same
live process leases and enforce the enrolled application identity before using
Mach memory copies. Invalid buffers return native errors without dereferencing
them in the adapter; completed vector ranges retain their partial byte count.
ARM32 self-process vectors use the existing address-space owner for both local
and remote byte addresses. ART retains AIM's original process-memory syscall
implementation and its authenticated remote-process transport.
ART's `smaps` and `smaps_rollup` views use the existing VM-map owner and Darwin
page counts. Resident usage follows the mapped pages; proportional and shared
usage approximate Linux accounting from Darwin's VM-object references. Remote
reads retain the original process credential checks.

Platform owners identify their JVM supplier from the verified common file
inventory, Android profile, native architecture requirements and complete supplied
platform image and package-catalog identities. Image content, paths, symlinks and
modes are recorded during supplier production. Assemblies that retain an explicit
immutable image component reuse that image identity; catalogs retain their own
content identity. Launches read this metadata without hashing image files. ART execution
versions have a separate identity; changing only those additions reuses the
same platform process. Changes to common Java or native files, the Android
profile or launcher adapter location replace an idle owner through its existing
kernel lease. Active controllers retain the current owner until retirement.

The platform process declares the sensor-privacy endpoint without starting its
service. Its first lookup starts the original service, including its state
controller, persistence, permission checks and listeners. Ordinary display and
media startup do not initialize this separate service. The platform process also
hosts the original
telephony event registry. Its internal user and application-operation calls use
the profile's existing identity and policy owners. Native audio permission
updates use Android's original `AudioServerPermissionProvider` and the same
package catalog and permission decisions. Native composition services use their
authenticated process scope in the same service directory, with shared profile
services as parent entries. Each live native audio-policy service receives the
original provider's package and grant updates; process retirement removes only
that process's endpoints. Native audio initialization joins the original
permission-update barrier after policy publication, then commits the shared
stream ranges. Application construction follows this initial audio readiness;
other native services and process setup start concurrently. Applications publish their complete local service
directory on the existing authenticated connection after context setup. Sensitive
permission checks query that application's original `IPermissionManager`,
including its manifest, explicit device selections and macOS authorization.
Original permission listeners propagate changes to the profile provider;
connection and Binder death retire the corresponding transport leases. Local
checks stay in the app process, and reverse calls run outside directory and
permission-owner locks. Authenticated process enrollment
supplies the system catalog with the installed APK set before admitting the
process; the system sandbox reads installed code without access to app data.
UID state queries aggregate live,
authenticated process activations rather than macOS user identifiers.
Permission checks retain the original process-wide `SystemConfig` instance;
its UID grants and split-permission declarations stay authoritative across
repeated checks without re-entering its system-server caller diagnostics.
Package metadata calculates requested permission grants only for
`GET_PERMISSIONS`. Signature grants retain full original APK verification;
grant enumeration snapshots the requested permission set before verification
or remote queries so unrelated local permission checks can proceed.

The all-files access Settings intents open an embedded Android settings window
for the calling application. Its explicit toggle persists
`OP_MANAGE_EXTERNAL_STORAGE` through the existing permission-decision owner;
the original `Environment.isExternalStorageManager()` reads that AppOps state.
Access applies to the application's existing Android storage volume and does not
expose additional Mac folders. Closing settings delivers the ordinary Activity
result and resumes the caller on its Android main Looper.

Remote service binding and activity launches wait for process publication through
that owner's asynchronous readiness future. The calling Android Looper continues
running while the destination starts. Original Binder service callbacks report
connection, null binding and process death; unbinding retires pending and connected
requests together. A connection that completes after cancellation is immediately
released. Publication and retirement callbacks run outside the process-directory
lock.

The account service has one profile-wide database. Google integration is selected
per game: disabled, installed services without an account, or an existing selected
account. Authenticator applications run as their own packages. Explicit sign-in
uses network access and preserves the account service's database across games.
The verified Google provider's service broker retains its original callback
contracts. Noninteractive game requests receive `SIGN_IN_REQUIRED` without the
optional account-resolution PendingIntent, both during service binding and in
the later Games Connect sign-in result. Other connection metadata, successful
service responses and explicit account-tool resolutions retain their original
owners. The provider's original Parcelable creators read connection metadata and
sign-in status.
Startup failures retain their original exception type and location while the
service retires its processes; provider output and account values are excluded
from lifecycle diagnostics. Account bootstrap failures also retain the original
initialization phase before the service adapter returns, including failures
before a JVM starts. Lifecycle records include recognized operating-system and
account-service error codes without error messages or filesystem paths.
Native execution records window-loop failures before invoking Activity teardown,
including when an application's destruction callback terminates its process.

Original Android input connections receive native text composition and keyboard
operations. Explicit copy and paste gestures transfer text through the launcher;
background clipboard reads are separate from Android's private clipboard state.
Native connection retirement releases its matching composition session.
ART composition waits for native service publication through the original
`IServiceManager::waitForService` registration callbacks. Each wait belongs to
the composition session and ends on launch cancellation or service-process
failure. Directory startup uses an original Binder transaction that accepts an
absent SurfaceFlinger before its process starts.
The window executable loads and publishes its actual process identity alongside
composer and SurfaceFlinger initialization. Its inherited startup channel stays
blocked until those services publish and the profile authority enrolls that
identity; only then does window initialization contact platform and display
services.
The original system-suspend, media-metrics and audio-HAL publishers initialize
concurrently. A combined registration wait retains their individual process
dependencies before starting audioserver.
The original editor's cursor anchor and view transform position macOS input
composition beside the Android caret. The physical window maps Android render
pixels to logical window points, including Retina scaling and resolution
multipliers. Geometry updates follow the active connection and stop when its
editor detaches.

Per-game keyboard touch controls can map WASD, arrow keys or both to a virtual
joystick. Its center is measured as percentages of display width and height;
its radius is a percentage of the shorter dimension. Movement keeps one stable
finger while the mouse operates another, using original Android multi-pointer
events and view-root dispatch. WASD mapping is enabled by default, pauses during
text editing, leaves Command shortcuts with the keyboard, and releases contacts on focus or
activity retirement. Controllers and wheel/trackpad scrolling retain their own
existing input paths.

One native window and surface boundary connects Canvas, GLES, video and native
activities to the physical Mac display. Presentation uses the committed backing
extent and the producer's actual content dimensions. Graphics settings attach to
the same launch and presentation paths. Canvas overlays use the native producer's
actual pixel origin before the common presenter applies its display transform;
top-left Vulkan images and bottom-left GLES images retain the same Android UI
placement. Canvas changes also redraw over a completed GPU snapshot of the
native image, so text and controls update independently of the game's frame
rate. The same bounded image pool and common graphics presenter own these
redraws; empty overlays add no native image copy. Audio, video, image storage and JNI
references retain their original owners through asynchronous work and shutdown.
Window teardown drains submitted Metal work for at most one second. Completed
and failed command buffers both permit resource retirement; the first rendering
exception remains available while EGL surfaces, fences and presenter references
are released. Work still in flight retains its dependent resources for a later
retirement attempt. Device initialization publishes its queue and shared events
only after all allocations succeed.
PixelCopy reads the raw submitted surface before effects and scaling, including
when its producer is idle. Native drawables, EGL window buffers, projection slots
and decoded frames retain their source leases through GPU readback. EGL windows
keep a stable surface identity while rotating up to three backing images; an
image remains unavailable for reuse until its readers retire. Swaps copy the
preceding contents only when preserved-buffer behavior is explicitly selected.
Directly writable hardware-buffer sources use a three-image GPU snapshot pool
capped at 128 MiB per process, inside the existing producer fence.
Planar video uses the same CoreImage conversion source for both VM bindings.
The original ART allocator supplies the NV12, NV21, YV12 or P010 plane offsets,
strides and color metadata. Its existing EGL image registry retains the mapped
buffer; acquiring an image refreshes its Metal texture through the original
external-texture binding. Acquire/read fences protect CPU-accessible plane views,
and Metal shared events order converted pixels before sampling. CoreVideo consumes
NV12 and P010 directly; Accelerate normalizes NV21 and YV12 chroma ordering without
replacing the decoder or BufferQueue. Image retirement waits for pending source
reads before releasing the original mapping. The GLES driver and GPU hostcall
implementation are delivered together with their matching protocol version.
The ART EGL window surface owns a dequeued producer buffer before drawing and
sizes its framebuffer from that buffer's extent. Consumer default dimensions
remain available through the original native window queries. Queueing transfers
the copy fence, resizing follows the next acquired buffer, and surface destruction
cancels an unused buffer before releasing the native window.
ART window presentation resolves multisampled color into a single-sample
attachment before applying orientation or scaling. That attachment shares the
existing imported image and GL-context lifetime; application framebuffer,
renderbuffer and scissor state remain intact.
Framebuffer operations use the original OES entry points for an ES1 context
and core entry points for ES2 or later, preserving the application's GL error
state during presentation. Legacy contexts use the advertised NV framebuffer
blit extension for reversed or scaled destination bounds, with the same Android
row origin as core ES3 presentation. Multisampled sources resolve with identical
bounds before either transformation.
`ANativeWindow_fromSurface` and `ANativeWindow_toSurface` retain the same buffer
consumer. A returned Java `Surface` has independent wrapper ownership; releasing
earlier Java wrappers keeps an acquired native window usable. The final native
reference releases the existing consumer after the window lock is dropped.

The JVM `SurfaceControl` transaction boundary is `HostSurfaceControl`.
Transaction completion follows `HostSurface.Target.onFrameCompleted` when the
existing output consumer accepts the Android frame. `CanvasFrameSource` owns
one copied latest image and its frame identity and latch timestamp; a newer
image may coalesce earlier transactions before physical display. Mac window
visibility, drawable availability and physical display completion do not delay
that Android latch. Original `TransactionStats` objects expose its timestamp
and an empty present fence when the output exports no Android fence descriptor.
Physical presentation timing and dropped-frame metrics remain separate.
Transaction sanitization validates the process-private transaction capability;
local layer transforms retain their meaning. This scene has no global Android
display or input-command authority and cannot address another process's layers.
ART retains its matching native SurfaceControl and SurfaceFlinger implementation.
Native service startup checks the original Binder directory with a single
`checkService` transaction before starting the graphics services. Each required
service then has its own registration check; startup does not enumerate or
request interface descriptions from unrelated services.
Both execution engines use the same launch timing owner. Logs identify an
operation before awaiting it and record its duration when it settles. Package
preparation, installed packages, service connections, graphics, isolation and
process startup retain separate timings; native composition has its own span.
Host runtime session mounts, Binder state and IPC live beside the application's
Android data directory. They are absent from its data mount and from
initialization of imported Android files. Closing the runtime retires these
session files after its native processes and service leases have settled.
Directory retirement runs asynchronously with bounded filesystem retries for
native socket-inode bookkeeping that finishes during removal.
Imported application trees declare their default Android owner on the root
inode. ART's original inode metadata owner materializes missing fields when a
file is first used, retaining explicit ownership and modes. Guest-created files
use the original creation path. When inode metadata is recorded, the physical
host owner retains access needed to store that metadata; Android observes the
requested mode under its umask, including mode `000` followed by `fchmod`.
Default lookup stays inside the existing writable
VFS area. Enrolled installed-code files and directories use the same import owner
with root ownership, directory mode `0755`, and file mode `0644` plus existing
execute bits. The original VFS synthesizes missing code fields without writing
descendant metadata; explicit inode fields and original image metadata retain
precedence. Read-only aliases use that same declared physical owner.
Published mounts bind each existing host root to its physical path once while
retaining the guest path. Imported-owner lookup compares containing host paths
before checking mount visibility or reading an import declaration. Canonical
roots reuse the original VFS path cache; dynamic aliases and later symlink
targets keep their original namespace behavior.
Links retain the same inode metadata; directory
moves carry the import default for descendants. Launch setup does not enumerate
application data, and its cancellable subprocesses leave the backend control
loop available.
The shared Activity owner selects a typed physical window binding for initial
and later Activity launches. The JVM binding uses its native window session;
ART borrows original Android surfaces from the existing output. Cross-process
Activity options carry a scoped output capability. Child surfaces retain the
same display and input owner, and closing a child restores input to its parent.
Initial attachment and resize carry the committed output's screen identity,
extent, refresh rate and density while retaining Android's default display ID.
The capability carries physical focus, sleep/wake and retirement to the child
Activity. Wheel and text intents enter the same shared Android input owners in
the receiving process; input completion retains the original ViewRoot handled
result. ART uses original Android input channels for pointer/key delivery,
including their bounded socket queue and completion protocol. The physical input
capability follows the application window across Activity replacement; events
target its current Android input owner rather than a retired Activity's view.
Window retirement
drains ready callbacks up to an asynchronous marker in the original message
queue before releasing the output lease. Future callbacks, synchronization
barriers and the surviving application's Looper remain owned by Android. The
JVM window pump separately retains its nonblocking native-poll deadline handling.
Window retirement leaves the application and its Binder services alive.
Native display retirement services the Android owner queue while callbacks are
executing. Waiting for its dispatcher thread to exit does not start unrelated
application messages.

The JVM fence boundary uses the complete original `SyncFence` JNI unit,
`libui` `Fence` implementation and `libsync` module alongside the existing
Binder descriptor owner. JNI exports derive from the original registration
table. Android retains reference counting, descriptor ownership, waits and
Parcel serialization; Darwin supplies descriptor polling and closure. Linux
sync-file ioctls retain their original declarations and normal descriptor errors.
ART pending-byte queries dispatch through the pinned Linux descriptor owner.
Event and timer descriptors reject `FIONREAD` with `ENOTTY`; epoll uses the
Android 16 kernel's `EINVAL` result for that unsupported request. Their native
notification carriers do not expose transport bytes as application data.

Fresh native descriptor slots retire metadata from their previous numeric
generation before the Linux open description is installed and published.
Existing retained pins keep their separate hidden descriptors and original
metadata. This applies to file and socket creation, socket acceptance and
transfer, and duplication; socket-only operations retain their normal errors
on regular files.

Native-thread retirement drains the original Bionic C++ thread-local destructor
list before guest pthread storage and JVM detachment. Java-owned threads use
the existing VM thread-end boundary and retain their VM attachment. Both C++
registration aliases share the same list and retirement owner.

An externally acquired native Looper retains its registered descriptors across
Java and physical thread retirement. Its holder can remove descriptors from
another thread before releasing the Looper. The last release closes remaining
descriptor leases. Retirement still ends the original thread's authority to add
descriptors, poll or execute application callbacks.

ARM32 pointer conversion uses an interval index over the existing mapped-memory
owner. Overlapping native aliases retain their lowest guest-base identity;
translation checks exact bounds and permissions under one owner lock. Mapping
replacement, splitting and retirement update that same index.
The shared ARM32 ELF image owner resolves symbol names through the image's
original GNU or SysV hash tables and Bionic's hash functions. Both execution
backends use the same lookup, relocation and image lifetime.
Converted representations expose their exact guest type extent. Native
allocation release and reallocation retire their aliases through this owner
before physical storage can be reused; failed reallocation retains the existing
mapping. Resolver results follow the original linked-list ownership contract.

Native imports have one process-wide dispatcher. Each resolver implements its
own namespace and returns control for other symbols. Registration is idempotent
by resolver identity; lookup uses an immutable snapshot without allocation or a
hot-path lock. Native library constructors and JNI initialization retain their
library and class-loader lifetime.
Native ABI adaptations precede generic host forwarding; symbols outside those
adaptations retain their original providers. Imported functions, dynamic libc
lookups and raw Linux syscall delegates use that same dispatcher.
Temporary signal-mask waits preserve Linux's optional-mask behavior: a null
mask leaves the current mask unchanged and does not constrain its unused size.
Late POSIX destructor callbacks re-enter the retained physical thread context
before guest code runs, including its Android thread pointer.

Native ELF instruction adaptation shares one image-owned code context for TLS,
reserved-register and syscall instructions. Original executable segments,
function and unwind metadata, and verified instruction boundaries distinguish
code from embedded data. Instruction counting and rewriting use that same
context. AIM cached and load-time discovery call the same whole-ELF metadata
and executable-range analysis as the native loader, including code outside
shortened section tables and original mapping symbols. Both loaders share the
same control-flow and literal-reference pass:
decoded branches and address-taken targets protect reachable instructions,
while memory-referenced, unreachable constant regions retain their original
bytes. Branches establish code only when their destinations reach decoded
instructions; an address inside the segment alone supplies no proof. A
conditional branch to established code also preserves its decoded prefix when
fallthrough reaches opaque bytes. Those opaque bytes retain their
original data classification. Function metadata alone does not turn encrypted source bytes into code.
An intact stack-protected continuation can establish another control-flow root
when its Bionic canary load, saved stack slot, matching guard comparison and
normal return agree within the original function boundary. A fixed FP slot can
retain the original TP across register reuse and dynamic SP allocation; guard
comparisons allow bounded intervening calculations that preserve both values.
A rooted aligned prologue preserving LR and its callee-saved TP register can
establish the exact TP/canary-load prefix before an opaque continuation. That
prefix supplies no evidence for the opaque continuation. Opaque entry bytes,
explicit data and incomplete guard sequences retain their original treatment.
Ambiguous regions remain eligible for the original instruction analysis.
For ELF segments populated by positional reads, original file-site recipes apply
to the first translation of each copied range. Subsequent writable generations
are analyzed from their current instruction bytes. Mapping identities and file
offsets remain available independently of those consumed recipes.

Raw ARM64 signal registration translates the original Linux kernel action
layout to the same signal owner used by Bionic's public functions. Handler,
mask, flags and restorer queries retain that owner; native VM faults continue
through their original Darwin handlers.
ARM64 thread-pointer instructions use the same AIM emitter in both executors.
ART retains its original Bionic thread pointer. The JVM executor stores the
original Bionic TLS slot layout with its retained physical-thread context and
reaches it through an allocated Darwin pthread key. Android application slots
and stack guards use that guest storage; reserved Darwin TSD remains private.
Bionic's original device API-level function reads the same Android property
owner as framework `Build` and native property queries.
ART's Linux `rt_sigprocmask` copies signal sets through AIM's original
fault-contained user-memory owner. Unreadable input and unwritable output
return Linux `EFAULT`; signal-mask updates retain the original operation order.
ART user-memory writes retain Mach copying for ordinary buffers. Darwin rejects
Mach writes into `MAP_JIT` memory; validated writable executable destinations in
the guest address range use a fault-contained native copy that preserves the
calling thread's previous write-protection view. Invalid or retired buffers
retain Linux `EFAULT`; source reads retain the original Mach copy path.
File, pipe and socket receive payloads use temporary output buffers only for
owned JIT destinations; the shared copy owner scatters returned bytes under
mapping guards after blocking I/O completes.
Executable Android mappings share AIM's original native `MAP_JIT` allocation,
protection migration and instruction-store implementation. The JVM executor
calls that owner through a native ABI from its existing mapping and signal
dispatchers; ART retains the original AIM entry points. The JVM mapping owner
retains guest extents across replacement, partial unmap, remapping and fork.
Those extents and original loaded ELF mappings use executable-memory migration.
ELF publication and retirement track the covering host pages when an image's
logical base is shifted inside its allocation to separate finer-aligned code
and data segments. This image bookkeeping preserves the original alignment
requirements of guest memory syscalls and does not claim adjacent mappings.
Native stacks, host libraries and other VM code caches retain Darwin's original
protection behavior and mapping identity. Per-thread resume
state remains with the executor's physical thread lifetime, including native
cleanup after Java detachment.
When writable executable memory becomes executable memory without write
permission, both executors translate the final staging bytes at their destination
addresses before AIM's atomic mapping replacement. The JVM executor uses its
existing instruction emitters and allocated TLS key in that staging step. Code
emitted or decrypted after the initial ELF load receives the same register,
thread-pointer and syscall adaptations. Preparation failures preserve the
original mapping; JVM-generated veneer storage retires with its code mapping.
ARM64 guest `SA_SIGINFO` handlers receive AIM's original Linux signal frame,
including general registers, FPSIMD state and signal masks. The native callback
owns frame storage and calls the guest directly, preserving nonlocal returns
and native unwinding. Returned register and mask edits update the original
Darwin signal context.
Saved native dispositions are represented by a Linux-callable chaining bridge.
It converts the caller's Linux signal context through the same AIM frame owner
before invoking the original Darwin handler, and returns register and mask
edits to the Linux caller. Restoring that disposition retains its native ABI;
native handler addresses are not published as Android callbacks.
Linux realtime disposition registration and queries use AIM's existing
process-wide signal owner, including its full masks, restorers and default or
ignored actions. These records are independent of Darwin's physical signal
numbers and do not require an initialized guest thread.
The shared ARM32 ABI converter selects `siginfo_t` payloads from the original
signal number and code. Clang supplies both record layouts and constants;
timer, queued-value, child, poll, syscall and fault-extension fields retain
their declared widths. Fault addresses reuse existing memory aliases without
creating readable mappings, and queued values retain their opaque bits. Signal
frame views belong to the callback and retire when it returns.
Fatal ART native reports retain the original interrupted registers and read a
bounded instruction window from the same process through the kernel's fault-safe
memory reader. Instruction bytes are labelled as observed at report time, after
any guest signal handler; ordinary handled faults perform no diagnostic memory
reads.
Software `SIGABRT` termination reports the original live guest syscall context
and bounded frame chain when no hardware fault preceded it. Host-only and idle
guest contexts do not acquire a guest fault attribution.
Fatal faults inside the native Linux adapter include the live guest syscall
arguments and frame chain alongside the interrupted native registers.
Explicit Linux syscall tracing includes the original guest instruction address,
link register and frame pointer with each entry record. Unmap records also
retain up to eight saved return addresses through the existing guest-memory
reader; invalid, unaligned and cyclic chains stop at the validated prefix.
An explicit `MACLAUNCHER_ART_FAULT_INSTRUCTION=1` launch diagnostic captures
the interrupted SIGILL instruction before the guest signal handler. The saved
word and report-time view have separate labels. The separate
`MACLAUNCHER_ART_HANDLED_FAULT_CONTEXT=1` diagnostic records at most sixteen
handled protection faults before guest delivery, including their interrupted
registers and instruction. It uses bounded local storage and the existing
diagnostic descriptor; unavailable output does not change signal delivery.
Ordinary launches perform no additional diagnostic reads.

Original Bionic character-classification functions share one native namespace,
including their inline and locale forms. The same owner supplies Bionic's
original multibyte conversion and iconv units, preserving Android's conversion
state layouts, UTF encodings and function aliases. Android LLVM compilation
retains those layouts while the Darwin backend emits native Mac code; errno
values use the native platform boundary.

The complete original Bionic terminal family shares the native descriptor
owner. Terminal ioctl calls translate Android records, control-character
indices, baud encodings and flags to Darwin terminal settings. Direct ioctl
requests use that same boundary; other descriptor requests retain their
existing owners.

Locale objects and locale strings retain their native ownership and per-thread
selection. `localeconv` exposes the complete original Android record layout
through a per-thread view, copying fields by their original names.

Bionic's process-execution family
retains its argument, environment, PATH and script selection above the native
process and private-path boundary. Variadic entries use the same AAPCS64
argument handlers as other native imports.

Guest JNI attachment first establishes the existing native thread's lifetime
owner, then attaches that thread to the VM. The same owner detaches it before
native thread retirement, including foreign callback threads. Signal dispatch
keeps native/JVM fault contexts with their original native handler and translates
guest fault contexts at the Android boundary.
Constructors, `JNI_OnLoad` and registered native calls enter through the same
thread setup as native workers, initializing their Android thread pointer and
stack guard in the existing retained execution context.
Native CPU-affinity masks use the same CPU count as `sysconf` and the process
CPU files. Raw Linux calls return the initialized mask extent; Bionic's libc
entry returns zero and clears the remaining buffer, including unused CPU bits.
Inline Linux syscalls save guest machine state on the existing physical
thread's guarded native stack before entering C. Small language-runtime stacks
retain their original bounds. Nested signal callbacks borrow the suspended
native cursor, and the original Bionic nonlocal-jump family restores that cursor
and Darwin alternate-stack status alongside its registers and signal mask.

Original Android compatibility callbacks receive the complete generated change
configuration for the application's target SDK. Platform compatibility policy
retains upstream SDK-dependent behavior for both older and current applications.
Before application native images load, the JVM native loader receives that same
parsed `ApplicationInfo.targetSdkVersion`; its symbol scope follows Android's
SDK-dependent local and global library visibility rules.

ARM32 uses the same framework, package storage, network policy, native library
loading and platform services as ARM64. The execution adapter changes machine
instructions, pointer widths and calling conventions; it does not introduce a
second Android service stack.

Common Java adapters live in the native `java` source group. ART compiles that
complete group with its own entry sources against the supplied Android core
declarations before DEX conversion. HotSpot-specific implementations live in
`java-jvm`; the JVM producer compiles both groups. The full original Android
framework and core libraries remain supplied by the selected runtime.
Native-call argument and result scratch storage belongs to each invocation.
A standard monotonic stack buffer retains full ABI alignment and uses ordinary
heap fallback for larger calls; nested callbacks retain independent storage.
The native type model retains every original C type declaration, including
interfaces returned through erased `void*` output parameters. One typed data-view
owner converts pointer chains, records, arrays and function pointers, publishes
alias identities before following cycles, and releases representation storage
with its owner. Original OpenSL ES and OpenMAX AL interface identifiers and
header declarations determine interface-query output types. Their native engine
and physical audio operations remain shared with ARM64.
OpenSL player and recorder configuration uses the original Wilhelm value,
size-query and object-state algorithms in the existing stream owner. Playback
stream types and recording presets remain per stream; performance queries
report the shared buffered CoreAudio path after realization.
JNI descriptors determine native argument widths and signedness, including
sign extension of Java byte and short arguments into AAPCS32 parameter words.
The width adapter uses one JNI reference, buffer and callback implementation
for both VMs. Its tables come from the selected VM's original JNI header.
HotSpot supplies method descriptors through JVMTI; ART supplies shorties through
the original NativeBridge runtime callbacks. Original libffi provides native
closures. NativeBridge registration retains original ART's regular or critical
call-type selection and uses the same cached JNI trampolines; critical calls
carry primitive arguments without a JNI environment or receiver.
VM initialization entry points use the same reference and execution owner with
the original `JavaVM*` calling convention. Native library search and image
publication share one component: pinned Bionic namespace access rules govern
isolated directories, explicit library links and inherited image membership.
The image registry retains canonical path identity and the original ELF
`DT_SONAME`. Either the loaded filename or SONAME identifies the same image;
Android `RTLD_NOLOAD` lookup returns existing images without mapping new files.
Constructors remain outside the mapping lock.
Address lookup retains guest ELF ownership and returns the actual native
provider's image and symbol metadata for imports implemented by macOS.
ART keeps JNI calls and references on its Bionic execution context,
while its thin transport delegates CPU, memory and ELF operations to the same
native implementation.
`art/build-arm32.mjs` compiles that shared JNI source with the selected NDK;
`art/build-ffi.mjs` builds its pinned Android libffi dependency using the
upstream configure and Make rules. Clang depfiles retain incremental header
dependencies, and the shared CPU archive comes from the normal Dynarmic target.
Its optional NativeBridge supplier uses original ART class-loader namespace
callbacks and retains original Bionic ownership of native ARM64 dependencies.
Translated dependency groups map before relocation and publish through the
same image registry. Original ART APEX namespace lookup identifies the existing
VM; JNI closures and their native cleanup code remain resident for the process
lifetime. The supplier recipe includes the corresponding original notices.
Suppliers containing this complete width adapter declare ARM32 alongside
ARM64. Preparation selects the APK's original native ABI and its installed
library directory. ART remains the original 64-bit VM; its NativeBridge owns
translated calls only. Dynamic library lookup uses the same retained image
groups, caller namespace and original Bionic `$ORIGIN`/`$LIB` runpath expansion.
Both bindings load the same original ARM32 compiler runtime, ABI routines and
legacy Bionic data image before application libraries; pointer-bearing tables
retain their original guest layout and namespace membership.
The complete legacy character-table family declared by Bionic's
`ctype_private.h` comes from its original `ctype_.c` and `ndk_cruft_data.cpp`
units. Classification, lowercase and uppercase tables and their exported
pointer variables remain in that same ELF image, including embedded zero bytes.
Clang evaluates the original NDK's LP32 and LP64 loader constants for the shared
adapter, preserving lookup-handle and binding-flag meanings across CPU widths.
The same native-import adapter and NDK type tables also compile in the Bionic
context. Original libffi calls Bionic's variadic exports directly there; the
macOS binding retains its existing Android argument-list handlers. Native
mappings retain their original allocator and protection callbacks across
partial unmaps, through the same memory owner.
Record conversion follows each ABI's original field layout; libffi separately
uses the complete native field order. Architecture-specific padding retains its
own extent, and Bionic's legacy inode member receives the canonical inode's low
word. File-status operations, including both `fstatat` aliases, share the existing
native namespace, identity mapping and Darwin-to-Bionic record conversion.
The `creat` and `creat64` entry points use the same `openat` owner for pathname
translation, creation modes and truncation.
Original NDK declarations include inline definitions and native-owner headers.
Clang supplies both targets' field layouts, character storage and file-command
values. Argument conversion preserves opaque epoll data words, complete
process argument arrays and native file-lock records. The original Bionic
scanf specifier/type selection supplies output-pointer layouts before the
shared scanner runs. ARM exception-index queries use the common image registry
and Bionic's original guest-width unwind wrapper.

## Storage and host policy

Java and native I/O share explicit application storage aliases, including scoped
external paths composed from the application's canonical private-files root.
Each alias resolves once to its existing data owner; device-protected storage
and other packages retain their separate paths.

Native libc and original libcore extended-attribute calls share one macOS file
boundary. The complete path, symlink and descriptor families use the existing
guest namespace and kernel attribute storage; create/replace flags and syscall
signatures are translated once. File descriptors retain the same metadata after
rename, and the common errno boundary preserves Android error values.
Filesystem capacity queries share one Android record converter across path,
descriptor and 64-bit aliases. The existing width converter supplies ARM32
records. File-access advice preserves descriptor offsets and reports Android
error values; supported read-ahead hints use macOS file-description controls.
The native Linux procfs view includes its existing parent directory, so managed
file APIs can validate that directory before opening CPU and memory reports.

Native `getrlimit`, `setrlimit` and `prlimit64` bound `RLIMIT_NOFILE` by
macOS `kern.maxfilesperproc`, preserving lower explicit limits and the other
resource limits. ART commits its credential limit only after macOS accepts the
change. Before lowering the physical descriptor limit, its existing descriptor
owner retains open descriptions for continued I/O. Those owners remain pinned
through close or replacement; exec transfer preserves guest close-on-exec flags.

Native `select`, `pselect` and `pselect64` imports use the same pollable descriptor
owner as counters, timers and epoll. Android signal masks and timeval fields are
converted at that boundary; timed selection preserves Android's remaining-time
result. ARM32 uses the existing generated signal-set and descriptor-set width
conversion before entering the shared native implementation.

Process memory maps report the current process's regions and access permissions
in Linux format. Native mappings use the macOS region view; translated ARM32
mappings use their original logical address space and page permissions. File
names and offsets come from the existing namespace and loaded-image metadata.
Installed APKs and primary/secondary native-library directories retain the
same path identities exposed by `ApplicationInfo`, including canonical file
targets behind symlinks. This does not expose enclosing preparation directories
or other applications' private files.
Each access refreshes the maps file atomically, preserving the snapshot held by
an already-open descriptor. Files outside the guest namespace remain anonymous.

Each application has private persistent files, preferences and caches under the
selected launcher profile. Temporary launcher profiles use separate storage.
The Android sandbox records native startup environment values before adding host
runtime controls. The versioned UTF-8 vector contains the admitted Android
namespace paths, private home and temporary directories, fixed executable search
path and selected locale settings. It excludes launcher credentials, host JVM
arguments, preloads and graphics or process-control variables. Entries retain
their original values and are bounded by count and UTF-8 byte size.
Native files retain allocation, positioned I/O and mapping operations after
adoption by the shared descriptor owner; their original access modes apply.
Prepared APK inputs retain the package's resource and split identities. Native
libraries retain their installed executable modes. The JVM sandbox permits
execute-permission checks for verified, read-only installed ARM ELF files through
exact-file capabilities; host binaries, scripts and writable paths are excluded.
Shared ELF files retain these capabilities when all hard links belong to
verified prepared inputs outside writable storage; unaccounted links are excluded.
ART's default installed-code view is root-owned and readable. Executable files
receive guest mode `0755`, preserving explicit guest metadata and the host's
private permissions. Mutable application files retain their guest owners and modes.
This does not add Linux ELF child-process execution to the JVM. ART reads assets
directly from the original APKs; JVM filesystem asset consumers use extracted inputs.
Unused extracted ART assets retire under the package preparation owner after
its generation readers release, preserving APK paths and native library inodes.
Path translation and the process sandbox confine file access to the application's
grants and shared read-only runtime inputs. Explicit file import copies the
selected file into application-owned storage.
Empty filesystem or executable capability collections grant no access.
Profile services retain installed APK generations through the same package
source owner. Independent installed packages prepare with bounded concurrency;
each package keeps its existing preparation lock, UID and caller data scope.
Process declarations retain catalog order, and failed preparation settles
started work before releasing its source generations.
Missing application or optional service code retires its installation metadata
while preserving its UID and saved files. Concurrent discovery retains newly
published source generations. Google service packages selected for a launch
retain their installation identity and report missing source files.

Network permission is selected per game and applied to JVM, native and embedded
web requests. Android connectivity state follows that selection. Advertising
policy and external-link requests are handled at host network and intent
boundaries, without removing Android framework APIs. External browser navigation
requires an explicit approved action. Location is supplied only when requested
and manually configured.

Original package resolution handles installed Android activities first. An
unresolved `ACTION_VIEW` with an HTTP(S) URL can request the Mac browser through
the shared approval boundary; Android package, component, MIME type and category
metadata do not suppress that fallback. Network isolation and advertising policy
apply before browser approval, and approval never grants direct browser access
to Android code.
The Java bridge uses the JDK URL parser for explicit ports, including
internationalized hostnames and IPv6 addresses. The host broker normalizes the
destination before requesting approval.

The WebKit provider forwards page and subframe navigation through the original
Android `WebViewClient` request overload, retaining URL, frame, gesture, redirect,
method and header metadata. Android's original overload dispatch preserves older
string-based clients. Application-initiated loads retain their separate identity;
local scheme messages use the same callbacks while network isolation applies to
actual network operations.

The ART Linux socket layer retains multicast scalar and membership record layouts.
UDP pending-byte queries use the native first-datagram payload count, excluding
source-address and control storage while preserving queued packets. Stream
queries retain their native readable-byte count.
Datagram receives retain Linux full-length `MSG_TRUNC` results using the existing
socket receipt for cross-process receive admission; readiness waits remain outside
that admission and preserve nonblocking mode, receive timeouts and zero descriptor limits.
IPv4 TTL and loopback values adapt to Darwin's byte records; IPv6 retains integer
values. Interface selections and group memberships resolve through the same
Linux device owner and physical network as other native sockets.

Application services share one initializer and application-lifetime owner across
VM bindings. Physical window and audio owners are supplied through typed bindings;
service registration and job lifecycle remain common code. Both VMs use the same
virtual Android battery: 100%, AC-connected, fully charged and healthy, with
battery saver disabled and nominal thermal status. These values live in the
common Android service implementation; no Mac battery/thermal observers or
notification threads run. Android battery clients and internal controls retain
their original contracts. Game wake locks are logical app-owned tokens and do
not create Mac power assertions, reset the idle timer or wake the computer.
Mac sleep and wake notifications enter the existing window event queue and
original Activity pause/resume path. Focus restoration stays suspended while
the computer sleeps, and only the current surviving Activity resumes on wake.

Both execution engines use the same signed Mac application entry, Android label
and rendered icon, IconServices operation, shader-cache access and LaunchServices
bundle grants. The shared native application boundary owns SDL/AppKit startup,
Dock identity, icon assignment, foreground eligibility and shutdown. VM adapters
pass identity data and retain their own VM references. Background launches do not
activate the application; windowed applications remain ordinary Dock applications.
Game windows use the launcher's dimensions and do not participate in macOS
saved-window restoration. The shared application boundary establishes SDL's
state-restoration policy before AppKit processes the initial launch event.

Activity orientation requests follow one output-owner policy. The JVM binds that
policy to its native window session; ART selects an actual native window mode
through the original SurfaceComposerClient and Composer3 interfaces. The shared
Mac placement routine fits each orientation to the screen. Original rendered
buffers commit the display dimensions and pointer coordinate extent together.
Physical pointer positions map from Mac window points into that committed
Android display extent. Window selection and local coordinates use the original
ViewRoot's screen frame; Android applies window compatibility scaling and view
scrolling through its original input stages.

| Platform responsibility | Shared implementation | VM-specific boundary |
| --- | --- | --- |
| App name, icon and Mac bundle | `package-metadata.js`, `application.js`, `application-platform.h` | JVM entry or native ART presenter executable |
| Window, drawable and lifetime | `window-physical.h`, `session-core.c` | VM surface references and original producer transport |
| Android surface composition | Original `Surface` and `SurfaceControl` APIs | JVM `HostSurface`/`HostSurfaceControl` adapters; ART original SurfaceFlinger |
| Keyboard, composition, pointer and scrolling | `window-input.h`, `HostInput`, `HostScrollInput` | JNI delivery or the ART input pipe |
| Audio devices, PCM mixing and volume | `audio-device.c`, `audio-pcm.c`, `audio-volume.c`, original Klepton audio source | Original Android media/AAudio transport |
| Physical network state and ad policy | `connectivity-core.h`, `network-policy.c` | JNI notification or ART hostcall notification |
| Google integration and account selection | `launch-policy.js`, `service-processes.js`, `google-accounts.js`, account service | APK process execution |
| App files and process identity | `storage.js`, `storage-namespace.json`, installed-package services, `ProcessAuthority` | JVM path translation or original ART VFS mounts and native IPC |
| Application and initial Activity creation | `HostApplication`, `HostActivity`, original `Instrumentation` and `AppComponentFactory` | Application class loader |
| Provider startup | Original manifest parser and `ActivityThread`, `HostPlatformPackages`, `HostContextServices.installProviders`, verified provider preference lease | Application class loader or lazy shared system process |

ART service lookup errors preserve the original service-manager transaction
status, distinguishing an absent connectivity service from an IPC failure.

Android Conscrypt and BoringSSL provide the Android cryptography and TLS boundary;
JDK callers retain their JDK providers. The supplied trust data and service
identities are recorded with their pinned inputs. KeyStore links the original
service implementations to the shared Binder and cryptography owners.
The shared application bootstrap installs the original Android KeyStore provider
before component factories and application code run; key operations use the
authenticated profile service and the application's Android UID.
The KeyStore owner keeps its database under the profile's private service data
directory, independently of the selected runtime version or owner process.

## Build inputs and reuse

The normal build reuses supplied executable framework, native runtime, ANGLE and
portable codec artifacts. It compiles owned adaptations and selected original
native implementation modules. A full Android product build is not part of this
pipeline. The original Blueprint parser resolves source groups for the modules
that are compiled; it does not require Soong or Kati product evaluation.

`framework-binary.json` identifies supplied artifacts and checksums.
`source-pins.json` and component source catalogs identify consumed revisions.
The immutable build snapshot records owned sources and compiler inputs. Java
assembly, DEX conversion, native objects and external supplier builds have separate
reuse boundaries, so an unrelated native edit retains unchanged application and
framework bytecode.

`buildArtGuest` builds the original Binder library and the native application
components through one producer. Its optional `targets` selects complete output
components and their link dependencies; omitting it builds every output.
Binder-only builds retain the original module source closure and reuse cached
Clang/Ninja objects without requiring the resolver or WebKit producers.

`buildGraphicsLibrary` supplies the complete JVM graphics object and link inputs
for full and component builds, including original framework GLES JNI bindings
and the typed guest ABI adapters. Component builds regenerate the same Ninja
graph from those inputs before reusing cached objects.

Compiler prefix maps keep developer paths out of delivered binaries. Published
native libraries use relocatable loader paths; notices retain source revisions
and licenses. Runtime staging installs a complete version and updates its
ordinary launcher declaration atomically.

Developer build arguments and source catalogs are documented in the
[native host reference](../../src/modules/android/native/README.md).

## ART supplier boundary

The ART source recipe lives in `src/modules/android/art`. It consumes a matched
Android image, ART/libcore binaries and original framework DEX, together with
pinned AIM Linux ABI and ELF support. It does not convert application DEX or
apply HotSpot framework rewrites. D8 packages the launcher-owned Java integration
classes separately. The JVM remains the default execution engine.
An optional complete HWUI component is supplied as `hwuiLibrary` with its
`hwuiNotices` directory. The shared launch layout binds that immutable file
read-only at `/system/lib64/libhwui.so` for composition and application processes.
The acquired system image and its recorded content identity stay unchanged.
Supplier-relative component notices are retained in the ART package declaration.
The optional producer in `native/hwui` builds the complete pinned Android 16
HWUI, Skia and static dependency targets against the image's private ABI. Its
CommonPool adaptation keeps the original class layout and API, wakes and joins
workers before synchronization storage is destroyed, and retires partially
constructed pools safely. Source, generator and compiler inputs are explicit;
original sources stay read-only. The producer preserves the original exports,
shared dependencies, release settings and sanitizer policy. `buildArt({hwui})`
selects this producer; omitting that input retains the image's original library.
Owned AIM overlays include the RGBX framebuffer projection and its IOSurface
implementation. Source export applies those overlays independently of any
enclosing Git checkout, while compiler products remain in the build cache.
The Linux device layer supplies the original DMA heap allocation, descriptor
metadata, buffer synchronization and mapping operations used by Codec2. Media
services retain the matching Android image's buffer-pool configuration. Native
display-mode operations use a separate protocol extension alongside upstream
text-input operations; editor state remains with the shared Android input owner.
ARM64 register translation uses the same Klepton instruction decoder and veneer
emitter as the JVM native loader. AIM retains its Linux ELF mappings, thread
slots and saved contexts; cached and load-time translation both use that owner.
Translated ELF files and load-time site records are keyed by the original ELF's
SHA-256 and the translation format version. Changes to instruction analysis or
emission use a new format version, so previously rewritten bytes are not reused.
Optional syscall tracing records bounded executable-publication rejections with
the publication stage, original instruction, address range and native error.
It also reports final staging ranges and the number of adapted instructions,
including general x18 operands, before executable publication.
Rejected publication preserves the existing mapping and its original bytes.
The JVM native loader snapshots the complete executable publication range into
private writable storage and plans TP, syscall and x18 adaptations together.
Final-address branch checks include unused reserved gaps in the owning ELF.
One mapping replacement publishes the prepared range after every site passes;
the original range retains its bytes and permissions on failure. Veneer
reservations remain owned until the corresponding source pages retire.
Load-time instruction stubs first reuse nearby executable islands. If ordinary
placement hints are occupied, allocation searches actual free Mach VM gaps
within the instruction's branch range. Island capacity fits page-aligned gaps,
and its mapping size is preserved across process forks and retirement.
Reserved ELF segments remain occupied;
stub allocation never replaces those mappings.
Immutable ART executable-file mappings use the same hardware instruction body
through a per-address trap identity when an x18 adaptation cannot reach a free
island. Bodies and continuations retain process ownership across replacement
and fork. Original breakpoints retain Linux signal delivery; a conflicting
retained identity is rejected before replacing the destination. Read/execute
file mappings prepare their translated bytes and final permissions before
fixed-address publication. Mutable JIT publication retains its direct-island
path.
Guest x18 values live in the existing thread slot, including across system calls
and preemption. Syscall snapshots and Linux signal frames read that same slot;
signal-handler register edits restore it while preserving Darwin's reserved
physical register. Indirect x18 branches resume through the saved Linux context.
SIMD structure operands are decoded only for allocated architectural encodings;
reserved opcode combinations remain unchanged in executable data.
Fixed fields in compare-and-swap and ordered memory instructions are validated
before register translation, preserving unallocated packed words byte for byte.
Reserved shift widths, bitmask immediates and memory-pair sizes also inform
the shared data-neighborhood analysis without classifying unknown extensions
as data.
Scalar floating-point conversions validate their precision, rounding and scale
fields. SIMD memory widths and register-index extensions retain their original
operand banks; reserved combinations remain unchanged in both executors.
Tagged immediate ADD/SUB instructions retain their fixed architectural fields.
ADD/SUB instructions that write SP use the same saved-context completion as
SIMD structure post-index instructions. Tagged pair stores retain their original
memory-tag operation and 16-byte immediate scale.
SIMD structure instructions that update SP by x18 execute their original memory
operation in hardware. Their shared veneer restores scratch registers and commits
SP through the existing saved signal context, without retaining a value in
Darwin's reserved physical register or reading released stack storage.
Original ELF preparation installs the existing native signal multiplexer after
the JVM starts, retaining its native dispositions before translated code runs.
ADRP veneers preserve the original page address even when nearby executable
storage crosses the instruction's signed page range, using immediate address
materialization when a relocated ADRP cannot reach it.
The initial ELF stack occupies the top of the existing guest address window,
with its original guard page, arguments and auxiliary vector. Allocation uses
the same non-replacing mapping owner as other guest memory; ordinary `mmap`
placement remains independent. Fork preserves the stack mapping, while exec
recreates it through the original ELF loader.
Fork relocates shadow-stack bytes only within the current context's owned
allocation. An architectural x18 pointer into ordinary guest memory retains
its address in the restored child mappings.
The ARM64 VDSO exports its clock and signal entry points with the standard
`LINUX_2.6.39` ELF symbol version, available through `AT_SYSINFO_EHDR`.
The procfs auxiliary-vector files expose that loader's immutable per-exec vector,
including the original guest addresses and CPU capability values. Linux's BTI
capability bit remains clear because executable mappings are unguarded; CPU BTI
instruction hints and other reported CPU capabilities are unchanged. Process and
task paths share the same vector; fork inherits it and exec replaces it. Other
guest processes read the saved bytes through the existing process record.

The supplier manifest records relative component paths and the Android image
identity. The Android payload contract `artExecutionVersion: 1` selects a supplied
ART entry; the declaration is independent of the JVM's conversion contracts.
Suppliers declaring `binderSenderIdentityVersion: 1` use authenticated process
credential transitions to update the original Binder transaction sender UID.
Opening security credentials remain fixed, while pending transitions have no
active sender identity until the native credential owner confirms the new UID.
The original window and service caller checks retain their enrolled identities.
Suppliers declaring `frameworkResourcePreinitVersion: 1` initialize the original
system AssetManager and image overlays before application setup. This stage uses
a minimal Linux startup identity, then permanently replaces real, effective,
saved and filesystem UID/GID values with the enrolled application identity and
clears capability sets and bounds. APK loading, application native constructors
and process enrollment validation follow that drop. The selected immutable boot
classpath and guest libraries supply the initialization code; retained suppliers
without this declaration continue to start directly as their application UID.
The optional `ptyHolder` component maps to `host/aim-pty-holder`, beside
`host/linux-run`, following AIM's original host-node dependency declaration in
`crates/aim-build/src/cargo.rs`. Original Linux terminal operations start that native owner
through the runner's sibling path; its process records remain in private session
state outside the guest filesystem.
APK code generations include their execution format, while installation identity
and private application data retain the same storage owners.
Native code metadata initialization uses the same per-package kernel lock as
APK verification and publication. Reusing a prepared generation preserves its
existing inode attributes and digest-cache identity. Initialization declares each
installed-code root without walking its descendants; standalone code files record
their metadata once. Writable application data retains its separate import policy.
ART application setup supplies the original VM's target SDK and uses Android's
native-library alignment inspection and package-state policy to select Bionic's
4 KB library compatibility mode on 16 KB systems. Manifest overrides and segment
eligibility remain with the original Android implementations.
The guest binding links the matched runtime APEX's `libdl_android.so` for this
private linker API; the NDK supplies the ordinary public link interfaces.
ELF segments copied into anonymous reservations retain their original file and
inode through the existing mapping owner. Executable publication uses the same
file translation metadata as ordinary mappings, preserving read-only ELF data
that shares a larger executable page. Mapping moves, retirement and fork retain
the corresponding source lifetime.
The native session initializes its original runtime and linker namespaces once;
app and provider processes add package mappings without recreating that state.
Before application JNI runs in JVM execution, the Bionic bootstrap gives the
original default namespace the current package's mounted native-library directory. Name-only
`dlopen` and dependency lookup retain original caller namespace, search order
and image ownership. Host library search paths are excluded; platform startup
dependencies are linked before the application directory is selected.
The existing installed-code initializer covers each mapped package and native
directory, preserving host-private modes and explicit guest inode records.
The macOS sandbox permits ownership-attribute reads on those exact directory
nodes without granting their contents or adjacent package files. The original
linker checks and selects existing library search directories; configuring a
search path does not grant access to a library.
Native C threads retain their attachment state across library loading. JNI
metadata publication borrows a VM attachment after authenticating the calling
image and releases it before the original linker runs constructors.
The temporary attachment preserves the native thread's Looper and execution
state. Application JNI detach and physical thread retirement retain their
normal lifecycle.
ART launch contexts can observe named runtime retirement steps through
`onRuntimeRetirementStage`. Observation failures preserve the original cleanup
result; ordinary launches have no observer.
The typed EGL/GLES carrier retains the complete NDK and pinned ANGLE extension
declarations. Callback functions and user pointers remain associated with their
original graphics context; context destruction retires their native holders
after active callbacks complete.
AAudio profiles map `libaaudio.so` to a complete typed NDK carrier backed by
the existing native Mac PCM stream owner. Builder callbacks are copied into
each opened stream and remain valid after the builder is deleted. Native
audio feeder callbacks retain authenticated application-image ownership and
one original Bionic pthread through physical retirement, with Java attachment
controlled by the original VM APIs. Stream release joins the feeder before
retiring its buffers; close then releases the stream object. Capture retains
the selected-input and microphone-permission policy of the native audio owner.
Stream attributes retain their adopted values; hardware queries read the live
native PCM format. Compressed offload and stream presentation timestamps return
`AAUDIO_ERROR_UNIMPLEMENTED`.
Their distinct mount views share the session's native descriptor metadata, so
Binder transfers preserve socket and file ownership across processes.
Executable access follows immutable installed code roots, with writable app data
kept separate. Authenticated installed-package records supply exact read-only
APK, split and native-code mappings. The existing package-code initializer
sets their Android root ownership and readable modes; peer private-data roots
remain unmapped. Native IPC uses directory-relative sockets inside the private
session directory, including profiles with long filesystem paths.

The two VM entries use the same application bootstrap, Activity lifecycle,
context-service and application-job initializer. Original ActivityThread,
LoadedApk and Instrumentation records share their initialization and retirement.
The original process bind record, package context and services are published
before the APK's component factory initializes. Its original class-loader
factory supplies the loader used for Application and initial Activity creation.
Feature APKs join the original cluster parse, including activities,
aliases, services, providers and receivers. Launcher inspection applies the base
application and SDK defaults while collecting split declarations in Android's
split-name order. Split application attributes do not replace the base defaults;
the original parser owns definitive component metadata and split identity.
Signature, dependency and native-ABI validation applies to the complete package
set. For isolated packages, the base loader contains only the base APK;
original `LoadedApk` and `ApplicationLoaders` construct the declared split
dependency hierarchy. `ContextImpl` supplies split resources and component
contexts. Initial Activities and local Services select the original split
loader; providers and receivers retain ActivityThread's split routing.
JVM preparations index classes by their original APK. Prepared bytes can be
shared without sharing defining loaders; later APKs containing a duplicate class
use the original per-APK converter so sibling definitions remain distinct.
Converted Android `ClassLoader.getSystemClassLoader()` calls use the immutable
Android platform loader, retaining the full framework class path. Original module
filters therefore share only the application classes selected by their own
delegation rules. Host JDK system lookups independently retain application
handlers, services, resources and instrumentation through the JVM system loader.
Named hardware-feature queries evaluate the matching device capability without
initializing unrelated graphics suppliers. Full feature enumeration and device
configuration retain the actual EGL version query, whose cache is independent
of process state and importance queries.
Application and initial Activity construction call original Instrumentation,
including the APK's `AppComponentFactory`, original exceptions and single
application attachment. Factory-created Activities retain the resolved Android
component and its original `ActivityInfo` during attachment. Provider publication uses the same verified preference
lease and precedes the original Application `onCreate` callback. Process selection
uses parsed component metadata. Original `ActivityThread` selects each provider's
context from its `ApplicationInfo`, retaining package-context creation when an
Application overrides its reported package name. Disabled components remain
excluded through Android's component state and enabled flags.
Activity attachment and local service routing use the installed component's
package, UID and process rather than a Context's reported package name. Remote
service requests retain the configured process principal as their caller.
Original `LoadedApk.AppComponentFactory` creates ordinary and job services with
the application loader; substituted classes retain their declared service name
during original `Service.attach` and lifecycle callbacks.
Both entries retain the `HostActivity` task owner across navigation and
configuration relaunches. Closing retires its current Activity stack on the
owner thread while the output and display source remain available to the
original pause, stop and destroy callbacks.
Initial and navigated Activities use original `ActivityThread` destruction,
which marks an Activity as finishing before pause, stop and destroy callbacks.
Activity task removal follows the original root-only and always-remove modes;
ordinary Activity finish retains the remaining task records.
An accepted local Activity launch owns its queued handoff until its main-thread
callback completes. A display-turn boundary between finishing a launcher and
creating its successor therefore does not retire their shared output.
Up navigation uses the same task owner, retaining the original destination
Intent, caller result and launch mode. Reusable parents receive a new Intent;
standard parents use ordinary Activity creation and replacement.
Initial ART output and service Activity output use the same window retirement
sequence. Activity teardown failures retain the first exception while compositor
detachment and window cleanup continue. Display callbacks stop after compositor
detachment; an active producer retains its window through the native close barrier.
Task-empty notifications run after queued Activity requests and recheck the
current task against the same window owner. A launcher can finish before starting
its successor without retiring the successor's output.
The common storage namespace maps private credential/device-protected data,
external files, cache, expansion assets and media to the existing installation.
JVM bindings translate host paths; ART projects the same aliases through its
original VFS while retaining native Android partition and session roots.
JVM File, stream and NIO path operations also use the existing native owner for
virtual `/proc` and `/sys` files, preserving original JDK descriptors and errors.
Fused module archive names use one planner over the original parsed
`ApplicationInfo` metadata and split catalog. JVM path mappings and ART
read-only VFS binds reference the containing APK; real installed splits take
precedence. Both paths retain the original inode and package identity without
copying archives or registering additional packages.
Original Linux descriptors retain their opened mount in the existing descriptor
owner. Proc-fd paths follow the current vnode name within that mount across
duplication, renaming, fork and exec, preserving Bionic canonical-path behavior
when several Android aliases refer to the same storage.
Synthesized proc files retain their canonical virtual name in that same
descriptor metadata. Native maps snapshots retain their origin on the snapshot
inode, so duplication, fork, exec and later snapshot replacement preserve the
opened file's name independently of its temporary storage.
After each renderer drains its own surfaces and callbacks, the common application
owner retires services, providers, broadcasts, network/location observation,
permission registrations, resources and context state. Partial ART startup uses
the same retirement path. The original failure remains primary; later cleanup
failures are suppressed on it, and repeated retirement is idempotent.
Native composition and application processes share one termination owner.
Session files and descriptors remain available until process exit, including
after forced termination; graphics publishers retire concurrently.
Touch-joystick and manual-motion settings use one application configuration
reader and the same input owners, including position and radius validation.
Keyboard construction uses the same complete character-map resource and device
registration; each VM binding invokes its original Android native parser.
Android resource configuration reports an exposed QWERTY keyboard for the SDL
keyboard source.
Typed physical bindings select the native surface representation, shared audio
owner and optional sensor publication; service policy remains in the common
implementation. The native presenter reports buffer retirement independently of
physical display, including occluded windows.
ART passes its present-fence observer to the shared graphics library through
`rsSubmitFramePresenterAtTimeObserved`; source-buffer release and presentation
retirement retain separate callbacks.
Both VM builds compile the same CoreAudio device discovery, format, latency,
route-monitor lifetime, PCM mixing, volume and pause implementation. JNI and
the original audio-ring hostcall protocol only translate their respective
transport records and callbacks.
Shared stream-activity policy queries the executing audio owner through the
same volume/activity binding. ART uses the original `AudioSystem` and native
audio policy service, while JVM uses its existing physical player activity.
The JVM decoder/player binding remains separate from ART's original media
clients. Decoded MediaPlayer and SoundPool clips share immutable PCM samples
and retain independent playback clocks, looping, rate, seek and channel gains
in that same mixer. Copies retain their samples through playback and release;
they do not open a separate Mac audio player.
The JVM MediaCodec native owner selects VideoToolbox for AVC/HEVC and the pinned
decoder-only libvpx library for VP8 and VP9 profile 0. Both decoders supply
retained CVPixelBuffers to the same input/output lease, callback, timestamp and
Surface owner beneath the original AOSP Java and NDK clients. libvpx I420 planes
are copied directly into a bounded NV12 pool, retaining color attachments and
using the same byte-buffer stride and native Surface presentation paths.
Software decode discovery reports its 4096 × 2304 limit and supported profile;
other VP9 profiles return the ordinary unsupported-format error.
The physical PCM output exposes one optional process-lifetime filter after
mixing and Android stream gain. It receives the original rendered samples on
the existing CoreAudio callback; filter implementations retain their code until
process exit and perform no blocking work on that callback.

APK inspection reads binary XML declaration, namespace, resource-map and
character-data chunks using Android's resource layouts. Character data preserves
the element hierarchy and does not replace manifest attributes or declarations.
Explicit microphone and camera selection uses the same launcher permission
request, sandbox capabilities and capture implementation. VM bindings marshal
device identities and PCM or camera buffers; the shared physical owner retains
capture conversion, device authorization, stream tokens and retirement.
Microphone resampling and anti-alias state use Klepton's original conversion
code in that same physical owner, shared by AAudio and media input bindings.
The media platform component owns selected devices, capture authorization,
microphone stream lifetime and camera sessions; VM adapters marshal strings,
tokens and sample buffers without maintaining separate media policy.
Application operation starts retain their client Binder, UID, package and
attribution. Nested starts balance their finishes; the last finish, client
death or application retirement releases the operation's death subscription.
Memory queries use each VM's native memory-accounting owner and a shared
ActivityManager threshold calculation; the ART process retains its original
Bionic system-information interface.
The shared compatibility service reads the JVM's packaged generated definitions
or ART's matching system and active APEX definitions through the original Android
configuration parser. Both paths preserve the same target-SDK and permission logic.
The original service is prepared before package shared-library policy runs.
Its process-wide ApplicationSharedMemory owner is initialized before configuration
loading invalidates the original compatibility cache. Shared nonce mappings,
change notifications and read-only client permissions retain their Android APIs.
Application binding then activates its original package receiver and installs
compatibility callbacks for the parsed application target SDK.

Manual motion has one descriptor, keyboard/controller and sampling owner in
`HostSensors`. The JVM's sensor queues consume it directly. Original ART native
clients use the image's SensorService and the pinned AIM AIDL sensor HAL, whose
physical source reads the same descriptors and samples through a per-application
shared-memory publication. Only the interactive process publishes that source;
its service processes share the native service. The original HAL retains Binder,
activation, flush and FMQ delivery. Original FMQ storage uses the existing memfd
supplier. Installed base/config/asset-pack APK names are preserved in native
filesystem mappings and class-loader source paths.

ART's Binder projection reuses the complete shared RPC, Parcel and authenticated
peer implementation. JNI object conversion uses the matching original Android
runtime. Local native Binder callers enter the existing VM attachment owner
before dispatching to the original endpoint. Android's native thread-local
detacher releases only attachments created by that owner at thread exit;
already attached callers retain their original lifetime and Binder identity.
Original SurfaceFlinger and media services retain Android composition
and media state; typed physical operations use the shared Mac session, display
clock, presenter, text input and PCM output. Application processes use the
existing profile-service enrollment and account/clipboard authorization channels.
Native Choreographer deadlines and physical display timestamps share the same
uptime clock domain, so suspended Mac time does not postpone frame callbacks.
Bionic native Choreographer calls use the complete typed NDK family and the
same thread-local Looper as Java queues and native descriptor events. Frame,
vsync and refresh callbacks retain their calling-image identity and execute on that
Looper's physical owner. Queued callbacks retire with the original native
frame owner; native C threads retain their existing Java attachment state.
The public `libandroid.so` retains the original export versions and complete
function surface. Handle-scoped symbol lookup and direct imports use the same
typed native families; remaining exports forward to the original Android image
library through a read-only system-code alias.
The JVM window pump yields between completed Android callbacks when a physical
display interval has elapsed. Native input and Canvas frame publication can
progress while animations keep the original queue active; callback execution,
message order, barriers, native descriptor events and idle handlers remain with
Android's original Looper.
Generated surface timestamps and timed video release use that same domain;
media presentation timestamps remain those supplied by the decoder or producer.
When the physical window has a separate process, its supervisor-owned process
identity supplies clipboard gesture authorization for that application. Closing
either process retires that relationship; enrollment never reads the clipboard.

Embedded browsing uses one `WebKitFactory` Android provider and one physical
WebKit operation family in `native/webkit-platform.mm`. The common portable JNI
adapter owns Java references, resource callbacks, JavaScript interfaces, dialogs
and snapshot delivery in either VM. The JVM calls the physical owner directly;
ART carries the same typed requests and callbacks to its existing Mac window
thread. Void notifications stay ordered on the Android window queue without
waiting for that queue on the shared physical window thread. Resource bytes,
navigation decisions and JavaScript interface results retain synchronous replies
and reentrant client calls. The ART reader retains native transport state separately from Android
callback references. Explicit session close joins the reader and releases those
references on the Android owner. Native process teardown signals retirement
without waiting under the loader lock; the platform DSO remains mapped through
process lifetime while the reader releases its descriptors. Reentrant client
calls retain the window thread's browser ownership. Browser
storage is scoped to the enrolled application, and the launcher supplies each
process's storage capability and the provider's runtime archive path. The same
package metadata uses the JVM host archive or its mapped ART DEX archive,
independently of VM protection-domain representation. Original `WebViewFactory` checks remain around
the native provider-selection boundary. External HTTP(S) links use the same
inherited request channel and launcher confirmation policy in both backends;
offline and advertising settings apply before a request can prompt.
The JVM entry and ART's Mac window process use the same private-storage adapter
for Darwin temporary-directory queries. WebKit's rule compiler keeps its scratch
files inside that process's private temporary directory, while native shader
cache ownership remains unchanged.
Both entries also share the WebKit process-service capabilities needed to load
local documents. HTTP, WebSocket and FTP requests retain the application's
network policy independently of those local service connections.

Connectivity uses the same passive Mac route observer and application network
identity owner. The matching image's original DNS resolver retains its query,
cache and Binder interfaces; its physical policy interface applies the existing
per-app network isolation and advertising policy. Resolver addresses and search
domains come from the Mac's current network configuration, without an added
public DNS fallback.

Developer builds accept explicit upstream source, image, generated AIDL, compiler
and exported-header inputs. ART Java compilation uses the matching Android SDK
`core-for-system-modules.jar` as its compiler system image alongside complete
framework headers. Those compile-only classes never enter the runtime image.
Clang/Ninja and Cargo retain ordinary incremental
products. `artSupplierComponents` supplies component destinations to producers
and reassembly tools. Supplier assembly copies those outputs and writes
a relocatable manifest; it does not install a runtime declaration or application
data. Android image acquisition and redistribution follow that image's license.
The original image redirect tool applies the shared Binder watchdog operation
to the matching service DEX. The remaining service code and all hook DEX files
remain in their complete containers.

## Mac.apk and AIM providers

The Android module owns package inspection, provider selection, private storage,
virtual device configuration and launch confinement. The launcher uses the same
module registry and runtime contracts as other game types.

| Component | Responsibility |
| --- | --- |
| Android module | Detect APK package sets, read manifest/resources, retain original inputs and select the runtime |
| Mac.apk provider | Resolve a managed publisher release and launch its Android application host |
| AIM provider | Launch the included pinned AIM host with its separately acquired compatible Android image |
| Shared macOS sandbox | Confine files, child processes and optional network access to the declared launch resources |
| Per-provider application root | Retain writable Android data, home, caches and temporary files for one game and provider |

### Provider boundaries

The optional runtime IDs are `macapk` and `aim`; `klepton` remains the default.
Mac.apk uses managed
publisher releases, so an upstream version can be installed or selected without
rebuilding MacLauncher. Release catalogs and downloads are queried only by
explicit actions.

AIM is a fixed adapted build from a pinned Git submodule. Owned patches remain
outside the read-only upstream checkout. Its native payload is selected through
the module's supplemental distribution declaration, including binary checksums,
CPU architecture, minimum macOS, source identity and license notices. It has no
runtime manager or installation tab.

Guest control commands retain the resident Android image, authenticated mount
namespace, Binder namespace and display endpoint. Original Android tools access
the resident display's input devices through the same Linux device boundary as
application processes.

The AIM Android image has a separate acquisition and storage lifetime. It is
excluded from the app payload and corresponding-source archives; selecting AIM
requests the required image download explicitly. A native host and Android image
must retain their compatible version identities.

### Files and process ownership

The module stores each provider below
`userData/android/apps/<gameId>/providers/<runtimeId>/`. Each provider receives its
own Android root, home, cache and temporary directories. Shared binaries are
read-only and do not contain per-game state. Changing a provider does not merge
its files, account stores or saves with another provider.

Legacy application storage remains separate and is preserved for explicit data
migration or export. Launcher records continue to use
`userData/games/<gameId>/`. Removing a library entry follows the module-owned
storage cleanup contract; original imported game files remain separate.

Launches execute the selected host directly inside the declared process policy.
Network isolation defaults to enabled and applies to the game process and its
children. Runtime acquisition completes through explicit consent before the game
starts. A failure to establish confinement prevents launch. AIM requires macOS
26.0 or later and confines application processes to offline operation without
Google account integration.

The Mac.apk provider creates a per-game application bundle with the game's
name and launcher icon. Its native executable is cloned from the selected
managed version, assigned the game's embedded macOS name and identifier, and
signed locally. Libraries, framework JARs and the Java runtime remain shared
links to the selected installation. The publisher's JIT and native ABI
entitlements are preserved; declared launcher graphics adapters can be loaded
after the process sandbox is established.

Mac.apk Google credentials have one owner at
`userData/android/profiles/macapk-google-v1/`. The provider calls the selected
runtime's original account store and authentication client in confined owner
processes. Account metadata and scoped authorization replies cross the
authenticated per-launch broker; games cannot read the owner profile. Original
APK signatures are verified with the included Android APK verifier before
binding the package name and certificate identity. Token requests retain that
verified identity and the selected account; guest identity fields cannot
override them. Per-application and per-request tokens are not placed in a shared
scope cache.

### Virtual device and host capabilities

Both providers receive the Pixel Tablet device profile: 2560 × 1600 at 320 dpi,
with an initial 1280 × 800 landscape window. Virtual device values remain stable
across providers and do not expose physical Mac device telemetry.

Files are limited to explicit imports and private application storage. Network,
clipboard, location, camera, microphone and account integration require their
own supported policy and explicit selection; runtime selection does not grant
host capabilities. Provider-native graphics, input and audio keep their upstream
ownership below this launcher boundary.
