# Reddit oficial: leitura, navegação e concorrência

## Estado

O conector `reddit` agora usa somente a Data API oficial via OAuth. Não faz fallback silencioso ao Google após falta de credenciais,403,429 ou timeout. A fonte `web` continua disponível separadamente para descobrir páginas indexadas.

Implementação/testes não equivalem a acesso aprovado pelo Reddit. No processo de validação local, `credentialStatus` foi `missing`: nenhum teste autenticado real foi realizado. Os testes de API usam fixtures, não posts reais obtidos por OAuth.

## Credenciais e autorização

O proprietário precisa obter acesso permitido pelo Reddit e um access token OAuth com escopo de leitura apropriado (`read`). Consulte o processo vigente diretamente no Reddit; não presumir que criar uma aplicação dispensa aprovação ou permite qualquer uso por agentes.

Fornecer ao processo DSH, por configuração de ambiente protegida:

- `REDDIT_ACCESS_TOKEN`: token OAuth válido, nunca senha da conta.
- `REDDIT_USER_AGENT`: identificador descritivo da aplicação, sem quebras de linha; por exemplo identificação da plataforma, nome, versão e contato conforme orientação do Reddit.

Não colocar tokens em argumentos da tool, `.agents`, Git, `.dumps`, screenshots ou mensagens. Configurar no ambiente do serviço/launcher que realmente executa o perfil, não somente num terminal diferente. Reiniciar/reabrir o processo após alterar o ambiente quando necessário.

Esta versão é **access-token-only**: o proprietário substitui tokens expirados. Não há login interativo, concessão por senha, refresh automático, uso de cookies pessoais ou contratação de acesso. Não usar tokens emitidos para finalidade sem autorização adequada.

API utilizada: GET em `https://oauth.reddit.com`, com redirects recusados e respostas de até2MB. Sem publicar, votar, enviar mensagens ou modificar conta. Autenticação ausente retorna `AUTH_REQUIRED`; bloqueio e quotas preservam resultados das outras fontes.

Documentação oficial:

- https://www.reddit.com/dev/api/
- https://www.reddit.com/dev/api/#GET_api_morechildren
- https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki
- https://redditinc.com/policies/data-api-terms

A Wiki esteve bloqueada neste ambiente e os termos não foram lidos integralmente na investigação anterior. Antes de operar, verificar aprovação, termos, uso por agentes e retenção aplicáveis; não tratar este README como autorização do Reddit.

## Navegação pela mesma tool

Criar configuração Reddit-only permite navegação sem disparar buscas sem sentido em outras fontes:

```json
{"action":"config","config":{"sources":["reddit"],"maxComments":40,"readsPerSource":2}}
```

Os identificadores abaixo são placeholders, não tokens ou pesquisas reais.

### Buscar em subreddit

```json
{"action":"search","config_id":"<id>","query":"local models","reddit":{"mode":"search","subreddit":"LocalLLaMA","sort":"new","time":"week"}}
```

### Listar tópicos recentes

```json
{"action":"search","config_id":"<id>","reddit":{"mode":"subreddit","subreddit":"LocalLLaMA","sort":"new"}}
```

`query` pode ser omitida nos modos `subreddit` e `thread`. Esses modos exigem configuração exclusivamente Reddit. Busca normal aceita Reddit junto de outras fontes.

### Abrir tópico e comentários

```json
{"action":"continue","run_id":"<id>","reddit":{"mode":"thread","postId":"<id-do-post>","sort":"top"}}
```

`postId` aceita ID base36 ou fullname `t3_...`. `commentId` aceita ID ou `t1_...` para focar uma resposta. A ferramenta verifica origem da thread antes de incorporar comentários retornados por expansão.

### Inspecionar e continuar

```json
{"action":"inspect","run_id":"<id>","ref":"<ref>","section":"comments","limit":6000}
```

```json
{"action":"inspect","run_id":"<id>","ref":"<ref>","section":"navigation","limit":6000}
```

O índice mostra até10 IDs pendentes como preview. **Não são os únicos persistidos**: `section:navigation` permite recuperar todos os IDs guardados, paginando por `offset/limit` se necessário. O acervo guarda até200 IDs de continuação por evidência, com indicação quando ainda há mais.

Para listar a próxima página, usar `reddit.after` devolvido pelo listing e repetir modo/subreddit/sort. Para expandir respostas, usar `reddit.mode:thread`, `postId` e `children:[IDs pendentes]`. Não inventar cursores e não tratar índice de array como cursor de API.

A leitura inicial busca comentários e tenta até duas expansões `morechildren`, até100 IDs por chamada e até o orçamento de comentários selecionados. Falha de expansão mantém post e comentários válidos, erros e pendências. Snapshots podem conter comentários removidos/inacessíveis/ausentes; não há garantia de thread completa ou representatividade.

## Concorrência

- `research` aceita chamadas paralelas; pesquisas diferentes não são serializadas globalmente.
- Mesma pesquisa continua protegida por lock e orçamento cumulativo.
- Default: **2 workers por backend**, compartilhados entre sessões/instâncias do plugin **no mesmo processo DSH**.
- Owner pode configurar `providerWorkers: 1` no plugin. Valores diferentes de1ou2 são rejeitados. O agente não pode alterar esse teto pela tool.
- Backend web é uma fila compartilhada por `web` e fallback do X; não vira uma fila independente por rótulo.
- Reddit API: até2 operações; `morechildren`: **1**, inclusive após cancelamento enquanto a requisição real ainda não terminou.
- HTTP: limite por origem; MCPs: limite por provedor.
- Filas limitadas (64 aguardando por chave); cancelamento retira aguardantes. Operação em andamento só libera slot quando realmente termina.
-429 e rate-limit headers ativam cooldown compartilhado; novas tentativas falham com indicação de espera em vez de bombardear o serviço. Outras fontes continuam.
- Deadlines incluem espera na fila. Concorrência não garante ausência de429: quotas também podem limitar volume por minuto/dia.
- A fila é **por processo**, não um semáforo distribuído entre processos/perfis independentes. Duas instâncias DSH distintas podem somar seus limites. Coordenação global entre processos é evolução separada; enquanto isso, preferir um backend/processo central ou ajustar trabalhadores a1.
- Registro de chaves tem limite512 por processo e preserva o menor limite configurado até reinício. Esgotamento retorna erro, não crescimento de memória sem limite.

## Dados e testes

A política de permissões da sessão vale para o armazenamento; `.dumps` deve ser ignorada pelo Git. Conteúdo externo permanece não confiável. Não manter acervo além do permitido pelos termos/autorização aplicáveis; esta versão não tem limpeza automática.

```sh
node --test plugins/research/*.test.mjs
```

As suítes Reddit/scheduler/concurrency cobrem OAuth em headers, hosts fixos, IDs, paginação, encadeamento, expansão parcial, credencial ausente, token não vazado,429/cooldown, cancelamento, limites deworkers, pesquisas simultâneas e recuperação seletiva do acervo. Não substituem validação autenticada real após configuração autorizada.
