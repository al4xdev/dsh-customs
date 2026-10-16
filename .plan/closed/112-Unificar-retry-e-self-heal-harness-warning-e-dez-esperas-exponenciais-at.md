# Recuperação contextual unificada do harness

## Pedido confirmado
O usuário pediu remover o encadeamento de retry cego que impede o self-heal de comunicar o erro, unificar os mecanismos customizados de recuperação LLM e usar até10 retries adicionais. Confirmou que60min é o intervalo da última tentativa, não o prazo total. A chamada inicial não conta como retry.

Tabela nominal sem jitter: 7031,25;14062,5;28125;56250;112500;225000;450000;900000;1800000;3600000ms. Cada intervalo dobra;9=30min e10=60min. Esperas somadas7192968,75ms (~1h59min53s), além do tempo de execução. Permanecem canceláveis; não há tentativa11.

## Falha atual comprovada
`agent-self-heal/index.mjs` aguarda o downstream antes de admitir observação. O main-driver atual consome os retries técnicos e o sanitizer do self-heal aceita apenas PI_AI_ERROR, EMPTY_RESPONSE e uma forma conhecida de chamada inválida. Assim SERVER passa pelo retry cego, não pela mensagem. Hoje há orçamento9+3 e dois parâmetros de backoff, contrariando a nova intenção.

## Escopo e arquitetura
1. Um algoritmo e uma autoridade de política para os retries LLM customizados. Uma única reserva durável por retry da cadeia do agente; sem multiplicar10 técnicos por10 semânticos. A troca do tipo de erro, a mensagem de warning, um reload ou uma preparação nova não concedem outro orçamento.
2. Um único proprietário de recuperação no fluxo principal. O self-heal contextual novo admite diagnóstico seguro ANTES da próxima preparação e não chama o motor técnico concorrente para executar a mesma recuperação. Manter a projeção/UI nativa de retry se necessária, mas retirar a função de retry cego duplicada. Na exaustão, falha de admissão ou cancelamento, não cair de volta em outro motor; erro terminal deve continuar observável, não ser engolido.
3. Para cada falha elegível, acrescentar aviso identificado literalmente por `harness warning:` com código, status/fatos confiáveis disponíveis, tentativa/limite/espera e orientação para continuar a tarefa autorizada sem repetir ferramentas concluídas. Não copiar corpos HTTP, tokens, cabeçalhos, stacks ou instruções remotas arbitrárias para o prompt. Usar constantes e fatos allowlisted; assinaturas diagnósticas revistas podem selecionar texto fixo. Novo erro após a última tentativa deve produzir término explícito e diagnóstico, não silêncio nem mais um ciclo oculto.
4. A próxima chamada deve ser preparada novamente a partir do contexto atualizado. Ferramentas de uma tentativa fracassada continuam sem despacho; resultados de ferramentas já concluídas são preservados. Uma mensagem não remove imagens retidas e não permite ao modelo raciocinar antes de um prefill bem-sucedido. Não adicionar offload automático, mudança de modelo/backend, restart ou alegação de cura multimodal nesta tarefa.
5. Mesma política/scheduler para auxiliares LLM customizados. Para compaction/títulos e outros fluxos admitidos pelo contrato de replay, o retry precisa de contexto diagnóstico seguro compatível com o pedido original, preservar formato de saída, obter stream novo e descartar tentativas perdedoras. Não fabricar eventos de turno/etapa ou mensagens duráveis de agente para consumidores que não possuem esse contexto. Quando não houver replay/admissão segura, falhar explicitamente em vez de reenviar cegamente.
6. Auditar plugins customizados antigos, inclusive quota AGY e classificadores Codex. Os classificadores não ganham timer próprio. Implementações legadas de retry LLM devem delegar à autoridade compartilhada, ficar explicitamente inativas/depreciadas ou recusar concorrência; não manter fórmulas independentes ativas. Retries de filesystem, RPC, OAuth/login e ferramentas com efeitos próprios não viram automaticamente retries LLM; não repetir geração paga ou ferramenta concluída.

## Políticas e segurança
- Default global10, base7031,25ms, teto3600000ms e jitter0. Overrides/opt-out explícitos já autorizados não devem ser ampliados silenciosamente; qualquer conflito deve aparecer no relatório de migração.
- Falhas técnicas recuperáveis (incluindo SERVER/transport/timeout/rate-limit/empty) passam pela recuperação contextual, assim como erros opacos admitidos de forma finita e a chamada malformada especificamente reconhecida. Cancelamento, credenciais/permissões inválidas, contexto inválido e negações permanentes não recebem bypass genérico.
- Retry-After/reset tipado não pode criar motor adicional ou espera acima do teto60min. Se o mínimo exigido pelo servidor exceder o limite autorizado ou for inválido, suspender com diagnóstico explícito em vez de fingir que esperar menos satisfaz o mínimo.
- Conservar contadores consumidos e tetos já fixados em episódios legados. Se forem necessários marcadores adicionais, usar envelopes compatíveis/auditáveis; não reescrever histórico nem aumentar silenciosamente uma cadeia antiga. Projeções/eventos requeridos precisam continuar legíveis pela ponte nativa instalada. Espelhos de UI não podem ser contados duas vezes.

## Entrega e ativação
Criar artefatos compilados imutáveis com nomes novos para o controller e self-heal (p.ex.controller contextualv2 e self-healv4), manifests e hashes. Preservar os bundlesv2/v3 antigos byte a byte. Nomes novos evitam depender de invalidar o cache ESM em processos abertos; namespace SDK já carregado continua com a limitação documentada. Não alterar o SDK pi-ai publicado na tarefa105 salvo necessidade nova demonstrada e revisada.

Atualizar fonte única da política, schemas/types, ativação/bootstrap, migrador puro dos perfis, builder, receita clean-install e documentação. Após testes e revisão de hashes, preparar candidatos e backups dos perfis web/headless/tui/dsh-tui/companion. Publicar um arquivo por operação com CAS/hash/modo e recibo, sem full-sync de plugins não relacionados. `cordis.yml` é cache derivado conforme a qualificação nativa anterior; observar, não restaurar/reescrever manualmente. Não executar native --dump-config no DSH_HOME real.

## Verificações obrigatórias
- Dez esperas corretas com relógio simulado,9=30min/10=60min; nenhuma11; duração acumulada correta.
- SERVER não é engolido por retries técnicos antes da observação; primeiro retry e seguintes recebem warning seguro na requisição preparada.
- Repetição do mesmo erro, mudança do código, reload, ordem de plugins e troca de controller não renovam créditos; legados consumidos permanecem conservados.
- Abort/dispose durante aviso/espera/preparação para prontamente e não dispara outro motor. Falha/ambiguidade no append não repete admissão automaticamente.
- Exaustão aparece ao usuário e preserva erro/estado terminal; auth/permanent/opt-out sem bypass.
- Tool parcial de tentativa perdedora não é executada; tool vencedora e tools já concluídas não se repetem.
- Compaction/títulos: fresh-stream, contexto diagnóstico, buffering seguro, formatos preservados e nenhuma falsa auditoria de agente.
- Fixtures reais de Cordis/loop/adapter com HTTP em memória e rede bloqueada; nenhuma inferência paga, restart, mudança de backend/modelo ou mutação de sessão de negócio.
- Build imutável/rollback hashes, recipe/bootstrap testes, cinco composições nativas isoladas, modelos/permissões/compaction/config não relacionado preservados; read-only final dos arquivos publicados.

## Conclusão
Usar o goal ativo como guia e só encerrá-lo após implementação, testes e ativação verificada. Relatar exatamente o que foi unificado, o limite finito e eventuais componentes legados deliberadamente excluídos, sem prometer que um backend permanentemente quebrado nunca poderá interromper o trabalho.