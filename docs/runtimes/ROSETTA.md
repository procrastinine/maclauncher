# Intel runtime prerequisite

`src/modules/shared/runtime/rosetta.js` is a UI-independent Node service for Apple's
Intel translation component. No probe, download, or installation runs when it is imported.
It is relevant on an Apple Silicon macOS host; Intel and non-macOS hosts skip it.

Play can request installation when an Intel runtime needs it. The shared consent adapter
receives a prerequisite plan with `licenseRequired`, Apple's license URL, and the
**Agree and Install** label. Ordinary download approval does not accept the license:
the adapter must return `{ approved: true, licenseAccepted: true }`. Declining cancels
the launch. Concurrent launches share one consent and installation request.

After consent, the backend invokes `/usr/sbin/softwareupdate --install-rosetta
--agree-to-license`. If administrator authorization is required, macOS displays its
own authorization dialog; launcher code never receives or stores a password. Only
Apple's system installer is used. Its location and the manual fallback are documented
in [Apple's installation guide](https://support.apple.com/en-us/102527).

Rosetta lives under `/Library/Apple/`, rather than the launcher data directory. The
read-only status exposes the actual `com.apple.pkg.RosettaUpdateAuto` receipt version,
installation date, macOS product version/build, and evidence source. A macOS version
is never reported as a Rosetta package version. Apple supplies the compatible system
component; this is not an independent launcher release catalog. Installed availability
uses a cached local check, and package evidence is read lazily. Missing availability is
briefly cached so another app's installation can be detected. After installation, an
Intel system executable is probed before the pending game resumes.

If installation cannot finish, the error provides the exact fallback: open Terminal
from Applications → Utilities (`/System/Applications/Utilities/Terminal.app`), run
`/usr/sbin/softwareupdate --install-rosetta`, and follow Apple's license/authorization
prompts. System installation is verified; an installer exit code alone does not count
as a working prerequisite.

## Core and manager integration

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

The core checked spawner accepts this context as its optional fifth argument:

```js
await processes.spawnDetachedChecked(executable, args, options, needsRosetta, prerequisiteContext);
```

It also detects thin Intel Mach-O executables when a caller omitted `needsRosetta`.
Installed launches retain their immediate spawn behavior and their existing direct
thin-Intel/DYLD handling. Synchronous unchecked spawning cannot display an asynchronous
installer and reports an actionable missing prerequisite instead.

Per-game contexts bind the consent adapter to that game. Runtime-manager action
contexts inject the same consent/progress services. GameMaker's Node tool runner
checks the selected Igor or decompiler executable with `ensureForExecutable` before
execution. Official runtime installation captures the manager's consent and progress
context in that runner; tool-file copying and validation do not execute Igor or request
translation. `createToolRunner({ prerequisiteContext })` binds a tool runner to an action,
and individual calls can pass `options.prerequisiteContext`. This context is removed
before calling Node's process API. A shell script must check the actual Intel executable it
will invoke, or pass `{ forceIntel: true }`; the script itself has no Mach-O CPU header.
Java's installed Intel runtime and decompiler paths await `context.ensureRosetta`
when needed. Java and LÖVE share this availability cache, so a completed installation
does not leave stale per-engine missing status.

`createRosettaService` and `createAppleInstaller` accept injected filesystem, process and installer dependencies.
