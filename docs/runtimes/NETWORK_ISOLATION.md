# Network isolation

Network isolation blocks a game's Internet and local-network access. It is controlled per game and applies to every runtime.

## Setting

Each game's inspector has one **Network access** checkbox, which applies to all of the game's runtimes; runtime settings have no separate network controls. A change takes effect on the next launch.

The **Network access** checkbox in **Settings → Launcher** sets the initial value for newly imported games, and it is off by default. Changing it does not change existing games. A game without a saved choice copies the current default once, and saved per-game choices are kept where possible. Some runtimes keep network access off where they cannot run online.

Some local web packages load their playable content from a website and need network access turned on.

## What isolation blocks

On macOS, isolation blocks Internet and local-network IP connections and incoming listeners in the game process and its child processes. This covers native libraries and child executables as well as JavaScript and Java APIs. If the network policy cannot be installed, the game does not start. A launch path that hands control to an unrelated application service cannot keep this guarantee, so it reports an error while isolation is on.

The setting applies to the game's own process tree. It is not a system-wide firewall and does not change a Steam client, a browser or another external service, including a Steam client that Play [starts for a Steam game](STEAM_API.md) after consent or with **Start automatically**. Games that require those services keep their connection and offline-mode requirements. Runtime [downloads](README.md#downloads-and-offline-use) and preparation happen before the game starts and are not affected by the game's setting.

## What stays available

- Local Unix-socket communication stays available for runtime coordination, including Wine's private server.
- An Electron game can reach the one loopback port that serves its local assets. That server only serves files from the game's permitted content directories and is not a network proxy.
- A game that runs its own Steam API from a Steam installation can reach a running Steam client through the client's local endpoints: loopback ports 57343 and 57344, or the loopback addresses named by the `Steam3Master` and `SteamClientService` environment variables. Games that use the included Steam helper, and all other games, get no Steam endpoint. Other loopback endpoints stay blocked.
- Explicit graphics-library injection still works through macOS's protected launch helpers.
- Native applications can still register for standard macOS application events, such as Quit from the Dock. This does not let them send automation events to other applications.
- Native applications can register their own accessibility and text input endpoints for their process. Incoming accessibility clients are validated through macOS TCC, and the system's accessibility authorization decides which are allowed. Window controls and assistive access keep working, and the game gets no access to another application's accessibility server.

## Electron and NW.js

Electron and NW.js apply the same policy to browser requests and to Node networking. MacLauncher's Electron browser broker keeps Chromium's GPU and network-service sandboxes. The game's first preload script installs the native network policy in the renderer, which has Node access, before any publisher script runs. Browser requests go through the session's origin restrictions and a local proxy that forwards nothing, and WebRTC follows the same proxy policy; only the local asset origin bypasses it. If the renderer policy or the preload fails, the game window closes.

Turning network access on allows online content but does not allow child processes. **Block child processes** is a separate runtime option, described in [web runtimes](WEB_RUNTIMES.md).

## Android

Android combines network isolation with its file-access policy and does not add a second sandbox.
