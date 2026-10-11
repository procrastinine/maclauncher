# Steam API support

Play detects compatible native consumers and supplies the included offline API automatically. Games retain their original files and receive separate local state. A matching native game library takes priority. Games without a Steam dependency perform no Steam setup.

The included MIT helper is `maclauncher-offline-abi-0.5.0-universal`, for Apple Silicon and Intel on macOS 13 or later. It supplies local application identity, language, achievements, statistics, opaque file storage and bounded native/manual callbacks. Authentication, game servers, overlays, multiplayer, cloud synchronization and encrypted tickets are unavailable. Unknown interface versions are refused; unsupported virtual calls exit explicitly instead of returning invented success.

[LuaSteam](https://github.com/uspgamedev/luasteam), [steamworks4j](https://github.com/code-disaster/steamworks4j), [Greenworks](https://github.com/greenheartgames/greenworks), legacy GameMaker and managed wrappers use distinct compatibility profiles. Each profile pins the consumer version, CPU, interfaces and helper source/binary checksums. Managed profiles also require exact assembly bytes and import tables; other assemblies retain complete native export checks.

Greenworks Automatic mode uses the separate included `maclauncher-ticket-unavailable-0.1.0-universal` loader. It supplies the required library exports while rejecting ticket checks and decryption. Native mode uses imported SDK libraries. Neither included helper requires an SDK, compiler, download or installation step.

Exact versions and contracts are listed in the [API catalog](../../src/modules/shared/runtime/steamworks/versions.json), [consumer profiles](../../src/modules/shared/runtime/steamworks/profiles.json) and [ticket catalog](../../src/modules/shared/runtime/steamworks/ticket-versions.json). Earlier profile IDs retain their original helper identities; selecting one never substitutes a newer API.

The standalone [API source and builder](../../src/modules/shared/runtime/steamworks/native/offline-0.5.0) and [ticket source and builder](../../src/modules/shared/runtime/steamworks/native/ticket-0.1.0) include fixed-width ABI fixtures and MIT notices. Rebuilding requires [Node.js](https://nodejs.org/) and Apple Command Line Tools, installed with `xcode-select --install` under `/Library/Developer/CommandLineTools`. Each builder takes a new absolute output directory, sets both deployment targets explicitly and records source/native checksums. These prerequisites apply only to development builds.
