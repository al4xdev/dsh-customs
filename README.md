# alex-dsh-machine-tools

Local, reversible extensions for Alex's DSH instances. Nothing here modifies an
installed DSH package: every tool is a Cordis plugin loaded from this repository
by path.

- `plugins/` — the plugins themselves plus `activation.json`, the single source
  of truth for what is active where. See `plugins/README.md`.
- `tools/activate.mjs` — the bootstrap that turns `activation.json` into the
  actual `cordis.patch.yml` files DSH reads.
- `.plan/` — task history. `.dumps/` — scratch, gitignored, local only.
- `frontend/dsh-tui/` — a separate clone with its own remote. Deliberately not
  tracked here; see `.gitignore`.

## The problem this repository exists to solve

The plugins live in the repo, but DSH does not learn about them from the repo.
It reads them from a `cordis.patch.yml` per profile:

```
~/.dsh/profiles/{web,headless,tui,dsh-tui}/cordis.patch.yml
```

Those files are outside version control, carry hand-written per-machine config
(local model providers, permission presets, theme, shortcuts) and long
explanatory comments, and used to be edited by hand from several different
sessions. The predictable result was drift: the repo's own copy of the overlay
listed six plugins while the live profiles loaded seven.

So activation is generated, not hand-written. `activation.json` is the only list.
`tools/activate.mjs` resolves every module path against wherever this repo
actually lives on the current machine, and rewrites *only* the contiguous run of
managed `alex-*` entries — every other byte of the profile, comments included, is
copied through untouched. Entries that do not start with the managed prefix
(`llm-llamacpp`, `grammar-fix`, `antigravity-tui-login`, …) are never touched, so
per-machine configuration survives every sync.

## New machine

```sh
git clone <this repo> ~/git/my/dsh-customs
cd ~/git/my/dsh-customs
node tools/activate.mjs          # report drift, change nothing (exit 1 if any)
node tools/activate.mjs --write  # apply
```

`--write` is safe to re-run; the operation is idempotent. A second run reports
`in sync` for every target.

Options:

| Flag | Effect |
| --- | --- |
| *(none)* | read-only drift report; exit code 1 when a target is out of sync |
| `--write` | apply the sync |
| `--profile NAME` | limit to one profile (repeatable); skips the repo overlay |
| `--root DIR` | resolve module paths against `DIR` instead of this repo's location |
| `--json` | machine-readable report |

The `yaml` package is not vendored. Resolution falls back to the DSH profile
tree, which always has it, so the bootstrap works on a fresh DSH machine without
an install step. Add `yaml` as a local dependency if you want the repo to be
self-contained.

## Adding or moving a plugin

1. Put the plugin under `plugins/<name>/index.mjs`.
2. Add a row to `plugins/activation.json`.
3. `node tools/activate.mjs --write`.

The script refuses to guess when it finds more than one separate run of managed
entries in a single file, and it reports manifest rows whose module is missing —
both cases would otherwise break every profile on the next DSH restart.

## Where machine config lives

This repository owns the plugins and nothing else. The rest of the DSH
configuration — `~/.dsh/AGENTS.md`, `~/.dsh/.agent-presets/` and the profiles
themselves — is versioned by the separate dotfiles repo, which uses `$HOME` as
its worktree (`git -C ~/git/my/dotfiles status`). Its `README.md` documents the
fresh-box clone recipe.

The division: dotfiles carries the hand-written config, this repo carries the
plugin sources and generates the `alex-*` wiring inside those profiles. After
cloning dotfiles onto a new machine, run `node tools/activate.mjs --write` here
so the generated rows point at the new layout.

## Known gaps

- `plugins/managed-plans/` is implemented but loaded by no profile. It is
  recorded under `knownInactive` in `activation.json` so the sync never enables
  it implicitly.
- Per-machine values inside the profiles (model routes, GGUF snapshot paths,
  permission defaults) are intentionally left as they are; they are configuration,
  not plugin wiring.
- The profiles also reference one plugin outside this repo by absolute path:
  `/home/alex/Applications/dsh-antigravity/tui-login.mjs`. It is not managed by
  `activation.json`, so the bootstrap will not fix it on a new machine.
