# Browser nativo DSH

Uma única tool `browser` expõe uma árvore de operações. O backend é **Playwright estável 1.64.0**, com Browser/Context/Page próprios por Agent, por uma fronteira MCP SDK2 privada. Não há Playwright MCP upstream, SDK1, `currentTab`, código da LLM ou APIs privadas do motor.

Registro global herdado permite que uma allowlist de subagente exclua `browser`. Cada operação valida schema, owner, geração, efeitos e política antes de executar. Popup/fechamento não muda o alvo para uma aba vizinha. O estado não é compartilhado por cwd; fork/resume não restaura handles vivos por replay.

## Preparar o ambiente, não o produto

Execute **neste checkout dsh-customs**; o helper também resolve seu runtime pela localização do módulo, não pelo projeto/cwd do usuário:

```fish
node tools/browser-runtime.mjs --doctor
node tools/browser-runtime.mjs --install
```

`--doctor` é o default: JSON com pins, versões instaladas, cache, executablePath/existência dos browsers selecionados, encoder gerenciado e `ffmpeg`/`ffprobe`. Não inicia browser, consulta modelo/provedor, instala packages, altera perfis ou skills. Existência de binário **não** prova launch/sandbox, policy do host, imagem no modelo ou ativação.

`--install` é explícito: verifica manifest/lock, executa `npm ci --ignore-scripts` **somente em `plugins/browser/runtime`**, confere as versões e chama a CLI oficial pinada para instalar Chromium/encoder. Cache administrativo default: `~/.cache/dsh-browser/playwright-1.64.0`. Não instala dependências no produto, roda apt, ignora TLS/desativa sandbox ou aceita flags/code/env/path livres. Não instala automaticamente a partir de uma chamada da tool.

Pins: Playwright/core `1.64.0`, SDK client/server `2.3.1`, AJV `8.17.1`, YAML `2.9.1`; Node ≥20. Versions mismatch falha antes do download do browser. Downloads e npm têm deadlines finitos; logs de filhos não são despejados no JSON com credentials.

Outros engines só por pedido administrativo explícito:

```fish
node tools/browser-runtime.mjs --doctor --engine firefox
node tools/browser-runtime.mjs --install --engine firefox
node tools/browser-runtime.mjs --install --engine webkit
```

Instalar um engine **não** o autoriza: `allowedEngines` no perfil continua `['chromium']` por default. Pode repetir `--engine` para nomes curados distintos. Dependências de SO ausentes precisam de diagnóstico/decisão separada; não há `--with-deps`/apt automático.

## Descobrir e chamar a única tool

Os blocos abaixo são **argumentos JSON para a tool `browser`**, não comandos shell. `args` é sempre obrigatório. O schema wire é pequeno; cada leaf tem schema estrito próprio retornado por `describe`.

```json
{"operation":"help","args":{}}
```

```json
{"operation":"help","path":"media.video","args":{}}
```

```json
{"operation":"describe","path":"session.open","args":{}}
```

```json
{"operation":"capabilities","args":{}}
```

Help lista apenas filhos imediatos, com limites/cursor; describe retorna uma operação. `path` é apenas de discovery; execução usa `operation` dotted. Metadados não fazem launch/install. `session.list/status` e `media.video/trace.status` consultam somente um worker já conectado quando a policy permite; sem worker/read-only retornam `LAST_KNOWN_STATUS`, sem afirmar que uma ação continua possível. Capture metadata não cria attachments nem entrega frames em chamadas de discovery. `catalogRevision` opcional detecta drift, **não** é token de aprovação.

### Recuperação de erros de envelope

Cada item do help traz `nextCall` completo: `help` para uma branch e `describe` para uma leaf. O help raiz traz `quickStart` com abrir → navegar → observar → screenshot. Describe inclui campos obrigatórios, não só defaults. Exemplos são **templates não executados**: substitua placeholders, URL, nomes e coordenadas por valores pretendidos e refs reais. Aprovação, disponibilidade e ownership continuam sendo verificados na execução.

A forma preferida continua sendo metacampos **no topo**, como nos exemplos. Para evitar loops por erro de posicionamento, o validator aceita também `args.path` apenas em help/describe, `args.sessionId` apenas quando a operação requer sessão, `args.pageId` apenas quando usa Page e `args.catalogRevision`. Eles são relocados antes dos mesmos checks, sem alterar o input original. Duplicatas idênticas são coalescidas; valores conflitantes falham **antes de efeitos**, sem escolher uma precedência.

Assim, esta chamada também funciona com refs válidas:

```json
{"operation":"page.navigate","args":{"sessionId":"bs_retornado","pageId":"bp_retornado","url":"http://127.0.0.1:8888/index.html"}}
```

Não há flatten genérico, coerção, seleção de sessão/aba ou alias executável. `page.goto` continua inválido, mas o erro ensina `page.navigate`. Describe sem path ou com uma branch ensina uma chamada completa de recuperação. Erros de args apontam para o describe correto no próprio texto, porque o erro nativo não preserva todos os details. Campos desconhecidos, código, IDs estrangeiros/stale, URLs proibidas, paths arbitrários de screenshot e ações sem aprovação continuam negados. **Não abra outra sessão só para corrigir o lugar dos IDs**: reutilize os retornados por `session.open`.

Na composição padrão, alterações no código `.mjs` entram ao **reabrir o DSH**; `/reload` da TUI só recarrega preferências, não esta implementação. Faça isso quando o agente estiver ocioso, sem parar o servidor do modelo. Após a reabertura, crie uma nova sessão browser: os handles do processo anterior não são restaurados pelo journal.

### Desktop e navegação

```json
{"operation":"session.open","args":{"engine":"chromium","headless":true}}
```

Use **os IDs reais retornados em `refs.sessionId`/`refs.pageId`**, não os placeholders abaixo. Pode omitir pageId somente quando a sessão tem exatamente uma Page; várias Pages exigem alvo explícito.

```json
{"operation":"page.navigate","sessionId":"bs_retornado","pageId":"bp_retornado","args":{"url":"http://127.0.0.1:5173","waitUntil":"domcontentloaded"}}
```

```json
{"operation":"observe.snapshot","sessionId":"bs_retornado","pageId":"bp_retornado","args":{"depth":4,"limit":128}}
```

Observação usa `Locator.ariaSnapshot()` YAML público. Refs só são emitidas quando vinculadas unicamente por APIs públicas à Page/document. Ref ausente, detached ou stale não vira um elemento por heurística, `first`/`nth` ou expressão JS. Para alvo sem ref, use um target público inequívoco:

```json
{"operation":"interact.click","sessionId":"bs_retornado","pageId":"bp_retornado","args":{"target":{"kind":"role","role":"button","name":"Salvar","exact":true}}}
```

Click pode enviar/publicar/excluir; uma permissão técnica da tool não é aprovação de uma ação externa sensível. Conteúdo da página é dado não confiável.

### Mobile de verdade emulado

```json
{"operation":"mobile.devices","args":{"query":"Pixel","limit":10}}
```

```json
{"operation":"session.open","args":{"engine":"chromium","headless":true,"emulation":{"device":"Pixel 7","orientation":"portrait"}}}
```

O preset está **dentro de `emulation`**, não em `args.device`. O resultado informa configurações efetivas. Resize por `emulate.viewport` não altera UA/DPR/isMobile/hasTouch; identidade nova exige `session.replace` explícito e invalida handles antigos.

```json
{"operation":"mobile.swipe","sessionId":"bs_retornado","pageId":"bp_retornado","args":{"from":{"x":195,"y":700},"to":{"x":195,"y":250},"durationMs":300,"steps":12}}
```

Pontos em CSS pixels do viewport. Swipe trusted é adapter Chromium-only; não há fallback mouse/synthetic oculto para Firefox/WebKit. Emulação não comprova UI Android/iOS nativa.

### Screenshot e vídeo

```json
{"operation":"media.screenshot","sessionId":"bs_retornado","pageId":"bp_retornado","args":{"mode":"viewport","format":"png","scale":"css","readiness":{"fonts":true,"images":true}}}
```

Modos viewport/fullPage/element, conforme describe; element exige target. FullPage/element/clip incompatíveis falham, não são inferidos. Nenhum filename/path arbitrário chega ao engine. Screenshot é artifact original e, quando rota/modelo+AttachmentStore admitem, imagem nativa. `imageUnavailable` significa arquivo disponível sem alegar que o modelo viu pixels.

```json
{"operation":"media.video.start","sessionId":"bs_retornado","pageId":"bp_retornado","args":{"scope":"page","fps":25,"maxDurationMs":15000}}
```

Guarde `data.captureId`/`refs.captureId`, interaja na mesma Page e finalize:

```json
{"operation":"media.video.stop","sessionId":"bs_retornado","args":{"captureId":"bc_retornado","inspectFrames":true}}
```

A captura é WebM por Page, não trace ou gravação de ações. Stop verifica container/duração/dimensões e entrega artifacts de frames representativos por default; leia os frames para comprovar resting/transição/final. Dimensões efetivas do encoder podem diferir de bounds solicitados. Não afirmar que o modelo assistiu ao vídeo inteiro. Inspecione o artifact retornado sem fabricar IDs:

```json
{"operation":"artifacts.inspect","args":{"artifactId":"ba_retornado"}}
```

Trace ZIP é context-scoped, sensível e sujeito a aprovação explícita. Vídeo/trace simultâneos são bloqueados onde recorder conflita; `partial`/`failed` não é entrega pronta.

## Políticas, artefatos e limites

Configuração opcional em `<raiz Git>/.agents/config.json`, no namespace `dshCustoms.browser`, preservando os demais campos. Um projeto pode desabilitar ou estreitar limites/recursos, não ampliar a política administrativa; `browserCache` é configuração do perfil, não override de projeto. Exemplo de opt-out:

```json
{"dshCustoms":{"browser":{"enabled":false}}}
```

- Read-only: discovery/metadados locais, sem iniciar browser/captura que escreve cache. Stateful startup exige integração com a política nativa; ausência de suporte falha fechada. Approval ausente/desabilitada **nega** operações que exigem ask.
- Sem perfil pessoal/attach, auth export/import, RCE/evaluate livre, shell, métodos CDP livres, TLS-ignore ou sandbox desativado. Extras disabled aparecem no catálogo, não ganham autorização por discovery.
- Defaults: 2 sessões/Agent, 4 Pages/sessão, 16 MP de imagem, vídeo até60s/30fps/100MiB; 250MiB artifacts/sessão e 500MiB/owner, com reserva de disco1GiB. Consulte describe/capabilities para limites efetivos.
- O broker nativo compartilha entre Agents uma reserva conservadora de até **4 workers/8 contexts/2GiB de orçamento dos owners ativos**. Ela é tomada antes do bootstrap e liberada apenas após join do range próprio ou startup cancelado sem worker. `capabilities.hostCapacity` mostra os contadores. Não é quota de filesystem, contador entre processos DSH independentes nem limite sobre raw archives retidos de owners inativos.
- Bytes de vídeo são vigiados a cada **500ms** e excessos pedem auto-finalização. Essa quota é **soft**, com possível overshoot; não equivale a limite de filesystem/OS. Finalização marca excesso como partial, não sucesso útil.
- Runtime/artifacts são namespaces gerados próprios e paths/export/upload passam pelo guard de host. Não gravar caches/prints/scripts no produto; `.dumps` só é destino local quando ignored e permitido. Path guard não é sandbox completo contra processo comprometido.
- Retenção default raw24h/entrega7dias aparece em metadata. Um artifact final efetivamente retornado por uma operação stateful tem o TTL de entrega confirmado no worker privado, após revalidar owner/path/bytes/hash; o TTL de projeto mais curto é respeitado. Discovery não promove retenção. Imagens normalizadas pertencem ao serviço nativo de attachments: o plugin não promete nem implementa GC/TTL de arquivos desse serviço; a retenção declarada aqui se refere aos originais managed. `retentionUntil` determina **elegibilidade** de cleanup guardado, não exclusão instantânea garantida por um daemon global. Policy pode adiar cleanup; arquivo retido não restaura Page/handle/session. Exporte deliberadamente entrega necessária, com destino autorizado e sem overwrite silencioso.
- Fechar sessão/Agent/worker fecha apenas recursos próprios; sem `kill-all`. Timeout/cancelamento não faz rollback de envio/navegação nem autoriza replay mutante. Após falha com efeito unknown, observe antes de repetir.

## Validação e ativação

```fish
npm run browser:doctor
npm run test:browser
npm run test:browser:live
```

O teste default não inicia os casos live do worker; `:live` os habilita explicitamente no cache administrativo pinado. Ambos usam fixtures offline e não chamam LLM/providers, instalam dependências ou ativam perfis. O runner resolve o checkout por sua própria localização e ignora cache/Node flags do caller.

A ativação é declarada pela entrada `alex-browser` em `plugins/activation.json` e gerada pelo bootstrap existente para **dsh-tui/headless/web/tui**. `npm run check` verifica a sincronização dos perfis; reabra o DSH para uma composição nova quando necessário. Doctor, suites de contrato/runtime/host, closure failclosed Page-bound, imagens/vídeo/frames reais, políticas native/PTC e smokes dos perfis são gates distintos: configuração em sync não substitui execução real. Os smokes offline não geram respostas de modelo; ImageBlocks no terminal podem aparecer como placeholders, sem comprovar pixels físicos.

Nenhuma nova skill/substituta é criada. Somente a skill antiga `playwright` tem remoção recuperável autorizada ao final da implementação validada; o provisionador não remove skills, não ativa perfis e não altera configuração MCP do dono. `playwright-mobile-media` e demais skills ficam preservadas.
