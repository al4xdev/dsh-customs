# Fix Companion Skills Composition

## Proven Cause
The dsh-web-app bundle disables global skill-filesystem and tool-skill. The Companion preset does not restore them; previous isolated provider validation did not cover delivery to the agent.

## Implementation
1. Insert skill-filesystem and tool-skill inside preset-companion.config.plugins in installed profile ~/.dsh/profiles/companion/cordis.patch.yml, without regenerating the file. Preserve model and all other configurations.
2. Configure customSkillDirs to /home/alex/git/my/dsh-companion-workspace/.agents/skills, preserving defaults, to also serve child projects with their own git.
3. Update generator tools/session-companion/profile.mjs and corresponding tests to prevent regression.
4. Installed and isolated SDK fixture: schemas/tool skill available only in preset; execute two skills via public API; capture first request with fake adapter to prove source.kind skill-catalog and names. Test root cwd and child repo with own git; without network or real models.
5. No manual restart or permission changes. The profile uses live patchReload; report limitations of confirmation on the already running process.

The cross-profile session_create fix will be addressed in a separate plan after transport analysis and approval, without conflating the two validations.
