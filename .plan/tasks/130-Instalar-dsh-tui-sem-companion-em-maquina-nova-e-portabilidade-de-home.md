# Instalar dsh-tui (sem Companion) em máquina nova e tornar perfis/plugins portáveis de HOME

## Pedido
Instalar nesta máquina (home `/home/alexsandro-pessoa`) só o `dsh-tui` customizado e seus
plugins, com as configs do dotfiles, igual ao fluxo do lab (home `/home/alex`). Sem
Companion (app/perfil/serviços), sem web/headless/tui nem `dsh-web.service`: o `dsh-tui`
roda o core `dsh` como base na própria instância do terminal.
Decisão do dono: corrigir `/home/alex` **na fonte** (dotfiles + plugins + geradores) e
aplicar também no lab, não symlink nem `sed` local.

## Estado encontrado (2026-10-16)
- Lab: `dsh-customs` em `096bd6f` (igual a este clone), TUI `custom@4d0b808`
  (= pin da receita `ebea5d7` + 2 commits: favoritos globais, ownership de questions),
  Antigravity `main@77c0c0f` (= pin). Os três limpos e sem commits locais. Node v26.10.
- Esta máquina: Node 25.7 (nvm.fish), git/g++/python3/pkg-config, GitHub e npm acessíveis.
- Dotfiles atualizado por fast-forward para `b850ed3` (pull com rebase recusava por
  mudança local não relacionada em `alacritty.toml`; `merge --ff-only` preserva).

## Lacunas da receita/repos (para o dono melhorar o git)
1. **`local-model-launch.mjs` não versionado.** O `dsh.fish` do dotfiles chama
   `~/.local/share/dsh-cli/local-model-launch.mjs`, que só existia no runtime do lab.
   Ele roda `node_modules/.bin/dsh --profile dsh-tui --patch /dev/fd/3` injetando o
   provider `strata-local` (`http://127.0.0.1:8080/v1`); sem servidor local segue sem
   erro. Precisa de `js-yaml` e `@deepseek-ai/cordis-plugin-include` no runtime.
   → Versionar (dotfiles ou dsh-customs) e instalar junto com o runtime.
2. **Regressão em `096bd6f`: `tools/clean-install/install.mjs` quebrava no import em
   máquina limpa.** `profile.mjs` passou a importar `tools/resilience/profile.mjs`, que
   carrega `yaml` no load, antes de existir qualquer `node_modules`. Afetava também o
   `install.sh --fresh` no Docker. Corrigido: `install.mjs` importa `./profile.mjs`
   só no passo de seed (mesmo padrão lazy do builder de recovery).
3. **Receita clean-install é Docker-only e Node 24 exato.** Para host com `~/.dsh`
   restaurado pelo dotfiles não havia caminho. Agora `tools/clean-install/host.mjs
   --fresh` compõe as mesmas etapas exportadas (buildForks/preparePi/installProtocol/
   prepareUnifiedRecovery/sharedGraph) e difere só em: sem `/.dockerenv`, Node ≥24,
   headers do node-pty do prefixo do Node ativo, sem seed de perfil; cria checkouts,
   links de `node_modules` e launcher onde faltam. Primeira execução real feita pelo
   driver `.dumps/host-install-20261016/install-host.mjs` (mesmo código + pin TUI).
7. **`@deepseek-ai/cordis` 4.0.5 dividia o grafo.** Publicado depois do build Docker;
   o `dsh` (`~4.0.4`) aninhava outra cópia e o `sharedGraph` recusava (1ª tentativa,
   `.dumps/host-install-20261016/attempt1-*`). Corrigido com override `cordis: 4.0.4`
   no `runtimePackage` (versão exata do Antigravity e do lab).
8. **Hardcodes de `/home/alex` em ferramentas/testes** que impediam rodar os testes
   aqui: `tools/clean-install/profile-transfer{,.test}.mjs`, `tools/activate.test.mjs`
   (corrigidos com `homedir()`). `plugins/common.mjs` mantém o fallback `/home/alex`
   de propósito: entra nos bundles imutáveis controller5/self-heal6 com hash revisado,
   e em runtime nunca é usado (o `process.argv[1]` do `bin.js` resolve antes).
4. **Runtime do lab ≠ receita.** Lab: `@deepseek-ai/dsh` + override pi-ai em
   `~/.local/share/dsh-cli`, TUI/AG via `link:` do perfil para os checkouts, mais o
   histórico de consolidação (404 links). Receita: um runtime único com TUI/AG/pi-ai
   empacotados e `profile/node_modules` → runtime. Esta máquina segue a receita.
5. **`/home/alex` fixo** (em correção nesta tarefa):
   - Perfil `dsh-tui` do dotfiles: `name:` dos `alex-*`, include de
     `standard-managed-plugins.yml`, `antigravity-tui-login`, include liangshen,
     includes do bloco research, paths dentro de `alex-research-*.yml`, `link:` do
     `package.json`.
   - Plugins: `plugins/common.mjs` (fallback de resolução), `plugins/trash/index.mjs`
     (proteção do runtime), `plugins/workspace-context/index.mjs` (texto do prompt).
   - Geradores que reescrevem absoluto: `tools/activate.mjs`,
     `tools/research-activation.mjs`, `tools/resilience/profile.mjs`.
   - Fora de escopo (documentado): `tools/task10-profile/promotion.mjs`,
     `tools/clean-install/profile-transfer.mjs`, `tools/resilience/pi-ai-candidate-worker.mjs`,
     `plugins/session-create/contracts.mjs` (Companion), docs históricos.
6. **`activate.mjs` não aceitava o perfil restaurado** (três runs `alex-*`): agora
   respeita o bloco do `research-activation` e dobra o `- insert:` isolado do
   migrador. `research-activation.mjs` (exige os cinco perfis) passou a aceitar e
   emitir caminhos relativos ao perfil; sem isso, a conversão quebrava o `--check`.
   O `alex-session-bridge` (só Companion) é aplicado no `dsh-tui` do lab, como o
   manifesto declara; nesta máquina fica desligado na camada local.

## Portabilidade (decisão do dono: corrigir na fonte)
- Semântica verificada no DSH: `baseUrl` do loader = diretório do perfil
  (`profile-boot`), e `name`/`path` com `./`/`../` resolvem por ele
  (`cordis-plugin-loader` `import`, `cordis-plugin-include` `path`).
- `tools/profile-paths.mjs`: forma relativa ao perfil. `activate.mjs` e o migrador de
  resilience (`profileDir`) passam a emitir/aceitar relativo; overlay do repo segue
  absoluto (`--patch` ancora no perfil).
- `tools/profile-portable.mjs`: conversão com prova estrutural e renomeação em cascata
  dos `alex-research-<hash>.yml`. No `dsh-tui`: 33 reescritas, 3 renames.
- Prova: `--dump-config` aqui vs lab resolve os mesmos `file:///HOME/...`; só mudam
  dobra de linha e texto dos includes (`.dumps/host-install-20261016/n-{lab,host}.yml`).
- Launcher versionado em `tools/dsh-launcher/` lendo include relativo ao perfil.
- Plugins: `trash` (runtime protegido via XDG_DATA_HOME/homedir), `workspace-context`
  (Home/projects do `homedir()`).

## Configuração só desta máquina
Providers/modelos específicos da máquina ficam em `~/.dsh/cordis.patch.yml` (camada do
DSH depois do perfil, ignorada pelo dotfiles). Detalhes locais em `.dumps/`, não no git.

## Fora do escopo desta máquina
Companion (`alex-session-bridge` é só do Companion; `companion: skin: whaleGirl` no
`dsh-tui` é o mascote da sidebar do TUI e fica), web/headless/tui, systemd.
Dependem de uso, não de load: `alex-browser` (`npm run browser:install`, ~680 MiB),
`alex-gen-image` (CLI `agy`), `alex-music` (`~/git/my/simp_mcp` + `uv`), research
Reddit/context7 (chaves). Login OAuth (Codex/Antigravity) é manual na TUI.

## Passos
- [x] Pull do dotfiles; levantamento do lab por SSH somente leitura.
- [x] Correção do import lazy em `install.mjs`.
- [x] Build host: runtime, forks, pi-ai, protocolo self-heal, recovery (2ª tentativa).
- [x] Forma portável em plugins, geradores e perfil; testes do repo.
- [x] Checkouts, links de `node_modules`, launcher; 19 plugins + 4 liangshen importam;
      TUI abre (guia de boas-vindas). Dono testou a TUI aqui: normal.
- [x] Camada local da máquina (`~/.dsh/cordis.patch.yml`).
- [ ] `host.mjs --fresh` validado numa HOME isolada.
- [ ] Aplicar no lab (patch de texto), testes e `--dump-config` lá; teste do dono na TUI do lab.
- [ ] Commits (dsh-customs, dotfiles) a partir do lab.
