# GitHub metadata transport

Several runtimes find their versions on GitHub. Their runtime managers read release, tag, commit and Actions metadata through one shared request module, `src/modules/shared/runtime/github-transport.js`, called the transport below. It makes requests only for the actions listed in [Downloads and offline use](README.md#downloads-and-offline-use). Loading modules, reading runtime state and opening a runtime panel make no requests and look up no credentials.

## Authentication

The main process shares one transport among its backend workers. On its first API request, the transport looks for a token: it reads an existing `GH_TOKEN` or `GITHUB_TOKEN`, or asks the installed GitHub CLI with `gh auth token --hostname github.com`. The outcome of this lookup is cached for the rest of the application session, including an unavailable CLI or a failed authentication. Tokens stay in process memory, so workers receive only metadata and the authentication status. Metadata pages are fetched with Node HTTPS rather than by starting a CLI process for each request, and a standalone Node caller uses the same transport inside its own process. A token only raises GitHub's API request quota, since no catalog or download requires a token or the GitHub CLI.

## Without API quota

When GitHub's REST API reports an exhausted quota, the transport reads the same metadata from public release pages, expanded asset lists, Atom feeds and Git HTTPS reference advertisements. These requests go to official GitHub hosts without authentication headers.

- Release SHA-256 digests come from the published asset metadata.
- Exact download sizes come from HEAD requests for the assets each runtime selects. The rounded sizes shown on web pages are never used as byte counts.
- Git reference advertisements resolve lightweight and annotated tags to exact commits, so no Git installation is needed.

When a digest or commit cannot be found this way, it is left empty instead of being estimated.

## Caching and limits

Callers that ask for the same metadata at the same time share one request. They also share a size-limited memory cache, which keeps metadata for fifteen seconds. A HEAD response for an asset can be reused for five minutes as long as the published SHA-256 stays the same, and a changed digest triggers a new size lookup. When one caller cancels, the request continues for the others; it is aborted only when every caller waiting on it has cancelled.

No more than eight network requests run at the same time. Response bodies are limited to 32 MiB, and redirects must stay on approved GitHub HTTPS hosts. Credentials are dropped whenever a request moves to a different origin.

## Related modules

- `github-releases.js` provides page-limited release, tag and commit queries. Its optional `assetFilter(asset, release)` narrows the size lookups while keeping the published asset names and digests.
- `github-runtime-catalog.js` holds each engine's version mapping, which stays separate from the transport and from the code that resolves tags to exact commits.
- `github-actions-catalog.js` reads public Actions metadata through the same request service. Its artifacts download through [nightly.link](https://nightly.link/), which serves public, unexpired artifacts without GitHub authentication.
