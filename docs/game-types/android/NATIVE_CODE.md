# Android native code

Many Android apps include native libraries: ARM64 or ARM32 ELF files built
against Android's Bionic C library and the Linux kernel interface. MacLauncher
Android loads these libraries into the application process on macOS. ARM64 code
runs directly on the Mac's CPU once its thread-pointer, reserved-register (x18)
and system-call instructions have been adapted, while ARM32 code is translated
to ARM64 by Dynarmic. In both cases, calls into Bionic and the kernel are
adapted to Darwin. Both execution engines use this native layer: the JVM engine
loads libraries through Klepton's loader, and the ART engine through AIM's
Linux ELF support with the same instruction adaptation.

On this page, *guest* code is the Android code that runs under these adapters,
such as application ELF libraries, Bionic and ART, and the *host* is the macOS
side. *Physical* threads, registers, pages and signal numbers are the real Mac
resources behind Android's virtual ones.
[Android runtime architecture](ARCHITECTURE.md) describes the rest of the
runtime and the other terms used here.

## Native imports

Every symbol that a native library imports is looked up through one
process-wide dispatcher. The dispatcher holds a set of resolvers, each of which
implements its own namespace and passes on the symbols it does not handle.
Registering a resolver again has no further effect, and lookups read an
immutable snapshot, so the hot path neither allocates memory nor takes a lock.
Native library constructors and JNI initialization stay tied to the lifetime of
their library and class loader.

Native ABI adaptations take precedence over generic forwarding to host
functions, and symbols outside those adaptations keep their original providers.
Imported functions, dynamic libc lookups and raw Linux syscall delegates all go
through the same dispatcher.

## Bionic C library

Several of Bionic's original units are compiled for the Mac. Its
character-classification functions, including their inline and locale forms,
share one native namespace, and the same component also includes Bionic's
original multibyte-conversion and iconv units with Android's conversion-state
layouts, UTF encodings and function aliases. Because these units are compiled
with Android's LLVM, the layouts stay Android's while the Darwin backend emits
native Mac code. Their errno values pass through the native platform boundary.

Bionic's complete original terminal family uses the same native descriptor
table as other files. When an application makes a terminal ioctl call, its
Android records, control-character indices, baud encodings and flags are
translated to Darwin terminal settings. Direct ioctl requests use the same
translation, while other descriptor requests keep their existing handlers.

Locale objects and locale strings belong to the native side, and each thread
keeps its own locale selection. `localeconv` returns the complete original
Android record layout through a per-thread view, with the fields copied by
their original names.

In the process-execution family, Bionic itself still handles arguments, the
environment, `PATH` search and script selection, and only then does a call
reach the native process and private-path boundary. Variadic entries use the
same AAPCS64 argument handlers as other native imports.

File-status operations, including both `fstatat` aliases, share the native
namespace, the Android user and group ID mapping and the conversion from Darwin
to Bionic records. The `creat` and `creat64` entry points go through the same
`openat` path for pathname translation, creation modes and truncation.

Bionic's original device API-level function reads the same Android property
store as the framework's `Build` class and native property queries.

## Library loading

### Library search and the image registry

One component searches for native libraries and registers the images it loads,
while Bionic's original namespace access rules decide which isolated
directories, explicit library links and inherited images each namespace can
reach. VM initialization entry points go through the same reference and
execution layer, with the original `JavaVM*` calling convention.

This image registry records each loaded image's canonical path and its original
ELF `DT_SONAME`. Either the loaded filename or the SONAME therefore finds the
same image, and Android `RTLD_NOLOAD` lookups return images that are already
loaded without mapping new files. Constructors run outside the mapping lock.
Address lookups attribute addresses inside a guest ELF image to that image,
and for imports that macOS implements they return the image and symbol
metadata of the actual native provider.

Before an application's native images load, the JVM native loader receives the
same parsed `ApplicationInfo.targetSdkVersion` that the compatibility callbacks
use, so that its symbol scope follows Android's SDK-dependent rules for local
and global library visibility.

The original runtime and linker namespaces are set up once per native session,
and app and provider processes then add their package mappings without
recreating them. Under the JVM, the Bionic bootstrap adds the current package's
mounted native-library directory to the original default namespace before any
application JNI runs. A `dlopen` by name alone and dependency lookup both keep
the caller's original namespace and search order, and each image stays in the
namespace that loaded it. Host library search paths are excluded, and platform
startup dependencies are linked before the application directory is selected.

The public `libandroid.so` keeps its original export versions and its complete
set of functions. Symbols looked up through a library handle and direct imports
use the same typed native function families, while the remaining exports are
forwarded to the original Android image library through a read-only system-code
alias.

### JNI method lookup

Each Android application library stays associated with the class loader that
defined it and with its loaded image, and JNI short and long symbol names are
resolved against that image. The symbol tables in the file provide dependency
metadata and early hints about class definitions, but the loaded symbol tables
decide which native methods are available.

To match exported symbols with native methods, library preparation lists the
defining loader's prepared classes that declare native methods, and a JVMTI
ClassPrepare observer adds classes to that list as they are prepared later.
Looking up exports neither initializes application classes nor prepares
unrelated ones. Each class's native methods are cached, and a symbol that was
unavailable can be looked up again after a relevant library or class changes.

Methods registered with `RegisterNatives` take precedence over exported
symbols. This also applies to methods declared in a superclass and to the
entries that were committed before a registration error. While registration
runs, the JVM's NativeMethodBind event reports the actual method and its
declaring class, even when that class is not yet prepared.
`UnregisterNatives` removes the registrations for the methods that the given
class declares, so a later library load can resolve those methods again. The
registration table refers to declaring classes through weak references, and its
updates are serialized with the publication of exported methods. A call to a
native method still goes directly to the registered function.

When a library loads through the prepared loading entry, its image is published
to the Java object that holds it before the ELF constructors run. Older entry
classes follow the same order: loading without initialization, publication,
then construction. `JNI_OnLoad` runs after construction, once for each
combination of library and class loader, and a missing symbol raises the JVM's
usual `UnsatisfiedLinkError`.

Loading a library leaves a native C thread's attachment state as it was. To
publish JNI metadata, the loader authenticates the calling image and attaches
the thread to the VM temporarily, then detaches it again before the original
linker runs constructors. This temporary attachment keeps the native thread's
Looper and execution state, and application JNI detach and physical thread
shutdown follow their normal lifecycle.

### Process startup

Native ELF constructors receive an argument vector and an environment, as they
do on Android. MacLauncher Android's sandbox records this native startup
environment before it adds its own host runtime controls. The environment is a
versioned UTF-8 vector that contains the Android namespace paths the sandbox
allows, the private home and temporary directories, a fixed executable search
path and the selected locale settings. Launcher credentials, host JVM
arguments, preloads and graphics or process-control variables are left out.
Entries keep their original values, and both their number and their UTF-8 byte
size are limited.

The Android JVM adapter configures this startup information before it publishes
an image. The first argument of the invocation is the authenticated Android
process name, and the environment holds the Android runtime values that the
launcher passes through, including the private home and temporary directories.
Host JVM arguments, and host preload or diagnostic settings added later, are
not included.

`NativeBinding.configureRuntime` obtains the invocation and environment from
`HostContext`, and the bridge encodes the Java strings as standard UTF-8 before
passing null-terminated vectors to `klj_library_set_startup`. The native core
keeps the strings and vectors for the life of the process. A second
configuration with the same values is accepted, whereas a changed invocation or
environment is rejected. Constructors receive writable vectors, while the
repeat check compares against separate copies of the original configuration.

For raw ARM64 ELF images, the core calls `DT_INIT` and then the
`DT_INIT_ARRAY` entries as `void (int argc, char **argv, char **envp)`. The
existing dependency order is kept, each image is initialized only once, and null
or sentinel entries keep their usual handling. When the startup configuration
is missing, initialization fails before any constructor runs. Image-format
providers keep their own initialization callback and calling convention.

The launcher passes the environment entries in the versioned
`KL_ANDROID_NATIVE_STARTUP_ENVIRONMENT` packet. Version 1 of the packet is the
canonical unpadded base64url encoding of a UTF-8 vector of NUL-terminated
`key=value` entries, with at most 64 distinct ASCII keys and 16,384 decoded
bytes. If the packet is missing or its encoding is invalid, the host
environment is never used in its place.

### Image paths and metadata

For a loaded guest image, `dladdr` reports the canonical pathname under which
the Android filesystem namespace allowed the image to load. That pathname is
stored with the image when it loads, so later renames or changes to namespace
aliases affect neither the name nor its storage while the image stays loaded.
Canonical physical targets, including symbolic-link targets, are matched to
their guest pathnames through the namespace aliases. Host preparation
directories are never reported as guest image pathnames, and an image that has
no such guest pathname keeps its registry name. Addresses in native providers
keep the platform linker's original metadata, and format providers keep their
existing image operations. Because the path storage is allocated when the image
loads and released with it, address queries reuse the stored name without
allocating paths or temporary strings.

The ART loader keeps the original ELF bytes and program headers. Read-only
image libraries can share hardlinked or translated cache bytes, but each open
file description still keeps its canonical Android pathname. The original
linker namespace checks use that name across descriptor duplication, fork and
exec, while the content-addressed code stays shared. Writable application paths
keep their existing mount and rename behavior.

As in Android's linker, the native loader records each image's mapped
program-header pointer and validated header count at load time, independently
of what the ELF header contains later. Later changes to the ELF header
therefore do not remove the image from program-header enumeration. The
program-header array itself stays mapped, so code that enumerates it sees
changes to its contents, and the pointer stays valid until the image unloads
because it belongs to the image mapping. Enumeration and process-map formatting
use the same image base, extent and namespace, and native format providers keep
their own program-header callbacks and mapping lifetimes.

When an ELF segment is copied into an anonymous reservation, the mapping table
still records its original file and inode. Installing adapted code in an
executable mapping uses the same file translation metadata as ordinary
mappings, so read-only ELF data that shares a larger executable page is kept.
Mapping moves, unmapping and fork keep the lifetime of the corresponding
source.

## Relocation, alignment and TLS

Bionic's 16 KB compatibility mode runs libraries built for 4 KB pages on
systems with 16 KB pages. ART decides whether to use it from the alignment of
all the read-only code that the current application is allowed to load,
including installed providers that its class loaders use. ART application setup
passes the original VM's target SDK, and Android's original alignment
inspection and package-state policy then select the mode. Explicit overrides in
the application manifest and settings take precedence, and the original Android
implementations still decide which segments are eligible. The original ELF
bytes, segment bounds, relocations and memory protections stay intact. For the
private linker API that sets this mode, the guest binding links
`libdl_android.so` from the matching runtime APEX, while the NDK provides the
ordinary public link interfaces.

When the last physical page of a Bionic RELRO request also holds writable data,
the native mapping layer leaves that data writable and protects the RELRO pages
before it. This adaptation applies only to the matching ELF operation of the
original loader; explicit memory-protection requests from the application keep
their usual semantics.

The JVM native image loader applies GNU_RELRO as part of its plan for page
permissions, after dynamic relocation and before constructors. A host page
loses write permission only when every writable load-segment byte on it lies
in the original RELRO range, so adjacent mutable data stays writable. At the
same relocation step, the ARM32 image adapter makes RELRO read-only through the
translated address space's original 4 KB page tracking. Program headers, load
alignment and relocated pointers still belong to their original image.

For thread-local storage, the ARM64 image adapter supports `PT_TLS`,
`DTPMOD64`, `DTPREL64`, `TPREL64` and `TLSDESC` while keeping the real Android
thread pointer and the original Bionic slots. Initial-exec and dynamic
references resolve to the same per-thread address. The fixed TLS layout is a
one-MiB demand-zero reserve with alignment up to 64 KiB, and a module's offset
stays reserved after the module unloads. When a new module loads, its TLS is
initialized on the existing physical threads before its native entry points are
published. A module that does not fit the fixed layout uses dynamic TLS
instead, and an initial-exec reference to such a module reports a loader error.

## ARM64 instruction adaptation

### Finding code

The instructions that use the thread pointer, the reserved x18 register or
system calls are rewritten before ARM64 code runs, while data embedded in
executable segments keeps its original bytes. To separate the two, each image
gets one code context, which the TLS, reserved-register and syscall adaptations
share with instruction counting. It tells code apart from embedded data using
the original executable segments, function and unwind metadata, and verified
instruction boundaries. AIM's discovery, both cached and at load time, calls the
same whole-ELF metadata and executable-range analysis as the native loader,
including code outside shortened section tables and original mapping symbols.
Both loaders also share one pass over control flow and literal references:

- Decoded branches and address-taken targets keep reachable instructions
  classified as code, while unreachable constant regions that memory references
  point to keep their original bytes.
- A branch establishes code only when its destination reaches decoded
  instructions; an address that merely lies inside the segment is not evidence
  of code.
- A conditional branch to established code also keeps its decoded prefix when
  fallthrough reaches opaque bytes, and those opaque bytes keep their original
  data classification.
- Function metadata alone does not turn encrypted source bytes into code.

Stack-protector sequences provide further evidence. An intact stack-protected
continuation can establish another control-flow root when its Bionic canary
load, saved stack slot, matching guard comparison and normal return all agree
within the original function boundary. The original TP can be held in a fixed
FP slot across register reuse and dynamic SP allocation, and a guard comparison
may follow a limited number of intervening calculations that preserve both
values. A rooted, aligned prologue that preserves LR and the callee-saved
register holding TP can establish the exact TP and canary-load prefix before an
opaque continuation, although it is not evidence about that continuation. Opaque
entry bytes, explicit data and incomplete guard sequences keep their original
classification, and ambiguous regions remain open to the original instruction
analysis.

When an ELF segment is filled by positional reads, the rewrite sites recorded
from the original file apply to the first translation of each copied range.
Anything written to the range later is analyzed from its current instruction
bytes, and mapping records and file offsets stay available after the recorded
sites have been used.

### Translation cache

Translated code is cached. ART's immutable native image helpers share AIM's
original translation cache across the launcher profile. AIM keys each entry by
the original content and the translation format, checks that the original file
and the host configuration are unchanged, and authenticates protected derived
files against the current translation of the verified source bytes. App and
peer-package processes keep their own private code caches, and their sandbox
has no access to the shared image-helper cache. Changes to the runner, Java
archives and packaging that do not touch native code leave the cache entries
valid.

Translated ELF files and load-time site records are keyed by the original ELF's
SHA-256 and the translation format version. Any change to instruction analysis
or emission comes with a new format version, so bytes rewritten by an earlier
version are never reused.

### Registers and the thread pointer

In ART, ARM64 register translation uses the same Klepton instruction decoder and
veneer emitter as the JVM native loader. AIM keeps its Linux ELF mappings,
thread slots and saved contexts, and both cached and load-time translation go
through it. Thread-pointer instructions are rewritten by the same AIM emitter in
both executors, although the thread pointer differs: ART keeps its original
Bionic thread pointer, whereas the JVM executor stores the original Bionic TLS
slot layout with its retained physical-thread context and reaches it through an
allocated Darwin pthread key. Android application slots and stack guards use
that guest storage, and Darwin's reserved TSD stays private.

Darwin reserves the physical x18 register, so the guest's x18 value lives in a
thread slot, including across system calls and preemption. Syscall snapshots
and Linux signal frames read that slot, and when a signal handler edits the
register, the slot is updated while Darwin's reserved register stays
untouched. Indirect branches through x18 resume through the saved Linux
context. SIMD structure instructions that update SP by x18 still run their
original memory operation in hardware, and their shared veneer restores the
scratch registers and commits SP through the saved signal context, without
leaving a value in Darwin's reserved register or reading released stack
storage. ADRP veneers keep the original page address even when nearby
executable storage lies outside the instruction's signed page range, and they
encode the address as an immediate value when a relocated ADRP cannot reach it.

Because the decoder validates instruction fields before it translates
registers, unallocated encodings in executable data stay unchanged:

- SIMD structure operands are decoded only for allocated architectural
  encodings, and reserved opcode combinations stay unchanged.
- Fixed fields in compare-and-swap and ordered memory instructions are checked
  first, so unallocated packed words are kept byte for byte.
- Reserved shift widths, bitmask immediates and memory-pair sizes also inform the
  shared analysis of neighboring data, without classifying unknown extensions as
  data.
- The precision, rounding and scale fields of scalar floating-point conversions
  are validated. SIMD memory widths and register-index extensions keep their
  original operand banks, and reserved combinations stay unchanged in both
  executors.
- Tagged immediate ADD and SUB instructions keep their fixed architectural
  fields, and ADD and SUB instructions that write SP are completed through the
  saved context in the same way as SIMD structure post-index instructions.
  Tagged pair stores keep their original memory-tag operation and 16-byte
  immediate scale.

### Executable memory

Executable Android mappings use AIM's original native implementation of
`MAP_JIT` allocation, protection migration and instruction stores. The JVM
executor calls that implementation through a native ABI from its mapping and
signal dispatchers, while ART keeps the original AIM entry points. The JVM
mapping table keeps each guest extent across replacement, partial unmapping,
remapping and fork, and those extents migrate to executable memory in the same
way as the original loaded ELF mappings.

An image's logical base can be shifted inside its allocation to separate code
and data segments with finer alignment. In that case, mapping and unmapping the
ELF image track the host pages that cover it, which keeps the original
alignment requirements of guest memory syscalls and never claims adjacent
mappings. Native stacks, host libraries and the code caches of other VMs keep
Darwin's original protection behavior and their own mappings. Per-thread resume
state lasts as long as the executor's physical thread, including native cleanup
after Java detachment.

Code can also appear after the initial ELF load, when an application emits or
decrypts it in writable memory. When such memory becomes executable without
write permission, both executors translate its final bytes at their destination
addresses before AIM replaces the mapping atomically, so this code receives the
same register, thread-pointer and syscall adaptations. The JVM executor uses its
own instruction emitters and allocated TLS key for this step. If preparation
fails, the original mapping is kept, and veneer storage generated by the JVM is
released with its code mapping.

Before a range becomes executable, the JVM native loader copies all of it into
private writable storage and plans its TP, syscall and x18 adaptations together.
Branch checks at the final addresses include unused reserved gaps in the ELF
image that contains the range. Only after every site passes does a single
mapping replacement install the prepared range; on failure, the original range
keeps its bytes and permissions. Veneer reservations stay allocated until the
corresponding source pages are unmapped.

Stubs created at load time are placed in executable islands, small executable
regions within branch range of the rewritten instruction. A stub first reuses a
nearby island. If the ordinary placement hints are occupied, allocation searches
the actual free Mach VM gaps within the instruction's branch range. Island
capacity fits page-aligned gaps, and the island's mapping size is kept across
process forks and unmapping. Reserved ELF segments stay occupied, and stub
allocation never replaces those mappings.

In an immutable ART executable-file mapping, an x18 adaptation that cannot reach
a free island runs the same hardware instruction body through a trap registered
for its address. These bodies and their continuations belong to the process and
are kept across mapping replacement and fork. Original breakpoints still
deliver Linux signals, and a conflicting existing trap registration is rejected
before the destination is replaced. Read/execute file mappings prepare their
translated bytes and final permissions before they are installed at their fixed
address, while mutable JIT code is still installed through islands directly.

### Stack, VDSO and auxiliary vector

The initial ELF stack, with its original guard page, arguments and auxiliary
vector, sits at the top of the guest address window. It is allocated by the
same mapping manager as other guest memory, which never replaces an existing
mapping, and ordinary `mmap` placement does not depend on it. A forked child
keeps the stack mapping, whereas exec recreates it through the original ELF
loader. During fork, shadow-stack bytes are relocated only within the current
context's own allocation, and an architectural x18 pointer into ordinary guest
memory keeps its address in the child's restored mappings.

The ARM64 VDSO, which applications find through `AT_SYSINFO_EHDR`, exports its
clock and signal entry points with the standard `LINUX_2.6.39` ELF symbol
version. The procfs auxiliary-vector files show the loader's immutable vector
for the current exec, including the original guest addresses and CPU
capability values. Linux's BTI capability bit stays clear because executable
mappings are unguarded, although the CPU's BTI instruction hints and the other
reported CPU capabilities are unchanged. Process and task paths share the same
vector, which a forked child inherits and exec replaces, and other guest
processes read the saved bytes through the process record.

## Guest memory access

When a system call copies data to or from application memory under ART, a bad
pointer has to produce Linux's `EFAULT`. ART's Linux `rt_sigprocmask`, for
example, copies signal sets through AIM's original fault-contained user-memory
layer: unreadable input and unwritable output return `EFAULT`, and signal-mask
updates keep the original operation order.

ART writes to ordinary user-memory buffers with Mach copying. Darwin rejects
Mach writes into `MAP_JIT` memory, however, so validated writable executable
destinations in the guest address range use a fault-contained native copy that
keeps the calling thread's previous write-protection view. Invalid or unmapped
buffers return Linux `EFAULT`, and reads from source buffers keep the original
Mach copy path. File, pipe and socket receives use temporary output buffers only
when the destination is the process's own JIT memory; after the blocking I/O
completes, the shared copy layer scatters the returned bytes under mapping
guards.

## Signals and faults

Guest code and the host VM handle signals in the same process, so registration
and delivery keep the two apart. When guest code registers a handler through
the raw ARM64 system call, the original Linux kernel action layout is
translated into the same signal state that Bionic's public functions use, and
queries for the handler, mask, flags and restorer read that state. Native VM
faults, on the other hand, continue through their original Darwin handlers.
Original ELF preparation installs the native signal multiplexer after the JVM
starts, which keeps the JVM's native dispositions in place before any
translated code runs. During dispatch, native and JVM fault contexts go to
their original native handler, while guest fault contexts are translated at the
Android boundary. Temporary signal-mask waits keep Linux's optional-mask
behavior: a null mask leaves the current mask unchanged and places no
constraint on its unused size.

An ARM64 guest `SA_SIGINFO` handler receives AIM's original Linux signal frame,
with the general registers, FPSIMD state and signal masks. Because the native
callback holds the frame storage and calls the guest handler directly,
nonlocal returns and native unwinding work, and register and mask edits made by
the handler update the original Darwin signal context.

When guest code reads a saved native disposition, it receives a Linux-callable
chaining bridge. The bridge converts the caller's Linux signal context through
the same AIM frame code before invoking the original Darwin handler, and then
returns any register and mask edits to the Linux caller. Restoring that
disposition keeps its native ABI, and native handler addresses are never
exposed as Android callbacks. Linux realtime dispositions are registered and
queried in AIM's existing process-wide signal table, with their full masks,
restorers and default or ignored actions. These records do not depend on
Darwin's physical signal numbers or on an initialized guest thread.

For ARM32 code, the shared ARM32 ABI converter chooses the `siginfo_t` payload
from the original signal number and code. Both record layouts and their
constants come from Clang, and the timer, queued-value, child, poll, syscall and
fault-extension fields keep their declared widths. Fault addresses reuse
existing memory aliases without creating readable mappings, and queued values
keep their opaque bits. Signal frame views belong to the callback and are
released when it returns.

### Fault reports and tracing

When native code crashes under ART, the fatal report keeps the original
interrupted registers and reads a limited window of instructions from the same
process through the kernel's fault-safe memory reader. Those instruction bytes
are labeled as observed at report time, after any guest signal handler has run,
and ordinary handled faults cause no diagnostic memory reads. A software
`SIGABRT` termination without a preceding hardware fault reports the live guest
syscall context and a limited frame chain instead. Host-only and idle guest
contexts are never reported as the source of a guest fault. When a fatal fault
happens inside the native Linux adapter itself, the report includes the live
guest syscall arguments and frame chain alongside the interrupted native
registers.

When Linux syscall tracing is turned on explicitly, each entry record includes
the original guest instruction address, link register and frame pointer. Unmap
records also keep up to eight saved return addresses, read through the
guest-memory reader, and an invalid, unaligned or cyclic chain stops at its
validated prefix.

The same optional tracing records a limited number of rejected attempts to make
adapted code executable, with the stage, the original instruction, the address
range and the native error. Before code becomes executable, it also reports the
final prepared ranges and the number of adapted instructions, including general
x18 operands. A rejected attempt keeps the existing mapping and its original
bytes.

Two launch diagnostics capture fault context:

- `MACLAUNCHER_ART_FAULT_INSTRUCTION=1` captures the interrupted SIGILL
  instruction before the guest signal handler runs. The saved word and the
  report-time view are labeled separately.
- `MACLAUNCHER_ART_HANDLED_FAULT_CONTEXT=1` records at most sixteen handled
  protection faults, with their interrupted registers and instruction, before
  they are delivered to the guest. It writes through fixed local storage and the
  diagnostic descriptor, and signal delivery is the same when that output is
  unavailable.

Without these diagnostics, launches perform no additional diagnostic reads.

## Threads

When guest code attaches a thread to the VM through JNI, the native thread's
lifetime tracking is set up first, and the same tracking detaches the thread
before it ends, including foreign callback threads. Constructors, `JNI_OnLoad`
and registered native calls enter through the same thread setup as native
worker threads, which initializes their Android thread pointer and stack guard
in the retained execution context. Late POSIX destructor callbacks also
re-enter the retained physical thread context, including its Android thread
pointer, before guest code runs.

When a native thread ends, the original Bionic list of C++ thread-local
destructors is drained before the guest pthread storage is freed and the thread
detaches from the JVM. Both C++ registration aliases add to that same list.
Threads that Java created keep their VM attachment instead and use the VM's
own thread-end handling.

A native Looper acquired from outside its thread keeps its registered
descriptors across Java and physical thread shutdown. The code holding it can
remove descriptors from another thread before releasing it, and the last
release closes the remaining descriptor leases. Once the Looper's original
thread has ended, it can no longer add descriptors, poll or run application
callbacks.

If thread creation fails under ART, the Linux error from the shared ID manager
is kept, and a physical pthread error is converted into the same ABI. The
reserved context and thread lease are released before control returns to
Bionic.

Native CPU-affinity masks use the same CPU count as `sysconf` and the process
CPU files. Raw Linux calls return the initialized extent of the mask, whereas
Bionic's libc entry returns zero and clears the rest of the buffer, including
unused CPU bits.

Before an inline Linux syscall enters C, it saves the guest machine state on the
physical thread's guarded native stack, and small language-runtime stacks keep
their original bounds. Nested signal callbacks borrow the suspended native
cursor, and the original Bionic nonlocal-jump family restores that cursor and
the Darwin alternate-stack status together with its registers and signal mask.

## Files and descriptors

When a native descriptor number is reused, the metadata from its previous use
is dropped before the new Linux open file description is installed and made
visible. Descriptions that the runtime still holds open keep their separate
hidden descriptors and original metadata. This applies when files and sockets
are created, when sockets are accepted or transferred, and when descriptors are
duplicated. Socket-only operations on regular files return their normal errors.

Under ART, queries for pending bytes go through the Linux descriptor layer.
Event and timer descriptors reject `FIONREAD` with `ENOTTY`, and epoll returns
the Android 16 kernel's `EINVAL` for that request. The native objects behind
their notifications never expose transport bytes as application data.

Extended-attribute calls from native libc and from the original libcore go
through one macOS file boundary. Their complete path, symlink and descriptor
families use the guest namespace and the kernel's attribute storage, and the
create and replace flags and syscall signatures are translated in one place. A
file descriptor keeps the same metadata after a rename, and the common errno
boundary keeps Android's error values.

Filesystem capacity queries use one Android record converter for the path,
descriptor and 64-bit aliases, and the shared width converter produces the
ARM32 records. File-access advice keeps descriptor offsets and reports Android
error values, and supported read-ahead hints map to macOS file-description
controls. The native Linux procfs view also includes its parent directory, so
Java file APIs can validate that directory before opening CPU and memory
reports.

Native `getrlimit`, `setrlimit` and `prlimit64` cap `RLIMIT_NOFILE` at macOS
`kern.maxfilesperproc`, while lower explicit limits and the other resource
limits are kept. ART updates its own credential limit only after macOS has
accepted the change. Before the physical descriptor limit is lowered, the
descriptor table keeps open descriptions available for continued I/O, and they
stay held open through close or replacement. When descriptors are passed
across exec, the guest's close-on-exec flags are kept.

Native `select`, `pselect` and `pselect64` imports use the same pollable
descriptor layer as counters, timers and epoll. Android signal masks and
timeval fields are converted at that layer, and a timed selection reports
Android's remaining-time result. ARM32 calls first go through the generated
width conversion for signal sets and descriptor sets, and then enter the shared
native implementation.

Process memory maps list the current process's regions and access permissions
in Linux format. Native mappings are taken from the macOS region view, while
translated ARM32 mappings use their original logical address space and page
permissions. File names and offsets come from the namespace and the
loaded-image metadata. Installed APKs and the primary and secondary
native-library directories therefore appear under the same paths that
`ApplicationInfo` reports, including canonical file targets behind symlinks,
without revealing the enclosing preparation directories or other applications'
private files. Files outside the guest namespace stay anonymous. Each access
refreshes the maps file atomically, while a descriptor that is already open
keeps the snapshot it holds.

## ARM32 execution

ARM32 apps use the same framework, package storage, network policy, native
library loading and platform services as ARM64 apps, without a second Android
service stack. The ARM32 execution adapter changes only machine instructions,
pointer widths and calling conventions. The
[ARM32 component reference](../../../src/modules/android/native/arm32/README.md)
describes the instruction, ELF and JNI boundaries.

### CPU and address space

The ARM32 CPU and address-space implementation is compiled once, into an object
target that both the JVM adapter and a standalone CPU archive use. ART's typed
host-call binding uses the same implementation, and its callbacks return
through the Linux execution context to the original ART JNI frame. The CPU
archive contains no VM, platform-service resolver or alternative libc.

While the CPU runs, it holds the address space's read guard and an eight-entry
cache of borrowed mappings. Full writable pages and compact buffer entries are
handled by Dynarmic's original page table. An access to a compact entry checks
the mapping's exact byte bounds and per-page permissions inline and keeps the
checked byte offset for the native access, whereas invalid and page-crossing
accesses go through the original callbacks. The cache is discarded before
native callbacks, protection changes or mapping removal, and the next run
starts with a fresh one.

Because ARM32 code uses 32-bit pointers, pointers passed between it and 64-bit
native code have to be converted. This conversion uses an interval index over
the mapped-memory table. Overlapping native aliases are identified by their
lowest guest base, and translation checks exact bounds and permissions under
one lock. Mapping replacement, splitting and removal update the same index, and
a converted representation exposes exactly the extent of its guest type. When a
native allocation is released or reallocated, its aliases are removed through
this index before the physical storage can be reused, and a failed reallocation
keeps the existing mapping.

Pointer cells, records and interface tables that cross between the two widths
keep their original extents as Clang describes them. Releasing a physical
resource removes its converted views and native-memory aliases through the same
memory table. A reallocation installs its new representation atomically, and if
it fails, the original pointer, bytes and error are kept. Resolver results are
freed in the order that the original linked-list rules require: a resolver list
releases its declared linked nodes, canonical strings and address buffers before
the native resolver frees them. Through the same memory table, native mappings
keep their original allocator and protection callbacks across partial unmaps.

The leases held for translated ARM32 threads stay valid while the shared native
lifetime manager runs application cleanup. A trivial native thread-local
pointer identifies the container of those leases and is cleared before its
storage is released. Native TLS destructor callbacks that run later get a fresh
container through the same manager, and each container releases its translated
stacks and leases after its callbacks have run.

### Images and symbols

Both engines load ARM32 libraries with one shared ELF image loader, which
resolves symbol names through the image's original GNU or SysV hash tables and
Bionic's hash functions, so lookup, relocation and image lifetime are the same
in both. Before any application library, both engines also load the same
original ARM32 compiler runtime, ABI routines and legacy Bionic data image, and
tables that contain pointers keep their original guest layout and namespace
membership.

The complete legacy character-table family that Bionic's `ctype_private.h`
declares is built from its original `ctype_.c` and `ndk_cruft_data.cpp` units.
Its classification, lowercase and uppercase tables and their exported pointer
variables, including embedded zero bytes, stay together in one ELF image. For
the shared adapter, Clang evaluates the original NDK's LP32 and LP64 loader
constants, so lookup handles and binding flags mean the same thing at both CPU
widths.

### JNI across widths

When Java calls an ARM32 native method, the JNI descriptor determines the
native argument widths and signedness, including the sign extension of Java
byte and short arguments into AAPCS32 parameter words. The width adapter has
one implementation of JNI references, buffers and callbacks for both engines,
with tables from the selected engine's original JNI header. HotSpot provides
the method descriptors through JVMTI, while ART provides shorties through the
original NativeBridge runtime callbacks, and native closures come from the
original libffi. NativeBridge registration keeps original ART's choice between
regular and critical calls and uses the same cached JNI trampolines; critical
calls pass primitive arguments without a JNI environment or receiver.

ART keeps JNI calls and references on its Bionic execution context, while a
thin transport hands CPU, memory and ELF operations to the same native
implementation. ART's optional NativeBridge implementation uses the original
ART class-loader namespace callbacks and leaves native ARM64 dependencies to
Bionic. Translated dependency groups are mapped before relocation and
registered in the same image registry. The original ART APEX namespace lookup
finds the existing VM, and JNI closures and their native cleanup code stay
resident for the life of the process. The build recipe for the ART components
includes the corresponding original notices.

An ART component build that contains this complete width adapter declares
ARM32 alongside ARM64, and preparation then selects the APK's original native
ABI and its installed library directory. ART itself stays the original 64-bit
VM, and its NativeBridge handles only translated calls. Dynamic library lookup
uses the same retained image groups, the caller's namespace and Bionic's
original `$ORIGIN` and `$LIB` runpath expansion.

The same native-import adapter and NDK type tables are also compiled in the
Bionic context. There, the original libffi calls Bionic's variadic exports
directly, while the macOS binding keeps its existing Android argument-list
handlers.

### Types and records

Each native call has its own scratch storage for arguments and results. A
standard monotonic stack buffer keeps full ABI alignment and falls back to the
ordinary heap for larger calls, and nested callbacks get storage of their own.

Conversion between the two widths relies on the native type model, which keeps
every original C type declaration, including interfaces returned through
erased `void*` output parameters. One typed data-view layer converts
pointer chains, records, arrays and function pointers. It registers aliases
before following cycles and releases a representation's storage together with
the object that holds it. For OpenSL ES and OpenMAX AL, the original interface
identifiers and header declarations determine the output types of interface
queries, and the native engine and physical audio operations behind them are
shared with ARM64.

Records are converted in each ABI's original field layout, while libffi
separately uses the complete native field order. Architecture-specific padding
keeps its own extent, and Bionic's legacy inode member receives the low word of
the canonical inode. The original NDK declarations include inline definitions
and the headers of the native implementations, and Clang provides the field
layouts, character storage and file-command values for both targets. Argument
conversion keeps opaque epoll data words, complete process argument arrays and
native file-lock records intact. For `scanf`, Bionic's original specifier and
type selection determines the output-pointer layouts before the shared scanner
runs. ARM exception index queries use the common image registry and Bionic's
original unwind wrapper for the guest width.
