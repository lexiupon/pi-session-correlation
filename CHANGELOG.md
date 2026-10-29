# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-10-29

- README: dropped local filesystem paths and the pointer into a private repository; the install
  section now uses pi's documented install sources only. Docs-only — versioned so the copy in the
  published tarball matches the repository.
- README: the internal sampling figure is stated qualitatively ("on our own traffic") instead of
  as a measured count.

## [0.1.0] - 2026-10-29

- Split into its own repository; previously a `pi-session-correlation/` directory in a combined
  `pi-extensions` repo. History preserved (7 commits), contents byte-identical.
- Extension moved to `extensions/index.ts` and declared through the `pi` manifest, matching the
  layout of the sibling packages.
- Published under the `@lexiupon` scope as `@lexiupon/pi-session-correlation` (first release; `private` dropped, `publishConfig.access` set).
- Host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) moved from
  machine-local `file:` dependencies to `peerDependencies`, as pi requires of a published package.
- Added `files` allowlist, `keywords` (incl. `pi-package`), MIT `LICENSE`, and this changelog.
- Header contract itself is unchanged — and still provisional until the companion RFC lands.
