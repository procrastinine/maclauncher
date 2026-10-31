# GitHub metadata transport

Runtime managers that discover versions on GitHub read release, tag, commit and Actions metadata through one shared transport, `src/modules/shared/runtime/github-transport.js`. It makes requests only for the actions listed in [Downloads and offline use](README.md#downloads-and-offline-use). Loading modules, reading runtime state and opening a runtime panel neither make requests nor look up credentials.

## Authentication

The main process shares one transport among its backend workers. On its first API request, the transport reads an existing `GH_TOKEN` or `GITHUB_TOKEN`, or asks the installed GitHub CLI for its token with `gh auth token --hostname github.com`. The result of this lookup, including an unavailable CLI or a failed authentication, is cached for the application session. Tokens stay in process memory, and workers receive only metadata and the authentication status. Metadata pages are fetched with Node HTTPS instead of repeated CLI processes. A standalone Node caller uses the same transport inside its own process. No catalog or download requires a token or the GitHub CLI; a token only raises GitHub's API request quota.

## Without API quota

When GitHub's REST API reports an exhausted quota, the transport reads the supported metadata from public release pages, expanded asset lists, Atom feeds and Git HTTPS reference advertisements. These requests go to official GitHub hosts without authentication headers.

- Release SHA-256 digests come from the published asset metadata.
- Exact download sizes come from HEAD requests for the assets each runtime selects. Rounded sizes shown on web pages are never used as byte counts.
- Git reference advertisements resolve lightweight and annotated tags to exact commits, without a Git installation.

A digest or commit that is not available is left missing and never replaced with a guess.

## Caching and limits

Concurrent callers share in-flight requests and a size-limited memory cache, which keeps metadata for fifteen seconds. An asset HEAD response can be reused for five minutes when the published SHA-256 is the same, and a changed digest gets a new size lookup. Cancelling one caller leaves the other subscribers active, and cancelling every subscriber aborts the request.

At most eight network requests run at the same time. Response bodies are limited to 32 MiB, redirects must stay on approved GitHub HTTPS hosts, and credentials are dropped when the origin changes.

## Related modules

- `github-releases.js` provides page-limited release, tag and commit queries. Its optional `assetFilter(asset, release)` limits the size lookups without discarding the published asset names or digests.
- `github-runtime-catalog.js` keeps each engine's version mapping separate from the transport and from resolving tags to exact commits.
- `github-actions-catalog.js` reads public Actions metadata through the same request service. Its artifacts download through [nightly.link](https://nightly.link/), which serves public, unexpired artifacts without GitHub authentication.
