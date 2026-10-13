# Task 5 — Browser DSH Page-bound com Playwright estável

## 0. Estado, autorização e leitura deste documento

Esta revisão 4 substitui integralmente a revisão 3, preservando seus contratos, regras, limites e matriz detalhada, com a alteração de backend explicitamente aprovada pelo dono após o spike G3. O dono selecionou via `ask_user_question` a opção **“Playwright estável direto (Recommended)”** depois da reprodução de mutação na página errada pelo MCP upstream. Não é fallback silencioso nem mudança autorizada por um subagente.

O dono autorizou a implementação e, ao final da validação, a ativação em **todos os perfis gerenciados: `dsh-tui`, `headless`, `web` e `tui`**. Também instruiu remover recuperavelmente **somente a skill antiga `playwright`, no final**, **sem criar skill substituta ou qualquer nova skill**. A skill `playwright-mobile-media` e as demais não devem ser removidas. Nesta subetapa editorial apenas o artefato de plano é revisado; a execução permanece coordenada pela sessão pai.

Este documento define arquitetura, contratos públicos, ownership, segurança, módulos e aceitação. Exemplos continuam sendo API proposta até implementação/validação. Evidência do spike alpha não comprova execução no Playwright estável: repetir os gates necessários. Gates explícitos não autorizam improvisar outra arquitetura.

Na execução: reusar o goal pai ativo, atualizá-lo para esta revisão exata após aprovação, registrar todos por fase, reunir evidências e só fechar a task quando critérios de pronto estiverem demonstrados. Alteração relevante de arquitetura/core, ampliação de privilégios ou remoção de requisito retorna ao dono.

## 1. Objetivo e decisões principais

Browser é uma capacidade mantida pelo ambiente DSH, reutilizável entre projetos/modelos. Agentes não devem instalar Playwright, escrever scripts ad hoc ou espalhar perfis, screenshots e vídeos no produto só para navegar.

Decisões aprovadas/propostas dentro do escopo autorizado:

1. **UMA tool nativa `browser`**, com `operation` como caminho hierárquico e `args` validados por operação. Árvore lógica navegável pela própria tool (`help`, `describe`, `capabilities`), sem depender de descoberta provider-specific.
2. Registro da root no perfil/root registry do DSH, **não uma nova contribuição própria em cada Agent**. A root é herdada pelos agentes, para allowlists de filhos poderem realmente excluí-la. Estado e autoridade permanecem por Agent, nunca globais por cwd.
3. Native gateway → cliente MCP **SDK v2 oficial privado** → worker com servidor MCP **SDK v2 oficial e uma root interna** → **Playwright estável `1.64.0` direto**, com Browser/BrowserContext/Page owned. Nenhuma leaf adicional registrada no ToolRuntime/modelo. Outras tools DSH continuam nativas e inalteradas.
4. Todo efeito, observação e captura recebe uma **Page pública concreta vinculada ao owner/session/document**, não currentTab, título, URL ou índice de aba. **ZERO embed de `@playwright/mcp`, ZERO SDK1/InMemory pair, ZERO RCE/templates de código livre, ZERO exports privados** na implementação de produção desta revisão.
5. Screenshots, mobile/touch e vídeo fazem parte da entrega. Extras têm catálogo/availability explícitos; não há promessa de suportar antecipadamente todo pedido possível.
6. Sem `run_code_unsafe`, shell, flags, `_meta`, init scripts ou métodos CDP livres na API inicial. Nenhum fallback inseguro para preencher capability ausente.
7. Browser lazy; `help`/`describe`/status local não lançam browser nem instalam nada. Worker pode existir para uma sessão ativa; sessão de coding sem uso não inicia worker/browser.
8. Instalação reproduzível e artefatos controlados, fora dos arquivos rastreáveis do produto.
9. Observação baseline usa **`Locator.ariaSnapshot()` público em YAML** mais targets/ref registry próprios. Refs só são emitidas quando podem ser vinculadas unicamente por APIs públicas a role/name locator ou ElementHandle na Page/document corretos; nenhuma ref inventada por parser ou dependência de `_snapshotForAI`.
10. Orientação fica na própria tool/help/describe, prompt nativo e README do plugin. **Não criar nova skill**. Remover apenas a antiga `playwright` recuperavelmente como última etapa depois da integração validada/ativada.

Não confundir quantidade de tools com custo total: uma root reduz schemas enviados, mas discovery e respostas também custam tokens. Medir no mesmo fluxo antes de afirmar economia.

## 2. Evidências e correções em relação ao plano anterior

### 2.1 DSH observado

Pacotes resolvidos por realpath da instalação ativa; caminho npx observado **não** vira dependência ou path hardcoded. `dsh-tools` observado: `0.2.0-rc.2`.

- `dsh-tools`: registro nativo, scopes, guards, pre/post-execute, output canônico, modos `native`/`ptc`/`both` e `presentAs` por Agent/scope.
- Restrição filtra contribuições **herdadas**, não as registradas no próprio scope. Portanto registrar browser novamente no filho pode contornar sua allowlist. A root global herdada evita essa falha de composição; operação stateful ainda exige `exec.agent` válido.
- Bridge MCP normal registra as tools descobertas individualmente. Montar Playwright plano e acrescentar uma fachada não esconde leaves nem reduz seu custo. A implementação r4 não monta o Playwright MCP upstream.
- Existe `ToolSchema.deferLoading` e metadata `toolUpdate`, mas pi-ai observado rejeita deferred loading; rotas sem suporte removem a flag e tornam tools imediatas. Não é solução portátil, nem prova de uma API de tree/search nativa.
- PTC expõe `run_code` + SDK gerado de tools. É por Agent inteiro, não solução para esconder somente browser e manter o restante nativo. Não ativar PTC globalmente nesta task.
- JSON Schema do DSH tem subset estrito: `type`, `properties`, `required`, `additionalProperties` booleano, `items`, `enum`, `const`, `oneOf`. Não presumir `pattern`, limites, `$ref` ou `anyOf` no schema wire. `defineTool` valida no body, depois do pre-hook: validação por operação precisa ocorrer também **antes da decisão de policy**.
- Sucesso nativo contém `value`; falha nativa não promete `value`. Não transformar deny/abort em sucesso JSON `{ok:false}` só para uniformizar envelopes.
- APIs públicas de attachments oferecem `saveImages`, `saveImage`, leitura e referências serializáveis; `llm.resolveModelInfo` permite verificar imagem no modelo da rota atual. Render nativo pode emitir `{type:'image', attachment:ref}`. Não copiar helpers privados do bridge MCP.

### 2.2 Versões selecionadas e histórico MCP

| Componente | Decisão / evidência |
| --- | --- |
| **Playwright estável** | **`1.64.0` selecionado pelo dono para backend direto**, com core/browsers/encoder compatíveis; runtime desta combinação ainda precisa ser validado |
| **SDK MCP v2** | client/server/core `2.3.1`, fronteira privada host↔worker; handshake/stdin/stdout/cancelamento ainda precisam prova real |
| `@playwright/mcp` histórico | `0.0.83`, gitHead `f183dad4a52965583e3cc1d59b88cdc279e2e57d`; usado somente no spike rejeitado e referências históricas, não dependência de produção r4 |
| `@playwright/cli` histórico | `0.1.22`, possível benchmark externo de ergonomia, não rota de execução |
| dependência MCP/CLI histórica | `1.64.0-alpha-1790635538000`, core gitHead `e8149b8257d32dcf8f72573ecc43e72439da7080`; não override/pin transitivo da nova implementação |
| SDK MCP v1 histórico | `@modelcontextprotocol/sdk` `1.32.1`; par in-memory testado no spike, **não integrar em produção r4** |

Node efetivo: 20+ para Playwright estável/SDK v2 selecionados. Novo grafo de produção usa o pin estável direto, não override da alpha do wrapper. Scratch histórico mantém pins/lock próprios para reprodução; não adulterar o spike para fingir que ele testou stable.

Achados históricos que seguem úteis para desenho de contratos, não autorização de reutilizar backend rejeitado:

- `createConnection(config, contextGetter)` era export público da versão MCP pesquisada; seu uso está **removido da arquitetura r4**. Não importar `coreBundle`, `BrowserBackend`, `Tab` ou outros internals.
- Supplied context exigia `isolated:false` na implementação alpha; a isolação real vinha de `browser.newContext()` owned/incognito. Na r4 criar diretamente esse contexto público, sem flag/selector do wrapper.
- Screenshot MCP com filename explícito podia não incluir image block. Na r4 produzir buffer/arquivo por Page.screenshot público e projetar deliberadamente via attachment DSH.
- `--output-dir` upstream não controlava todos os filenames. Paths e quotas seguem responsabilidade própria; eviction posterior ao efeito não é hard quota.
- Vídeo MCP era context-wide, não por aba. R4 não usa essa tool; qualquer captura context-wide extra exige implementação própria, scope explícito e artifacts por Page.
- API pública `page.screencast.start({path})` realmente salva vídeo WebM, desde 1.59; `fps` desde 1.64. Stream de frames sem arquivo não é entrega de vídeo; Screencast com arquivo validado é.
- `recordVideo` exige configuração de contexto e fechamento para flush; não simular start/stop recriando contexto silenciosamente.
- Trace MCP produzia live artifacts, não necessariamente ZIP. R4 usa `context.tracing.stop({path})` público para ZIP; nenhum adapter upstream live automático.
- Touchscreen público oferece tap. Swipe não é mouse drag/wheel nem dispatch sintético. Adapter Chromium via CDP fechado precisa comprovar eventos trusted e efeito de scroll/gesto; WebKit/Firefox não herdam essa capability.
- Caps upstream não eram barreira de segurança: core incluía `browser_run_code_unsafe`. R4 não carrega o catálogo upstream; WebMCP/page-provided tools continuam proibidas como fonte de autoridade.

### 2.3 Spike executado, blocker e decisão do dono

Scratch ignorado: `.dumps/tasks/task05-backend-spike/`. Evidências completas em `RESULT.md`, `output/report.json`, `output/selection-race.json`, `probe.mjs`, `selection-race.mjs`, `run-history.json` e artefatos de imagem/vídeo/trace.

No grafo histórico alpha, G2 passou: factory pública, SDK1 matched pair, listTools lazy e um contexto incognito own. G5 passou no fixture local: bytes de screenshots, touch trusted/CDP swipe, vídeo/trace públicos same context; WebM final medido 392×852, 25 fps, 2.28 s, frames inspecionados com count0→1→2 e ZIP CRC válido. Isso é evidência histórica, não conclusão de gates stable/DSH.

**G3 falhou de forma reproduzida:** fechar selected Page depois da aceitação do request e antes do dispatcher upstream, usando callback público Transport.onmessage no teste, fez `browser_click` responder `isError:false` e incrementar o contador de uma **outra Page sobrevivente**. `selectedClosedBeforeDispatch:true`, `survivorCount:1`, `unexpectedOtherPageEffect:true`; assertion esperado0 falhou. As páginas tinham URL/título iguais; testes sequenciais com popup/close/reindex haviam passado e eram insuficientes. Locks de chamadas não bloqueiam eventos de lifecycle e o currentTab upstream não fornece vínculo público ao Page esperado.

O dono foi consultado depois dessa evidência e aprovou **“Playwright estável direto (Recommended)”**. Preservar r3 e scratch como histórico; a r4 elimina o currentTab/SDK1/embed, não reclassifica a falha como pass e não executa outra arquitetura silenciosamente.

## 3. Desenho de componentes e fronteiras

```text
Modelo / Agent (native; PTC apenas se já selecionado pelo dono)
  |
  | UMA browser {operation, path?, sessionId?, pageId?, args, catalogRevision?}
  v
ToolRuntime DSH — root herdada, filtro por Agent, log/callId e cancelamento
  |
  +-> pre-execute / guard browser
  |     bounds -> manifest -> schema leaf -> efeitos -> policy/ask/deny
  |
  v
Native Gateway
  +-> meta-ops locais: help / describe / capabilities
  +-> broker por exec.agent: owner, generation, quota, lifecycle
  +-> host FS/policy: staging de uploads e export de artefatos
  +-> projeção nativa: texto + attachment refs + erro nativo
  |
  | cliente SDK MCP v2 oficial privado, stdio, sem shell/servidor público
  v
Worker owned do Agent — servidor SDK v2, API interna de uma root
  +-> handshake versões / manifestHash / owner
  +-> revalidação + fila/locks + target registry + artifact/capture manager
  |
  +-> Playwright ESTÁVEL 1.64.0, imports/APIs públicos diretos
         Browser owned -> BrowserContext incognito owned -> Page registry próprio
         cada request resolve UMA Page concreta; nenhum currentTab upstream
         observação -> Locator.ariaSnapshot YAML + refs/targets próprios
         interação -> Locator/ElementHandle vinculados Page/document
         screenshot -> buffer/arquivo guardado
         touch -> tap / CDP Chromium de comandos fechados
         vídeo -> Screencast page-scoped
         trace -> tracing ZIP context-scoped
```

Fronteiras:

- Serviços DSH/tools/cordis/scope/attachments resolvidos no grafo do host. Não carregar segunda cópia dos peers que identifiquem scopes.
- Dependências de Playwright estável, validadores e SDK v2 do worker pertencem ao checkout/pacote worker pinado. Nada emprestado de cache privado DSH/Claude.
- SDK v2 client/server/core da fronteira usam versões compatíveis. Apenas dados JSON/protocolo cruzam host↔worker; sem SDK1/InMemory/createConnection ou objetos Page transportados ao host/modelo.
- O worker vê scratch gerenciado e cópias staged, não recebe root do produto como cwd/default roots.
- O modelo não escolhe owner, grants, `_meta`, cwd, scripts, flags, executablePath ou transport.
- Uma instância Browser por worker; contextos isolados por session. Nenhum compartilhamento entre Agents. Inicialmente até duas sessions por Agent, sujeitas a limites globais; otimizar pooling entre Agents está fora de escopo.
- Funções fixas de probe/readiness/geometry são código confiado do adapter usando APIs públicas, não scripts da LLM, templates RCE ou strings de expressão Playwright.

### Escolhas alternativas controladas

A troca de backend foi **decidida pelo dono**; não há seleção dinâmica entre MCP/CLI/stable. Se stable Page-bound, SDK2 stdio ou observação pública não satisfizer um gate, parar e registrar a causa/voltar ao dono. Não reinstalar SDK1/MCP, usar API privada ou iniciar segundo motor como workaround.

Fachada MCP pública + bridge nativo não é fallback automático; qualquer mudança da root nativa/global e das restrições herdadas exige nova decisão. CLI oficial pode ser baseline de comparação de tokens/ergonomia, não rota de execução nem licença para instalar skills. PTC/deferred loading são otimizações opcionais comprovadas, não mudanças da arquitetura default.

## 4. API pública: uma tool, não um schema-monstro

### 4.1 Envelope wire mínimo

```json
{
  "operation": "media.screenshot",
  "sessionId": "bs_example",
  "pageId": "bp_example",
  "catalogRevision": "bc_example",
  "args": {"mode":"viewport","format":"png","scale":"css"}
}
```

Schema wire conceitual, dentro do subset DSH:

```json
{
  "type":"object",
  "properties":{
    "operation":{"type":"string"},
    "path":{"type":"string"},
    "sessionId":{"type":"string"},
    "pageId":{"type":"string"},
    "catalogRevision":{"type":"string"},
    "args":{"type":"object","additionalProperties":true}
  },
  "required":["operation","args"],
  "additionalProperties":false
}
```

`args` aberto no **wire** não é aberto no executor. Cada operação possui schema/semântica próprios obrigatórios. Não usar enum gigante, union de todas as leaves, aliases silenciosos, campo action redundante ou milhares de parâmetros opcionais.

Regras:

- `operation` exata/case-sensitive; leaf usa caminho dotted curado. Sem pass-through de nome MCP/Playwright desconhecido.
- `path` somente em `help`/`describe`; proibido em execução. IDs são aceitos apenas onde descriptor permite; não ignorar campos indevidos.
- `catalogRevision` é detecção de drift opcional, não token de aprovação. Drift informado retorna `CATALOG_CHANGED` antes do efeito.
- `args` obrigatório, mesmo `{}`; nenhuma operação batch/array no MVP. Uma chamada corresponde a uma decisão auditável.
- Bounds preliminares de bytes/depth/strings/arrays precedem AJV e resolução de paths. Como o host pode logar argumentos antes do hook, isso não garante que input enorme jamais entre no transcript.

### 4.2 Navegação do catálogo

```json
{"operation":"help","args":{}}
{"operation":"help","path":"media","args":{}}
{"operation":"help","path":"media.video","args":{}}
{"operation":"describe","path":"media.video.start","args":{}}
{"operation":"capabilities","args":{}}
```

- Help root: ramos imediatos e resumo curto; sem todos os schemas.
- Help ramo: filhos imediatos, finalidade, availability e efeitos resumidos. Busca textual opcional somente no catálogo curado.
- `describe`: uma leaf, input/output schemas, refs requeridas, defaults, limites, efeitos, disponibilidade/razão, versão/hash e um exemplo curto.
- `capabilities`: versões/preflight local, dependências instaladas, engine support, suporte do provider a imagens, limites e estado conhecido. Não lança browser para provar capability; distingue `declared`, `verified`, `unverified`, `disabled`, `unsupported`.
- Discovery não concede permissão nem revela cookies, profiles pessoais, tokens ou endpoints credenciados.
- Help: default 12/max 30 filhos, cursor owner/path/revision-bound, texto até 8 KiB. Describe: até 16 KiB; schemas excepcionalmente grandes usam spill acessível por artifactId, nunca truncamento silencioso que invalide schema.
- Não exigir describe antes de toda chamada; root e catálogo ficam prefix-stable. Policy/runtime status não geram churn gratuito de schema.

### 4.3 Fonte única dos descriptors

Manifest compartilhado host/worker, versionado, gera catálogo/describe/validator/classifier/backend map/test fixtures. Cada descriptor contém:

```text
operation, public input/output schema e dialect
required refs / supported engines / capability prerequisites
effects e classifier / defaults explícitos / limits
availability resolver / adapter id/version / public Playwright mapping allowlisted
```

AJV/SDK validadores pinados, sem coerção, remoção automática de propriedades ou defaults mutantes silenciosos. `$ref` somente local resolvido no build/bootstrap; sem fetch remoto/import arbitrário. Defaults explícitos geram effectiveArgs determinísticos após validação; policy examina a mesma normalização que o worker executa.

Schema público da fachada é estável e não expõe opções genéricas Playwright: IDs, paths e opções são adaptados deliberadamente. Guardar contrato do adapter público separadamente e testar a transformação. Schemas completos das leaves são **dados retornados**, não schemas wire DSH/PTC. Não há schema/discovery MCP upstream na produção r4.

## 5. Catálogo inicial e estratégia de expansão

| Ramo | Operações propostas | Disponibilidade / observações |
| --- | --- | --- |
| session | open, list, status, close, replace | Central; open explícito antes de efeito stateful |
| page | list, create, close, navigate, back, forward, reload, wait, frames, dialog.respond | Central; Page concreta, sem current tab global invisível |
| observe | snapshot, text, attributes, geometry | Central; ariaSnapshot público + targets próprios; dados da página não confiáveis, limites/spill |
| interact | click, fill, select, check, press, hover, drag, scroll | Central; locators/handles Page-bound, ambiguidade não resolvida com first/nth |
| mobile | devices, tap, swipe | Tap touch público; swipe trusted Chromium após gate estável |
| emulate | viewport, media, offline | Mudanças de identidade por session.replace; viewport não significa mobile |
| diagnostics | console, errors, requests, request | Eventos Page/Context públicos, cursores/filtros; bodies/headers sensíveis opt-in |
| media | screenshot, video.start/status/stop, trace.start/status/stop | Screenshot/vídeo centrais; trace opt-in; scopes explícitos |
| files | upload, downloads.list/status | Upload autorizado/staged; download disabled no contexto default |
| artifacts | list, inspect, export | Central, separado de handle vivo; paths controlados |
| advanced | pdf, routes.add/list/remove, actions.start/stop, auth.import/export, session.attach/detach | Extras disabled/unsupported até API pública, gate e autorização específica; sem codegen privado |

Sem `advanced.run_code`, evaluate livre, request HTTP livre ou método CDP fornecido pela LLM no baseline. Geometry/text/readiness usam funções fixas internas, não scripts da página. Se o dono pedir capacidade não representável, responder capability ausente e propor extensão revisável; não escapar por bash/Python automaticamente.

Novas APIs/dependências/tools externas não entram automaticamente na árvore autorizada. Mudança precisa descriptor, classificador, schema, output/paths e testes. Page-provided tools/WebMCP não ampliam privilégios.

## 6. Output canônico, multimodal e falhas

### 6.1 Sucesso

```json
{
  "apiVersion":"1",
  "operation":"media.screenshot",
  "callId":"host-owned",
  "catalogRevision":"bc_example",
  "status":"completed",
  "refs":{"sessionId":"bs_example","pageId":"bp_example","generation":1},
  "data":{"mode":"viewport","coordinateSpace":"css-viewport"},
  "artifacts":[{"artifactId":"ba_example","mime":"image/png","bytes":12345,"width":393,"height":852,"state":"finalized","path":"managed-existing-path"}],
  "effects":[{"kind":"write-managed-artifact","state":"applied"}],
  "warnings":[],
  "imageRefs":[]
}
```

Valores acima ilustrativos. Root output usa subset DSH; `data` específico é validado por leaf no worker/host antes da projeção. IDs/callId vêm do host/broker, não do modelo. Schema interno de erro/sucesso no protocolo worker não altera o contrato de falha nativo DSH.

- `completed`: efeito esperado concluído e artefatos finalizados conforme verificação.
- `partial`: efeito realmente parcial, com fatos, artefatos parciais e recuperação; nunca denial mascarada ou vídeo incompleto chamado pronto.
- `effects` registra `none`/`applied`/`partial`/`unknown`; unknown não autoriza replay.
- Resposta normal resumida/bounded; não anexar snapshot completo automaticamente depois de toda interação.

### 6.2 Screenshot visível ao modelo

- Worker retorna bytes/image content e metadata verificáveis, separados do artifact original.
- Host verifica rota atual `session.requestHeader`/modelo, não rota congelada na criação. Exigir `inputModalities` com image e AttachmentStore público.
- Usar APIs públicas `attachments.saveImages` e output.render com image attachment refs. Não guardar base64 de imagem no canonical value/transcript; referências serializáveis e metadata bastam.
- Artifact original e attachment normalizado são distintos. Normalização pode reduzir pixels; preservar originalDimensions e informar coordenadas CSS versus image pixels.
- Ausência de store/modelo image-capable: artifact continua disponível e resposta informa `imageUnavailable`; não fabricar image block nem dizer que a LLM viu a imagem.
- Verificar cancelamento antes e depois de save; API pública observada não aceita signal para hard-abort do commit. Não prometer cancelamento atômico; aguardar quiescência e tratar attachment/arquivo criado como efeito conhecido.
- Vídeo/trace são entregas de arquivo, não image blocks mágicos. Inspeção de vídeo usa metadata + frames, e não equivale a modelo assistindo vídeo/áudio.

### 6.3 Falhas e recuperação

Usar erro nativo/HarnessError da instalação host, mantendo código durável e mensagem sanitizada. Worker envelope de erro é convertido pelo gateway; não afirmar que native failures contém canonical `value`. Deny/ask indisponível/timeout/abort nativos permanecem autoritativos (`ABORTED_BEFORE_DISPATCH`, `ABORTED`, `TOOL_TIMEOUT` etc.).

Códigos de domínio mínimos: `INVALID_ENVELOPE`, `UNKNOWN_OPERATION`, `INVALID_ARGS`, `UNSUPPORTED_CAPABILITY`, `CATALOG_CHANGED`, `SESSION_NOT_FOUND`, `PAGE_NOT_FOUND`, `STALE_HANDLE`, `STALE_SNAPSHOT`, `AMBIGUOUS_TARGET`, `INVALID_STATE`, `LIMIT_EXCEEDED`, `ARTIFACT_PATH_DENIED`, `BACKEND_UNAVAILABLE`, `BACKEND_ERROR`.

Diagnostic interno seguro: operation/callId, fields bounded, effectState, retryable e recovery proposta. Mensagem ao modelo inclui apenas fatos/recuperação sem tokens/headers/stack bruto. Foreign IDs respondem not-found sem revelar vizinhos. Não transformar authorization violation em sucesso com status:error. Partial success é permitido somente com resultado parcial conhecido; falha desconhecida é erro com orientação para observar antes de repetir.

Não prometer entrega universal de JSON de erro após políticas de terceiros. Validar observabilidade nativa/PTC/replay durante gate.

## 7. Pipeline, policy e handshake

```text
1. ToolRuntime resolve root visível ao Agent (allowlist/guard nativo)
2. Pre-hook valida bounds e envelope; lookup exato no manifest
3. AJV leaf + refs + revisão + effectiveArgs; classificar efeitos reais
4. Policy administrativa + policy efetiva da sessão + ask quando exigido
5. Body revalida, resolve owner e adquire fila/lock de contexto
6. Rechecar state/generation/policy epoch/quotas e capturar Page bound antes do efeito
7. Worker SDK2 handshake validado; revalidar request/manifest/refs/limites
8. Adapter público executa UMA operação na Page/Context concreta, com deadline/cancelamento
9. Validar/mapear output, registrar artefatos, projetar imagem/erro
10. ToolRuntime registra outcome canônico e fatos auditáveis
```

- A root autorizada não autoriza todas as leaves. Classificador usa operation+args normalizados e efeitos, não annotations readOnly de terceiros.
- Pre-hook e body usam a mesma fonte de schema; worker repete validação e limites. Operação sem classificador, desconhecida ou com manifest mismatch é negada antes do efeito.
- Não emitir pre-execute falso com nome virtual, chamar browser recursivamente ou inventar leaf logs nativos. SDK2 privado é I/O do body, não subdispatch ToolRuntime.
- Hashes de manifest/schema/adapters e policy epoch relevantes são verificados host↔worker. Não incluir segredos em hashes expostos, nem permitir `approved:true`/owner `_meta` no input público.
- API MCP interna do worker transporta request público normalizado + contexto de execução **injetado pelo host**: owner opaco, generation, manifestHash, callId/rootCallId, deadline e policy snapshot permitida. Nenhuma dessas autoridades é um campo repassável pelo modelo.
- Process/stdin owned, sem HTTP listener/CDP exposto. O worker confia no canal privado host, não em payload de página. Processo separado por si só não é contenção contra código com mesmo usuário e acesso shell irrestrito.
- Se policy muda enquanto aguarda lock, revalidar; grant once não vira standing grant. Store de owner não pode ser escolhido por IDs/cwd do modelo.
- `isConcurrencySafe`: false para stateful no início; true somente meta-ops locais comprovadamente puras. Locks protegem chamadas/cleanup, mas não impedem eventos de fechamento/navegação: Page concreta é o vínculo de efeito, não mutex/current tab.
- Depois de resolver Page, não consultar de novo “primeira/current/vizinha” após await. Se ela fechar/crash/navegar invalidando document/ref, falhar com estado conhecido/unknown, sem retarget/retry em outro Page.

## 8. Classes de efeitos e políticas reais do host

| Classe | Exemplos | Tratamento |
| --- | --- | --- |
| discovery/status | help, describe, capabilities local | Sem browser/instalação/efeitos externos |
| observe-page | snapshot/text/geometry | Conteúdo não confiável; pode ler dados sensíveis de página autorizada |
| navigate-network | navigate/reload/open URL | Rede/redirects/localhost; não prometer GET sem efeitos |
| mutate-page | click/fill/select/press/touch | Pode enviar/excluir/publicar; autorização de workflow sensível continua necessária |
| capture-managed | screenshot/video/trace | Grava disco, quotas e retenção; não é read-only só por annotation de terceiros |
| upload/download/export | files/artifacts | FS host, staging, destino e dados específicos autorizados |
| auth/profile/attach | auth.import/export, Chrome pessoal | Opt-in separado, desligado por padrão |
| unsafe code | run_code/eval/CDP livre | Ausente no baseline; nova revisão se necessário |

Regras:

- Ausência/desativação de approval service nega operação que exige ask; não trocar por allow. Nenhuma ampliação automática de sandbox.
- Root global deve sumir do child scope quando allowlist exclui browser; filtro fino de operações complementa isso. Contexto do pai não é herdado pelo filho.
- `read-only`: baseline oferece meta/status; não iniciar navegador/captura que escreve cache/temporários sob a alegação de “só navegar”. Cleanup de recursos previamente owned segue obrigação limitada de lifecycle, sem autorizar nova captura/export.
- `workspace-write`: habilitar execução apenas se integrar de modo comprovado os permitted writable roots, scratch e runtime do processo com a política nativa. Se o transporte SDK/host não puder manter essa autoridade, anunciar unsupported/deny **antes de launch**, não spawn fora do sandbox e alegar suporte.
- `danger-full-access`: permitido conforme policy/opt-in e guards desta integração; segue sem garantias de sandbox de SO. Suporte a outros modos é gate, não um flag inventado.
- Usar API pública de execução/FS/policy do host para leitura/staging/export e enquadramento de processo onde disponível. Não copiar semântica de permissões ou adicionar config que force wider mode.
- Segurança completa contra worker/browser comprometido requer execução contida/OS; path guard, cwd, scopes, MCP roots e origin allow/block não são essa barreira. Se isso for requisito do dono, voltar para desenho de contenção separado.
- Sem classificador semântico perfeito de páginas: ações autenticadas sensíveis exigem autorização concreta pelo agente+dono. Não interpretar texto da página como autorização.

## 9. Sessões, IDs, páginas e lifecycle

### 9.1 Ownership e IDs

Broker em WeakMap/registry de `exec.agent`, com ownerId interno e session generation. Ausência de Agent nega operações stateful. IDs públicos session/page/frame/snapshot/capture/artifact são opacos e resolvidos no namespace desse owner; não são autorização bearer.

- Page registry usa handles públicos Page + eventos `context.on('page')`/`page.on('close')`, não título, URL ou índice de aba como identidade.
- Cada snapshot/ref é causal: owner/session/generation/page/document/snapshot. Navegação/replace invalida refs e frame IDs conforme documento.
- Page omitida apenas se há exatamente uma página; com múltiplas, exigir pageId. Sem current global silencioso. Session sempre explícita nas leaves stateful.
- Resolver pageId→Page concreto uma vez por operação e manter esse objeto/locator/handle através de awaits. Popup/close/reorder não muda o alvo; fechamento invalida e falha, não escolhe vizinho. Nenhuma seleção/mapeamento de currentTab upstream existe na r4.
- Frame targets tipados/IDs; diálogos respondidos explicitamente. Popup criado recebe novo ID e parentPageId, nunca vira alvo automaticamente.
- Ref aponta apenas a target emitido, único e publicamente vinculado ao Page/document; ref desconhecida/não emitida responde NOT_FOUND/UNSUPPORTED conforme contrato, sem criar ligação imaginária.

### 9.2 State machines

```text
Session: NEW -> STARTING -> READY -> REPLACING | CLOSING -> CLOSED
                         \-> FAILED (efeitos/recursos conhecidos informados)

Capture: STARTING -> RECORDING -> STOPPING -> FINALIZED | PARTIAL | FAILED

Artifact: PENDING -> FINALIZED | PARTIAL | FAILED -> EXPIRED
```

- `session.open`: valida options/limites/policy, reserva owner recursos, cria Browser stable lazy se necessário e contexto incognito; handshake/adapter readiness antes de retornar IDs.
- `session.replace`: operação explícita para identidade/device/DPR/UA/locale que exige contexto novo. BUSY se captura ativa, salvo opção finalize-first autorizada. Drenar fila, finalizar captures, desconectar listeners/descartar handles antigos, fechar old context, criar novo contexto no browser owned, nova geração e IDs. Informar perda de DOM/abas e quais cookies/storage foram ou não restaurados.
- `session.close`: scoped; fecha resources próprios, não browser pessoal ou todos browsers da máquina. Artefatos finalizados sobrevivem segundo retenção.
- Compaction/resume/clear com novo Agent: baseline fecha/desassocia recursos do Agent anterior e reporta handles stale/state lost. Não fingir que replay restaura browser vivo ou que storageState restaura DOM. Persistência de daemon entre Agents é fora do MVP.
- Fork/spawn: owner/context novo; conversa seed não copia conexão/auth/live handles.
- Idle/unload/crash: impede novos effects, cancela fila, finaliza mídia bounded, fecha context/browser/SDK2/client/worker owned, aguarda quiescência. Timeout não abandona promises/processos indefinidamente.
- Falha após mutação não faz rollback nem retry automático. Reconexão restabelece transporte/status; não reexecuta submissão/click/download.
- Graceful teardown tem prazo; hard-stop apenas processos próprios com identidade verificada. Worker perdido pode deixar arquivo partial; não chamá-lo finalized.

## 10. Alvos, prontidão e interação

Target leaf tipado, validado localmente por AJV:

```text
{kind:'ref', snapshotId, ref}
{kind:'role', role, name, exact?}
{kind:'testId', value}
{kind:'css', value}       # escape-hatch bounded, opt-in/configurado
```

Sem string de expressão Playwright/JS. Match count diferente de 1 gera AMBIGUOUS_TARGET/NOT_FOUND; não usar first/nth automaticamente. Refs somente de snapshot emitido para a mesma Page/document geração.

### 10.1 Observação pública e registry de refs

Baseline `observe.snapshot`: `Page`/`Frame` owned → Locator público apropriado → **`Locator.ariaSnapshot()` YAML**. Snapshot é dado não confiável, delimitado por alvo/profundidade/bytes; resultado contém snapshotId, Page/document/generation, formato e refs realmente emitidas. Não chamar `_snapshotForAI`, importar helpers privados ou reaproveitar refs eN de MCP.

Parser YAML serve apenas para interpretar dados/apresentação; não executa expressões, não gera locator JS, não elege `nth` ou assume vínculo por ordem da árvore. Candidatos role/name são aceitos somente quando um **locator público Page-bound resolve exatamente um elemento**, com schema/role/name limitados e verificações de owner/document. Ref pode registrar esse locator explicitamente vinculado e/ou ElementHandle público capturado; para identidade de node, preferir handle e invalidar se detach/document mudou. Uma ref não pode retarget silenciosamente um novo nó equivalente após drift.

Se ariaSnapshot não fornece vínculo suficiente, emitir observação sem ref para esse nó e orientar target público role/name/testId; chamadas de ref ausente/não emitida dão NOT_FOUND/UNSUPPORTED. Não inventar IDs/handles para aparentar paridade com MCP. Ambiguidade, detached node e snapshot stale falham antes de efeito; nenhuma resolução “primeiro que combina”.

Text/attributes/geometry usam Locator/ElementHandle/APIs públicas e funções fixas de probes; console/errors/requests usam eventos públicos Page/Context e registros bounded. Probes não aceitam código da LLM. Navegação, frame detach e Page close invalidam document/frame/ref registry.

### 10.2 Gestos e readiness

Tap aceita target ou point CSS, exatamente um. Swipe aceita pontos CSS explícitos e duração/steps bounded. Coordinates são relativas ao viewport do main frame; iframe/offset precisa conversão conhecida, não chute a partir de screenshot normalizada.

Wait/readiness é explícito: elemento/texto/estado, fonts/images quando solicitado, deadline. `networkidle` não é garantia universal de app pronta; não depender de sleeps indefinidos. Captura retorna condições verificadas/timeout. Não esconder banners/dados ou alterar UI por padrão; masks/estado demo precisam seleção explícita.

## 11. Desktop, mobile e emulação

`session.open.args` aceita subset curado: engine/headless e emulation via preset **ou** custom completo. Não aceitar launchOptions/contextOptions genéricos, executablePath/proxy/ignoreHTTPS/noSandbox do modelo.

- Desktop default: Chromium headless, viewport 1280×720, sem touch/mobile.
- Mobile canônico para custom: 393×852, DPR 2, isMobile/hasTouch verdadeiros e UA/preset efetivo explícito. Preferir devices oficiais; preset name é validado na versão estável pinada, não inventado.
- Merge device + overrides documentado; retornar engine, viewport, screen, DPR, hasTouch, isMobile, UA, orientação, locale/timezone/media reais.
- `emulate.viewport` altera viewport, não UA/DPR/touch/mobile. Troca de identidade por `session.replace`.
- `emulate.media`/offline podem operar no contexto/page existente quando API suporta. Geolocation/permissões extras são capabilities opt-in, não grant default.
- `mobile.tap`: Playwright touchscreen público com hasTouch; não alias de mouse click.
- `mobile.swipe`: adapter Chromium público `context.newCDPSession(page)` usando somente Input.dispatchTouchEvent com lista fechada de tipos, pointer id, steps e finally end/cancel. Capability só vira verified após fixture na **stable** provar touch/pointer isTrusted e scroll/gesto esperado. WebKit/Firefox unsupported para esse adapter; nunca fallback sintético/mouse oculto.
- Emulação não comprova Android/iOS físico, barra de sistema, teclado nativo, permissions picker ou app shell. Acesso físico/ADB é outra capacidade.

## 12. Screenshots

Input público proposto:

```text
mode: viewport | fullPage | element
format: png | jpeg | webp
scale: css | device
 target obrigatório só no modo element
clip? / maskTargets? / readiness? apenas nas combinações declaradas
```

Sem filename/path livre. FullPage+element/clip incompatíveis; conflito é erro de schema/semântica, não preferência implícita.

Adapter público **`Page.screenshot` na Page owned** produz buffer/arquivo gerenciado + imagem. Não usar tool MCP upstream/filename/image inline na produção r4. Host realiza admissão/projeção explícita como definido na seção 6.

- Validar dimensão/DPR/pixel budget antes, tamanho após e condições de readiness.
- FullPage enorme não é cortada silenciosamente; negar com sugestão de viewport/element/clip.
- Metadata: CSS viewport, pixels do original, scale, formato, página/generation, capture time e artifactId. Attachment normalizado informa suas próprias dimensões.
- Máscara é opt-in por targets autorizados; não garantia de redaction universal.
- Testar layout/composição lendo a imagem real, não apenas screenshot path.

## 13. Vídeo, trace e gravação de ações

### 13.1 Vídeo baseline page-scoped

Adapter público Screencast com path owned na Page concreta; start/stop não recriam contexto. Esse é o baseline. Captura context-wide extra é implementação própria/opcional, **explicitamente distinta**, não MCP reutilizado.

```text
media.video.start args:
  scope:'page', size? {width,height}, fps?, cursorPreset?, maxDurationMs?
  retorna captureId, scope, pageId, generation, state, limites efetivos
media.video.status/stop args:
  captureId
```

- Size é max bounds/aspect ratio quando API assim define; retornar dimensão efetiva medida, não prometer exatos 1280×720. Spike alpha mostrou canvas padding e arredondamento de width ímpar; repetir stable e verificar frames antes de declarar mídia útil.
- Reservar ID/path/quota antes de iniciar. Start duplicado no mesmo recorder => INVALID_STATE; stop do mesmo captureId pode retornar resultado já finalizado, sem reexecutar efeitos.
- Auto-stop por duração, quota/idle/close segue state machine; não manter recorder indefinidamente após cancelamento.
- Stop aguarda flush, stat/metadata/container/duração/dimensões e frames representativos. Se encoder/browser morreu, retornar partial/failure factual.
- Page fechada/crash ainda precisa finalização/path verificado. Sem áudio/câmera/desktop recording no baseline.
- FPS configurável apenas se runtime suporta; Firefox/WebKit podem produzir menos frames. Disponibilidade de encoder FFmpeg gerenciado faz parte do preflight; não instalar sistema automaticamente.
- Cursor/action overlay é preset curado, não HTML/CSS/code livre da LLM; se pacing altera ações, declarar no resultado.
- `recordVideo` é fallback somente como sessão de captura explicitamente criada com opções iniciais e perda de estado informada; nunca recriação silenciosa da sessão existente.

### 13.2 Context-wide opcional Page-bound

Se implementado por adapters públicos diretos, declarar `scope:'context'`, páginas existentes/futuras e `artifacts[]` por pageId. Registrar failures em páginas futuras; path planejado não conta como sucesso. Limitar tabs/bytes e permitir captura apenas das Pages autorizadas do contexto. Não expor isso como uma gravação exclusiva da aba atual. Disabled/unsupported até gate específico; não reintroduzir start_video MCP.

### 13.3 Trace/ações

Trace é opt-in devido a snapshots/network/auth. Baseline ZIP via `context.tracing.start/stop({path})` público, context-scoped. Sources:false por default. Snapshots/screenshots são opções explícitas; redaction não elimina necessariamente segredos.

Trace live é capability diferente de ZIP, com arquivos/recursos múltiplos, não baseline. Não chamar diretório live de trace.zip. Library tracing não registra automaticamente assertions de um test runner. Nenhuma API privada ou trace upstream para preencher gap.

Inicialmente trace+vídeo e recordVideo+Screencast são mutuamente exclusivos no mesmo recorder/context onde houver conflito de configuração. Só liberar combinação após testes de size/ownership/flush; não deixar recorder existente ignorar size silenciosamente.

Gravação de ações/codegen não é vídeo. Extra opt-in, dados sensíveis possíveis, output em artifact e sem commitar teste gerado automaticamente. Se não houver API pública estável compatível, declarar unsupported, não chamar `_startRecording`/internals.

MP4/GIF/trim/otimização são pós-processamento opcional com entradas/saídas limitadas e dependência declarada. Não fazem parte do baseline nem autorizam ffmpeg/shell arbitrário.

## 14. Artefatos, arquivos, paths e retenção

### 14.1 Layout

```text
ambiente gerenciado fora do repo
  installation/cache/browser binaries
  runtime/<owner>/<session>/<generation>/
    observation-output/  downloads/  uploads-staged/  captures/  traces/

projeto, somente se .dumps estiver ignorado e policy permitir
  .dumps/browser/<session>/<capture>/
    evidência local/export deliberado + manifest de artifacts
```

Worker cwd absoluto é scratch private; no host `process.chdir`. Dependendo do modo/policy, scratch precisa estar dentro de writable roots permitidos; path de ambiente não é autorização automática. Se `.dumps` não é ignored, usar runtime permitido e avisar, sem alterar gitignore.

Artifact schema: artifactId, owner interno, kind/MIME/bytes, state, path local existente quando aplicável, page/session generation de origem, dimensões/duração, checksum quando útil, retentionUntil e export/attachment relationships. Não derivar authority de markdown/link da página ou de processo externo.

### 14.2 Todas as rotas de escrita

- Nomes gerados, collision-safe; nenhum modelo fornece filename backend/cwd/_meta/roots.
- Auditar screenshot, vídeo, snapshots, console/rede, tracing, downloads, storage-state e eventos popup. Diretório configurado isolado não substitui controle de todo writer/overwrite.
- Verificar paths absolutos/relativos, `..`, symlinks, ancestors e colisões antes de abrir/publicar. Não sobrescrever arquivos do dono silenciosamente. Guards com paths não prometem TOCTOU race-free contra escritor hostil.
- Private dirs/permissões, criação exclusiva e publicação atômica quando suportadas. Arquivos incompletos ficam pending/partial e não são exportados como final.
- Quotas reservadas antes; watcher/accounting durante gravação detecta excesso e finaliza. Sem limite de filesystem/OS, overshoot é possível: não chamar watcher de hard quota absoluta.
- Cleanup próprio respeita retenção/IDs e recursos owned; não usar eviction de biblioteca para remover entregas. Nada de glob sobre produto ou kill-all.
- Artifact de servidor remoto não tem path local fictício. Remote browser/file delivery está fora do baseline; futura transferência precisa validar bytes/origem antes de presentar local.

### 14.3 Upload/download/export/auth

- Upload: host resolve e autoriza leitura pelo serviço/policy nativos; copia/stages arquivo bounded em namespace próprio, passa handle/path staged ao worker. Não dar worker acesso geral ao produto/home.
- Download: `acceptDownloads:false` default; contexto explicitamente download-enabled após autorização. Nome do site não define destino; mapear ID/nome gerado e verificar bytes/tipo/colisões. Disparar download pode ter efeitos externos, não repetir automaticamente.
- Export: artifactId -> destino concreto autorizado pelo host, sem overwrite silencioso. Owner e retention verificados; cópia de fonte owned não equivale a permissão no destino. Import/export de auth usa caminho separado e nunca resposta textual/Git default.
- Artifact final apresentado ao dono tem retenção declarada; antes de expirar, informar/preservar export quando pedido. Raw scratch e entrega não têm necessariamente mesmo TTL.

## 15. Defaults propostos e limites administrativos

Valores são decisões de projeto para validar no spike stable, não requisitos de biblioteca. Owner/admin pode ajustar dentro de limites explícitos; LLM não ganha acesso a overrides de instalação/policy.

| Recurso | Default inicial proposto |
| --- | --- |
| Sessions por Agent / contexts | até 2; cada session um contexto isolated |
| Tabs por session | 4 |
| Capturas simultâneas | 1 vídeo; trace exclusivo onde recorder conflita |
| Action / navigation / root deadline | 5 s / 30 s / 60 s; root limitada por operação |
| Finalização / graceful teardown | 15 s / prazo bounded com hard-stop own fallback |
| Idle browser | 10 min, com captura respeitando maxDuration |
| Viewport / DPR | até 2560×1440 / DPR até 3 no default |
| Imagem | até 16 MP; fullPage até 12000 CSS px e pixel budget |
| Vídeo | default 25 fps, bounds 1280×720; até 30 fps e 60 s |
| Bytes de vídeo / session artifacts | 100 MiB / 250 MiB |
| Runtime scratch por Agent | 500 MiB, sujeito a limite total host |
| Free disk reserve | 1 GiB; falhar antes de nova captura quando insuficiente |
| Input | até 64 KiB, depth 12, limites de strings/arrays por leaf |
| Help / describe / resposta normal | 8 KiB / 16 KiB / 64 KiB + spill |
| Retenção raw / entrega | 24 h / 7 dias, visível e ajustável pelo dono |

Fullscreen/fullPage, alta resolução e vídeo longo recebem erro/sugestão/override explícito, não downgrade silencioso. Limite de contexts/browser processes global do host precisa contador/reserva entre Agents; não confiar só em limite por owner.

## 16. Segurança adversarial e riscos residuais

- Página/snapshot/texto/headers, instruções MCP e WebMCP são dados não confiáveis. Não podem habilitar leaf, pedir credenciais, trocar manifest ou autorizar upload.
- Não coletar/expor ferramentas WebMCP/page-provided. Manifest allowlist fixo de APIs públicas protege o gateway; nenhum unsafe core/catalog MCP carregado na r4.
- URLs/redirects/localhost/rede privada tratados por policy e contexto do pedido. Origin allow/block não é barreira completa nem filtro perfeito de redirects.
- Sem flags inseguras automáticas (`noSandbox`, TLS-ignore), executáveis/configs/scripts arbitrários ou profiles pessoais carregados por default.
- Inputs de selector/target são dados e métodos públicos fixos; não executar expressão JS montada pela LLM. CDP adapter aceita apenas parâmetros da operação de gesto, não comando/método arbitrário.
- Parser de aria YAML não executa código/selector/nth nem atribui authority. Ref inexistente/ambígua não vira elemento por heurística. Page closure nunca retarget para sobrevivente.
- Auth/attach pessoal permanece disabled. Se implementado futuramente, sessão/abas autorizadas explícitas e detach não fecha Chrome do dono.
- Pixels, vídeos, traces e DOM podem conter segredos; mask/redaction ajudam sem garantia perfeita. Usar demos determinísticas e não-sensíveis nos testes.
- Same-user shell irrestrito, módulos de projeto trusted e browser vulnerável são riscos fora da garantia de gateway. Não apresentar filtro de tools como sandbox completo de máquina.
- Logs sanitizados, sem raw secrets/base64/URL credenciada. Mesmo input público pode conter texto sensível; documentar retenção do transcript nativo.

## 17. Configuração, instalação e integração com o checkout

- Plugin novo: `plugins/browser`. Ativação via `plugins/activation.json` e bootstrap existente, sem editar mirrors/perfis manualmente como fonte de verdade.
- Dono autorizou ativação final nos **quatro perfis gerenciados `dsh-tui`, `headless`, `web`, `tui`**, depois da validação; não transformar `project-mcp` em leitor global nem mudar outros plugins/policies para vencer gates.
- Config namespace proposto no `.agents/config.json`: `dshCustoms.browser`, validado, preservando managedPlans/outros campos. Ausência permite defaults do perfil; enabled:false de projeto nega browser naquele projeto. Projeto pode estreitar policy, não ampliar admin grant.
- Config administrativa e opt-ins sensíveis vêm de perfil/dono; projeto não pode selecionar executable/unsafe scripts/Chrome pessoal sozinho.
- Precedência: negações admin/preset/session + projeto; quotas por mínimo autorizado; overrides compatíveis somente onde permitido. Reload não altera manifest vivo silenciosamente: nova geração/Agent conforme política documentada.
- MCP Playwright já configurado: detectar diagnóstico/config duplicada. Não eliminar/mutar server do usuário. Escolha explícita entre rota existente e gateway; não expor ambos automaticamente e chamar integração padronizada. Remoção da skill antiga não é autorização para remover servidores/configs MCP.
- Worker dependencies em pacote dedicado ou root checkout lock conforme gate; grafo **Playwright estável1.64.0+SDK2**, sem MCP wrapper/SDK1. Bootstrap reproduzível; não adicionar packages ao produto inspecionado.
- Downloads/instalação de browser apenas operação administrativa autorizada do ambiente. Preflight é somente verificação; dependência ausente retorna BACKEND_UNAVAILABLE/capabilities claro e não quebra sessão de coding.
- Root meta-ops devem continuar disponíveis se backend faltar; por isso registro native não depende de SDK/Playwright worker importado eager.
- Versionar Node/Playwright/core/SDK2/validator/browsers/encoder e compatibilidade por matriz. Não `npx @latest` no caminho normal.
- Não criar `.agents/skills/browser`, skill substituta ou instalar/copiar skills de Playwright/MCP/CLI. Documentação funcional é README e orientação nativa/help.

## 18. Módulos propostos e responsabilidade

Nomes são desenho; criação de produção ocorre pela implementação coordenada, não pela subetapa de revisão do plano:

```text
plugins/browser/
  index.mjs                 root nativa global, hooks/prompt, lifecycle/plugin unload
  host.mjs                  resolve peers host + serviços públicos sem identity drift
  config.mjs                precedência/admin/project/read-only preflight
  manifest.mjs              catálogo público curado, schemas/effects/adapter metadata
  validation.mjs            bounds/AJV/normalização pura/hash
  policy.mjs                classificação, prehook/guard e recheck efetivo
  broker.mjs                Agent ownership, worker lazy, reservations/lifecycle
  render.mjs                texto/images/errors usando APIs públicas
  host-files.mjs            leitura/staging/export guardados
  worker/
    server.mjs              servidor SDK2 MCP privado, root interna e handshake
    sessions.mjs            Playwright stable Browser/Context ownership/state/replace/close
    targets.mjs             Page/frame/document/ref registries públicos, sem currentTab
    observation.mjs         Locator.ariaSnapshot YAML, targets únicos, probes/eventos públicos
    capture.mjs             states de vídeo/trace, finalize e quotas
    artifacts.mjs           namespaces/writers/manifests/retenção
    adapters/               interação/screenshot/touch/video/trace Page-bound públicos
  *.test.mjs                suites puras, SDK2 integration e native contracts
  fixtures/                 páginas locais determinísticas/hostis, closure-race regression
  live-check.mjs            prova opt-in host/TUI/providers/browser real
  README.md                 contrato, autorização, instalação, limits/recovery
```

Nenhum `upstream.mjs`/SDK1/embed/factoryMCP/internal helper é necessário. Dependency graph deve ser acíclico: manifest/validation puros compartilhados; policy host não importa backend; meta-ops não carregam Playwright; worker não importa peers DSH; render não decide autorização. Extrair utilidades existentes apenas quando necessário e com regressão, sem refactor amplo de project-mcp/common por conveniência.

## 19. Gates de viabilidade antes da entrega de produção

**G0 — Host/authority:** root global herdada, child restrictions, prehook validado antes do efeito, erro nativo, policy modes e processo/scratch não burlando host. Se suporte a um modo não for provado, denied/unsupported nesse modo.

**G1 — Schema/provider:** wire `args` aberto roundtrip nos providers ativos (Codex/pi-ai, Antigravity/Gemini, DeepSeek, demais realmente configurados). Strict providers podem não aceitar open object: testar adapter não-strict com AJV obrigatório; se inviável, voltar ao dono antes de argsJson/schema gigante. Não converter silenciosamente.

**G2 — Backend stable e fronteira SDK2:** imports/types/exports Playwright1.64.0 públicos, own Browser/Context/Page e lazy lifecycle/close. **Provar runtime real SDK2 client/server handshake+stdio/root única**, manifest/owner/errors/cancelamento/quiescência; outerSDK2 ainda não foi testado pelo spike histórico. Zero SDK1/embed/private exports/templates RCE.

**G3 — Page-bound failclosed:** resolver Page owned por ID e manter esse objeto através de awaits. Fixture idênticaURL/título com popup/close/reorder/frame/document invalidados e closure-race **durante request/efeito** deve falhar sem mutar sobrevivente. Ref só unique/publicly bound; nenhuma API currentTab ou fallback por index/URL/title. Reproduzir o counterexample histórico como regressão inversa: survivorCount deve permanecer0.

**G4 — Multimodal:** screenshot real vira attachment para modelo image-capable; modelos sem imagem recebem diagnóstico/arquivo. Native/PTC/replay e cancelamento de armazenamento respeitados.

**G5 — Mobile/mídia STABLE:** repetir settings efetivos mobile, tap, trusted swipe Chromium, vídeo per-page finalizado e trace scope/conflicts no grafo estável/browsers/encoder selecionados. Arquivo/container/dimensão efetiva/frames verificados. Pass alpha histórico não satisfaz este gate.

Saída: relatório curto versionado, inventário capability verified/unverified, tokens/latência baseline, arquitetura confirmada/gaps e decisão. Gates não autorizam remover requisitos ou mudar novamente de arquitetura sem dono.

## 20. Fases de execução autorizada

| Fase | Entrega | Dependência / saída |
| --- | --- | --- |
| A — stable/protocolo spike bounded | G0–G5 com fixture local/temporários ignorados; closure regression e SDK2stdioruntime | Registrar diferenças para spike histórico; nenhuma ativação final prematura |
| B — contratos | manifest, wire, validators, errors, help/describe, hashes | Pure suites passam; catálogo sem Playwright eager |
| C — integração native | root global, policy, broker/worker lazy, lifecycle | child filters e denies native/PTC demonstrados |
| D — sessão/observação | stable público, Page/document/ref registry, ariaSnapshot YAML, nav/interact/diagnostics | G3, stale refs sem inventar, popups/frames/targets corretos |
| E — mobile/mídia | screenshot/image, mobile gestures, vídeo/trace states | G4/G5stable + artefatos reais validados |
| F — arquivos/limites | uploads staged/export/download opt-in, quotas/cleanup | path/ownership/adversarial/regressões |
| G — rollout | instalação pinada, README/help/prompt nativo, ativação nos quatro perfis gerenciados | TUI/providers/perfis e repo hygiene; rollback testado; **nenhuma nova skill** |
| H — cleanup final específico | remover recuperavelmente somente skill antiga `playwright`, com path/identidade verificados | Só após integração validada/ativada; sem substituta e sem remover mobile-media/outras skills |

Algumas provas de spike exercitam APIs finais antes das fases; não significa construir toda solução no spike. Manter cada mudança pequena/reversível e atualizar goal/todos. Não fechar etapas por mocks quando exigem runtime real.

## 21. Matriz de testes e evidências de aceitação

| ID | Prova obrigatória |
| --- | --- |
| API-01 | Apenas uma browser root em schemas(scope); zero Playwright leaves |
| API-02 | Help por níveis bounded; describe um schema/exemplo; nenhum browser/worker launch em meta-op |
| API-03 | Unknown leaf/new backend capability/meta/code/command rejeitados antes do efeito |
| API-04 | Root/subset DSH e leaf AJV distintos; unknown fields/default/coercion/drift testados |
| API-05 | Providers ativos roundtrip args open; failure não encerra Agent; native/PTC mesma policy |
| SDK-01 | SDK2stdioruntime: Client/server handshake/root única/schema/manifest/owner/error/cancel/close reais, sem SDK1 |
| POL-01 | Child allowlist sem browser: sem schema e UNKNOWN_TOOL antes body/worker |
| POL-02 | Child com browser: owner novo; IDs/auth do pai não acessíveis |
| POL-03 | Deny/ask ausente/read-only/unsupported workspace authority não causam launch/escrita |
| POL-04 | Policy muda na fila: recheck; grant once não habilita outra op/params |
| POL-05 | Direct worker malformed authority/manifest/hash/owner rejeitado; nenhum approved flag do modelo |
| LIFE-01 | Dois Agents mesmo cwd/projetos isolados: cookies/tabs/files/captures |
| LIFE-02 | Fork/spawn/compaction/resume/clear comunicam state loss/generation sem replay de efeitos |
| LIFE-03 | Unload/startup/crash/reconnect/idle/cancel deixam recursos owned finalizados ou partial conhecidos |
| LIFE-04 | Concurrent mutações/lifecycle serializados; sem reentrância/browser recursive calls |
| PAGE-01 | Navigate/fill/click/wait estado real local; stale/ambiguous sem first fallback |
| PAGE-02 | Popup/close/reorder/frames/dialogs atingem Page concreto, sem confiar título/URL/index como ID |
| PAGE-03 | Closure-race durante dispatch/await: Page fecha, operação failclosed e survivorCount==0; sem retarget/ref equivalentes |
| OBS-01 | Snapshot/text/console/rede delimitados com cursor/spill e payload hostil como dado |
| OBS-02 | Locator.ariaSnapshot YAML público; parser não executaJS/nth; refs só unique locator/handle Page/document-bound |
| OBS-03 | Ref não emitida/desconhecida/ambígua/detached/document stale falha; sem inventar eN ou helper privado |
| IMG-01 | Viewport/fullPage/element/clip válido + conflicts inválidos + DPR/scale/masks explícitos |
| IMG-02 | Imagem realmente no contexto modelo/TUI/PTC, não só path/base64; no-image route diagnóstico |
| IMG-03 | Original vs normalized attachment dimensions, fonts/images readiness e limites pixels |
| MOB-01 | Desktop/preset/custom assertions viewport/UA/DPR/isMobile/hasTouch/orientação no stable |
| MOB-02 | Tap touch e swipe Chromium trusted+default scroll no stable; WebKit/Firefox unsupported, sem mouse fallback |
| VID-01 | Start -> interação -> stop produz WebM stable com duração/dimensões efetivas/frames corretos |
| VID-02 | Page scope exclusivo; context-wide extra descreve todas páginas/falhas/artifacts ou unsupported |
| VID-03 | Duplicate start/stop already-finalized/page close/crash/encoder ausente/time/bytes/disk/abort |
| VID-04 | Cancel/idle/teardown não deixa gravação eterna; partial nunca entregue como finalized |
| TRACE-01 | ZIP real vs live declarado/unsupported, scope context e artefatos múltiplos; sources default false |
| TRACE-02 | Trace/vídeo/recordVideo conflito negado ou combination comprovada, sem size ignorado |
| FILE-01 | Upload autorizado/staged; worker não recebe root/home path livre |
| FILE-02 | Traversal/symlink/absolute/relative/filename/site-name/collision/overwrite rejeitados |
| FILE-03 | Todos writers e spontaneous downloads/popups contabilizados; nenhum writer fora do artifact manager |
| ART-01 | Artifact metadata corresponde arquivo/container; remote path não fingido local |
| ART-02 | Retenção/pending/finalized/partial/expiry/export/cleanup owned, sem apagar entrega/produto |
| ADV-01 | WebMCP/unsafe code/init/config/CDP livre não habilitados via args/caps/discovery; zero exports privados |
| ENV-01 | Browser/SDK2/encoder ausentes/offline/version mismatch diagnosticam sem quebrar coding |
| ENV-02 | Reinstalação lock+stable/browser binaries/Node version reproduzível; nenhum @latest runtime/MCP/SDK1 produzido |
| CLEAN-01 | Produto fixture não ganha package/lock/scripts/config/media/cache rastreáveis; git status antes/depois preserva sujeira preexistente |
| LIVE-01 | Host/TUI real: root call, deny, imagem, arquivo/vídeo e teardown, não apenas mock dispatch |
| PROFILE-01 | Ativação e root/policy/lifecycle comprovados em dsh-tui/headless/web/tui sem mudar outros plugins |
| SKILL-01 | Última etapa remove recuperavelmente somente playwright antigo; mobile-media/outras preservadas; ZERO skill nova/substituta |
| PERF-01 | Prompt+discovery+respostas+turnos/processos/latência comparados no mesmo fluxo contra MCP plano/CLI como benchmark, não backend |

Fixtures sem contas pessoais/pagamento/efeitos externos. Testes de unit/schema não executam módulos desconhecidos só para inspecionar. Capturas têm estado determinístico não-sensível. Ferramentas de teste usam `.dumps` ignored ou temporários autorizados. Testes opt-in browser/live não fazem parte implicitamente de toda suite LTS.

## 22. Observabilidade, rollout, cleanup final e rollback

- Root logs já mostram operation/args/callId; acrescentar metadata/fatos de backend/owner/capture sanitizados usando APIs existentes. Não inventar eventos Session arbitrários ou dizer que SDK privado gera `tools/ptc-dispatch`.
- Erros duráveis mantêm código nativo; status/recovery não expõem secrets. Reportar capability unverified em vez de afirmar suporte com base em README/spike alpha.
- README, descrições/help/describe e prompt nativo ensinam root, targets, state loss, screenshots/media e limites. **Não criar/instalar skill nova ou substituta**; não editar skills não solicitadas para realizar a migração.
- Atualizar documentação do checkout que ainda chama task 5 experimental junto da nova entrega real aprovada.
- Rollout autorizado para **dsh-tui/headless/web/tui**, via manifest/bootstrap existente, com smoke/root/policy/lifecycle em cada perfil e teste TUI onde existe frontend. Uma fase controlada de smoke antes da expansão é permitida; a entrega final deve incluir todos os quatro.
- **Cleanup final específico:** verificar entrada/path absoluto e identidade da skill antiga `playwright` (base observada `/home/alex/.agents/skills/playwright`); ler/inspecionar antes de remoção conforme política, tratar symlink como link e não deletar alvo externo inadvertidamente. Usar remoção recuperável (`trash`) apenas do path explícito confirmado. Não tocar `playwright-mobile-media`, project-mcp ou outras skills; não adicionar substituta. Fazer isso somente ao final após smoke/ativação verificados, registrar receipt/recuperação e confirmar que o catálogo futuro não promete a skill removida.
- Rollback: desativar row browser no manifest via bootstrap, unload/quiescence own, preservar artifacts finalizados e não remover browser pessoal/produto. Pins anteriores/cache administrado permitem voltar versão do backend estável; auth/profile opt-in nunca destruído como cleanup automático. Skill removida tem recuperação pelo receipt, não reinstalação substituta automática.
- Fechamento da task registra versão/revisão, testes realmente executados, quatro perfis ativados, evidências, receipt de skill e limitações/unsupported restantes. Não basta salvar configuração ou expor uma root vazia.

## 23. Fora de escopo e decisões ainda condicionais

Não criar framework genérico de tool tree para todas tools DSH, modificar core/provider para forçar discovery, escrever browser engine/MCP manual/test runner/editor de vídeo, automatizar captcha/2FA ou operar app mobile nativo.

Desligados no baseline: Chrome pessoal/attach, auth persistente/export, eval/RCE livre, remote browser, áudio/webcam/desktop livestream, suporte universal de engines/gestos, daemon persistente entre Agents. Operações extras têm availability explícita e exigem revisão/prova; não precisam ser todas implementadas para baseline.

Excluídos da produção r4: embed/factory Playwright MCP, SDK1/InMemory pair, currentTab selection, RCE templates, `_snapshotForAI`, `_startRecording` e outros exports privados. Excluída qualquer nova skill/substituta; única remoção autorizada é `playwright` antiga, na etapa final recuperável.

Condicionais a resolver: SDK2outer handshake/stdioruntime/authority, stable Page-bound closure/ref failclosed, autoridade workspace-write pelo host, schema open object nos providers, recorder conflicts/encoder na stable. Resultado “não demonstrado” mantém capability bloqueada ou retorna ao dono; não vira improviso silencioso. A mudança para stable já foi decidida, mas sua prova runtime ainda não foi herdada do spike alpha.

## 24. Referências pesquisadas, histórico e limites das provas

Evidências locais: `plugins/project-mcp/README.md`, `index.mjs`, `host.mjs`, `config.mjs`; `plugins/activation.json`, `plugins/README.md`, `package.json`; exports/tipos/implementações instaladas de `dsh-tools`, `dsh-llm`, `dsh-llm-pi-ai`, `dsh-llm-deepseek`, `dsh-mcp-client`, `dsh-attachment`, `dsh-tool-fs`. Resolver pelo host em execução, não hardcode do cache pesquisado.

Histórico preservado: task5r3 hash `970ef77b9ec1b3708ea72ba4d910fb938d3985e4a328f35d556861bd4beb2017`; `.dumps/tasks/task05-backend-spike/RESULT.md`, `output/selection-race.json`, `selection-race.mjs`, `probe.mjs`, `output/report.json`, `run-history.json`. Não editar a revisão histórica/mirrors diretamente para apagar a hipótese rejeitada.

Referências selecionadas e históricas:

- [Playwright stable1.64.0](https://registry.npmjs.org/playwright/1.64.0), [Locator API/ariaSnapshot](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot), [SDK2 Client](https://registry.npmjs.org/@modelcontextprotocol/client/2.3.1), [SDK2 Server](https://registry.npmjs.org/@modelcontextprotocol/server/2.3.1): pins da arquitetura r4.
- [MCP versão consultada](https://registry.npmjs.org/@playwright/mcp/latest), [CLI](https://registry.npmjs.org/@playwright/cli/latest), [SDK v1](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest): latest é evidência da consulta histórica, não dependência de produção/pin permanente.
- [MCP export histórico](https://github.com/microsoft/playwright-mcp/blob/f183dad4a52965583e3cc1d59b88cdc279e2e57d/index.js) e [types](https://github.com/microsoft/playwright-mcp/blob/f183dad4a52965583e3cc1d59b88cdc279e2e57d/index.d.ts): explicam spike, não importar na r4.
- [MCP backend da core histórica](https://github.com/microsoft/playwright/tree/e8149b8257d32dcf8f72573ecc43e72439da7080/packages/playwright-core/src/tools/backend): context/tabs documentam a causa currentTab/closure; screenshot/video/tracing/response e unsafe/caps são histórico dos riscos.
- [SDK in-memory público v1 histórico](https://github.com/modelcontextprotocol/typescript-sdk/blob/ff07b001194fe60ee9deb2121cf119057565796d/src/inMemory.ts): não integrar na r4.
- [Screencast v1.64.0](https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/api/class-screencast.md), [Tracing](https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/api/class-tracing.md), [vídeos](https://playwright.dev/docs/videos).
- [Touchscreen](https://playwright.dev/docs/api/class-touchscreen), [legacy touch](https://github.com/microsoft/playwright/blob/v1.64.0/docs/src/touch-events.md), [Chromium touch input](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/server/chromium/crInput.ts).
- [MCP overview](https://github.com/microsoft/playwright-mcp/blob/main/README.md), [CLI overview](https://github.com/microsoft/playwright-cli/blob/main/README.md): referências de comparação/histórico, não rota runtime.

Dois estudos iniciais cobriram contratos/provider/DSH e backend/mobile/mídia; depois o spike real isolado instalou os pins históricos, iniciou Chromium sandbox-enabled em fixture loopback e comprovou blocker G3 e primitives de G2/G5alpha. Nenhuma produção/ativação/skill foi alterada pelo spike ou por esta revisão editorial. Nova implementação stable precisa provas próprias e segue a autorização explícita do dono, com remoção recuperável somente da antiga skill `playwright` ao final.

## Definição de pronto

Uma root browser herdada e filtrável, árvore lógica útil e compacta, schemas/policies por operação sem bypass conhecido nos testes, **Playwright estável Page-bound e SDK2 privado comprovados**, closure/ref failclosed sem mutação de vizinho, navegação/screenshot/mobile-touch/vídeo funcionando no runtime real, artefatos finais inspecionados e controlados, produto sem poluição, instalação/teardown reproduzíveis, ativação validada em **dsh-tui/headless/web/tui**, somente a antiga skill `playwright` removida recuperavelmente no final e **nenhuma skill nova/substituta**, com limites explícitos. Gate não comprovado, tool exterior registrada ou arquivo de vídeo não inspecionado não contam como integração pronta.
