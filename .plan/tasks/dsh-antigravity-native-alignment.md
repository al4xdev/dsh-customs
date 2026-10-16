# Plano de Alinhamento: Plugin DSH Antigravity com o Cliente Nativo AGY (v1.4.0)

## Identificação da Sessão de Referência
- **Conversation / Cascade ID:** `c95120e1-fb0e-4a64-9298-e58a37a77eab`
- **Data da Auditoria:** 16 de Outubro de 2026
- **Binário de Referência:** `/home/alex/.local/bin/agy` (v1.4.0 linux/amd64)
- **Token / Conta Testada:** `alexsandropessoa300@gmail.com` (`aicode-consumers`)

---

## 1. Conhecimento Prático Extraído do Binário Nativo (`agy`)

### 1.1 Identidade e Rastreabilidade da Conexão
O servidor do Cloud Code (`daily-cloudcode-pa.googleapis.com`) diferencia clientes e recursos pelo conjunto de headers HTTP e query parameters:
- **`User-Agent` exato:** `antigravity/1.4.0 linux/amd64` (ou versão vigente).
- **Rastreamento de Tráfego:**
  - `X-Aicode-Request-Id`: UUID gerado por request (`agent-${crypto.randomUUID()}`).
  - `X-Aicode-Trajectory-Id`: Identificador único da sessão/conversa (no DSH, o ID do chat).
  - `X-Aicode-Prompt-Id`: Identificador do turno atual para aproveitamento de KV-cache (prefill cache).
  - `X-Goog-User-Project`: `aicode-consumers` (evita desvio para billing padrão do GCP).
- **Query Parameter nativo no SSE:**
  - `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse&purpose=tabChat`

### 1.2 Estrutura e Formato das Requisições
- **Envelopamento do Body:**
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
- **Controle de Thinking:** O campo nativo da API do Cloud Code fica em `generationConfig.thinkingConfig.thinkingBudget` (inteiro), e não campos soltos como `thinking_budget`.

### 1.3 Arquitetura de Cotas Isoladas (Descoberta da Sessão)
O backend não compartilha uma cota única para todos os modelos. O `/usage` do AGY demonstrou a existência de **três buckets independentes**:
1. **Gemini Models (Flash e Pro):** Limites semanais e janela deslizante de 5 horas.
2. **Claude e GPT Models (Opus, Sonnet, GPT-OSS):** Limite semanal independente.
3. **Gemini 4 Argon:** Cota semanal isolada dedicada para planos Pro/Ultra.
- **Comportamento da API:** Quando a cota de um bucket atinge `0.00%`, a API omite esses modelos do retorno dinâmico de `v1internal:fetchAvailableModels`. Tentativas forçadas com nome direto retornam `404` ou caem na trava de quota.

### 1.4 Catálogo Nativo de Modelos (Structs Go em `.data`)
No offset `0xb63f680` do binário `agy 1.4.0`, o catálogo estático interno contém as definições completas que a UI do AGY utiliza, incluindo:
- `gemini-4-argon-low` (enum `1419`, `MODEL_PLACEHOLDER_M419`)
- `gemini-4-argon-medium` (enum `1418`, `MODEL_PLACEHOLDER_M418`)
- `gemini-4-argon-high` (enum `1417`, `MODEL_PLACEHOLDER_M417`)
- `gemini-3.8-flash-tiered` (enum `1322`, `MODEL_PLACEHOLDER_M322`)
- Família Claude 5.5 (`claude-opus-5-5-*` e `claude-sonnet-5-5-*`)
- `gpt-oss-120b-medium`

---

## 2. O que Torna o Plugin DSH Mais Próximo do Nativo

### 2.1 Alinhamento de Protocolo (`plugins/dsh-antigravity/src/api.ts`)
- **Headers Completos:**
  Adicionar `X-Aicode-Request-Id`, `X-Aicode-Trajectory-Id` (baseado no chat ID) e o query param `purpose=tabChat`.
- **User-Agent Dinâmico:**
  Configurar o User-Agent padrão como `antigravity/1.4.0 linux/amd64` (em vez de genérico sem OS/arch).
- **Normalização de `thinkingConfig`:**
  Garantir que os modelos com suporte a pensamento sempre usem a sub-estrutura `generationConfig.thinkingConfig.thinkingBudget`.

### 2.2 Blindagem de Billing e Roteamento Seguro
- Reforçar o guardião `guardedPayload` para rejeitar qualquer sinalizador de faturamento por token (`PAYGO`, `BILLING_OVERAGE`, `CREDIT_CONSUMPTION`).
- Assegurar que toda requisição de usuário individual passe estritamente por `aicode-consumers` e endpoint Daily (`daily-cloudcode-pa.googleapis.com`), evitando o endpoint de produção (`cloudcode-pa`) que responde 429 para esse perfil.

### 2.3 Atualização do Catálogo Estático (`plugins/dsh-antigravity/src/models.ts`)
- Atualizar a lista `maintainedModels` para incorporar os modelos introduzidos na versão 1.4.0 (`gemini-4-argon-*`, `gemini-3.8-flash-tiered`, etc.).
- Permitir que modelos nativos conhecidos fiquem visíveis e selecionáveis no DSH mesmo em períodos em que o `fetchAvailableModels` filtre o modelo por cota zero temporária.

### 2.4 Leitura de QuotaInfo do Backend
- O payload de resposta do `fetchAvailableModels` traz `quotaInfo.remainingFraction` e `quotaInfo.resetTime`.
- Disponibilizar esses dados para a interface do DSH para que o usuário possa consultar o estado do bucket antes de disparar prompts.

---

## 3. Próximos Passos (Para a Próxima Semana)
1. **Verificação de Cota Ativa:**
   Consultar o `/usage` quando a cota do bucket Argon renovar (após a contagem de 166h).
2. **Teste de Liberação do Catálogo:**
   Validar se o `daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` volta a expor o Argon com a cota positiva.
3. **Aplicação do Bundle no DSH:**
   Com as definições alinhadas ao binário `1.4.0`, compilar o plugin (`npm run bundle:host`) em uma sessão limpa.
