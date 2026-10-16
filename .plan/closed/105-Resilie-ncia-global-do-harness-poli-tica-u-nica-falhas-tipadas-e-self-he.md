# Resiliência global do harness, independente de provider

## Objetivo e orientação

Usar o goal ativo como âncora da execução após aprovação. Implementar uma base comum de recuperação para qualquer modelo/provider que passe pelo serviço LLM do DSH, seja adapter nativo ou pi-ai. Providers novos recebem a base sem precisar de entrada numa lista. Particularidades de provider acrescentam normalizações/extensões; não são a fonte da resiliência padrão.

Não é um patch exclusivo para Bonsai, Codex ou Antigravity. Não alterar servidor, contexto128k, sampling, speculative decoding, modelos, credenciais ou permissões. CLIs externos e ferramentas com efeitos não passam a ser repetidos automaticamente.

## Evidências já obtidas

Auditoria em `.dumps/tasks/retry-policy-audit.md`, scripts/testes no mesmo diretório;24 verificações offline passaram. Composição efetiva: Codex/AGY normal9,5s→20min,jitter10%; strata-local default5,0,5s→8s nas cinco esperas. Engine atual chamado antigravity-quota-retry é geral, mas a configuração longa e o bridge estruturado ficaram concentrados em providers específicos.

O MTMD real chegou como PI_AI_ERROR, fora do retry normal. Self-heal fez3 tentativas imediatas; notices descartaram a mensagem e mostraram apenas erro não classificado. Há infraestrutura comum, mas não uma política global efetiva e cobertura diagnóstica uniforme.

## Política inicial proposta

- Uma definição central autoritativa: modo normal,9 retries após a tentativa inicial, backoff5s exponencial, teto20min, jitter10%.
- Códigos comuns: EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, com classificação tipada e precedência de cancelamento/erros permanentes.
- Esse perfil soma41min15s de esperas nominais, não horas garantidas; execução, jitter e Retry-After alteram a duração real. Não elevar silenciosamente para20 retries/4h21min15s. A duração poderá ser alterada num único ponto de configuração depois.
- Exceções esparsas e explícitas, sem copiar a política inteira por provider. Migrar as configurações conhecidas e preservar opt-outs deliberados; políticas nativas já resolvidas não permitem adivinhar a diferença entre omissão e override, portanto documentar a autoridade e a precedência centrais, sem heurística por comparação de valores.
- Respeitar Retry-After validado. Não antecipar mínimos do servidor nem transformar hint acima do limite aceito em tentativa mais cedo.
- Preservar extensão AGY de quota: somente código tipado/opt-in com reset validado, até24h. Quota e transitórios compartilham o mesmo contador finito, como hoje.
- Self-heal: manter3 ciclos por episódio e suas provas de retomada/progresso; adicionar espera nominal5/10/20s com jitter pelo controlador comum. Não renovar orçamento de transporte ao injetar notice.

## Arquitetura

### 1. Um controlador e dois drivers

Criar um plugin global de resiliência, com módulos separados para política, classificação, controlador/agendamento, driver do loop e driver auxiliar. O controlador possui admissão, contadores, cálculo de atraso, cancelamento/dispose e diagnóstico. Self-heal solicita uma recuperação limitada ao mesmo agendador, em vez de criar um terceiro engine.

O novo plugin substitui o fork antigravity-quota-retry; o llm-retry nativo continua desabilitado nessa composição. Não carregar dois engines nem habilitar retries internos do SDK pi-ai. Preservar a recuperação nativa de contexto/imagens como transformação específica, sem duplicar backoff.

Driver principal usa agent/request-error após assistant/attempt durável e antes de qualquer dispatch de ferramenta concluída. Manter turn/step, tentativa nova, contexto durável e projeção/auditoria compatíveis. O driver auxiliar ignora incondicionalmente os objetos marcados pelo isAgentLoopRequest do MESMO módulo host; uma falha principal não paga duas esperas.

### 2. Chamadas auxiliares, incluindo compactação

Cobrir chamadas pelo serviço LLM independentemente de provider. Compactação e outras finalidades explicitamente replay-safe têm buffer privado por tentativa; somente a tentativa vencedora é publicada, uma única vez. Limites iniciais:16MiB e65536chunks por operação; respeitar o AbortSignal/deadline do caller. Ao exceder o limite, falhar de forma explícita sem replay inseguro.

Chamadas auxiliares arbitrárias não podem ser repetidas depois de expor saída/efeitos; recuperar antes de exposição ou exigir um contrato replay-safe explícito. Não prometer replay seguro universal para consumidores desconhecidos.

Não repetir next() do waterfall Cordis: ele consome a cadeia. Usar redispatch novo do serviço LLM, com bypass local desta camada válido durante toda a iteração, para refazer os demais middlewares. PreparedLlmCall.stream é one-shot: cada tentativa precisa de preparação nova. Verificar suporte/contrato de replay de callers prepared; não monkey-patch de registro privado nem promessa de pinagem de geração inexistente na API pública.

Não colocar Promise/backoff em compaction/summary-error, que é síncrono. Não repetir compactRegion/compactNow nem ferramentas já executadas: somente a geração do resumo antes do commit. Provar um único commit.

Eventos llm/retry nativos exigem turno/passo e provider compatível; não inventá-los para compactação manual/idle ou provider auxiliar diferente. Inicialmente, auxiliares usam contadores em memória e diagnóstico seguro externo ao journal obrigatório. Não chamar append(...,{ignorable:true}), pois a API atual ignora esse campo. Não prometer continuação automática de auxiliares após crash/restart. Qualquer extensão necessária de protocolo/persistência fora desses contratos exige revisão específica antes da promoção.

### 3. Preservar falhas tipadas, sem depender de textos

Generalizar o observador portátil de falhas do SDK e o bridge público llm/stream. Uma única assinatura/bridge deve possuir os fatos estruturados, inclusive para Codex; manter somente seu fallback histórico estreito de WebSocket como exceção. Nada de dois observers classificando o mesmo fim de stream.

DTO detached/frozen seleciona provider/API, categoria neutra, mensagem fixa segura, status real, requestId validado e Retry-After validado. Nunca exportar corpo, headers completos, causa/stack, cookies, tokens ou conta. Preservar fatos permanentes/cancelamento acima de categorias transitórias. Não inferir HTTP503 de wording ou HTTP200 de um stream; desconhecidos permanecem desconhecidos. Não tornar PI_AI_ERROR inteiro retryable.

A classificação deve funcionar por API/contrato, não por nome do modelo ou lista de providers. Auditar e instrumentar os catches finais das10 KnownApi instaladas: openai-completions, mistral-conversations, openai-responses, azure-openai-responses, openai-codex-responses, anthropic-messages, bedrock-converse-stream, google-generative-ai, google-vertex e pi-messages. Preservar também fatos SSE antes dos throws que hoje convertem payload tipado em texto, especialmente Responses/Azure. APIs futuras ou customizadas continuam herdando a política global para falhas neutras; publicar matriz de capabilities e não alegar preservação estruturada onde o adapter não a fornece.

SDK helper sem scheduler/ALS. Bridge do harness com contexto por dispatch e next/return/throw, isolamento de chamadas concorrentes e aninhadas, encerramento após finish/abort e rejeição de fatos estrangeiros/tardios. Adapters nativos tipados passam intactos sem DTO correspondente.

Não reconstruir cegamente sources/pi-ai: essa snapshot está atrás do observador instalado. Partir do estado canônico verificado e das receitas mantidas, preservar patches anteriores e produzir candidato/allowlist/hashes próprios. Ferramentas de promoção anteriores são específicas do Codex e não autorizam esta nova mudança.

### 4. Self-heal útil e compatível

Preservar contador durável, reserva antes de admissão, dedupe, suspensão, autorização causal de retomada humana e prova de progresso. Não rearmar ao recarregar configuração, trocar política ou admitir a própria observação. Cancelamento/dispose vencem a espera e impedem nova tentativa.

Diagnóstico seguro e específico: categoria, fase, fatos tipados, tentativas/esperas e orientação revisada pertinente. Não repassar texto bruto arbitrário nem conceder novas permissões. Rota genérica configurada não deve perder informação útil apenas por não ser Codex/AGY.

Compatibilidade: manter action/version/state legados legíveis. Esperas podem ter metadados aditivos no topo de eventos existentes, sem novos campos incompatíveis no state estrito nem novas ações que quebrem leitores anteriores. Provar reopen/rollback em fixture. Não afirmar que notice permite ao modelo corrigir o servidor se nenhuma inferência chega a produzir resposta.

## Validação obrigatória

- Providers artificiais não listados, local OpenAI-compatible, Codex, AGY e adapter nativo herdam a mesma base; precedência/opt-out/extensões explícitos.
- HTTP5xx tipado com texto opaco, transporte, timeout,429 genérico versus quota nomeada;401/403,400/413,policy,contexto,cancel e desconhecidos não viram loops cegos. Fixtures por API e SSE quando aplicável; capabilities verificadas.
- Fixture real do adapter pi-ai + mesmo SDK/observer, resposta HTTP500 com mensagem MTMD, status/hint/id preservados, retry pelo controlador. Não afirmar que o caso real tinha status500 se não houver esse fato capturado.
- Agenda9, jitter/cap, hints, quota24h, esgotamento, persistência do budget principal, nenhuma renovação silenciosa de budget e exatamente uma espera por decisão.
- Self-heal3 com espera, diagnóstico seguro, canários de segredos/instruções, reservas, cancel/dispose, progresso e retomada causal; readers antigos/novos e sessões já existentes.
- Auxiliares: main-bypass, redispatch atravessando todos os middlewares, prepared one-shot, descarte de parcial fracassado, publicação vencedora única, limites, early-return, concorrência, chamadas aninhadas e cancelamento.
- Compactação automática/manual e com provider alternativo: resumo recuperado e commit único, sem alterar limiares/contexto.
- Nenhum client tool executado durante tentativa fracassada/backoff; sucesso executa somente o que o loop nativo admitiu. Não prometer exatamente-uma-vez de efeitos remotos/hosted ou crash após efeito sem receipt.
- Regressões existentes de Codex/AGY/self-heal/compaction e identidade de módulos no processo novo. Testes offline com relógio simulado e rede bloqueada; sem chamadas pagas.

## Integração e promoção segura

Registrar em recipes/manifest compartilhados e provar composição em todos os perfis mantidos compatíveis, incluindo dsh-tui e derivações headless/Companion onde usam o host canônico. Global significa todos os providers no serviço LLM de cada host carregado, não alterar silenciosamente processos antigos/npx incompatíveis. Validar compatibilidade antes de ativar em outro host.

Remover a duplicação conhecida de baselines por provider sem apagar configuração de modelos/OAuth nem as exceções. A promoção não deve sincronizar indiscriminadamente drift de plugins alheios. Preservar as alterações concorrentes existentes no repositório/frontend/manifest.

Candidato isolado, testes, hashes/allowlists e recibo revisado; backups recuperáveis e CAS/preflight dos arquivos exatos. Nada de edições ad hoc em node_modules. Publicação não é multi-file atômica; ter rollback ensaiado e recusar baseline alterado. Não reiniciar TUI, servidor, serviço ou agente em trabalho. Validar em processo novo isolado; informar a necessidade de reabrir a TUI quando o dono estiver ocioso.

## Critérios de conclusão

Código e configuração têm uma fonte global de política e um controlador, sem branches de tempos por modelo; exceções são delimitadas. Matriz de APIs/callers informa cobertura real e limitações. Testes e composição comprovam os contratos acima, artefatos/rollback documentados e aplicação validada sem interromper o trabalho do dono. Encerrar o goal apenas depois de verificar o resultado efetivo autorizado.
