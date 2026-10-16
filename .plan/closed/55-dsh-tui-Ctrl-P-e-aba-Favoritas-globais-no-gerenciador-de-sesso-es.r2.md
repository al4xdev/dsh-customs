# dsh-tui — Ctrl+P e aba Favoritas globais no gerenciador de sessões

## 1. Pedido, escopo e autorização

Implementação futura no fork pessoal `frontend/dsh-tui`, limitada aos **três comportamentos confirmados pelo usuário**:

1. **Ctrl+P:** marcar/desmarcar a sessão realmente selecionada no gerenciador.
2. **Tab:** alternar a tela atual e **Favoritas**, substituindo as fontes externas dessa navegação.
3. **Favoritas:** reunir sessões DSH marcadas de todos os projetos, com os estados e indicadores atuais.

**Setas, Enter e `/bg` já funcionam e não serão redesenhados.** Sem busca nova, servidor, refatoração de backend, preferência nova ou quarta funcionalidade escondida.

Esta sessão foi autorizada para investigação e plano, não implementação. O plano permanece no backlog; não compilar, instalar, atualizar upstream, commitar ou publicar agora. Execução futura exige pedido/aprovação específico.

## 2. Base, instalação e decisão separada de upstream

- Repo: `/home/alex/git/my/dsh-customs/frontend/dsh-tui`.
- Base mapeada: branch `custom`, HEAD `ebea5d738481bbc7c35006410ad9ce1a998dc883`, pacote `0.14.0`.
- Fish executa `~/.local/share/dsh-cli/local-model-launch.mjs` → profile `dsh-tui`.
- `~/.dsh/profiles/dsh-tui/package.json` liga o pacote TUI a este checkout. Compilar aqui regenera os artefatos da instalação ligada; não fazer isso despreocupadamente com sessões abertas.
- Pin store, catálogo global, status, resume e stop já existem: **não é necessário atualizar para implementar Favoritas**.
- **Plano 54**, em `para-o-dono`, contém comparação com upstream v0.15.0: 94 commits ausentes, cinco patches locais, ganhos, riscos e decisão.
- Inventário completo com links: `.dumps/tasks/dsh-tui-upstream-20261013-inventory.md`.
- Se o dono escolher atualização, integrá-la como tarefa separada antes de Favoritas e remapear o plano: v0.15 muda foco, cache, host e os mesmos hooks. Não embutir esse upgrade nesta mudança localizada.
- Sem decisão de upgrade, o baseline é o fork atual. Revalidar Git status/HEAD antes de editar, pois outras tarefas podem trabalhar no workspace.

## 3. Contrato visível

### Tela atual

Preservar a tela da imagem: rail de projetos, sessões do workspace selecionado, cartão Nova sessão, filtro existente e atalhos atuais. As fontes Claude/Codex saem apenas dessa navegação; no canal DSH passam a existir duas vistas:

```text
DSH | Favorites
```

O pacote possui idiomas oficiais en/zh; usar labels traduzidos. As duas opções existem mesmo sem fontes externas ou dados. Em largura extrema, manter folding/overflow atual e aba ativa visível; Tab não depende do mouse.

### Favoritas globais

- Mesma lista/renderização; conjunto vem dos pins elegíveis de **todos os cwd/projetos do catálogo DSH deste channel**.
- Workspace selecionado NÃO limita essa vista. Rail continua com seu contrato atual e determina o destino de Nova sessão, não o filtro de favoritas.
- Título da lista informa **Favoritas · todos os projetos**, não o projeto da rail.
- Reusar estrela, status, spinner, current e ocupação existentes. Sem estado remoto inventado ou nova prioridade de ordenação.
- Mostrar cwd/projeto abreviado na linha de fatos já existente, sem terceira linha: usuário está migrando para TTY, onde hover não basta para diferenciar títulos iguais.
- Rail e cartão Nova sessão permanecem. O cartão explicita o workspace selecionado e mantém Enter/Ctrl+N atuais.
- Empty state próprio de favoritas, indicando como marcar via Ctrl+P; loading e busca sem matches mantêm suas mensagens e precedência.

### Busca, troca de vista e `/bg`

- Nenhum buscador/filtro/comando novo. Reusar o filtro existente e seu predicate.
- Troca de vista limpa query/notice/menus conforme o `switchTab` atual.
- Cada montagem inicia em DSH/tela atual, como hoje; não persistir aba nem fazer `/bg` abrir Favoritas automaticamente.
- `/bg`, `/resume`, `/home` e `/agentview` continuam abrindo o mesmo supervisor; pin ou Tab nunca inicia, encerra ou abre uma sessão por efeito colateral.

## 4. Mapa de fontes verificado

Caminhos relativos ao pacote; linhas referem-se à base atual e precisam ser remapeadas se houver upgrade.

| Fonte | Responsabilidade / mudança |
|---|---|
| `src/screens/SessionSupervisor.tsx:104–225` | Consumo do hook, estado de fontes/tabs, `useForeignSessions`, troca de abas. Trocar fontes por duas vistas. |
| `SessionSupervisor.tsx:227–453` | Modais e teclado. Adicionar pin local e adaptar Tab sem alterar setas/Enter/Esc/N/L/X. |
| `SessionSupervisor.tsx:505–600,875–904` | Header/budgets/SourceTabs/overflow/panes estrangeiros. Reusar tabs, retirar consumo de fontes só dessa superfície. |
| `SessionSupervisor.tsx:680–785` | Título/filtro/cartão/rows/empty/callbacks. Título global e contexto cwd só em Favoritas. |
| `src/screens/sessionSupervisor/useSessionSupervisor.ts:109–125,343–409` | Backend, cache e única listagem global, partial/enrichment/generation guards. Preservar contratos. |
| `useSessionSupervisor.ts:184–196` | `listedSessions` global elegível; base correta de Favoritas. |
| `useSessionSupervisor.ts:215–247,470–496` | Rail, grupos por cwd e `visibleSessions` atual por selected.path. Mudar a base da derivação conforme vista. |
| `useSessionSupervisor.ts:289–296,505–538,756–770` | Pins, foco por ID, índices/card0, movimento e sessão sob cursor. Uma coleção para render e ações. |
| `useSessionSupervisor.ts:577–584` | Persistência do pin e notice de falha. Reusar. |
| `useSessionSupervisor.ts:643–662,709–724` | Entrada/ocupação e stop próprio/background. Reusar sem bypass. |
| `src/sessionPins.ts:129–201` | Namespace DSH, lock, leitura sob lock, escrita atômica. Sem schema novo. |
| `src/components/sessions/SessionListRow.tsx:125–153,173–226` | Estado/estrela/duas linhas/fatos. Prop opcional de contexto só em Favoritas. |
| `src/sessions/format.ts:248–265` | `formatProject(cwd, home)`: HOME→~, cwd desconhecido e normalização. Caminho conferido diretamente; reusar. |
| `src/components/sessions/SourceTabs.tsx:48–58,69–113` | Tabs genéricas/active-never-fold/overflow. Reusar sem redesign. |
| `src/screens/sessionSupervisor/model.ts:29,33,122–131` | Rail em 84 colunas, duas linhas e busca existente. Não alterar geometria/predicate. Tipo de vista pode viver aqui. |
| `src/screens/Chat.tsx:4243–4247,5061–5066,5864–5929` | Escopo teclado do supervisor e Ctrl+P de contexto no Chat. Preservar ação global. |
| `src/utils/keymap.ts:231` | `contextPanel` default Ctrl+P. Não remapear. |
| `scripts/verify-session-supervisor.tsx` | Terminal real in-memory/fake channel; substituir expectations source tabs em 1687–1932. |

Nenhuma nova dependência, API Harness, serviço Cordis ou import vendor na UI é necessário. Seguir `AGENTS.md`, `docs/contributing.md` e `ADAPTER.md`; editar fontes, nunca `lib/` manualmente.

## 5. Etapas de implementação futura

### A — Preparação e baseline

1. Ler instruções e arquivos atuais, verificar HEAD/status e diffs preexistentes.
2. Confirmar a escolha entre fork atual e upgrade separado; não sobrescrever trabalho paralelo nem os patches managed-plan/grammar/retry.
3. Ancorar a execução num goal específico/reutilizado e acompanhar etapas/aceite. O goal desta sessão é planejamento e termina com os artefatos.
4. Coordenar build/ativação do checkout ligado para não afetar sessões abertas. Não encerrar TUI/processos do usuário automaticamente.

### B — Uma vista, uma lista derivada

1. Introduzir tipo explícito `sessions | favorites`, com uma única fonte de estado no modelo/hook, exposta à tela. Não manter tab no componente divergente da coleção do hook.
2. Default `sessions`; Favoritas só quando `dshBackend` é verdadeiro.
3. Derivar a base ANTES do guard `selected === undefined`:

```text
sessions  → selected ? groupedEntries[selected.path] : []
favorites → listedSessions.filter(session => pins.has(session.id))
```

4. Em ambos aplicar o predicate existente, cópia e mesma ordenação live primeiro + updatedAt descendente; incluir dependências view/pins/listedSessions/query/pulse.
5. Render, `sessionAt`, `sessionIndex`, `focusedSession`, Enter/Ctrl+X e scroll devem usar essa mesma `visibleSessions`. Nunca filtrar só no JSX.
6. Preservar enumeração global única, cache channel/source-scoped, snapshot, partial/enrichment e generation guards. Não listar por favorita ou projeto.
7. Não podar pins ausentes a partir de cache parcial nem transferir pin para fork/model/session ID novo.

### C — Ctrl+P reutiliza o pin da estrela

1. Inserir o handler após camadas modais; usar o padrão `isMod` já adotado pelos demais Ctrl/Cmd, garantindo Ctrl+P Linux pelo byte `\u0010`.
2. Só agir em DSH + pane da lista + `focusedSession` real. Não usar `focusSessionId` bruto: filtro/unpin pode ocultá-lo e o índice tem fallback.
3. Rail, card0, vazio e zero matches: consumir como no-op; não salvar ID invisível/undefined nem inserir `p` na query.
4. Reusar `persistPin` → `setSessionPinned`, que relê sob lock e altera só o ID. Não usar overwrite do set inteiro stale.
5. Mouse estrela e teclado compartilham o caminho; clicar na estrela não abre a sessão.
6. JSON/lock/permissão: notice existente, sem mudança visual/foco em falha. Testar duplo toggle no mesmo batch; se exigir ajuste de closure, limitar ao toggle compartilhado.

### D — Tab troca fontes por vistas

1. DSH/Favoritas disponíveis sempre no canal DSH, independentes de fontes ou facade estrangeira; Tab/Shift+Tab alternam o par, clique é equivalente.
2. Retirar só do supervisor a chamada a `useForeignSessions`, efeito de fonte desaparecida, `foreignKey` e `ForeignSessionPanes` sem uso. O efeito antigo não pode resetar Favoritas por não ser fonte externa.
3. Reusar `SourceTabs`, widths/folding/overflow; não apagar módulos de parsing/facade/migrate/backends para limpar a árvore.
4. `/migrate` e CLI de migração continuam. Supervisor não-DSH preserva vista única e namespace próprio; não listar DSH por channel Claude/Codex.
5. Limpar query/notice/menus como atual; não chamar `activateList` indiscriminadamente, pois reseta foco para current/card.
6. Novo pin e troca de vista não atuam atrás de ApprovalPanel ativo. Guardar o fluxo comum de troca, incluindo clique/overflow, não só tecla. Não refatorar broadcast/ownership de todas as teclas antigas de approval.

### E — Global legível e ações seguras

1. Reusar `SessionListRow`, `liveStateOf`, `holderOf`, spinner/current e `openSession`/`stopSession`.
2. Prop opcional `workspaceLabel` apenas em Favoritas; calcular na tela com `src/sessions/format.ts:formatProject`. Row normal sem prop mantém texto/estilo atuais.
3. Inserir cwd cedo na facts row, com orçamento compacto/truncamento por display cells para deixar espaço temporal. Não basename sozinho: diretórios distintos podem ter nomes iguais. Não adicionar terceira linha.
4. Título global; cartão e Ctrl+N explicitam/seguem o workspace selecionado. Selecionar workspace não filtra favoritas, mas mantém o reset de foco da rail atual.
5. Working/live conservam visão global atual do catálogo elegível; total continua rows visíveis. Sem contador/estado/ordenação novos.
6. **Menu contextual da row:** `SessionSupervisor.tsx:767–773` usa `selected` da rail, não cwd da sessão. Favorita B com rail A poderia oferecer rename/remove de A. Menor solução: desabilitar somente `onContextMenu` das rows em Favoritas, mantendo menu da rail. Não introduzir switchWorkspace pelo cwd da favorita.
7. Empty de favoritas distinto de loading/no-match, com orientação Ctrl+P.

### F — Foco, Enter e background permanecem

1. Manter foco por ID, índice derivado/card0, setas/Enter/Esc e scroll window.
2. Reparar ID stale somente após unpin bem-sucedido da favorita focada que saiu da lista: primeira row restante, consistente com fallback atual. Não mover foco em falha, pin normal ou toggle de outra row.
3. Última favorita removida: manter cartão Nova sessão visível/focado conforme o contrato existente, explicitamente rotulado com o projeto. Pin/Tab NÃO criam/abrem automaticamente; Enter no cartão continua sua ação atual e claramente exibida.
4. Sem cursores paralelos/preferência/restauração especial de aba. Selecionar rail continua podendo zerar foco.
5. Entrada é por `openSession` → `resumeTo(id)`, não callback bruto nem selected.path; não aplicar outro working gate ao DSH.
6. Não mudar `/bg`, `/resume`, `/home`, `/agentview`, drafts, IDs, compaction ou mount ledger. Sessão estacionada continua trabalhando.

## 6. Invariantes e limitações documentadas

### Runtime e ocupação

- Pin não inicia/encerra/toma posse de sessão e não muda cwd.
- Outro PID continua bloqueado para entrada; pulso visual pode atrasar 2s, reserva no adapter é a autoridade.
- Working/needs-input são conhecidos para agentes do runtime atual; ocupação externa não autoriza inferir status remoto.
- Stop continua só background próprio, não current nem PID externo.

### Catálogo/cwd

- Mesma elegibilidade: sem prompt, subagent e ancestrais ocultos do fork atual continuam fora, mesmo pinados.
- Diretórios não registrados/históricos podem aparecer em Favoritas sem alterar registry.
- Resume usa ID/cwd registrado, nunca workspace da rail.
- Lacuna preexistente: header sem cwd pode usar cwd atual, e resume não tem a mesma validação de diretório da criação. Não resolver backend neste escopo nem alegar proteção que não existe.

### Store

- DSH permanece em `~/.dsh-tui/session-pins.json`; backend stores isoladas; sem migração/schema/preferência nova.
- IDs órfãos tolerados, nunca limpos com base em partial/cache.
- Pins externos não são sincronizados em tempo real com uma tela aberta hoje: leitura no mount e mutações locais. Não adicionar polling/sync como quarta feature.
- Gravação strict sob lock preserva JSON malformado/mutações distintas. Não contornar erro com overwrite integral.

### UI

- Ctrl+P do contexto global fica intacto fora do supervisor.
- Narrow rail oculta com pane ainda no rail é preexistente; não corrigir navegação estreita inteira aqui.
- Aprovação tem problema preexistente de múltiplos listeners: proteger apenas novas operações Tab/pin/clique de aba, sem alterar outros controles nesta tarefa.

## 7. Matriz de regressões

### Atalho/store

- Ctrl+P pin/unpin do mesmo ID do `❯`, sem resume/new/stop e sem query pollution.
- No-op em rail/card/vazio/no-match; modais/approval mantêm prioridade.
- Estrela mouse equivalente e não abre; duplo toggle no mesmo batch volta ao início.
- Restart/remount mantém pins mas não aba.
- Lock busy/JSON corrompido/falha de gravação: notice e preservação de bytes/row/foco.

### Vistas/global

- Tab/Shift+Tab/cliques no par mesmo sem dados/facade/arquivos de fontes.
- Probe/scan/import externos nunca chamados ao montar/alternar esta tela.
- A+B+cwd não registrado aparecem juntos, com A/B selecionado, sem selected e registry vazio/rejeitado.
- Atual continua por selected.cwd; elegibilidade/pins órfãos/current mantidos.
- Query existente e clear/reset/Esc mantêm contrato; loading/no-match/empty distinguidos.

### Foco/ações

- Unpin primeiro/meio/último/único; ID real visível, nenhum Enter abre ID removido.
- Card0 explicitamente Nova sessão; criação só pela ação existente, nunca efeito de pin/Tab.
- Re-sort/pulse/enrichment/partial/refresh/resposta superseded não desalinham render/Enter/stop.
- Favorita B com rail A abre B por ID; contextual da row não age sobre A.
- Occupied bloqueia Enter/clique; current não stoppable; stop próprio mira ID correto.
- Tab/clique protegidos por approval; mouse/teclado mantêm consistência.

### Status/cache/bg/Chat

- Estados working/needs-input/idle/completed/failed/stopped/current/occupied mantêm glyphs/cor/spinner.
- Pulso não adiciona enumeração; first-paint cache, failed refresh e generation guards preservados.
- `/bg` continua trabalhando/abrindo supervisor sem auto-favoritar ou mudar default.
- Ctrl+P fora do supervisor mantém contexto; drafts/caret/imagens preservados antes/depois Esc.
- Namespace/backend browse externos seguem válidos.

### TTY/layout

- Inline/fullscreen; 120/84/83/60 cols; terminal curto, resize e >viewport.
- Active-never-fold, overflow e hints Tab/Ctrl+P inclusive com query.
- Títulos iguais/cwd distintos, HOME, cwd vazio, caminho longo, CJK/emoji; sem hover.
- Teste real TTY: marcar, Tab, observar needs-input, entrar, bg, sair e clean exit/restauração de terminal.

## 8. Validação futura — comandos e limites

Nenhum teste/build foi rodado nesta investigação. Comandos executados no diretório do pacote, usando pnpm/Node compatíveis:

```fish
pnpm build
pnpm verify:session-supervisor
node scripts/verify-session-browser.mjs
node scripts/verify-keymap.mjs
node --import tsx/esm scripts/verify-ctrl-t-scope.tsx
pnpm verify:i18n
node scripts/build-guide.mjs
node scripts/verify-guide.mjs
pnpm verify:fixed-window
pnpm verify:package
```

- Substituir integration expectations source-tabs de `verify-session-supervisor.tsx:1687–1932`; manter snapshot/cache/backend sections e testes residuais de utilitários ainda usados.
- Store tests já em `verify-session-browser.mjs:62–88`; expandir UI sem store paralela.
- Script fixa idioma pré-import; usar `settled`/`settle`, não sleeps novos arbitrários sem tags.
- Sem root `test`/`lint`: esses scripts não existem. Build compila + gates, não equivale a toda suíte.

A prop contextual afeta componente compartilhado; executar também os três regressions CI requeridos para shared rendering/Chat quando essa superfície for tocada:

```fish
env DSH_TUI_LANG=zh node --import tsx/esm scripts/repro-askpanel.tsx
env DSH_TUI_LANG=zh node --import tsx/esm scripts/verify-askpanel-layout.tsx
env DSH_TUI_LANG=zh node --import tsx/esm scripts/repro-toolcards.tsx
```

- Backend shared se afetado: `node --import tsx/esm scripts/verify-backend-chat.tsx` e `node --import tsx/esm scripts/verify-session-archive.tsx`.
- Integração Chat/drafts se tocada: `pnpm verify:composer-draft-handoff`.
- Alteração involuntária de migrate/facade: revisar escopo e focused migrate-browse/migrate-command, não apagar cobertura.
- Antes de eventual integração/merge/publicação seguir grupos CI e contrato atuais como tarefa separada; não executar scripts de diagnóstico indiscriminadamente.
- Registrar resultado real e declarar testes/manual TTY não executados; não transformar estratégia em alegação de validação.

## 9. Docs, i18n e guia

1. `src/i18n.ts`: labels/alcance/empty/hints Ctrl+P/Tab em zh/en; hints também com query; placeholders corretos.
2. `README.md` + `README_ZH.md`: Ctrl+P contextual e vistas/favoritas globais; retirar promessa de import via source tabs desta tela, manter `/migrate`.
3. `docs/interaction{,.en}.md`: tabela e source strip; remover Ctrl+P da lista 'deliberadamente removido'; preservar descrições de setas/Enter/bg.
4. `docs/user-guide{,.en}.md`: gerenciador, alcance e atalhos.
5. `docs/migrate{,.en}.md`: fontes saem desta navegação, /migrate/CLI ficam.
6. `docs/foreign-session-tabs-design.md`: UI histórica/superada no fork; não declarar serviços/parsing removidos.
7. Comentários tela/hook/row/scripts: pin não implica pinned-first, ordenação permanece live+recência.
8. Guia gerado de docs com build-guide/verify-guide; não editar cópias geradas.
9. Nenhuma mudança em keymap/context panel, managed/native plan, grammar, retry ou descrição de `/bg`.

## 10. Aceite e entrega da execução futura

- [ ] Ctrl+P só no supervisor/lista, mesma store da estrela, persistência e falhas seguras.
- [ ] Tab alterna duas vistas sem fontes externas nessa tela.
- [ ] Favoritas DSH globais elegíveis com cwd legível e status atual.
- [ ] Setas/Enter/bg/rail/card/filtro preservados; pin/Tab sem criação/abertura automática.
- [ ] Foco/refresh/unpin não direcionam ação ao ID errado.
- [ ] Ocupação/stop current/approval para novas operações mantidos; menu contextual não aponta ao workspace errado.
- [ ] `/migrate`, outros backends e namespaces intactos fora da navegação removida.
- [ ] Sem novo servidor/dependência/persistência/preferência/sync/pin cleanup.
- [ ] Gates/regressões/manual aplicáveis com evidência e docs/guia zh/en coerentes.
- [ ] Sem upgrade fish/profile/upstream, encerramento de sessões, commit/push ou publicação ocultos no escopo.

## 11. Esforço e conclusão do planejamento

Lógica pequena e localizada: tela, hook e uma prop de apresentação. Maior trabalho: regressões de foco/modais/cache e documentação. Estimativa relativa **pequeno a médio** nesta base; upgrade v0.15 é separado e mais arriscado. Não prometer prazo fixo sem gates na base escolhida.

Investigação com cinco subagentes: UI/teclado, runtime/store, testes/docs, revisão adversarial e upstream em paralelo. Não houve mudança de código/build/teste/merge. Só fetch das refs upstream e criação de documentos. Goal desta sessão termina com plano + relatório/inventário; backlog não foi executado.

Revisão 2: conferido e corrigido o caminho do helper `formatProject` para `src/sessions/format.ts` e vinculado o inventário completo upstream; escopo dos três comportamentos permanece o mesmo.
