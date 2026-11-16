# Rosetta

MacLauncher runtimes that exist only as Intel (x86_64) builds need Rosetta, Apple's translation component, to run on Apple silicon. This page describes how Play installs Rosetta and how its status is reported. On Intel Macs and on hosts other than macOS, the check is skipped. [Processor compatibility](PROCESSOR_COMPATIBILITY.md) lists which components contain Intel code.

## Installation during Play

When an Intel runtime needs Rosetta and Rosetta is missing, Play asks to install it. The prompt shows Apple's license and an **Agree and Install** button, since approving an ordinary download does not count as accepting that license. Declining cancels the launch. Launches that need Rosetta at the same time share one prompt and one installation.

After consent, MacLauncher runs Apple's own installer, `/usr/sbin/softwareupdate --install-rosetta --agree-to-license`. When the installation needs administrator authorization, macOS asks for it in its own dialog, and the launcher never receives or stores a password. An installer exit code alone does not count as a working installation, so MacLauncher then runs an Intel system executable to confirm that Rosetta works before the game starts. [Apple's installation guide](https://support.apple.com/en-us/102527) describes where Rosetta is installed and how to install it manually.

If the installation cannot finish, the error gives the manual steps: open Terminal from Applications → Utilities (`/System/Applications/Utilities/Terminal.app`), run `/usr/sbin/softwareupdate --install-rosetta`, and follow Apple's license and authorization prompts.

## Status

Rosetta is a system component installed under `/Library/Apple/`, outside the launcher's data directory. Apple supplies the compatible version, so MacLauncher has no release catalog for it. The status MacLauncher shows is read-only. It reports the version from the installed `com.apple.pkg.RosettaUpdateAuto` package receipt, the installation date, the macOS product version and build, and where each piece of information came from. A macOS version is never reported as a Rosetta version.

Availability is checked locally and cached, and the package receipt is read only when it is needed. A result that finds Rosetta missing stays cached only briefly, so an installation made by another app is noticed.

## Implementation

The Rosetta service, `src/modules/shared/runtime/rosetta.js`, is a Node module with no dependency on the UI. Importing it runs no check, download or installation.

```js
const Rosetta = require("./src/modules/shared/runtime/rosetta");

const prerequisiteContext = {
  confirmRuntimeInstall, // returns explicit approved + licenseAccepted for licenseRequired plans
  logger,
  signal,
  onProgress
};
await Rosetta.ensure(prerequisiteContext);
await Rosetta.ensureForExecutable(toolPath, prerequisiteContext);
```

The shared consent callback, `confirmRuntimeInstall`, receives a prerequisite plan with `licenseRequired`, Apple's license URL and the **Agree and Install** label. To accept, it must return `{ approved: true, licenseAccepted: true }`.

The process helper that checks prerequisites before starting a program accepts the same context as its optional fifth argument:

```js
await processes.spawnDetachedChecked(executable, args, options, needsRosetta, prerequisiteContext);
```

When the caller leaves out `needsRosetta`, the helper detects thin Intel Mach-O executables itself. With Rosetta installed, launches start immediately and handle thin Intel executables and `DYLD` directly. The synchronous helper does not check prerequisites and cannot show an asynchronous installer, so it reports a missing Rosetta with an error that says what to do.

### Callers

- A per-game context binds the consent callback to its game, and the contexts of runtime-manager actions supply the same consent and progress services.
- GameMaker's Node tool runner checks the selected Igor or decompiler executable with `ensureForExecutable` before running it, and the installation of official runtimes passes the manager's consent and progress context to that runner. Copying and validating tool files does not run Igor and does not ask for Rosetta.
- `createToolRunner({ prerequisiteContext })` binds a tool runner to an action, and individual calls can pass `options.prerequisiteContext`. The context is removed from the options before Node's process API is called.
- A shell script has no Mach-O CPU header, so its caller must check the Intel executable that the script actually runs, or pass `{ forceIntel: true }`.
- Java's code for an installed Intel runtime and for decompilers awaits `context.ensureRosetta` when needed. Java and LÖVE share the availability cache, so once an installation completes, neither engine still reports Rosetta as missing.

`createRosettaService` and `createAppleInstaller` accept injected filesystem, process and installer dependencies.
