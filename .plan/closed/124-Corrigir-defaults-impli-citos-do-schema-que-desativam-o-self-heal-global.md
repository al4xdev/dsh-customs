# Corrigir self-heal global materializado pelo schema nativo

## Causa reproduzida
No Alex Tavern bd1e8bdc-94ff-41fc-ba8b-f6b478e1f3ef: tentativa17056 TRANSPORT; auditoria17057 apenas observed; warning17058 recovery stopped retry0/max10; turn/end17060 error. Replay somente leitura confirma orçamento0/10, seguro e sem pin histórico restritivo. O planner puro admite a falha.

A chamada REAL do schema exportado `Config({})` de plugins/llm-resilience/index.mjs materializa `policy.retryableCodes:[]` e `auxiliary.replaySafePurposes:[]` por defaults implícitos de Schemastery. resolveConfig interpreta essas listas como escolhas explícitas e desativa toda elegibilidade, para QUALQUER provedor. Isso explica a recusa0/10. Não é falha específica de Codex/GPT nem cota demonstrada. Os testes anteriores de apply direto não atravessavam essa normalização.

## Implementação
1. Corrigir o schema global para distinguir ausência de lista de lista vazia explícita, inclusive patches esparsos de providers e propósito replay-safe auxiliar. Preservar opt-outs explícitos, validação de campos desconhecidos, limites e demais defaults.
2. Regressões pelo schema realmente aplicado e pelo carregamento Cordis/plugin, com provider genérico: SERVER e TRANSPORT recebem warning e nova preparação; configuração vazia preserva sete códigos e dois propósitos seguros; [] explícito continua desabilitando, providers esparsos não recebem campos artificiais.
3. Publicar somente novo controller imutável v5; manter owner v6 e protocolos/history/accounting inalterados. Não editar bundles históricos v4/v6 nem evidências fechadas da task112.
4. Atualizar builder, manifest, migração/inventário/instalação e documentação/testes necessários para alvo5/6, preservando dados e alterações concorrentes de outras tarefas.

## Validação e publicação
Executar testes relevantes completos e acceptance offline com SDK/caller real e HTTP simulado (sem chamadas pagas), incluindo configuração normalizada pelo schema. Qualificar os cinco perfis em DSH_HOME isolado comparando modelos/permissões/compaction e configurações não relacionadas com os bytes ATUAIS. Fazer backups privados e trocar apenas a URI do controller4 para5, um arquivo por operação, com hashes/modos e proteção contra drift. Verificar os arquivos publicados e a configuração normalizada. Rollback funcional preserva controller4/owner6 sem apagar a proveniência.

## Restrições
Sem outro Continue, reinício de processos, alteração de backend/modelos/sampling/SDK, replay de ferramentas, reset de orçamento, aumento de limite ou bypass de auth/cancel/permanente. Não inferir atualização de namespace já importado sem evidência. Sem commit indiscriminado.