# DSH: oficina portátil validada; migração live ainda não executada

## Estado e fronteira
A preparação autorizada pelo proprietário foi implementada e verificada. `dsh-customs` centraliza fontes, pins, patches, build/artefatos e wiring; dotfiles continua dono de configs `.dsh`, preferências e launchers. Usamos o goal da oficina para orientar implementação e validação.
**A tarefa 7 não está concluída como limpeza/consolidação.** Passa para o dono porque o restante exige decisão de alvos e janela para mudanças live. Aprovar este registro/organizar a categoria não é consentimento genérico para apagar caches, migrar perfis ou encerrar sessões. Nenhuma operação live está autorizada por esta revisão.

## Entregas verificadas
- `tools/workshop/manifest.json`: DSH0.2.0-rc.2, fontes/pins/PM e estratégias revisadas de três forks.
- `tools/workshop/{core,bootstrap}.mjs`: doctor/plan estritamente metadata-only; prepare cria plano/seed sem subprocessos; bootstrap explícito exige network+build consent e destino novo.
- Guards: overwrite/traversal/symlinks/ancestors HOME, `.dsh`, runtime, configs/caches incluindo npx e outros Git worktrees são recusados. Própria `.dumps` é exceção restrita de ensaio. HOME/XDG/DSH_HOME/cache/temp dos subprocessos são privados; configs/redirects npm/pnpm/Git herdados não redirecionam install a roots live.
- TUI: receita upstreamc2eee952 + patch32arquivos equivale ao fork comprometido c4f040104e9d45955ed346ce0b1a2d8cb2fab779; hash f2c4747d38adb0b6de2c786b449987af2d3e62e9fbcff2cdf69a8504690a908c, vendor614dfa1ac168db79fcf4577cf0ebb34e2e3b944b/pnpm11.21.0.
- Pi: baseline c043dedb60695f45fd9577ced676074f08d7f9b0/0.87.1, correção reasoning default; donor oficial da instalação seed nova, não catálogo alterado do host. Prepare aceita source/donor/outputroot e defaults HOME/XDG, sem generalizar os promoters históricos. Novos WS commits/upgrade em outra tarefa não entram por HEAD.
- Antigravity: pin7dcd24272a0897cb0698b24cc9edc0a587c3bea7, lib committed/prebuilt. Patch hashado marca peer legado de tipos/client opcional; guard prova lib inalterado e ausência de referência JS ao peer. Sem force/legacy-peer-deps. Compilação standalone e integração web permanecem não comprovadas.
- Root dependency/lock YAML2.9.1 para ativação independente do antigo npx; docs raiz/guiaoficina/task10 histórico/notaPi atualizadas.

## Evidência real, não apenas mocks
- Ensaio1: seed e builds TUI/Pi+packAG passaram; finalize falhou ERESOLVE no peer antigo AG. Receipt preservado como falha, nunca reclassificado.
- Ensaio2: bootstrap completo passou após patchAG explícito, sem perfil ativado.
- Ensaio3 final: `.dumps/workshop-build3-20261012/receipt.json`, exit0 com HOME/cache/temp privados e caches novos. CLI/adapter0.2rc2, scopedPi0.87.1+alex.codex-default.7f8948d3c423, identities Cordis/scope compartilhadas. Todos comandos OK, installedtrue, profileActivatedfalse.
- TUI/Pi tarballs byte-idênticos entre três ensaios; AG idêntico entre dois com patch. Observação destes ensaios, não garantia bit-a-bit entre datas/registries. Locks/SHAs em receipts.
- 197 testes passaram: oficina24, LTS74, MCP29, managedplans70; também grammar-config/refinements/native checks e git diff --check. Diff do sourceTUI c2→c4 verificado separadamente para preservar bytes de unifiedpatch.
- Guia durável `tools/workshop/README.md`; evidência local resumida `.dumps/workshop-portability-validation.md`. `.dumps` não é backup durável e nenhum artefato novo dela foi ativado.

## Limites honestos da base
Bootstrap instala o runtime corrigido e Antigravity, produz tarballTUI, mas não monta/configura/ativa perfis nem altera launchers/serviços/dotfiles. Modelos locais personalizados do catálogo antigo não são copiados silenciosamente. Primeiro install npm ainda resolve transitivas; receipts selam o resultado, não toda resolução futura. Não houve boot/dump-config, LLM/login/inferência, commit/push/publicação nem modificação de runtimes/fontes/perfis ativos nesta etapa. Mudanças/locks/tooling precisam entrar no Git pelo proprietário antes de um clone remoto levar a nova base.

## Decisão necessária antes da migração live
Manter `/home/alex/.local/share/dsh-cli` como runtime canônico, preservar forks/fontes. Propor uma janela apropriada **com alvo/perfil/serviço exatos e rollback** em revisão de execução separada. Não executar agora:
1. Revalidar inventário/links/processos e novas alterações de outras tarefas; snapshot antigo não comprova sobra hoje. Web ainda foi observado em npx; shared tinha401links para lá e207ENOENT; adapterTUI tinha referência em `.dumps`.
2. Fazer backup persistente consistente de perfis/locks/mapas/launchers/serviço e dados relevantes, incluindo rollback privado; não guardar somente em `.dumps`/`/tmp` nem imprimir segredos.
3. Migrar dependência scratch e shared link graph para artefatos/host duráveis revisados; resolver identidade Cordis/scope e OAuth importer real, sem correção indiscriminada de links quebrados.
4. Migrar serviço web/launchers dotfiles da invocação npx móvel para root escolhido, preservando flags/perfis; aceitação web/HTTP/browser separada de TUI. Não usar `dsh --dump-config` live como diagnóstico.
5. Após todos dependentes resolvidos e processos relevantes encerrados pelo proprietário, validar nova abertura e rollback. Só então propor quarentena recuperável do npx **exato**, nunca npm cache clean global ou remoção de outros projetos/caches.

Nenhuma parada/restart, remoção/move, troca de links/perfis ou instalação live pode decorrer automaticamente deste registro. A oficina está pronta como base de preparação; consolidação fica aberta para essa decisão.