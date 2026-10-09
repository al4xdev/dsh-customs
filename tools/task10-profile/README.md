# Task10 portable isolated profile (review before running)

Nothing has been provisioned, installed, built, activated or launched by this
change. `plugins/activation.json` is the **only plugin list**. Its task10 engine
and scene rows target only `dsh-tui-task10`, opt out of the generic repo overlay
with `overlay:false`, and use production `wakeAgent:true`. The existing four
profiles retain exactly their managed entries. `knownInactive` is now empty
because managed-plans is declared only for this isolated profile, not production.

## CLI / API

- `node tools/provision-task10.mjs --check` (default): read-only patch integrity
  and profile availability check. Optional `--receipt PATH` checks the pinned
  recipe, tarball SHA256, package identity and public Markdown API.
- `--prepare --receipt PATH`: exclusively creates `package.json`, `cordis.yml`
  and `cordis.patch.yml` in `$DSH_HOME/profiles/dsh-tui-task10` (default
  `~/.dsh/profiles/dsh-tui-task10`). Refuses nonempty/existing custom profiles,
  symlink targets, wrong receipts and artifacts. Does not install or activate.
  Empty existing real directories are allowed. A failure may leave a partial
  directory; inspect it manually, never rerun cleanup automatically.
- `node tools/task10-frontend/bootstrap.mjs --bootstrap SOURCE ARTIFACTS`:
  explicit network/install/compile/pack operation; both paths must be absent and
  disjoint. Never operates on `frontend/dsh-tui` or its index. Outputs a tarball
  and `receipt.json`; failure leaves its new checkout for inspection, not deletion.
- `node tools/activate.mjs --check --profile dsh-tui-task10`: read-only wiring
  review. The later scoped `--write` generates the managed entries from the
  central manifest. Do not use an unscoped write for this deployment.
- `node tools/task10-profile/check.mjs`: small in-memory overlay/CST fixture,
  requires `yaml` visible in the DSH profiles tree; no filesystem writes.

The skeleton disables native `plan-mode` before registering the replacement,
disables incidental `session-title-llm` calls and configures frontend
`externalPlanCommand:true`. It does not override permission/model defaults or
read/copy production profile settings. Those four profiles remain untouched;
the isolated profile inherits the pinned base defaults (not custom production
model/permission overrides). Configure an intentional model route separately
before interactive acceptance, if needed. No false validation wakeAgent default.

Frontend API: public `./ui` exports `Markdown`, source mapping helpers including
`markdownSourceRange`, and the host scene UI provides them to managed-plans.
Bare `/plan` routes externally only under the opt-in configuration; native
frontend deployments retain their picker. The patch includes *all* tracked
checkout differences (including bilingual docs) and untracked
`src/markdown-source.ts`; no generated lib, node_modules or huge vendor export.

## Exact pending owner-reviewed deployment

Prerequisites: existing DSH CLI compatible with **0.2.0-rc.2**, Node **^22.19 or
>=24**, **pnpm 11.21.0**, Git, tar, network access and build toolchain required by
the pinned frontend. Choose fresh source/artifact paths whose parents exist.
The tracked recipe pins URL/base/vendor commit and SHA256 of the source patch.
Bootstrap runs: clone -> detached checkout -> recursive pinned submodules ->
patch check/apply -> `pnpm install --frozen-lockfile --ignore-scripts` ->
`pnpm compile` (includes vendor builds, **not** the big verification suite) ->
public UI/package import smoke -> `pnpm pack --ignore-scripts` -> artifact SHA256
receipt. Receipt is a local integrity record, not a signed reproducible-build
attestation. Review its origin; the provisioner verifies bytes, not provenance.

Run these **only after parent/owner review authorizes provisioning/build**
(fish syntax, from this repository; substitute genuinely absent paths):

```fish
node tools/task10-frontend/bootstrap.mjs --bootstrap /absolute/fresh-task10-source /absolute/fresh-task10-artifacts
node tools/provision-task10.mjs --check --receipt /absolute/fresh-task10-artifacts/receipt.json
node tools/provision-task10.mjs --prepare --receipt /absolute/fresh-task10-artifacts/receipt.json
pnpm --dir ~/.dsh/profiles/dsh-tui-task10 install --ignore-workspace --prod --ignore-scripts
node tools/activate.mjs --check --profile dsh-tui-task10
# Expected drift on the first check; inspect desired rows before writing:
node tools/activate.mjs --write --profile dsh-tui-task10
node tools/activate.mjs --check --profile dsh-tui-task10
# Explicit owner-approved interactive launch only:
dsh --profile dsh-tui-task10
```

Use the matching `$DSH_HOME` path instead of `~/.dsh` when overridden. The fresh
profile installs **dependencies only**, including pinned yaml for the generator;
frontend development dependencies exist only in the fresh build checkout.
Do not install through the global `dsh-tui` launcher: it targets `dsh-tui`.
Do not use the temporary `plugins/managed-plans/isolated-core.patch.yml`, whose
old validation setting differs from this deployment. Keep artifacts available
until install finishes; relocations need an explicitly reviewed new file path.
Review the new profile lockfile/peer resolution against the installed DSH
contract before launch. DSH home-level patches can affect every profile and DSH
boot can maintain shared module fallback links; isolation is profile composition,
not a separate DSH home or a claim of zero global runtime side effects.

Then perform the approved real manual flow: stage -> /plan -> comment -> reject
-> revised same id -> approve tasks -> close, plus save-only category and stale
revision. This can wake the agent (`wakeAgent:true`) and needs explicit owner
permission. No model/local calls were made during implementation. Recovery:
launch the unchanged native production profile; no automatic deletion, restoring,
staging, committing or migration is provided.

## Personal-fork refinements

The managed scene is English-only UI; plan and comment content is preserved as
authored. Mouse clicks and arrows select native rendered source blocks. `c` edits
an existing annotation, `Esc` saves a comment draft, and `d` requires `y/n` before
deleting it. Deleted drafts retain audit metadata, but are not sent on rejection.
Historical revisions are read-only. `O` reopens the current plan using the same ID
and a new staged revision; already staged plans are simply opened. Old decisions,
comments and closure evidence remain in revision history. No old execution grant
survives reopening. The agent's `plan_reopen` is a proposal, never approval.

Focused checks (no model calls):

```fish
node tools/task10-profile/refinements-check.mjs
cd frontend/dsh-tui
node --import tsx/esm ../../tools/task10-profile/viewer-check.mjs
node --import tsx/esm ../../tools/task10-profile/presentation-check.mjs
```

For the local stable-profile handoff, use the separate promotion instructions.
Preparing it must not alter the currently running Harness; apply only after exit.
