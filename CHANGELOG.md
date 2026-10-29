# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-10-29

- Split into its own repository; previously a `pi-session-correlation/` directory in a combined
  `pi-extensions` repo. History preserved (7 commits), contents byte-identical.
- Extension moved to `extensions/index.ts` and declared through the `pi` manifest, matching the
  layout of the sibling packages.
- Renamed to `@alexion42/pi-session-correlation`; `private` dropped, `publishConfig.access` set.
- Host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) moved from
  machine-local `file:` dependencies to `peerDependencies`, as pi requires of a published package.
- Added `files` allowlist, `keywords` (incl. `pi-package`), MIT `LICENSE`, and this changelog.
- Header contract itself is unchanged — and still provisional until the companion RFC lands.
