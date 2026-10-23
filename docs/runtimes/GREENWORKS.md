# Greenworks

[Greenworks](https://github.com/greenheartgames/greenworks) is a native Node bridge used by some NW.js games for Steam integration. Its package, host version and native Steam SDK dependencies are separate inputs.

MacLauncher pairs Greenworks with the selected NW.js version. Automatic selection uses the newest installed host with a listed compatible Greenworks ABI, or prepares a compatible pair when none is installed. Both missing downloads are planned together; declining either leaves both installations unchanged. **Runtimes → NW.js → Greenworks** lists release history and imported native SDK libraries. Explicit per-game NW.js versions take priority and must match an available bridge ABI. Refresh, installation and SDK import do not create a global host preference.

## Native dependencies

| NW.js | Greenworks | Steamworks SDK | CPU/API route | Minimum macOS |
| --- | --- | --- | --- | --- |
| 0.103.1 | 0.22.0 | 1.63 | ARM64 offline helper; Intel requires native SDK API and Steam | 13.5 |

Other bridge packages can be downloaded independently; Play requires a supported native dependency contract.

Automatic mode on the supported ARM64 pair uses the included offline API and encrypted-ticket loader. No SDK import is required. Play validates the exact API route and application ID, asks before downloading a missing host or bridge, then links the native libraries into a small private wrapper. Original assets and the parent environment remain unchanged; native libraries are shared.

**Import Steamworks SDK 1.63…** accepts an authorized [Steamworks SDK](https://partner.steamgames.com/doc/sdk) folder or a directory containing its genuine native libraries for Native mode or Intel:

- Required: `libsdkencryptedappticket.dylib`, normally under `public/steam/lib/osx/`.
- Native API: `libsteam_api.dylib`, normally under `redistributable_bin/osx/`.

Import checks exact file hashes, CPU slices, exports and signatures. One shared registration lives under `userData/runtimes/greenworks-sdk/sdk-1.63-c3a1cd191b1e-7824c030a762/`, normally in `~/Library/Application Support/maclauncher/`. Reimport reuses healthy bytes; adding the API library updates the same registration. Headers, SDK source and compiler tools are unnecessary. Valve's libraries retain their terms and are not MacLauncher payloads.

## Steam API routes

The exact ARM64 pair uses the included offline API by default, even when official libraries are imported. Its `greenworks-0.22.0-nw0.103.1-sdk1.63-ml1-arm64-offline-abi0.5.0` profile covers client initialization, typed application ID/language/identity and asynchronous stats callback delivery. Its separately versioned encrypted-ticket loader rejects ticket operations. Online services and encrypted-ticket decryption are unavailable. Intel has no supported offline route for this pair. [Steam support](STEAM_API.md) describes helper versions and limits.

Advanced backend callers can set `context.runtimeSettings.steamApiMode = "native"` to use the imported official API, which requires a working native Steam client. Ordinary games without a detected Steam bridge do not need this setting.

`greenworks-preparation.js`, `greenworks-sdk.js` and `nwjs-manager.js` under [the shared web runtime module](../../src/modules/shared/web/runtime) provide SDK import, preflight and preparation without Electron. API setup uses `context.prepareSteamApi` with the bridge's exact interface requirements. Detection and native validation cache their results against source file identities.
