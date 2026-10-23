# Network isolation

Settings → Launcher contains one **Network access** checkbox that supplies the
initial setting for newly imported games. Each game's inspector has an On/Off
checkbox that applies across its runtimes. Changing the default does not change
existing games. Changes take effect on the next launch; runtime settings do
not contain separate network controls. The default is disabled. Runtime-specific
requirements can keep access disabled where online execution is unavailable.

On macOS, isolation blocks Internet and local-network IP connections and incoming listeners in the game process and its child processes. This applies to native libraries and child executables as well as JavaScript or Java APIs. The game is not started if the network policy cannot be installed. Launch paths that hand control to an unrelated application service cannot provide this guarantee and report an error when isolation is enabled.

Local Unix-socket communication remains available for runtime coordination, including Wine's private server. Electron games retain access to one specific loopback port serving their local assets. That server only serves files from the game's permitted content directories; it is not a network proxy. Other loopback endpoints remain blocked. Explicit graphics-library injection is preserved when crossing macOS's protected launch helpers.

Native application event registration remains available for standard macOS actions,
including Quit from the Dock. This does not grant permission to send automation
events to other applications.

The setting applies to the owned game process tree. It is not a system-wide firewall and does not change an already-running Steam client, browser or other external service. Games that require those services retain their connection and offline-mode requirements. Runtime downloads and preparation follow their existing explicit consent flow before the game starts.

Electron and NW.js use this same policy for browser requests and Node networking.
Enabling access permits online content without also permitting child-process
execution. **Block child processes** is an independent runtime option. Android
combines network isolation with its existing file-access policy rather than
applying a second sandbox.

Existing saved per-game network choices are preserved where possible. Games
without a saved choice copy the current default once. Some local web packages
load their playable content from a website and require enabled network access.
