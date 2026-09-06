# Capture improvements

Completed local web-slurp 0.3.0: package setup/update/uninstall and skill/CLI symlinks; persistent named Chrome profiles with verified ownership and manual sign-in resumption; loaded static asset manifest and offline CDN replay; desktop/mobile captures; pixel comparison with Retina density; explicit click/hover/scroll state capture with cancellation and partial-result preservation.

Validation: 16 tests passed across six files (full suite: 15 passed, auth test updated for stricter shutdown refusal then passed separately). TypeScript check, skill validator, and diff whitespace check passed. Packed archive installed into isolated directories, verified CLI version and owned symlinks, then uninstalled. Independent auth, asset, flow, and visual reviews completed.

Limits: sign-in remains manual; resource collection may revalidate observed URLs and records unavailable assets; replay is a static reference, not a recovered backend. Pixel differences do not verify behavior. Flow selectors address the top-level document and capture explicit states, not video. Failed captures preserve partial evidence and require a fresh output directory when evidence exists.

Installed CLI and skill point at this checkout. The source is tracked in Git; no package registry publication was performed.
