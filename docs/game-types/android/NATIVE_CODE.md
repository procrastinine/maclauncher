# Android native code

Many Android apps include native libraries: ARM64 or ARM32 ELF files built
against Android's Bionic C library and the Linux kernel interface. MacLauncher
Android loads these libraries into the application process on macOS. ARM64 code
runs directly on the Mac's CPU after its thread-pointer, reserved-register (x18)
and system-call instructions are adapted. ARM32 code is translated to ARM64 by
Dynarmic. Calls into Bionic and the kernel are adapted to Darwin. Both execution
engines use this native layer: the JVM engine through Klepton's loader, and the
ART engine through AIM's Linux ELF support with the same instruction adaptation.

[Android runtime architecture](ARCHITECTURE.md) describes the rest of the
runtime and the terms used here.

## Native imports

Native imports go through one process-wide dispatcher. Each resolver implements
its own namespace and passes on symbols it does not handle. Registration is
idempotent per resolver, and lookup reads an immutable snapshot without
allocating or taking a lock on the hot path. Native library constructors and JNI
initialization keep their library and class-loader lifetime.

Native ABI adaptations take precedence over generic host forwarding, and symbols
outside those adaptations keep their original providers. Imported functions,
dynamic libc lookups and raw Linux syscall delegates all use the same
dispatcher.

## Bionic C library

Original Bionic character-classification functions, including their inline and
locale forms, share one native namespace. The same component supplies Bionic's
original multibyte conversion and iconv units, keeping Android's conversion
state layouts, UTF encodings and function aliases. Android LLVM compilation keeps
those layouts while the Darwin backend emits native Mac code, and errno values go
through the native platform boundary.

The complete original Bionic terminal family shares the native descriptor table.
Terminal ioctl calls translate Android records, control-character indices, baud
encodings and flags to Darwin terminal settings. Direct ioctl requests use the
same translation, and other descriptor requests keep their existing handlers.

Locale objects and locale strings keep their native ownership and per-thread
selection. `localeconv` exposes the complete original Android record layout
through a per-thread view, copying fields by their original names.

Bionic's process-execution family keeps its argument, environment, `PATH` and
script selection above the native process and private-path boundary. Variadic
entries use the same AAPCS64 argument handlers as other native imports.

File-status operations, including both `fstatat` aliases, share the native namespace, identity mapping and Darwin-to-Bionic record conversion. The
`creat` and `creat64` entry points use the same `openat` path for pathname
translation, creation modes and truncation.

Bionic's original device API-level function reads the same Android property
store as the framework's `Build` class and native property queries.

## Library loading

### Library search and the image registry

VM initialization entry points use the same reference and execution layer with
the original `JavaVM*` calling convention. One component handles native library
search and image publication, and Bionic's original namespace access rules govern
isolated directories, explicit library links and inherited image membership. The
image registry records each image's canonical path and its original ELF
`DT_SONAME`, so either the loaded filename or the SONAME identifies the same
image, and Android `RTLD_NOLOAD` lookups return existing images without mapping
new files. Constructors run outside the mapping lock. Address lookup keeps guest
ELF ownership and returns the actual native provider's image and symbol metadata
for imports that macOS implements.

Before application native images load, the JVM native loader receives the same
parsed `ApplicationInfo.targetSdkVersion` that the compatibility callbacks use.
Its symbol scope follows Android's SDK-dependent rules for local and global
library visibility.

The native session initializes its original runtime and linker namespaces once,
and app and provider processes add package mappings without recreating that
state. In JVM execution, before application JNI runs, the Bionic bootstrap gives
the original default namespace the current package's mounted native-library
directory. Name-only `dlopen` and dependency lookup keep the original caller
namespace, search order and image ownership. Host library search paths are
excluded, and platform startup dependencies are linked before the application
directory is selected.

The public `libandroid.so` keeps the original export versions and complete
function surface. Handle-scoped symbol lookup and direct imports use the same
typed native families, and the remaining exports forward to the original Android
image library through a read-only system-code alias.

### JNI method lookup

Android application libraries keep their defining class loader and loaded image,
and JNI short and long symbol names are resolved against that image. File symbol
tables provide dependency metadata and early hints about class definitions, while
the loaded symbol tables decide which native methods are available.

Library preparation takes one inventory of the prepared native classes that
belong to the defining loader, and a JVMTI ClassPrepare observer extends that
inventory as later classes are prepared. Export lookup neither initializes
application classes nor prepares unrelated classes. Native method inventories
are cached per class, and symbols that were unavailable can be looked up again
after a relevant library or class change.

Committed `RegisterNatives` entries take precedence over registration through
exported symbols. This includes methods declared in a superclass, and a
committed prefix of entries followed by a registration error. While registration
runs, the JVM's NativeMethodBind event supplies the actual method and declaring
class, including registration on a class that is not yet prepared.
`UnregisterNatives` removes the registrations for the methods declared by the
given class, so a later library load can resolve those methods again. The
registration table uses weak references to declaring classes and serializes
registration updates with the publication of exported methods. Calling a native
method is still a direct call to the registered function.

The prepared loading entry publishes the image to its Java owner before ELF
constructors run. Earlier entry classes keep their order: load without
initialization, publication, then construction. `JNI_OnLoad` runs after
construction, once per owning library and class loader. Missing symbols raise
the JVM's usual `UnsatisfiedLinkError`.

Native C threads keep their attachment state across library loading. To publish JNI metadata, the loader authenticates the calling image and attaches the thread to the VM temporarily, detaching it again before the original linker runs constructors. The temporary
attachment keeps the native thread's Looper and execution state, and application
JNI detach and physical thread shutdown follow their normal lifecycle.

### Process startup

Before it adds host runtime controls, MacLauncher Android's sandbox records the native startup environment. This versioned UTF-8 vector contains the Android namespace
paths that the sandbox allows, the private home and temporary directories, a fixed executable
search path and the selected locale settings. It excludes launcher credentials,
host JVM arguments, preloads and graphics or process-control variables. Entries
keep their original values and are limited in count and UTF-8 byte size.

The Android JVM adapter configures native image startup before publishing an
image. The invocation's first argument is the authenticated Android process
name, and its environment contains the Android runtime values that the launcher
passes through, including the private home and temporary directories. Host JVM
arguments and later host preload or diagnostic settings are
excluded.

`NativeBinding.configureRuntime` obtains the invocation and environment from
`HostContext`. The bridge encodes the Java strings as standard UTF-8 and passes
null-terminated vectors to `klj_library_set_startup`. The native core keeps the strings and vectors for the life of the process. A repeated configuration with
the same values is accepted, and a changed invocation or environment is
rejected. Constructors receive writable vectors, while repeat checks compare
against separate copies of the original configuration.

For raw ARM64 ELF images, the core calls `DT_INIT` and then the `DT_INIT_ARRAY`
entries as `void (int argc, char **argv, char **envp)`. Existing dependency
order, once-only initialization and null or sentinel entries are preserved. If
the startup configuration is missing, initialization fails before any
constructor runs. Image-format providers keep their own initialization callback
and calling convention.

The launcher passes the environment entries in the versioned
`KL_ANDROID_NATIVE_STARTUP_ENVIRONMENT` packet. Version 1 contains canonical
unpadded base64url encoding of a UTF-8 vector of NUL-terminated `key=value`
entries, with at most 64 distinct ASCII keys and 16,384 decoded bytes. A missing
packet or invalid encoding never falls back to the host environment.

### Image paths and metadata

For a loaded guest image, `dladdr` reports the canonical pathname under which
the Android filesystem namespace allowed the image to load. The image stores that pathname when it loads, so later renames or namespace alias changes do not affect
the name or its storage while the image stays loaded. Canonical physical targets
are matched through the namespace aliases, including symbolic-link
targets. Host preparation directories are never published as guest image
pathnames, and an image without such a guest pathname keeps its registry name.
Native provider addresses keep the platform linker's original metadata, and
format providers keep their existing image operations. Path storage is allocated when the image loads and released with the image, so address
queries reuse the stored name without allocating paths or temporary strings.

The ART loader keeps the original ELF bytes and program headers. When read-only
image libraries share hardlinked or translated cache bytes, each open file
description keeps its canonical Android pathname. The original linker namespace
checks use that opened name across descriptor duplication, fork and exec, while
content-addressed code stays shared. Writable application paths keep their
existing mount and rename behavior.

The native loader keeps each image's mapped program-header pointer and its
validated header count from load time. This follows Android's linker model, in
which a loaded image stores its program-header pointer and count independently of
the ELF header's later bytes. Later changes to the ELF header therefore do not
remove the image from program-header enumeration. The mapped program-header
array stays live, so changes to its contents are visible to consumers. The
pointer belongs to the image mapping and stays valid until the image unloads.
Enumeration and process-map formatting use the same image base, extent and
namespace ownership, and native format providers keep their own program-header
callbacks and mapping lifetimes.

ELF segments copied into anonymous reservations keep their original file and
inode through the mapping table. Executable publication uses the same
file translation metadata as ordinary mappings, which keeps read-only ELF data
that shares a larger executable page. Mapping moves, unmapping and fork keep the
corresponding source lifetime.

## Relocation, alignment and TLS

ART evaluates native-library alignment across all read-only code that the current
application is allowed to load, including installed providers that its class
loaders use.
ART application setup supplies the original VM's target SDK, and Android's
original alignment inspection and package-state policy select Bionic's 16 KB
compatibility mode, the 4 KB library compatibility mode on 16 KB systems.
Explicit overrides in the application manifest and settings take precedence, and
segment eligibility stays with the original Android implementations. Original
ELF bytes, segment bounds, relocations and memory protections remain intact. The
guest binding links the matched runtime APEX's `libdl_android.so` for this
private linker API, and the NDK supplies the ordinary public link interfaces.

When Bionic's RELRO request shares its final physical page with writable data,
the native mapping layer keeps that data writable and protects the preceding
RELRO pages. This adaptation applies only to the original loader's matching ELF
operation, and explicit memory-protection requests from the application keep
their usual semantics.

The JVM native image loader applies GNU_RELRO through its page-permission plan, after dynamic relocation and before constructors. A host
page loses write permission only when all writable load-segment bytes on that
page belong to the original RELRO range, so adjacent mutable data stays
writable. The ARM32 image adapter makes RELRO read-only through the translated address
space's original 4 KB page tracking at the same relocation step. Program
headers, load alignment and relocated pointers keep their original image
ownership.

The ARM64 image adapter supports `PT_TLS`, `DTPMOD64`, `DTPREL64`, `TPREL64` and
`TLSDESC` while keeping the real Android thread pointer and the original Bionic
slots. Initial-exec and dynamic references share the same per-thread address. A
demand-zero reserve provides one MiB of fixed TLS layout with alignment up to
64 KiB, and module offsets stay reserved after a module unloads. New modules
initialize existing physical threads before their native entry points are
published. Modules that do not fit the fixed layout use dynamic TLS, and an
initial-exec reference to one of them reports a loader error.

## ARM64 instruction adaptation

### Finding code

Native ELF instruction adaptation shares one code context per image for TLS,
reserved-register and syscall instructions. The original executable segments,
function and unwind metadata, and verified instruction boundaries tell code
apart from embedded data, and instruction counting and rewriting use the same
context. AIM's cached and load-time discovery call the same whole-ELF metadata
and executable-range analysis as the native loader, including code outside
shortened section tables and original mapping symbols. Both loaders share one
control-flow and literal-reference pass:

- Decoded branches and address-taken targets protect reachable instructions,
  while unreachable constant regions that memory references point to keep their
  original bytes.
- A branch establishes code only when its destination reaches decoded
  instructions. An address that merely lies inside the segment proves nothing.
- A conditional branch to established code also keeps its decoded prefix when
  fallthrough reaches opaque bytes, and those opaque bytes keep their original
  data classification.
- Function metadata alone does not turn encrypted source bytes into code.

An intact stack-protected continuation can establish another control-flow root
when its Bionic canary load, saved stack slot, matching guard comparison and
normal return agree within the original function boundary. A fixed FP slot can
hold the original TP across register reuse and dynamic SP allocation, and guard
comparisons allow a limited number of intervening calculations that preserve
both values. A rooted, aligned prologue that preserves LR and its callee-saved TP
register can establish the exact TP and canary-load prefix before an opaque
continuation, without being evidence about that continuation. Opaque entry
bytes, explicit data and incomplete guard sequences keep their original
treatment, and ambiguous regions stay open to the original instruction
analysis.

For ELF segments filled by positional reads, the original file-site recipes
apply to the first translation of each copied range. Later writable generations
are analyzed from their current instruction bytes. Mapping records and file offsets stay available after those recipes are used.

### Translation cache

ART's immutable native image helpers share the original translation cache within
the launcher profile. AIM keys cache entries by original content and translation
format, checks the original file identity and host configuration, and
authenticates protected derivatives against the current translation of verified
source bytes. App and peer-package processes keep separate private code caches,
and their sandbox does not receive the shared image-helper cache. Unrelated
changes to the runner, Java archives and packaging keep native cache entries.

Translated ELF files and load-time site records are keyed by the original ELF's
SHA-256 and the translation format version. Changes to instruction analysis or
emission use a new format version, so previously rewritten bytes are never
reused.

### Registers and the thread pointer

ARM64 register translation in ART uses the same Klepton instruction decoder and
veneer emitter as the JVM native loader. AIM keeps its Linux ELF mappings, thread
slots and saved contexts, and cached and load-time translation both go through
it. Thread-pointer instructions use the same AIM emitter in both executors. ART
keeps its original Bionic thread pointer. The JVM executor stores the original
Bionic TLS slot layout with its retained physical-thread context and reaches it
through an allocated Darwin pthread key. Android application slots and stack
guards use that guest storage, and Darwin's reserved TSD stays private.

Guest x18 values live in a thread slot, including across system calls
and preemption. Syscall snapshots and Linux signal frames read that slot, and
register edits by a signal handler update it while Darwin's reserved physical
register is preserved. Indirect branches through x18 resume through the saved
Linux context. SIMD structure instructions that update SP by x18 run their
original memory operation in hardware. Their shared veneer restores scratch
registers and commits SP through the saved signal context, without leaving a
value in Darwin's reserved register or reading released stack storage. ADRP
veneers keep the original page address even when nearby executable storage is
outside the instruction's signed page range, and materialize the address as an
immediate when a relocated ADRP cannot reach it.

The decoder validates instruction fields before translating registers, so
unallocated encodings in executable data stay unchanged:

- SIMD structure operands are decoded only for allocated architectural
  encodings, and reserved opcode combinations stay unchanged.
- Fixed fields in compare-and-swap and ordered memory instructions are checked
  first, keeping unallocated packed words byte for byte.
- Reserved shift widths, bitmask immediates and memory-pair sizes also inform the
  shared data-neighborhood analysis, without classifying unknown extensions as
  data.
- Scalar floating-point conversions validate their precision, rounding and scale
  fields. SIMD memory widths and register-index extensions keep their original
  operand banks, and reserved combinations stay unchanged in both executors.
- Tagged immediate ADD and SUB instructions keep their fixed architectural
  fields. ADD and SUB instructions that write SP use the same saved-context
  completion as SIMD structure post-index instructions. Tagged pair stores keep
  their original memory-tag operation and 16-byte immediate scale.

### Executable memory

Executable Android mappings share AIM's original native `MAP_JIT` allocation,
protection migration and instruction-store implementation. The JVM executor
calls it through a native ABI from its mapping and signal dispatchers,
and ART keeps the original AIM entry points. The JVM mapping table keeps guest
extents across replacement, partial unmap, remapping and fork, and those extents
and the original loaded ELF mappings use executable-memory migration.

When an image's logical base is shifted inside its allocation to separate
finer-aligned code and data segments, ELF publication and unmapping track the
covering host pages. This bookkeeping keeps the original alignment requirements
of guest memory syscalls and never claims adjacent mappings. Native stacks, host
libraries and other VM code caches keep Darwin's original protection behavior
and mapping identity. Per-thread resume state stays with the executor's physical
thread lifetime, including native cleanup after Java detachment.

When writable executable memory becomes executable without write permission,
both executors translate the final staged bytes at their destination addresses
before AIM's atomic mapping replacement. The JVM executor uses its own instruction emitters and allocated TLS key for this step. Code emitted or
decrypted after the initial ELF load receives the same register, thread-pointer
and syscall adaptations. A failed preparation keeps the original mapping, and
veneer storage generated by the JVM is released with its code mapping.

The JVM native loader snapshots the complete executable publication range into
private writable storage and plans TP, syscall and x18 adaptations together.
Branch checks at final addresses include unused reserved gaps in the owning ELF.
One mapping replacement publishes the prepared range after every site passes,
and on failure the original range keeps its bytes and permissions. Veneer
reservations stay allocated until the corresponding source pages are unmapped.

Load-time instruction stubs first reuse nearby executable islands. If the
ordinary placement hints are occupied, allocation searches actual free Mach VM
gaps within the instruction's branch range. Island capacity fits page-aligned
gaps, and its mapping size is kept across process forks and unmapping. Reserved
ELF segments stay occupied, and stub allocation never replaces those mappings.

When an x18 adaptation in an immutable ART executable-file mapping cannot reach a
free island, it uses the same hardware instruction body through a trap registered for that address. Bodies and continuations stay owned by the process across
replacement and fork. Original breakpoints keep Linux signal delivery, and a conflicting existing trap registration is rejected before the destination is replaced.
Read/execute file mappings prepare their translated bytes and final permissions
before fixed-address publication, while mutable JIT publication keeps its
direct-island path.

### Stack, VDSO and auxiliary vector

The initial ELF stack occupies the top of the guest address window,
with its original guard page, arguments and auxiliary vector. It is allocated by
the same non-replacing mapping manager as other guest memory, and ordinary
`mmap` placement is independent of it. Fork keeps the stack mapping, and exec
recreates it through the original ELF loader. Fork relocates shadow-stack bytes
only within the current context's own allocation, and an architectural x18
pointer into ordinary guest memory keeps its address in the restored child
mappings.

The ARM64 VDSO exports its clock and signal entry points with the standard
`LINUX_2.6.39` ELF symbol version, available through `AT_SYSINFO_EHDR`. The
procfs auxiliary-vector files expose that loader's immutable per-exec vector,
including the original guest addresses and CPU capability values. Linux's BTI
capability bit stays clear because executable mappings are unguarded, while CPU
BTI instruction hints and the other reported CPU capabilities are unchanged.
Process and task paths share the same vector. Fork inherits it, exec replaces
it, and other guest processes read the saved bytes through the process record.

## Guest memory access

ART's Linux `rt_sigprocmask` copies signal sets through AIM's original
fault-contained user-memory layer. Unreadable input and unwritable output return
Linux `EFAULT`, and signal-mask updates keep the original operation order.

ART user-memory writes use Mach copying for ordinary buffers. Darwin rejects
Mach writes into `MAP_JIT` memory, so validated writable executable destinations
in the guest address range use a fault-contained native copy that keeps the
calling thread's previous write-protection view. Invalid or unmapped buffers
return Linux `EFAULT`, and source reads keep the original Mach copy path. File,
pipe and socket receives use temporary output buffers only for owned JIT
destinations; the shared copy layer scatters the returned bytes under mapping
guards after the blocking I/O completes.

## Signals and faults

Raw ARM64 signal registration translates the original Linux kernel action
layout to the same signal state that Bionic's public functions use. Handler,
mask, flags and restorer queries read that state, and native VM faults continue
through their original Darwin handlers. Original ELF preparation installs the native signal multiplexer after the JVM starts, keeping its native
dispositions before translated code runs. Signal dispatch keeps native and JVM
fault contexts with their original native handler and translates guest fault
contexts at the Android boundary. Temporary signal-mask waits keep Linux's
optional-mask behavior: a null mask leaves the current mask unchanged and does
not constrain its unused size.

ARM64 guest `SA_SIGINFO` handlers receive AIM's original Linux signal frame,
including general registers, FPSIMD state and signal masks. The native callback holds the frame storage and calls the guest directly, so nonlocal returns and
native unwinding work. Register and mask edits made by the handler update the
original Darwin signal context.

Saved native dispositions are represented by a Linux-callable chaining bridge.
It converts the caller's Linux signal context through the same AIM frame code
before invoking the original Darwin handler, and returns register and mask edits
to the Linux caller. Restoring that disposition keeps its native ABI, and native
handler addresses are never published as Android callbacks. Linux realtime
disposition registration and queries use AIM's existing process-wide signal
table, including its full masks, restorers and default or ignored actions. These
records are independent of Darwin's physical signal numbers and do not require
an initialized guest thread.

The shared ARM32 ABI converter selects `siginfo_t` payloads from the original
signal number and code. Clang supplies both record layouts and constants, and
timer, queued-value, child, poll, syscall and fault-extension fields keep their
declared widths. Fault addresses reuse existing memory aliases without creating
readable mappings, and queued values keep their opaque bits. Signal frame views
belong to the callback and are released when it returns.

### Fault reports and tracing

Fatal ART native reports keep the original interrupted registers and read a
limited instruction window from the same process through the kernel's fault-safe
memory reader. The instruction bytes are labeled as observed at report time,
after any guest signal handler, and ordinary handled faults cause no diagnostic
memory reads. A software `SIGABRT` termination with no preceding hardware fault
reports the live guest syscall context and a limited frame chain. Host-only and
idle guest contexts are not attributed a guest fault. Fatal faults inside the
native Linux adapter include the live guest syscall arguments and frame chain
alongside the interrupted native registers.

Explicit Linux syscall tracing includes the original guest instruction address,
link register and frame pointer in each entry record. Unmap records also keep up
to eight saved return addresses read through the guest-memory reader,
and invalid, unaligned and cyclic chains stop at the validated prefix.

Optional syscall tracing also records a limited number of rejected executable
publications, with the publication stage, original instruction, address range
and native error. It reports final staging ranges and the number of adapted
instructions, including general x18 operands, before executable publication. A
rejected publication keeps the existing mapping and its original bytes.

Two launch diagnostics capture fault context:

- `MACLAUNCHER_ART_FAULT_INSTRUCTION=1` captures the interrupted SIGILL
  instruction before the guest signal handler runs. The saved word and the
  report-time view are labeled separately.
- `MACLAUNCHER_ART_HANDLED_FAULT_CONTEXT=1` records at most sixteen handled
  protection faults before guest delivery, including their interrupted registers
  and instruction. It uses fixed local storage and the diagnostic descriptor, and unavailable output does not change signal delivery.

Ordinary launches perform no additional diagnostic reads.

## Threads

Guest JNI attachment first sets up the native thread's lifetime
tracking and then attaches the thread to the VM. The same tracking detaches it
before the native thread ends, including for foreign callback threads.
Constructors, `JNI_OnLoad` and registered native calls enter through the same
thread setup as native worker threads, which initializes their Android thread
pointer and stack guard in the retained execution context. Late POSIX destructor
callbacks re-enter the retained physical thread context, including its Android
thread pointer, before guest code runs.

When a native thread ends, the original Bionic C++ thread-local destructor list
is drained before guest pthread storage is freed and the thread detaches from the
JVM. Java-owned threads use the VM's own thread-end handling and keep their VM
attachment. Both C++ registration aliases share the same list.

An externally acquired native Looper keeps its registered descriptors across
Java and physical thread shutdown. Its holder can remove descriptors from another
thread before releasing the Looper, and the last release closes the remaining
descriptor leases. Once its thread ends, the Looper's original thread can no
longer add descriptors, poll or run application callbacks.

ART thread creation keeps the shared ID manager's Linux error and converts the
physical pthread error into the same ABI. A failed creation releases the
reserved context and thread lease before returning to Bionic.

Native CPU-affinity masks use the same CPU count as `sysconf` and the process CPU
files. Raw Linux calls return the initialized mask extent, while Bionic's libc
entry returns zero and clears the rest of the buffer, including unused CPU bits.

Inline Linux syscalls save guest machine state on the physical thread's
guarded native stack before entering C, and small language-runtime stacks keep
their original bounds. Nested signal callbacks borrow the suspended native
cursor, and the original Bionic nonlocal-jump family restores that cursor and the
Darwin alternate-stack status together with its registers and signal mask.

## Files and descriptors

A fresh native descriptor slot drops the metadata of its previous numeric
generation before the Linux open file description is installed and published.
Descriptions that are still pinned (held open by the runtime) keep their separate hidden descriptors and original metadata. This applies to file and socket creation, socket acceptance and
transfer, and duplication. Socket-only operations on regular files return their
normal errors.

ART pending-byte queries go through the Linux descriptor layer.
Event and timer descriptors reject `FIONREAD` with `ENOTTY`, and epoll returns
the Android 16 kernel's `EINVAL` for that request. The native objects that carry their notifications never expose transport bytes as application data.

Native libc and original libcore extended-attribute calls share one macOS file
boundary. The complete path, symlink and descriptor families use the guest namespace and kernel attribute storage, and create and replace flags and
syscall signatures are translated once. File descriptors keep the same metadata
after a rename, and the common errno boundary keeps Android's error values.

Filesystem capacity queries share one Android record converter across the path,
descriptor and 64-bit aliases, and the shared width converter supplies ARM32
records. File-access advice keeps descriptor offsets and reports Android error
values, and supported read-ahead hints use macOS file-description controls. The
native Linux procfs view includes its parent directory, so Java file APIs can validate that directory before opening CPU and memory reports.

Native `getrlimit`, `setrlimit` and `prlimit64` cap `RLIMIT_NOFILE` at macOS
`kern.maxfilesperproc`, keeping lower explicit limits and the other resource
limits. ART commits its credential limit only after macOS accepts the change.
Before the physical descriptor limit is lowered, the descriptor table keeps open descriptions for continued I/O. They stay pinned through close or
replacement, and exec transfer keeps guest close-on-exec flags.

Native `select`, `pselect` and `pselect64` imports use the same pollable
descriptor layer as counters, timers and epoll. Android signal masks and timeval
fields are converted at that boundary, and timed selection keeps Android's
remaining-time result. ARM32 uses the generated signal-set and
descriptor-set width conversion before entering the shared native
implementation.

Process memory maps report the current process's regions and access permissions
in Linux format. Native mappings use the macOS region view, and translated ARM32
mappings use their original logical address space and page permissions. File
names and offsets come from the namespace and loaded-image metadata.
Installed APKs and primary and secondary native-library directories keep the
same path identities that `ApplicationInfo` exposes, including canonical file
targets behind symlinks, without exposing the enclosing preparation directories
or other applications' private files. Each access refreshes the maps file
atomically while keeping the snapshot held by an already-open descriptor. Files
outside the guest namespace remain anonymous.

## ARM32 execution

ARM32 apps use the same framework, package storage, network policy, native
library loading and platform services as ARM64 apps. The execution adapter
changes machine instructions, pointer widths and calling conventions; there is
no second Android service stack. The
[ARM32 component reference](../../../src/modules/android/native/arm32/README.md)
describes the instruction, ELF and JNI boundaries.

### CPU and address space

A native build compiles the ARM32 CPU and address-space implementation once into an
object target that both the JVM adapter and a standalone CPU archive use. ART's
typed host-call binding uses that same implementation, and callbacks return
through the Linux execution context to the original ART JNI frame. The CPU
archive contains no VM, platform-service resolver or alternative libc.

Each CPU run holds the address space's read guard and an eight-entry cache of
borrowed mappings. Dynarmic's original page table handles full writable pages
and compact buffer entries. Compact accesses check the mapping's exact
byte bounds and per-page permissions inline and keep the checked byte offset for
the native access, while invalid and page-crossing accesses go through the
original callbacks. The cache is discarded before native callbacks, protection
changes or mapping removal, and the next run starts with a fresh cache.

ARM32 pointer conversion uses an interval index over the mapped-memory table. Overlapping native aliases keep their lowest guest-base identity, and
translation checks exact bounds and permissions under one lock. Mapping
replacement, splitting and removal update the same index. Converted
representations expose their exact guest type extent. Native allocation release
and reallocation remove their aliases through this index before physical storage
can be reused, and a failed reallocation keeps the existing mapping.

Cross-width native pointer cells, records and interface tables keep their
original extents as Clang describes them. Releasing a physical resource removes
its converted views and native-memory aliases through the same memory table.
Allocator reallocation publishes its new representation atomically, and a
failure keeps the original pointer, bytes and error. Resolver results follow the
original linked-list ownership contract: resolver lists release their declared
linked nodes, canonical strings and address buffers before the native resolver
frees them. Native mappings keep their original allocator and protection
callbacks across partial unmaps, through the same memory table.

ARM32 translated-thread leases stay live while the shared native lifetime
manager runs application cleanup. A trivial native thread-local pointer
identifies the lease container and is cleared before its storage is released.
Later native TLS destructor callbacks get a fresh container through the same
manager, and each container releases its translated stacks and leases after its
callbacks run.

### Images and symbols

One shared ARM32 ELF image loader resolves symbol names through the image's
original GNU or SysV hash tables and Bionic's hash functions, and both engines
use the same lookup, relocation and image lifetime. Both engines load the same
original ARM32 compiler runtime, ABI routines and legacy Bionic data image before
application libraries, and pointer-bearing tables keep their original guest
layout and namespace membership.

The complete legacy character-table family declared by Bionic's
`ctype_private.h` comes from its original `ctype_.c` and `ndk_cruft_data.cpp`
units. The classification, lowercase and uppercase tables and their exported
pointer variables stay in that same ELF image, including embedded zero bytes.
Clang evaluates the original NDK's LP32 and LP64 loader constants for the shared
adapter, so lookup handles and binding flags mean the same thing at both CPU
widths.

### JNI across widths

JNI descriptors determine native argument widths and signedness, including sign
extension of Java byte and short arguments into AAPCS32 parameter words. The
width adapter uses one JNI reference, buffer and callback implementation for
both engines, with tables from the selected engine's original JNI header.
HotSpot supplies method descriptors through JVMTI, and ART supplies shorties
through the original NativeBridge runtime callbacks. Original libffi provides
native closures. NativeBridge registration keeps original ART's choice between
regular and critical calls and uses the same cached JNI trampolines; critical
calls carry primitive arguments without a JNI environment or receiver.

ART keeps JNI calls and references on its Bionic execution context, while its
thin transport delegates CPU, memory and ELF operations to the same native
implementation. Its optional NativeBridge implementation uses original ART
class-loader namespace callbacks and leaves native ARM64 dependencies with
Bionic. Translated dependency groups are mapped before relocation and published
through the same image registry. The original ART APEX namespace lookup
identifies the existing VM, and JNI closures and their native cleanup code stay
resident for the life of the process. The ART supplier's build recipe includes the corresponding original notices.

ART suppliers that contain this complete width adapter declare ARM32 alongside ARM64. Preparation selects the APK's original native ABI and its installed
library directory. ART stays the original 64-bit VM, and its NativeBridge
handles translated calls only. Dynamic library lookup uses the same retained
image groups, caller namespace and original Bionic `$ORIGIN` and `$LIB` runpath
expansion.

The same native-import adapter and NDK type tables also compile in the Bionic
context. There, original libffi calls Bionic's variadic exports directly, while
the macOS binding keeps its existing Android argument-list handlers.

### Types and records

Argument and result scratch storage for native calls belongs to each invocation.
A standard monotonic stack buffer keeps full ABI alignment and falls back to the
ordinary heap for larger calls, and nested callbacks get independent storage.

The native type model keeps every original C type declaration, including
interfaces returned through erased `void*` output parameters. One typed
data-view layer converts pointer chains, records, arrays and function pointers,
publishes alias identities before following cycles, and releases representation
storage with its owner. Original OpenSL ES and OpenMAX AL interface identifiers
and header declarations determine the output types of interface queries, and
their native engine and physical audio operations are shared with ARM64.

Record conversion follows each ABI's original field layout, while libffi
separately uses the complete native field order. Architecture-specific padding
keeps its own extent, and Bionic's legacy inode member receives the low word of
the canonical inode. Original NDK declarations include inline definitions and
the headers of the native implementations, and Clang supplies both targets'
field layouts, character storage and file-command values. Argument conversion
keeps opaque epoll data words, complete process argument arrays and native
file-lock records. The original Bionic `scanf` specifier and type selection
supplies output-pointer layouts before the shared scanner runs. ARM exception
index queries use the common image registry and Bionic's original guest-width
unwind wrapper.
