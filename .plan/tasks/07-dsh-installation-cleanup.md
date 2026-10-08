# Plan 7 — Investigate and clean up multiple DSH installations

## Objective

Map DSH installations, launchers and running instances on Alex's machine, choose the intended canonical installation with the owner, and retire redundant copies without losing profiles, plugins, credentials or sessions.

Planning only. Recording this plan does not authorize stopping processes, moving installations or deleting data.

## Initial observations to verify

- `dsh` resolves to `/home/alex/.local/share/dsh-cli/node_modules/.bin/dsh`.
- A running web process uses `/home/alex/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh` on port 3080.
- Local-model launchers use `/home/alex/.local/share/dsh-cli/local-model-launch.mjs`, the `dsh-tui` profile and temporary model patch overlays.
- Profiles and persistent state exist under `/home/alex/.dsh`.
- Machine-local plugins exist under `/home/alex/Applications`, including DSH integrations.

These observations do not prove that any installation or instance is redundant. Separate applications, profiles, dependency trees and temporary overlays may be intentional.

## Investigation

1. Inventory DSH package versions, resolved executable paths, symlinks and installation methods without recursively scanning unrelated projects.
2. Map each running DSH process to executable, profile, port, working directory and launcher. Identify which process actually serves the current session.
3. Inspect shell aliases/functions, user services, autostart entries and npm/npx launch commands that can recreate obsolete installations.
4. Map shared versus installation-specific profiles, plugin packages, session storage and configuration. Do not expose credential values in reports.
5. Identify custom modifications in installed packages before comparing or retiring copies; preserve work from Plans 1–6 and existing local integrations.
6. Present a compact recommendation identifying the canonical installation, intentional secondary instances and genuinely redundant copies. Ask the owner to approve the concrete cleanup targets.

## Future cleanup after approval

- Prefer correcting launchers to use the selected installation rather than maintaining multiple accidental entrypoints.
- Validate any migrated profiles/plugins in a separate instance before touching the active service.
- Stop only explicitly identified and approved processes; preserve the active conversation and unrelated apps.
- Verify each absolute target path before moving it.
- Move retired files/directories to collision-free recovery locations under `/tmp` or use `.bak`; do not permanently delete unless explicitly requested.
- Preserve credentials, profiles, sessions and custom plugins. Do not clear all npm caches or uninstall unrelated dependencies.
- Record recovery mappings and explain that `/tmp` is temporary, not durable backup.

## Completion criteria

- Every relevant DSH entrypoint and running instance is understood.
- The owner has selected a canonical installation and approved actual cleanup targets.
- Approved obsolete entrypoints no longer recreate redundant installations.
- The retained web/TUI workflows, model access and custom plugins work after cleanup.
- Recovery locations are documented and no unrelated or active-session data is lost.
