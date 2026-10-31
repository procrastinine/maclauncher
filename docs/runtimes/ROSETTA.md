# Rosetta

Rosetta is Apple's translation component that runs Intel (x86_64) programs on Apple silicon. MacLauncher runtimes that exist only as Intel builds need it, and on Intel Macs and hosts other than macOS the check is skipped.

## Installation during Play

When an Intel runtime needs Rosetta and it is missing, Play asks to install it. The prompt includes Apple's license and an **Agree and Install** button; approving an ordinary download does not accept the license. Declining cancels the launch. Concurrent launches share one prompt and one installation.

After consent, MacLauncher runs `/usr/sbin/softwareupdate --install-rosetta --agree-to-license`, Apple's own installer. If administrator authorization is needed, macOS shows its own authorization dialog; the launcher never receives or stores a password. After the installation, MacLauncher runs an Intel system executable to confirm that Rosetta works before the game starts. An installer exit code alone does not count as a working installation. [Apple's installation guide](https://support.apple.com/en-us/102527) describes where Rosetta is installed and how to install it manually.

If the installation cannot finish, the error gives the manual steps: open Terminal from Applications → Utilities (`/System/Applications/Utilities/Terminal.app`), run `/usr/sbin/softwareupdate --install-rosetta`, and follow Apple's license and authorization prompts.

## Status

Rosetta is a system component installed under `/Library/Apple/`, outside the launcher's data directory. Apple supplies the compatible version, and MacLauncher has no release catalog for it. The read-only status reports the version from the installed `com.apple.pkg.RosettaUpdateAuto` package receipt, the installation date, the macOS product version and build, and where the evidence came from. A macOS version is never reported as a Rosetta version.

Availability is a cached local check, and the package receipt is read only when needed. A missing result is cached briefly, so an installation made by another app is noticed.

## Implementation

`src/modules/shared/runtime/rosetta.js` is a Node service that does not depend on the UI. Importing it runs no probe, download or installation.

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

The shared consent adapter receives a prerequisite plan with `licenseRequired`, Apple's license URL and the **Agree and Install** label. To accept, the adapter must return `{ approved: true, licenseAccepted: true }`.

The core checked spawner accepts the same context as its optional fifth argument:

```js
await processes.spawnDetachedChecked(executable, args, options, needsRosetta, prerequisiteContext);
```

It also detects thin Intel Mach-O executables when the caller leaves out `needsRosetta`. When Rosetta is installed, launches start immediately and keep their existing direct handling of thin Intel executables and `DYLD`. The synchronous unchecked spawner cannot show an asynchronous installer, so it reports the missing prerequisite with an error that says what to do.

### Callers

- Per-game contexts bind the consent adapter to that game, and runtime-manager action contexts inject the same consent and progress services.
- GameMaker's Node tool runner checks the selected Igor or decompiler executable with `ensureForExecutable` before running it. Official runtime installation passes the manager's consent and progress context to that runner. Copying and validating tool files neither runs Igor nor asks for translation.
- `createToolRunner({ prerequisiteContext })` binds a tool runner to an action, and individual calls can pass `options.prerequisiteContext`. The context is removed before Node's process API is called.
- A shell script has no Mach-O CPU header, so its caller must check the actual Intel executable that the script runs, or pass `{ forceIntel: true }`.
- Java's installed Intel runtime and decompiler paths await `context.ensureRosetta` when needed. Java and LÖVE share the availability cache, so a completed installation does not leave either engine reporting Rosetta as missing.

`createRosettaService` and `createAppleInstaller` accept injected filesystem, process and installer dependencies.
