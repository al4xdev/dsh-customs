# Configure Automatic GPT Compaction Near 190k

## Objective
Modify only `/home/alex/.dsh/profiles/dsh-tui/cordis.patch.yml`, without code changes, to bound the automatic trigger for `openai-codex/gpt-6.1-sol` to approximately 190,000 tokens.

## Execution
- Add override for the existing `compaction-basic` plugin, maintaining `auto: true` and specific policy `provider: openai-codex`, `model: gpt-6.1-sol`, `thresholdRatio: 0.69853` (floor of 272000 × ratio = 190000).
- Preserve output reserve, headroom, and all other options; safety limit may trigger before 190k. Do not force capacity increase or modify catalog.
- Preserve all unrelated profile content, other models, and sessions.
- Validate YAML using host parser and configuration using official service without initializing runtime/LLM; verify ratio and rule isolation.

## Completion Criteria
Configuration saved and validated offline; notify that new processes load the rule and that safety margin may trigger earlier. No LLM calls or code modifications. Use active goal to track completion.
