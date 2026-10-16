# dsh-tui upstream v0.15.0 — ganhos, riscos e decisão de atualização

## 1. Natureza deste documento

Relatório de investigação e decisão do dono, não autorização para atualizar, instalar, compilar, mesclar ou publicar. A atualização é independente da implementação de Favoritas. A solicitação desta sessão é somente planejamento.

Investigação em 2026-10-13 por um subagente dedicado, em paralelo ao mapeamento da funcionalidade. Evidências: Git, manifests, release notes e diffs de código; não foram executados merge de teste, benchmarks, build ou smoke da versão nova.

## 2. O que realmente está atrás do upstream

| Item | Resultado verificado |
|---|---|
| Fork / origin | https://github.com/al4xdev/dsh-TUI.git |
| Upstream real | https://github.com/ccch1mneyyy/dsh-TUI.git |
| Branch local | `custom` |
| HEAD local | `ebea5d738481bbc7c35006410ad9ce1a998dc883` |
| Versão local do pacote | `0.14.0` |
| Base comum | `c2eee95218d1decfce138f7d31ef7099cc391d00` |
| Branch padrão upstream | `main` |
| HEAD upstream consultado | `18e4a206afc367f055a2b3379bb221abcbb5d99e` |
| Versão upstream | `0.15.0` |
| Divergência | 5 commits locais exclusivos / 94 commits upstream exclusivos |
| Patches upstream | 84 non-merge + 10 merges; os 84 não são patch-equivalentes aos locais |
| Tamanho agregado base → upstream | 562 arquivos; +37.280 / -5.985 linhas |
| Sobreposição com alterações locais | 19 arquivos; sobreposição NÃO significa 19 conflitos textuais comprovados |

HEAD local tem data de committer 2026-10-13T14:14:45-03:00; HEAD upstream 2026-10-13T10:04:24-04:00. Essas datas não representam a data de instalação. Os 94 commits incluem documentação, testes, merges, release e reversão; não são 94 funcionalidades.

### Descoberta relevante no fetch

O refspec de `upstream` estava restrito à tag `v0.14.0`. Um fetch comum não atualizaria `upstream/main`. Foi realizado somente:

```text
git fetch --no-tags upstream +refs/heads/main:refs/remotes/upstream/main
```

Isso atualizou referências de investigação, sem alterar o refspec configurado, branch, índice ou arquivos da working tree. Status final do subagente: árvore limpa, `custom...origin/custom`.

## 3. Ganhos mais relevantes para este uso

### A. Gerenciador de sessões: menos espera e seleção mais previsível

- [01b9af00](https://github.com/ccch1mneyyy/dsh-TUI/commit/01b9af00): abre na lista do cwd atual e foca a sessão mais recente por `updatedAt`, mesmo quando outra sessão live/pin antiga está acima na ordenação.
- [70909910](https://github.com/ccch1mneyyy/dsh-TUI/commit/70909910): preserva seleção ao ativar/hover da lista; cursor nativo acompanha filtro, lista e rail.
- [6d4c1435](https://github.com/ccch1mneyyy/dsh-TUI/commit/6d4c1435), [95a7891d](https://github.com/ccch1mneyyy/dsh-TUI/commit/95a7891d), [6ff1809f](https://github.com/ccch1mneyyy/dsh-TUI/commit/6ff1809f): antecipação da listagem, compartilhamento de pending scan e snapshot inicial entre backends. `SessionCatalog.list` passa a aceitar `onPartial` e `snapshotKey`; renomear/deletar invalida scan pendente e atualiza snapshot.
- Ganho estrutural confirmado no código, não uma medida de latência real desta máquina.
- Essas alterações atingem exatamente `SessionSupervisor`, seu hook, foco e cache: se houver atualização, fazê-la antes de implementar Favoritas reduz retrabalho.

### B. Trocar modelo sem gerar outra sessão/fork

- [16b60dff](https://github.com/ccch1mneyyy/dsh-TUI/commit/16b60dff): `/model` usa `ModelSelectionRef` por agente e não cria/forka outro Agent. Mantém session ID, favoritos e transcript.
- Rejeita hosts antigos abaixo de `0.1.2-alpha.3` quando o contrato de herança não é suportado; não é promessa de funcionar silenciosamente em qualquer DSH.
- UI de modelo + effort: [26a68a34](https://github.com/ccch1mneyyy/dsh-TUI/commit/26a68a34), [75bf6f1a](https://github.com/ccch1mneyyy/dsh-TUI/commit/75bf6f1a).
- Novos comandos de backend: [42866fc1](https://github.com/ccch1mneyyy/dsh-TUI/commit/42866fc1), `/dsh`, `/claude`, `/codex`. Valor menor para quem já migrou tudo para DSH.

### C. Streaming, scroll e caret

- [e67946ba](https://github.com/ccch1mneyyy/dsh-TUI/commit/e67946ba): mantém altura medida da linha crescente no streaming até nova medição, evitando colapso e saltos de scroll ao sair da janela.
- Série `dfbee683`, `76721426`, `b6c1ce3b`, `6a344477` até `ad13b201`: caret nativo, handoff, seleção retida e prioridade de Escape para overlays. Pode melhorar o uso por teclado/TTY, mas a série é acoplada; não tratar um cherry-pick de cursor isolado como seguro.
- [c8be75b1](https://github.com/ccch1mneyyy/dsh-TUI/commit/c8be75b1): corrige probe de imagem após troca de kernel.
- [76c2a26b](https://github.com/ccch1mneyyy/dsh-TUI/commit/76c2a26b): fitting HiDPI e budget de canvas Kitty, pouco relevante para console Linux puro.

### D. Medição de contexto mais consistente

- [bc3a4b12](https://github.com/ccch1mneyyy/dsh-TUI/commit/bc3a4b12): utiliza `contextBreakdown` do meter para system/schema de ferramentas e rateia `messageTokens` pelas estimativas do transcript. Barra e hover usam parcelas coerentes e inteiros somando a ocupação medida.
- `StatusLine` mostra `starting <backend>` antes de ready.
- Isso não implica redução comprovada de tokens, RAM ou VRAM.

### E. Permissão persistida e retry padrão

- [461b1af6](https://github.com/ccch1mneyyy/dsh-TUI/commit/461b1af6): persistência de `/permission` e retry padrão de 5 tentativas, incluindo `STREAM_CLOSED`, pela configuração oficial do Harness; respeita `retryPolicy` explícita.
- Pode ser ganho upstream, mas neste fork é principalmente um ponto de reconciliação: o commit local `ebea5d73` já introduz policy pertencente ao provider e preserva os defaults Harness quando omitida.
- Não substituir inadvertidamente a política local por uma policy fixa upstream.

## 4. O que NÃO veio pronto

- `src/sessionPins.ts` está idêntico à base `0.14.0`: mesmo arquivo `~/.dsh-tui/session-pins.json`, lock, escrita atômica e isolamento de outros backends.
- Não veio a aba de favoritas globais nem a combinação solicitada de Ctrl+P + Tab.
- Não há evidência de que atualizar transforme a TUI em cliente remoto leve ou elimine o consumo por instância.
- Nenhuma economia de RAM/VRAM foi medida.

## 5. Custos e mudanças que exigem atenção

### Host, entrada e configurações

- [0d93cab3](https://github.com/ccch1mneyyy/dsh-TUI/commit/0d93cab3): host próprio/composition root; DSH in-process; profiles mais leves para Claude/Codex.
- [53b30129](https://github.com/ccch1mneyyy/dsh-TUI/commit/53b30129): ajustes de migração/adoption desse host.
- `/settings` migra de `settings.yaml`/profile para `~/.dsh-tui/settings.json`; há escape hatch documentado `DSH_TUI_HOST_ENTRY=0`.
- [d708cb88](https://github.com/ccch1mneyyy/dsh-TUI/commit/d708cb88): preferências persistidas ganham dos deployment defaults para model/preset/effort/kernel; env explícita continua prioritária.
- `/plugin` substitui `/plugins`, com alias temporário por um release.
- `--resume`, `-c`, `--continue` passam a falhar com exit não zero quando não há sessão válida do backend escolhido, em vez de iniciar outra silenciosamente.

### Contratos e dependências

- [bc890963](https://github.com/ccch1mneyyy/dsh-TUI/commit/bc890963): backend registry/manifests.
- [6c7cd863](https://github.com/ccch1mneyyy/dsh-TUI/commit/6c7cd863): receitas de instalação.
- [e3c371ed](https://github.com/ccch1mneyyy/dsh-TUI/commit/e3c371ed), [1d832df3](https://github.com/ccch1mneyyy/dsh-TUI/commit/1d832df3): maior isolamento de Claude/Codex da UI e do host.
- `BackendHost` ganha dataDir, locale e appVersion; `sessionPrefs(host)` e `SessionCatalog` mudam; channel core consome `ChannelHost` neutro em vez de Cordis Context.
- Manifest de contribuição backend `v1alpha1` fica congelado; não interpretar isso como picker automático end-to-end de qualquer backend terceiro.
- Linha validada upstream continua DSH `0.2.0-rc.2`; Node `^22.19 || >=24` e pnpm 11 não sobem nesta comparação.
- Surgem peers opcionais/dev e probes de APIs de boot/cmdline/proxy/launch/plugin-manager, `zod ^4.4.3`, geração de `backends.generated.ts` e gates novos.
- Conferência adicional do agente principal: o manifest da CLI instalada em `/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/package.json` informa `0.2.0-rc.2`. Isso é coerente com a linha validada, mas não substitui smoke das APIs/plugins efetivamente resolvidos.
- Fish executa `local-model-launch.mjs` → DSH profile `dsh-tui`; o profile liga o pacote deste checkout. Não assumir que a nova entrada standalone será usada automaticamente só porque existe upstream.
- Atualizar fontes sem compilar não atualiza `lib/`; rebuild no checkout ligado em uso merece coordenação para não afetar sessões abertas.

### Privacidade

- [61677067](https://github.com/ccch1mneyyy/dsh-TUI/commit/61677067): remove overrides de privacidade do `cordis.patch.yml`; config overrides 8 → 6. `session-telemetry-otel`, `plugin-package-inventory-deepseek` e `session-log-deepseek` herdam defaults oficiais.
- Metadados de sessão/inventário podem ser enviados ao baseURL conforme defaults oficiais. Feedback continua condicionado a feedback explícito.
- `DSH_TELEMETRY_MODE` isoladamente não controla session-log/inventory. Decidir e preservar overrides locais explicitamente antes de promover uma atualização.

## 6. Os cinco commits locais que precisam sobreviver

| Commit | Intenção local |
|---|---|
| `fe25d475` | Comando externo de planos e fonte Markdown |
| `a2feaeab` | Ponte grammar pelo Ctrl+G |
| `3b165878` | Apresentação grammar e atalhos do editor |
| `c4f04010` | Separação managed-plan / native-plan |
| `ebea5d73` | Retry policy pertencente ao provider |

Áreas com alterações dos dois lados: README/README_ZH, package, Chat, PromptInput, Launchpad, ui, i18n, tips, plugin/index/oauth profiles, completion/extensions/state/mode-permission-actions e testes de policy/UI.

Riscos concretos:
1. Permission persistence e `/plan` upstream podem recolocar o modo native-plan no fluxo deliberadamente separado pelo fork.
2. Caret/startup drafts podem interceptar Ctrl+G ou quebrar aplicação da correção grammar no editor.
3. Policy fixa de OAuth upstream pode sobrescrever a semântica provider-owned local.
4. Entrada/host e migração de settings podem mudar resolução de profile, defaults e credenciais/config.

Não foi simulado merge; sobreposição de arquivos é risco de revisão, não declaração de conflitos inevitáveis.

## 7. Recomendação ao dono

**A atualização vale avaliar, sobretudo por `/resume`, foco/scroll e `/model` mantendo o ID. Não vale trocar o fork por upstream puro nem dar pull/rebuild diretamente na instalação em uso.**

Escolhas:

### A — Entregar Favoritas no fork atual primeiro

- Menor risco imediato; nenhuma dependência da versão nova para a funcionalidade.
- Plano de Favoritas usa a base `ebea5d73`, pin store existente e alterações localizadas.
- Custo: futura integração v0.15 precisará reconciliar novamente os mesmos hooks de lista/foco.

### B — Integrar v0.15 com os cinco patches locais, depois Favoritas

- Melhor ordem se já houver intenção de atualizar: evita desenvolver a funcionalidade sobre foco/cache que serão substituídos.
- Requer uma tarefa separada aprovada, checkout de integração isolado, resolução explícita de managed-plan/grammar/retry/privacidade/settings, build e smoke reais da entrada fish/profile.
- Não é parte da tarefa simples de Favoritas e não está autorizada por este relatório.

### C — Cherry-picks seletivos

- Só para correções pequenas demonstradamente independentes, por exemplo avaliar CJK emphasis `52f4f50b`.
- Não puxar um pacote parcial de cursor, cache ou host sem fechar dependências. `0d629068` precisa avaliar a colisão com `/plan` local.

**Decisão solicitada:** manter a base atual para Favoritas ou abrir primeiro uma tarefa separada de integração v0.15? Sem essa decisão, o plano de Favoritas permanece ancorado no fork atual; nenhuma atualização automática.

## 8. Critérios mínimos de uma eventual atualização

- Preservar e testar os cinco patches locais e os overrides de privacidade desejados.
- Validar imports/runtime realpath/peers no DSH rc.2 instalado e launcher fish/profile com link.
- Validar migração de settings e precedência de env/defaults sem expor credenciais.
- Validar resume fail-closed, `/model` estável, `/permission`, managed plans, Ctrl+G/grammar, OAuth/retry, `/bg`, status e drafts.
- Build/gates/pacote e regressões focadas; inline/fullscreen, teclado e TTY.
- Promover só após evidência; não encerrar sessões do usuário nem commitar/push/publicar sem pedido específico.

## 9. Limitações da evidência

Comparação estática dos commits disponíveis em 2026-10-13. Não comprova ganhos de desempenho medidos, ausência de regressões ou compatibilidade completa de build/runtime. Revalidar HEADs e árvore antes de uma futura integração. O goal desta sessão encerra ao entregar plano + relatório, não ao implementar ou atualizar.
