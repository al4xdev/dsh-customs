# Mobile companion

Frontend Web mobile-first para o **profile companion** existente do DSH. Projeto independente, não plugin do host e não fork do TUI.

Duas telas: conversas e chat. Sem configurações, seleção de modelo/profile, workspaces ou terminal. Outros projetos são consultados pela ferramenta `session` dentro da conversa. O renderer oficial mantém Markdown, código, tabelas, streaming, histórico, cards de ferramentas, aprovação e perguntas.

## Executar

Requer Node >=22 e instalação durável do DSH **0.2.0-rc.2** em `~/.local/share/dsh-cli`. O backend companion deve estar ativo em `127.0.0.1:3081`, com seu preset único `companion` e suas políticas existentes. Não cria nem modifica esse profile.

No diretório deste projeto:

```fish
npm ci --include=dev
npm run check
npm start
```

O frontend escuta **127.0.0.1:3082 por padrão**. Para acesso pelo IP da máquina em rede confiável:

```fish
npm start -- --host 0.0.0.0 --port 8889
```

Abra `http://IP_DA_MAQUINA:8889`; `0.0.0.0` é o endereço de bind, não o endereço para abrir no celular. Isso expõe HTTP em todas as interfaces IPv4, sem criptografia; não publique na internet. A autenticação nativa continua obrigatória. Hostnames arbitrários não são aceitos, apenas os IPs locais das interfaces identificados ao iniciar o servidor.

Para o acesso privado recomendado, use o link do companion; no deployment descrito abaixo o endereço público8443 permanece o mesmo. Nunca coloque tokens no código, variável de build ou armazenamento do browser. O login/cookie nativo é encaminhado pelo proxy. Caso o ambiente npm bloqueie o postinstall do esbuild, o binário opcional distribuído pode funcionar sem esse script; não contorne políticas de instalação.

`DSH_RUNTIME_NODE_MODULES` pode indicar outro diretório de dependências durante o build. A versão do runtime continua estritamente validada; atualização do DSH exige revisão explícita, não mistura silenciosa de versões. Os aliases de declarações em `tsconfig.json` apontam para a instalação durável deste host; ao mover o projeto/runtime, ajuste também esses aliases.

## Tipagem e lint

React permanece o framework. TypeScript usa `strict`, opcionais exatos, acesso indexado verificado, catches `unknown` e contratos públicos reais dos serviços/slots do DSH. Dados de rede são validados antes de uso. As dependências locais incluem apenas os tipos React18; o runtime React/store vem do singleton oficial, sem uma segunda instância empacotada.

`npm run typecheck` verifica o código TypeScript próprio; `npm run lint` exige zero warnings com ESLint type-aware estrito, promises, React hooks e acessibilidade. Servidor/scripts/testes JS recebem regras JS reais, não uma alegação de tipagem equivalente. Código upstream/gerado não é mascarado como código próprio aprovado. `npm run check` executa typecheck, lint, testes e build, nessa ordem.

## Arquitetura

- `src/`: shell React e navegação próprios, usando React/store únicos do Web oficial.
- `server/`: proxy HTTP/WS same-origin para o backend fixo3081, catálogo público read-only de headers Zstd e transformação do bootstrap.
- `styles/`: layout de uma coluna, safe-area, viewport dinâmico, alvos de toque44px e input16px.
- `public/`: ícone e manifest local. Sem service worker: não há cache offline de conversas, API ou credenciais. Adicionar à tela inicial depende do browser; não é APK.
- `test/`: regressões isoladas de auth/proxy/profile/bootstrap/navegação. Artefatos de build em `dist/`, ignorados pelo Git.

O bootstrap e a composição modular do Web são reaproveitados. O shell não envolve uma página desktop num iframe e não esconde toda a página com CSS. Substitui o root e a navegação oficial, cuja restauração automática poderia abrir sessões de outros profiles. A lista é filtrada pelo **header persistido `agentPreset: companion`**, antes de qualquer `retain`/follow. Títulos e atualização podem ser suplementados por projeções cached do `session/list` oficial, sem abrir agentes ou ler históricos para filtrar.

Novos chats passam por criação nativa com preset explicitamente fixo. A resposta validada permite uma pequena janela de cache para chats vazios ainda não materializados; um header persistido estrangeiro sempre vence e revoga essa entrada. Links/Back/Forward são revalidados; nenhuma seleção antiga de workspace é restaurada. O URI inclui somente o id do chat, nunca credenciais.

O serviço é integrado ao backend companion dedicado. O proxy `/api/` continua sendo a API **do proprietário autenticado**, não um firewall de RPC para clientes hostis. A ausência de telas de configuração não é uma nova barreira de autorização. A verificação do preset único não prova criptograficamente o profile/políticas: preserve o serviço companion e sua configuração restrita existentes.

### Fronteira de adaptação upstream

Versão/tag: `dsh-v0.2.0-rc.2`, commit `639ed015397290b3745d163aafe02ffee4aa3f84`, repositório [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2).

Os bundles browser `@deepseek-ai/dsh-client-*` usam `__ModuleLoader__`, não imports ESM isolados. Este projeto mantém a closure de módulos do renderer/conversation/composer e infraestrutura, mas exclui telas de settings/model/preset e o HMR que poderia restaurar o roster desktop. Cada bundle servido recebe hash de conteúdo e publicação atômica; o runtime instalado nunca é editado.

Única adaptação textual no bundle nativo: `server/native-adaptations.mjs` omite o callback `onBranch` do footer. rc.2 não fornece um switch público e o callback original cria fork diretamente, antes da navegação protegida. O recorte é exato, exige um único match e falha fechado quando o código upstream muda. Parser, transcript, cards, composer, streaming e confirmações permanecem originais. A licença MIT do DeepSeek e OFL da fonte Montserrat são copiadas para `dist/licenses/`. Dependências upstream mantêm suas respectivas licenças.

## Publicar no serviço atual

O unit de referência está em `deploy/dsh-mobile-companion.service`, com caminhos deste host. Produção usa `server/start.mjs`, que não possui opção/env de login de teste ou backend arbitrário.

1. Build/test e verificar que nenhuma instância temporária de auditoria ocupa3082.
2. Instalar o unit em `~/.config/systemd/user/dsh-mobile-companion.service`; executar `systemctl --user daemon-reload` e `systemctl --user enable --now dsh-mobile-companion.service`.
3. Alterar **somente** a rota Tailscale HTTPS8443 para `http://127.0.0.1:3082`. Backend3081 continua ativo. HTTPS443/Web3080 e TUIs não devem mudar.
4. Verificar login privado, chat/streaming, histórico e confirmação pelo endpoint8443; não imprimir o link/token em terminal ou journal.

Publicação neste host em 2026-10-13: unit frontend ativo em3082 e HTTPS8443 apontando para ele; HTTPS443 permanece em3080, com os processos Web e companion originais preservados. O endpoint público sem autenticação retorna401; `/__test/login` em produção retorna404. Login nativo HTTPS retornou303, seguido por bootstrap mobile200 e catálogo autenticado200 exclusivo companion, sem imprimir credenciais. Renderer, histórico, resposta real e reconexão foram verificados no navegador loopback usando a autenticação nativa já estabelecida. Teclado/bounce físicos ainda exigem validação no aparelho.

Rollback: restaurar a rota8443 para `http://127.0.0.1:3081` e parar/desabilitar o unit frontend. Não apagar/converter históricos, reinstalar profiles ou reiniciar o Web original.

## Limites e evidência

Testes automatizados não representam um Android/iPhone físico. Browser mantido emulado utiliza393×852, DPR2 e touch/mobile; verificar também320/360 e landscape, overflow, histórico, reconnect e aprovação. O teclado físico, barras do sistema e instalação na tela inicial dependem de teste no aparelho. O catálogo atualmente retorna até100 chats; links antigos autenticados continuam passando pelo guard de header, mas paginação além desse limite requer melhoria. Headers sem título usam um identificador curto para distinguir conversas.

Helpers de login/fixtures/captura são locais em `.dumps/mobile-companion`, fora do produto. A seam de login existe somente como opção de construtor para auditoria loopback e fica desabilitada na CLI de produção. Não publicar instâncias de auditoria ou auto-answerers de aprovação.
