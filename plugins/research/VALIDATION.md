# Research — validação

## Correção: HN com JSON truncado (plano123)

- Causa reproduzida: `/api/v1/items/35154527` do Algolia devolve árvore completa; transporte HTTP nativo corta em100000 caracteres antes da seleção local de comentários. O parser corretamente recusava JSON incompleto, restando apenas título/snippet.
- Correção: Algolia com campos mínimos só para busca; post e comentários lidos individualmente pela API oficial Firebase. Tentativas limitadas por maxComments, lotes2, limite deworkers compartilhado; sem aumentar maxBodyChars nem analisar JSON cortado.
- Smoke real em https://news.ycombinator.com/item?id=35154527: HN informou2507descendants. Post+4comentários recuperados (5JSONs Firebase), maior JSON individual2444caracteres. Comparação antiga: truncated:true,100000caracteres. O artigo externo retornou403, registrado como parcial sem perder a conversa.
- Evidência: `.dumps/hackernews-incremental-smoke.json` e pesquisa `r-7-hn-incremental-large-topic-regression-7c0c57d525ec`; comentários completos selecionados estão no acervo, não no relatório compacto. Quatro comentários não equivalem à thread inteira.
- **105/105 testes passaram**, incluindo11 testes novos deHN: `.dumps/hackernews-fix-tests.log`. Testes incluem nó truncado, árvore grande, orçamento0, relações de pais, ciclos/IDs, removidos, cancelamento, artigo bloqueado e concorrência.
- Smoke opt-in (rede pública, não rodado pela suíte offline): `node plugins/research/hackernews-live-check.mjs`. Mantém100000 caracteres por resposta e no máximo4comentários; cria pesquisa/relatório em `.dumps`.
- Reabrir o processo DSH para carregar o conector novo. A atualização não altera credenciais, perfis ou limites globais deHTTP.

## Atualização: Reddit oficial e concorrência (plano118)

- Conector OAuth read-only: busca/subreddit/thread, comentários encadeados, expansão serial e cursores. Sem token/UA válidos retorna AUTH_REQUIRED, sem fallback silencioso.
- Token disponível no processo de teste: **não** (`credentialStatus:missing`). Não foi feita validação autenticada real nem habilitado refresh/login/contratação. Testes de API usam fixtures.
- Tool permite pesquisas concorrentes, com scheduler compartilhado por backend no mesmo processo: até2 workers (owner pode reduzir a1), morechildren1, fila limitada, cooldown de quota e cancelamento sem liberação prematura de slots.
- Leitura de comentário ausente tenta expansão; respostas com novos marcadores more podem progredir; árvore processada e texto são limitados, mantendo pendências/cobertura.
- Cursor compacto mostra10 IDs; inspect section:navigation recupera todos os IDs persistidos (até200), com paginação e limite de contexto.
- **94/94 testes passaram**, zero falhas: `.dumps/research-reddit-tests-final.log`. Inclui Reddit, scheduler, integração concorrente com acervo real em fixtures Git, registro nativo, ativação e regressão Companion.
- `research-activation --check`: changes:[] nos cinco perfis; nenhum restart forçado. Reabrir processo para carregar código/ambiente novos.
- Limite deworkers não é distribuído entre processos DSH independentes; configurar um backend/processo central ou limitar trabalhadores enquanto não houver coordenação distribuída.
- Configuração, exemplos e limitações em [REDDIT.md](REDDIT.md).

## Histórico da primeira entrega

As seções abaixo registram a versão anterior (quando Reddit ainda usava índice web); não descrevem o conector oficial atual.

## Código e integração

- Tool pública `research`: config/search/inspect/continue.
- Configuração dentro dos tetos do proprietário; permissões de filesystem verificadas antes de abrir armazenamento.
- Busca e leituras paralelas, erros por fonte, snippets preservados quando a leitura falha.
- Evidências locais e recuperação seletiva; inspeção limitada a 16 KB, comentários fora do índice padrão.
- Continuação com orçamento cumulativo e lock de pesquisa; leitura que falhou pode ser tentada em nova rodada.
- HN com árvore de comentários limitada e contagem de nós; grep.app com filtros; Context7 com identidade/proveniência explícitas.

## Testes automatizados

Comando:

```sh
node --test plugins/research/*.test.mjs tools/research-activation.test.mjs tools/session-companion/profile.test.mjs
```

57 testes passaram na verificação final, com zero falhas; evidência em `.dumps/research-tests-final.log`. Testes usam fixtures/mocks, exceto integração de registro que usa módulos DSH reais sem rede. Teste de política read-only nega a abertura de acervo sem elevar permissões.

## Testes reais de rede

Acervos locais (não versionados):

- `r-1-research-public-connector-smoke-a370bfbc5125`: HN preservado; grep.app retornou erro de serviço; Context7 informou mudança de ID. Falhas não apagaram outra fonte.
- `r-2-research-public-connector-smoke-edfa3ae151e3`: HN, grep.app e Context7 retornaram e foram persistidos/inspecionados. Backend web deliberadamente indisponível neste runner isolado para testar falha parcial.
- `r-3-smoke-conversacional-gemini-4-2ef25445a9c6`: chamada da tool real por GPT-6 Luna low; três buscas web/index expiraram com limite reduzido de15s; HN retornou zero resultados. Nenhuma evidência inventada.
- `r-4-smoke-web-real-deadline-9c51e8824eae`: tool real por Luna low; backend web encontrou fonte mas leitura foi recusada por redirect cross-origin; HN trouxe discussão especulativa. Duas evidências persistidas, incluindo snippet da leitura falhada. Não comprova anúncio do produto.

Amostras por Luna low confirmaram texto do artigo HN contra página pública e comentários com respostas encadeadas. Revisão encontrou homônimo Flutter em grep e ambiguidade de identidade de documentação React: filtros de código e metadados de biblioteca foram adicionados. Comentários HN são HTML explícito, não texto normalizado garantido; artigo e comentários são recuperados separadamente.

## Ativação

Migrador seletivo aplicado em web, headless, tui, dsh-tui e companion. 14 arquivos de configuração/derivados alterados. `web_search` desativada nos escopos em que existia; `web_fetch` e backend web preservados. Minimal/Companion não ganharam `web_fetch` implicitamente.

Recibo local reversível:

`.dumps/research-activation/3ab8d72f-20d4-407e-a761-01cb5bf3b262/receipt.json`

`node tools/research-activation.mjs --check` após aplicação retornou `changes: []` em todos os cinco perfis.

Não foram reiniciados servidores/perfis ativos à força. O teste conversacional comprovou que um runtime já aberto ainda mantinha o limite anterior de25s, embora o código novo permita60s por operação web e180s cumulativos. **Reabrir o DSH/perfil para carregar integralmente a versão final.** Configuração em todos os perfis não significa smoke de rede independente em cada um; backends existentes podem diferir.

## Limitações deliberadas

- Reddit/X: descoberta pelo índice web e leitura HTTP pública. Sem API autenticada, coleta completa de respostas ou contratação de acesso ao X.
- MCP/Google são serviços externos mesmo com modelo principal local.
- Erros de quota, bloqueio, biblioteca ambígua e redirecionamentos recusados são relatados; não são burlados.
- Sem browser fallback, cursores manuais de comentários, expansão arbitrária de links ou planejador LLM interno nesta versão.
- `.dumps` deve ser ignorada pelo Git e estar no cwd autorizado; sessões read-only são recusadas, inclusive inspect nesta versão.
- Sem coleta de todos os comentários, prova de representatividade, limpeza automática de acervo ou compartilhamento implícito entre sessões.
- Orçamento registra operações lógicas de busca/leitura, não billing remoto preciso. Nenhuma API paga adicional foi habilitada.
