# Real Antigravity Search Quality Test

## Objective
Execute an experimental search requested by the user, evaluate native search evidence and source quality without modifying installed plugins or default profile.

## Execution
1. Create temporary runner in `.dumps/` using existing credential service and OAuth refresh; never print or record tokens.
2. Query available models and submit a verifiable technical question (Node.js 24: release, LTS, and migration from Node.js 22), requesting Google Search in the native payload.
3. Preserve only text, queries, and public grounding metadata in the local report; evaluate real sources and check official pages if results exist.
4. Honestly report quality or endpoint incompatibility. Do not replace the provider or disable DeepSeek in this test.

## Validation
HTTP success alone is not enough: check groundingMetadata, queries, and URLs; do not present an ungrounded response as proven search. Bound timeout and attempts. Conclude goal after recording result.
