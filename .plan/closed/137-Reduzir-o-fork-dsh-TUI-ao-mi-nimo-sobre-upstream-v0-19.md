# Reduzir o fork dsh-TUI ao mínimo sobre upstream v0.19

Objetivo: deixar a branch `custom` de `frontend/dsh-tui` o mais perto possível de `upstream/main` (`4c6131e7`, v0.19.0) sem perder funcionalidade. Hoje o fork tem 9 commits / 27 arquivos de `src/` (+789 −73) sobre a base `90333ade`.

## Mapa das mudanças do fork

| # | Mudança (arquivos) | Destino | Motivo verificado |
|---|---|---|---|
| 1 | Ctrl+G de gramática no painel `/btw` (`sidePanel/btw/BtwThreadScene.tsx`) | **Descartar** | O dono não usa mais `/btw`. |
| 2 | `retryPolicies` por provider no OAuth (`oauth/index.ts`, `oauth/profiles.ts`, `verify-oauth-retry-policies.mjs`) | **Descartar** | Já substituído pelo plugin `alex-llm-resilience`; `tools/resilience/profile.mjs` migra e remove `dsh-tui-auth.config.retryPolicies`. Nenhum perfil local usa a chave. |
| 3 | `/plan` externo (`externalPlanCommand` em `capabilities.ts`, `command-completions.ts`, `mode-*.ts`, `sessionModes.ts`, `state.ts`, `ui-policy.ts`, `channel-ui.ts`, `index.ts` Config, `Chat.tsx`, `tips.ts`, 3 scripts de verify) | **Migrar para plugin + perfil** | O conflito só existe porque o plugin usa o nome `plan`, que o TUI trata como plan-mode nativo. Renomear o comando do `managed-plans` (ex.: `/plans`), desligar a linha nativa de plan-mode no perfil e configurar `modes` sem `plan`. Os subcomandos (`new`, `auto on/off/status`) passam para `ctx.tuiCommandTrees` (seam público no upstream). |
| 4 | Navegador de planos em cena (`ui.ts` exporta `Markdown` e `markdown-source`; `Markdown.tsx` ganha `sourceNavigation`/`preserveSource`; `package.json` `./ui`) | **Migrar quase tudo para o plugin**; resta 1 linha | `markdown-source.ts` é lógica pura sobre `marked`, então vai para o plugin. A navegação por bloco pode ser feita no plugin, renderizando cada bloco com `<Markdown stripPromptTags={false}>`. `preserveSource` já é `stripPromptTags: false` no upstream. O único resto é exportar `Markdown` no `ui` das cenas (os painéis já recebem `ui.Markdown`). Vira PR upstream e, até o merge, um patch de 1 linha. O subpath `./ui` não tem consumidores em `plugins/`. |
| 5 | Resultados das tools de plano renderizados como Markdown (`AssistantToolUseMessage.tsx`) | **PR upstream ou descartar** | Não há seam de renderização de resultado de tool (`tuiRenderers` só cobre eventos de sessão). É cosmético: propor um `format: 'markdown'` na presentation do card genérico. |
| 6 | Dono das perguntas de agentes em `/bg` (`questions-answerer.ts`, hunk em `extensions.ts`, `rawChannel` em `plugin.ts`, `verify-question-provider-guard.tsx`) | **PR upstream; manter até o merge** | O bug ainda existe no upstream. Lá agora há **dois** pontos de `registration.register(channel)` (`plugin.ts:1646` e `:3356`), e o rebase precisa cobrir os dois. |
| 7 | Remoção do aviso de update em background (`plugin.ts`) | **PR upstream (`updateCheck: false`); manter 1 hunk até lá** | O upstream não tem setting nem env para desligar. O Launchpad também chama `checkForTuiUpdate()` (`Chat.tsx` ~1087), e o fork não desligou essa chamada. |
| 8 | Ctrl+G para corrigir o rascunho no composer e no Launchpad (`PromptInput.tsx`, `Launchpad.tsx`, prop `provider` em `Chat.tsx`, `GrammarFixActivity.tsx`, `grammarFixPresentation.ts`, strings em `i18n.ts`) | **Manter no fork, reduzido a um hook genérico; PR upstream de seam** | O upstream não expõe leitura/substituição do rascunho (`tuiPrompt` é só slot de exibição; `tui/input` age no envio e tiraria a revisão antes de enviar). Ctrl+G é tecla reservada para plugins (`tuiShortcuts` recusa). Proposta: um seam `tuiComposer` com `registerDraftAction({ key, run(draft, signal) })`. Até lá, o fork fica só com o hook, e apresentação, dicas e textos vão para o plugin `grammar-fix` (toast/status line). |
| 9 | Docs do fork (`README.md`, `README_ZH.md`), `.gitignore` `.dumps/` | **Mover docs para dsh-customs**; `.gitignore` fica | Os READMEs conflitam a cada merge do upstream. |

## Fork residual esperado

- Hook de ação de rascunho (item 8), até existir seam upstream.
- Dono das perguntas em `/bg` (item 6), até o PR entrar.
- Desligar o update check (item 7), até o PR entrar.
- Exportar `Markdown` em `ui.ts` (item 4), até o PR entrar.

Cada item fica num commit próprio sobre `upstream/main`, para cair sozinho quando o upstream absorver.

## Passos

1. Criar a branch `custom-v0.19` a partir de `upstream/main`, sem mexer em `custom`, que segue como rollback.
2. Plugin `managed-plans`: renomear o comando, registrar a command tree, trazer `markdown-source` e a navegação por bloco; ajustar o perfil (desligar plan-mode nativo, `modes` sem `plan`, remover `externalPlanCommand`).
3. Plugin `grammar-fix`: absorver apresentação, dicas e strings; consumir o hook novo.
4. Aplicar os commits residuais (itens 4, 6, 7 e 8) sobre a branch nova, incluindo os dois pontos de registro do item 6.
5. Rodar build e os verifies do upstream mais os do fork que sobrarem (`verify-question-provider-guard`, launchpad), além dos testes de `plugins/managed-plans` e `plugins/grammar-fix`.
6. Ajustar os testes de dsh-customs que importam o OAuth do fork com `retryPolicies` (`plugins/session/resume-runtime.test.mjs`, `tools/clean-install/inventory.mjs` marker `oauth32`).
7. Depois de aprovado e instalado, rodar `npm run prompt:audit` e reportar qualquer diff de baseline.
8. Rascunhar as issues/PRs upstream dos itens 4, 5, 6, 7 e 8 em `.dumps/`, para o dono revisar antes de publicar.

## Riscos e verificações

- Confirmar no lab que nenhum perfil ainda depende de `dsh-tui-auth.retryPolicies` antes de descartar o item 2.
- Trocar `/plan` por `/plans` muda o nome que o dono digita. Se o nome `/plan` for indispensável, o item 3 vira PR upstream (opt-out do picker nativo), e o patch fica até lá.
- A navegação por bloco no plugin precisa manter a numeração de listas ao renderizar cada item separadamente. Validar visualmente.
- Nada é publicado no GitHub (push, PR, issue) sem confirmação explícita.
