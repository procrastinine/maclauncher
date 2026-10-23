# Android window and scheduling tests

The Java fixtures compile against a built runtime's complete AOSP framework and
host adapters. Set `KLEPTON_NATIVE_RUNTIME` to that runtime directory. Java 21 and
macOS development tools are required. Tests never compile a substitute Android
framework or replace environment, resource, clock, or input APIs.

- `session-core-test.c` checks partial acquisition, reverse release, owner
  identity, branch adoption, callback drain and committed extents. It runs from
  `android-host-callbacks.test.js`, alongside generated callback table lifetime
  checks, under ASAN/UBSAN.
- `tick-mailbox-test.cpp` checks the actual atomic mailbox with concurrent
  publication, latest-value coalescing and checked clock conversion.
- Choreographer and wake fixtures supply native display timestamps beneath
  original AOSP scheduling. They check owner-Looper dispatch, delays, cancellation,
  reentrancy, callback errors and synchronous wake retirement. They do not assert
  private queue limits or data structures from removed framework replacements.
- Display checks use original Display and DisplayManagerGlobal clients against
  committed native observations. They preserve immutable snapshots, distinguish
  requested points and committed pixels, preserve logical UI dimensions across
  density changes, and verify callback ownership and retirement.
- Host fixtures retain the actual application, provider, activity, resource and
  shutdown code. The two native fixture files replace only window operations and
  the renderer entry, to exercise startup and cleanup failures deterministically.
  Guest class loading after cleanup uses a separate JAR outside the test classpath.
- Clock checks compare original SystemClock calls with actual native uptime and
  continuous-clock brackets. The native deadline and mailbox checks run without
  an installed runtime; the Java checks use its real native libraries.

Every JVM uses checked JNI and bytecode verification. Subprocesses have deadlines
and temporary files are removed after completion. Controlled display observations
are not a physical-display timing or gameplay claim. Host setup can initialize
ANGLE; the fixture window operations do not create a visible window.
