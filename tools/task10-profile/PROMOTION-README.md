# Task10 default-profile promotion (this machine only)

**Prepare now; apply only after exiting Harness and every default `dsh-tui`
runtime.** Nothing here builds, packs, contacts models, changes the base version,
rewrites the fish launcher, accesses credentials, or installs globally.

## CLI and artifact contract

From `/home/alex/git/my/dsh-customs` (fish-compatible commands):

```fish
node tools/task10-profile/promotion.mjs --check
node tools/task10-profile/promotion.test.mjs
node tools/task10-profile/promotion.mjs --prepare --bundle /absolute/bundle.json --state /home/alex/.local/share/dsh-cli/task10-ready-UNIQUE
```

`--check` is read-only. `--prepare` writes only an **absent**, private durable
state directory; its parent must exist, be canonical, and share the profile's
filesystem. Never put this directory inside `.dumps`, the profile, or plugins.
The parent builds/packs the tarball separately, then supplies:

```json
{
  "schemaVersion": 1,
  "package": "@deepseek-harness-tui/dsh-tui",
  "version": "0.14.0",
  "runtimeVersion": "0.2.0-rc.2",
  "tarball": "/absolute/sealed-fork.tgz",
  "tarballSha256": "<64 lowercase hex characters>",
  "recipePatchSha256": "<current tools/task10-frontend/recipe.json patchSha256>"
}
```

This is local integrity, **not signed provenance**. Preparation verifies package
identity/public UI shape and composes the fork bundle plus proposed profile/home
patches through public, boot-free patch APIs. It does not evaluate `!!js`, mount
plugins, or claim real interactive acceptance. Never use live `dsh --dump-config`
for preparation: the installed CLI rewrites `cordis.yml` even in dump mode.

Review `STATE/activation.proposed.json`, `package.proposed.json`, and privately
`cordis.proposed.yml` (may contain inline provider settings). `plan.json` records
input/artifact hashes, original dependency specs/resolutions, preset sources,
selected-preset hints, and preparation validation. Source/config changes require
fresh preparation; do not edit prepared files or run concurrent promotion commands.

## After closing Harness: owner executes

Replace `STATE` with the exact prepared absolute directory:

```fish
node /home/alex/git/my/dsh-customs/tools/task10-profile/promotion.mjs --apply --state STATE --harness-closed
# Only after successful apply; preserves the original fish launcher:
and dsh
```

Apply checks `/proc` for relevant same-user `dsh-tui`/local launcher/default or
ambiguous DSH runtimes; explicit other profiles and known positional web/headless
entry points are excluded. It reports PID/executable/profile classification, never
raw prompts/tokens, and never kills processes. Acknowledgment is not a guarantee
against a concurrent launch: keep every relevant runtime closed throughout.

Before **any live write**, apply archives the full exact profile (including
`node_modules`, symlinks, lockfile and plugin-manager state), compares the archive
against its source, backs up exact activation manifest bytes, fsyncs backups, and
writes `receipt.json`. Keep enough disk for the full archive and rollback tree.
The original lock remains the install input. Only the TUI dependency becomes a
local file tarball; all existing non-TUI specs/importers, installed direct-package
manifests, provider/config bytes and launcher files must remain unchanged.

Installation uses existing absolute
`/home/alex/.local/share/dsh-cli/node_modules/.bin/pnpm`, explicit profile cwd,
`--ignore-workspace --prod --ignore-scripts --no-frozen-lockfile`. The unchanged
CLI is `/home/alex/.local/share/dsh-cli/node_modules/.bin/dsh` (not a fish function).
No global npm reinstall/uninstall, base upgrade, build scripts, or runtime boot.
Manifest changes occur **only during apply**, then
`tools/activate.mjs --write --profile dsh-tui` generates root managed rows.

Applied tarball and filtered presets persist in
`~/.dsh/profiles/dsh-tui/task10-promotion/`, **outside `.dumps`**. Root native
planning is disabled. Original official standard/PTC/cordis plugin lists lose
**only** their native isolated `planning` group; all other tools and reference
expressions survive. Literal `id` + `plugins` include declarations own those TUI
registry seats (root `config: !!js` would be invalid). Minimal has no planning and
is untouched. No selected preset, persisted session, or existing mode is changed.
**Custom/packaged presets (including liangshen) and Shift+Tab modes using native
plan-mode are not migrated; inspect/test them before use.** Owner acceptance of
`/plan` remains pending and can contact the selected model.

Apply validates offline composition and imports the installed package/public UI
and managed plugin modules with the existing CLI's in-memory resolution hook;
no plugin mounting/model calls. Validation failure attempts exact rollback.
This is **not an atomic multi-file transaction**; interruption/recovery failures
remain visible in the receipt and require inspection before launching.

## Rollback and receipt

```fish
node /home/alex/git/my/dsh-customs/tools/task10-profile/promotion.mjs --rollback --receipt STATE/receipt.json --harness-closed
```

Receipt v1 fields: `status`, `state/profile/manifest`, `backup` (archive,
inventory, manifest paths + SHA256), `bundle`, `priorDependencyResolution`,
`proposedManifest`, `validation`, `installed` hashes, and `rollback` verification.
Statuses include `backed-up`, `applying`, `applied`, `apply-failed`,
`rolling-back`, `rolled-back`. Manual rollback refuses newer profile/manifest
edits rather than overwriting them. It quarantines the current full tree in
`STATE/retired-profile`, restores/compares the original profile and exact manifest,
and **does not reinstall or delete anything**. If a receipt is incomplete or
post-apply runtime/settings changes occurred, retain all artifacts/backups and
perform owner-directed recovery; do not silently force rollback.
