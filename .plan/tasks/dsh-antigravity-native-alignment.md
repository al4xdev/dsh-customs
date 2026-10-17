# Alignment Plan: DSH Antigravity Plugin with AGY Native Client (v1.4.0)

## Reference Session Identification
- **Conversation / Cascade ID:** `c95120e1-fb0e-4a64-9298-e58a37a77eab`
- **Audit Date:** October 16, 2026
- **Reference Binary:** `/home/alex/.local/bin/agy` (v1.4.0 linux/amd64)
- **Tested Token / Account:** `alexsandropessoa300@gmail.com` (`aicode-consumers`)

---

## 1. Practical Insights Extracted from Native Binary (`agy`)

### 1.1 Connection Identity and Traceability
The Cloud Code server (`daily-cloudcode-pa.googleapis.com`) differentiates clients and resources via a combination of HTTP headers and query parameters:
- **Exact `User-Agent`:** `antigravity/1.4.0 linux/amd64` (or current version).
- **Traffic Tracking:**
  - `X-Aicode-Request-Id`: UUID generated per request (`agent-${crypto.randomUUID()}`).
  - `X-Aicode-Trajectory-Id`: Unique session/conversation identifier (in DSH, the chat ID).
  - `X-Aicode-Prompt-Id`: Current turn identifier to leverage KV-cache (prefill cache).
  - `X-Goog-User-Project`: `aicode-consumers` (prevents diversion to default GCP billing).
- **Native Query Parameter in SSE:**
  - `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse&purpose=tabChat`

### 1.2 Structure and Request Formatting
- **Body Wrapping:**
  ```json
  {
    "project": "aicode-consumers",
    "model": "<MODEL_NAME_OR_ALIAS>",
    "request": {
      "contents": [...],
      "systemInstruction": { "role": "user", "parts": [{ "text": "..." }] },
      "generationConfig": {
        "thinkingConfig": {
          "thinkingBudget": 128
        }
      }
    },
    "requestType": "agent",
    "userAgent": "antigravity",
    "requestId": "agent-..."
  }
  ```
- **Thinking Control:** The native Cloud Code API field is located at `generationConfig.thinkingConfig.thinkingBudget` (integer), rather than top-level or loose fields such as `thinking_budget`.

### 1.3 Isolated Quota Architecture (Session Discovery)
The backend does not share a unified quota across all models. AGY's `/usage` revealed the existence of **three independent buckets**:
1. **Gemini Models (Flash and Pro):** Weekly limits and 5-hour sliding window.
2. **Claude and GPT Models (Opus, Sonnet, GPT-OSS):** Independent weekly limit.
3. **Gemini 4 Argon:** Dedicated isolated weekly quota for Pro/Ultra tiers.
- **API Behavior:** When a bucket's quota reaches `0.00%`, the API omits those models from dynamic responses of `v1internal:fetchAvailableModels`. Forcing calls using the direct model name yields `404` or hits quota blocks.

### 1.4 Native Model Catalog (Go Structs in `.data`)
At offset `0xb63f680` of binary `agy 1.4.0`, the internal static catalog contains complete definitions used by the AGY UI, including:
- `gemini-4-argon-low` (enum `1419`, `MODEL_PLACEHOLDER_M419`)
- `gemini-4-argon-medium` (enum `1418`, `MODEL_PLACEHOLDER_M418`)
- `gemini-4-argon-high` (enum `1417`, `MODEL_PLACEHOLDER_M417`)
- `gemini-3.8-flash-tiered` (enum `1322`, `MODEL_PLACEHOLDER_M322`)
- Claude 5.5 Family (`claude-opus-5-5-*` and `claude-sonnet-5-5-*`)
- `gpt-oss-120b-medium`

---

## 2. Aligning the DSH Plugin with Native AGY

### 2.1 Protocol Alignment (`plugins/dsh-antigravity/src/api.ts`)
- **Complete Headers:**
  Add `X-Aicode-Request-Id`, `X-Aicode-Trajectory-Id` (based on chat ID), and the query parameter `purpose=tabChat`.
- **Dynamic User-Agent:**
  Configure default User-Agent as `antigravity/1.4.0 linux/amd64` (rather than a generic string without OS/arch).
- **`thinkingConfig` Normalization:**
  Ensure models with thinking support always structure it under `generationConfig.thinkingConfig.thinkingBudget`.

### 2.2 Billing Shielding and Secure Routing
- Reinforce the `guardedPayload` guard to reject any per-token billing flags (`PAYGO`, `BILLING_OVERAGE`, `CREDIT_CONSUMPTION`).
- Ensure every individual user request routes strictly through `aicode-consumers` and the Daily endpoint (`daily-cloudcode-pa.googleapis.com`), avoiding the production endpoint (`cloudcode-pa`) which responds with 429 for this profile.

### 2.3 Static Catalog Update (`plugins/dsh-antigravity/src/models.ts`)
- Update `maintainedModels` list to incorporate models introduced in version 1.4.0 (`gemini-4-argon-*`, `gemini-3.8-flash-tiered`, etc.).
- Allow known native models to remain visible and selectable in DSH even during periods when `fetchAvailableModels` filters out the model due to temporary zero quota.

### 2.4 Backend QuotaInfo Ingestion
- The response payload of `fetchAvailableModels` provides `quotaInfo.remainingFraction` and `quotaInfo.resetTime`.
- Expose this data to the DSH interface so the user can inspect bucket status before dispatching prompts.

---

## 3. Next Steps (For Next Week)
1. **Active Quota Verification:**
   Query `/usage` once the Argon bucket quota renews (after the 166h countdown).
2. **Catalog Unlocking Test:**
   Validate whether `daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` resumes exposing Argon with positive quota.
3. **Applying Bundle to DSH:**
   With definitions aligned to binary `1.4.0`, compile plugin (`npm run bundle:host`) in a clean session.
