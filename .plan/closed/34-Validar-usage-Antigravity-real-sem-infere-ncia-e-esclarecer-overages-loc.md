# Validate real Antigravity usage without inference and clarify local overages

## Request and authorization boundary
User authorized consuming Claude/Opus quota to test empty balance and confirmed Never, then clarified that the Overages configuration is LOCAL to the client, not an account kill-switch. The authorization applies to quota; it does not authorize paid AI credits or bypasses. The approved task 33 quota usage proceeds independently. Investigate mechanism in fork and public documentation; compare Claude/Gemini via offline subagent. **Do not run inference/exhaustion until there is baseline-only proof or a new explicit owner decision regarding financial risk.**

## Authorized execution here
After task 33 service/candidate is green, run a read-only validation of metadata usage against the current Antigravity account through the existing official credential provider/manager, in an isolated process without modifying profiles or restarting agents. Query only fetchAvailableModels, not streamGenerateContent/search/login/onboarding/overage/prompt. Up to two metadata queries (cache/force or double-check), bounded timeout 10s / caller lifetime, bounded response. Manager may refresh/persist token via official flow if expired; without reading values via read tool or printing/recording tokens/projectId/clientsecret/email/rawbody/headers. Store only allowlisted DTO produced by usage parser in `.dumps`, with fractions/reset/source/age/status/window unknown. Command/policy startup without paid calls; ensure credential backend host init does not reconfigure accounts/profiles and keeps logs quiet. If access to the credential service cannot be done without mutable boot or if credentials are absent, record limitation and provide command for the user to invoke; do not invent quota or re-authorize login.

## Overages safety
Review official Google CLI/plans documentation and fork request body. Community sources indicate root `enabledCreditTypes:[GOOGLE_ONE_AI]` as opt-in; this is not a guaranteed official contract. Record that current fork does not request this field and that Never in IDE/CLI does not prove a third-party provider inherited the rule. No change to inference payload/billing/credits config here; requires a separate reviewed task if implementing baseline-only.

## Empty quota test
If real metadata already shows remainingFraction 0 for Claude, record evidence without consuming extra quota and without inferring a 5h window. If positive balance or unknown schema, do not exhaust automatically due to overage risk: record that live-burn request is conditional upon baseline-only clarification / explicit acceptance of the risk, in addition to finite budget/deadline in a subsequent review. Do not rotate account/model/endpoint to circumvent limitations. Gemini serves as metadata and fixture comparison, not an exhaustion target.

## Provider/model comparison
Offline read-only delegation finds differences in requests/tool schema/signatures/stop/errors between Claude and Gemini on the same provider. Report shared policy vs distinct wire contracts, matrix, and real pre-existing failures. Do not modify inference/resilience during usage task 33 or claim general provider certification based on a single model.

## Acceptance
Delivered billing/model comparison reports, real usage metadata with sanitized DTO or explicit limitation, without inference/quota burn/credits/rotation/restarts. Record observed quota-empty scenario only if real; mocks remain separate. Include next steps: confirmed fresh zero usage for the correct bucket and reliable reset may guide future wait; isolated/unknown/stale 429 does not.
