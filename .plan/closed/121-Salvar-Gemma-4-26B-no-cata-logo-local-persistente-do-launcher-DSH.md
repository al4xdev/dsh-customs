# Fixed Gemma in DSH Local Catalog

## Diagnosis
The fish `dsh` calls `/home/alex/.local/share/dsh-cli/local-model-launch.mjs`. This launcher maintains Bonsai 2 27B (QW) in the offline catalog and appends the currently discovered model. Qwen Dirk and Gemma already appear in web/headless, but are not in a persistent catalog of the dsh-tui launcher.

The user started `gen gmmed`; status/log reads and local GETs to `/v1/models` and `/props`, without generation, confirmed Gemma 4 26B Q4_K_XXL: full GGUF id, context 65536, vision=true, and supports_reasoning_effort=false.

## Authorized Change
1. Add a fixed Gemma entry to the launcher, with the exact id returned by the server, readable label, context 65536, maxTokens 32768 (same existing live rule), image support, and no artificial reasoning levels.
2. Initialize catalog with Bonsai/QW and Gemma; live discovery continues updating the corresponding entry and appending other models.
3. Do not alter default models, other registrations/profiles, gen launcher, backend, sampling, or processes. Do not generate inference or commit.

## Validation
Private backup of original file and targeted change with prior reading. Isolated test of the launcher itself with simulated fetch/spawn/dump: offline keeps both; live Gemma updates without duplicating; unknown model is added without clearing fixed ones; no default patches without explicit override. Syntax check and preservation of active gen service. Local evidence ignored in `.dumps/`.
