# Corrigir recuperação do WebSocket error genérico no Codex noturno

## Objetivo e evidência
Corrigir a categoria que interrompeu alex-tavern em 13/10/2026 01:01:18: `turn/end` com `PI_AI_ERROR` / `WebSocket error`, sem retry, retomado manualmente às 07:11. Usar o goal desta sessão para guiar implementação e validação após aprovação; completar apenas com evidências verificadas.

Código instalado confirmou: pi-ai produz exatamente `WebSocket error` se o evento não informa causa; o adapter não reconhece `socket` dentro de `WebSocket`; o middleware atual aceita apenas closes1000/1012. Não houve esgotamento do orçamento oficial.

## Correção escolhida e escopo
Modificar somente `plugins/codex-transient-close/index.mjs`, seus testes/fixture e README. Acrescentar a mensagem **exatamente** `WebSocket error` à normalização para TRANSPORT, exclusivamente em request marcado pelo mesmo host como loop normal, provider openai-codex, purpose ausente, finish error PI_AI_ERROR e signal não abortado. Manter exclusão de status HTTP4xx, incluindo auth/quota/oversize, e mensagens qualificadas/permanentes. Preservar chunk facts, replay metadata e código original nos streams fora do escopo. Nenhum retry próprio: política oficial inalterada, cinco retries adicionais com backoff/cancelamento/audit existentes.

Não modificar o fork pi-ai, node_modules instalado, providers, credenciais, recipes/pins ou orçamento. Não aplicar regex genérica /WebSocket/, PI_AI_ERROR global retryable, always ou retries infinitos. Erro request-buffer-limit do H3 permanece fail-fast e fora desta task. Compactação/title continuam excluídos.

### Tradeoff explícito
A mensagem genérica perdeu sua causa; ela não prova transitoriedade nem permite garantir distinção entre transporte e handshake opaco. A recuperação exata e limitada tenta restabelecer a conversa sem ampliar mensagens conhecidas de auth/quota/policy/oversize. Se o erro opaco persistir, seis attempts no total encerram o turno. Não prometer execução noturna ininterrupta, exatamente-uma-vez de efeitos remotos ou LTS geral. Preservar causa estruturada no fork é melhoria futura separada, não inventar informação inexistente.

## Testes/gates
1. Acrescentar teste específico que reproduz falha original sem plugin: mesma mensagem genérica, zero retry e zero CLIENT tool.
2. Acrescentar recuperação genérica no loop oficial real, com fake adapter sem rede, tool chunks incompletos e completos: failed stream/backoff executam zero tools; sucesso executa só tool da tentativa bem-sucedida; histórico parcial não entra no próximo request e attempt IDs são novos.
3. Testar generic WS persistente: seis attempts, cinco pares retry/retry-started; exhaustion, reset entre turns, concorrência/reload, cancel e dispose sem nova tentativa ou tool indevida.
4. Expandir matriz negativa da mensagem genérica: requests unmarked, outros providers, purpose compaction/title, cancellation, outros códigos, 4xx; mensagens com prefixo/sufixo, newline/CR, auth/quota/policy/oversize e request-buffer-limit permanecem intactas. Reexecutar regressões closes1000/1012 e defaults oficiais.
5. Executar `node --test plugins/codex-transient-close/codex-transient-close.test.mjs`, `npm run test:lts:contracts`, syntax/diff check e verificação read-only de wiring atual `node tools/activate.mjs --check --profile dsh-tui`. Caso check indique drift preexistente, registrar e não escrever perfis incidentalmente.
6. Atualizar README com escopo, risco do erro opaco, evidências e ativação. Guardar logs/receipt local em `.dumps`, sem dados privados no Git. Revisar diff para preservar alterações alheias.

## Ativação, rollback e limites
O perfil dsh-tui já aponta para o módulo local; editar sua fonte afeta futuros carregamentos. Não reiniciar ou recarregar processos/sessões automaticamente. Informar que processo novo ou reload explícito suportado é necessário para usar o código novo; sessão persistida pode ser retomada. Não fazer chamadas live pagas ou teste de madrugada incidentalmente. Não tocar histórico Tavern/H3. Rollback da mudança é a reversão focada do diff do plugin, testes e README; não usar rollback de tarball da task26. Sem commit/push/publicação nesta task.

## Aceite
Regressão offline da mensagem real passa pelo retry oficial limitado, negativos continuam fail-fast, contratos LTS verdes, diff restrito, documentação correta e instrução de ativação sem parar agentes existentes. Noite controlada posterior continua sendo gate operacional para LTS, não requisito para declarar esta correção de classificação implementada.