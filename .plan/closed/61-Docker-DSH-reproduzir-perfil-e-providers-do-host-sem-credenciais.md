# Reproduce host profile in Docker

## Request
User requested pulling the current profile for testing, following the absence of Gemini in the image's public profile. Fix the prior incomplete coverage without automatic inference.

## Execution
1. Inspect only manifests, YAML, and specific includes from `/home/alex/.dsh/profiles/dsh-tui` and root configuration required by the composition. Do not print sensitive content: private YAML inspection will be programmatic with output restricted to IDs, module names, structure, and redacted references. No broad searches across home or credentials.
2. Export a sanitized copy under `.dumps/`, preserving ordering, IDs, providers, presets, and policies; exclude tokens/keys/credentials/OAuth, history/sessions, and unnecessary personal endpoints/references. Do not modify host. Public module paths will be remapped to container sources; additional includes audited individually.
3. Apply to the existing test container (confirm name/status), preserving any login/credentials the user may have already created inside it. Do not replace the entire `.dsh` directory or touch credentials. Update public recipe wiring if necessary; only explicitly reviewed files are committed to Git, never private exports or dumps.
4. Verify offline composition and provider registration without invoking models, authentication, quota queries, or daemons. Use composition APIs without evaluating `!js` or importing providers where risk exists. Distinguish registered status from authenticated/functional status.
5. Provide fish command and list any adjustments, removed configs, or uncopied capabilities. Goal tracks execution until profile is testable without automatic spending.

## Acceptance
Gemini/Antigravity and other modules/providers from the audited profile present in the Docker composition, canonical SDK identity, relevant synthetic/static test passed. No tokens printed/published/copied to image, no models invoked. Existing container login preserved.
