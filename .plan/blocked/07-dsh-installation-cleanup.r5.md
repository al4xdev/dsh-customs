# DSH — reinventário atualizado; migração live ainda não autorizada

## Estado e autoridade
A preparação portátil de 2026-10-12 foi validada; sua baseline continua histórica, não corresponde automaticamente ao host que evoluiu. Em 2026-10-13 o proprietário autorizou **reinventário somente leitura** enquanto outros agentes terminam. Usamos um goal próprio para orientar essa investigação, concluído após verificar o relatório.

**Plano7 permanece Blocked.** Este registro não autoriza install/build/promoção, parada/restart, alteração de links/perfis/serviços, migração ou retirada. A janela ainda precisa ser confirmada pelo proprietário e o plano de execução deve ter alvos exatos e rollback em revisão separada. Aprovar este artefato de categoria blocked não é aprovação de operação live.

## Fronteira reafirmada pelo proprietário
- dsh-customs: fontes, recipes/pins, patches, builds, artefatos e wiring.
- dotfiles: configs pessoais `.dsh`, preferências e launchers shell/serviços.
- Dados privados/sessões/OAuth permanecem fora da receita e dos relatórios públicos.
- **Frontend externo `frontend/mobile-companion` excluído da instalação e migração:** não é plugin nem componente do bootstrap. Seu código/cache/UI não foi auditado. Backend DSH companion aparece somente como consumidor da CLI a preservar.

## Entregas históricas preservadas — não confundir com host atual
Baseline workshop: CLI0.2.0-rc.2, TUI upstreamc2 + patch equivalente ao commitc4f040, Pi c043 reasoning/default, Antigravity7dcd prebuilt com optional-peer patch. Guards de destino/consentimento/isolation, doctor/plan metadata-only e bootstrap em destino novo continuam registrados. Ensaio1 falhou ERESOLVE preservado; ensaios2/3 passaram, sem ativar perfis. Ensaio3 `.dumps/workshop-build3-20261012/receipt.json` teve HOME/cache/temp privados, identidade Cordis/scope compartilhada e profileActivatedfalse. Validação daquela etapa:197 testes mais gates associados. Detalhes imutáveis na revisão4 e `.dumps/workshop-portability-validation.md`; receita durável em `tools/workshop/README.md`.

A task29 posteriormente registrou publicação assinada dos quatro source repos; aquela pendência de publicação da revisão4 mudou. As alterações novas abaixo continuam locais/não pinadas na receita; publicação histórica não comprova publicação delas.

## Reinventário de 2026-10-13
Evidência local: `.dumps/dsh-installation-reinventory-20261013.md`. Processos/links observados às15:56–15:58UTC; fontes/hashes/receipts observados nesta rodada. Agentes podem continuar editando, portanto repetir snapshot antes de executar.

### Instalações e dependentes
- `/home/alex/.local/share/dsh-cli`: CLI0.2.0-rc.2; quatro TUIs dsh-tui (PIDs632046/744341/756298/878443) + `dsh-companion.service` PID796675/loopback3081.
- `/home/alex/.npm/_npx/1e7f6d9597241db0`: CLI0.2.0-rc.2; `dsh-web.service` launcher827/DSH1456/loopback3080. Unidade ainda chama npx, não canônico.
- Shared profiles:401 links resolvidos nesse npx,207 quebrados; não classificados como dispensáveis nem alterados. AdapterTUI segue em `.dumps/pi-ai-fork/runtime-cc0c4b95b7145f89`. CheckoutsTUI/AG também são dependências ativas.
- Fish dsh → local-model-launch canônico. Fim de dois agentes não equivale a fechamento dos quatro TUIs. Backend companion precisa sobreviver à consolidação, mas frontend externo não entra no escopo.

### Código atualizado não coberto pela baseline
- TUI HEADc4f040, dirty5modified+1untracked: retry OAuth por provider/task32 promovido, fora do patch histórico.
- AG HEAD413f559, dirty11modified+12untracked: usage/resiliência/signaturesV4; lib/index.js atual hash3c803a50… confere receipt durável task42V4, não o prebuilt antigo.
- Pi instalado0.87.1+alex.codex-default.206545bfd51e; manifest ainda aponta ao artefato durável796b9c3c…; task38 adicionou structured-failure observer **sem alterar package/version/lock**. Hashes atuais selecionados de index/API/helper batem com receipt durável task38. Reinstalar somente o tarball original perde a overlay.
- Pi source existe em cópias/staging. `.dumps/pi-ai-fork/ws-review/.git` aponta ao antigo `/home/alex/git/my/pi/.git/worktrees/ws-review`, hoje ausente; Git falha128. Nenhum HEAD/remoto/dirty atual desse worktree foi confirmado. f5a24 é provenance/publicação histórica, não HEAD atual comprovado. Task38 usa staged source + patch determinístico mantido no repo; não há conclusão de perda do código.
- Self-heal é plugin separado e está referenciado no patch dsh-tui, mas não no activation manifest observado. O gerador substitui runs alex-*; sync write sem revisão pode removê-lo (ou recusar múltiplos runs). Session bridge é declarada para futuros launches, não apareceu como path literal nesse patch; não inferir rollout por manifesto nem injetar agora.
- Browser tem runtime próprio Playwright1.64.0/MCP2.3.1 em plugins/browser/runtime e cache separado; não é sobra do root npx. install.sh continua TODO, não instalador.

Receipts existentes em `~/.local/share/dsh-customs-backups/{long-retry-20261013-task32,codex-failure-categories-20261013-task38,antigravity-resilience-20261013-task42-v4}` são backups/promoções específicos históricos, não snapshot integral consistente atual. Nenhum novo backup de produção foi feito.

## Proposta para a janela — execução separada, não agora
1. Proprietário confirma término dos agentes e janela; revalidar fontes, module refs, PIDs e consumidores. Não interromper automaticamente esta conversa/outros TUIs.
2. Preservar o canônico **atual**, com overlays/model catalog e configurações existentes; não substituí-lo pela oficina baseline de ontem. Caso haja reinstall/fresh rebuild, primeiro reparar provenance Git Pi e consolidar patches/artefatos novos com identidades corretas, preservando melhorias32/38/42/43 conforme revisão final dos agentes.
3. Resolver drift self-heal/session/activation e planejar substituição da dependência scratch por dependência durável; não rodar activate write como preflight.
4. Backup privado persistente de runtimes/overlays, fontes necessárias, perfis, locks, link map, launchers/unidades e dados relevantes. Controller de execução deve sobreviver à parada dos consumidores; não confiar em `.dumps`/`/tmp` ou restaurar profile histórico por cima de melhorias posteriores.
5. Compor/testar offline grafo Cordis/scope/importers e hooks, TUI/web/companion e rollback. Auth, chamadas reais e modelos permanecem decisões separadas.
6. Em execução aprovada, migrar shared/adapter e invocação web para roots/artefatos duráveis, preservando configs dotfiles/flags/portas e disponibilidade companion. Não executar dsh --dump-config live.
7. Somente após zero referências/processos para o npx **exato**, propor quarentena recuperável persistente desse alvo. Não npm cache clean global, remoção indiscriminada de broken links ou limpeza de .dumps inteira.

## Resultado desta rodada
Reinventário registrado e fingerprints selecionados conferidos. Nenhum install/build/fetch/import de provider/teste/modelo/login, alteração de runtime/config/perfil/link/launcher, stop/restart, move/removal ou commit/push. Fontes dos agentes preservadas. Nenhum alvo de retirada imediata comprovado. Consolidação/migração continua aberta e Blocked.