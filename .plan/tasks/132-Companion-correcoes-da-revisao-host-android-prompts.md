# Companion: correções da revisão (host, Android, prompts)

## Origem (2026-10-16)
Quatro revisões somente leitura (núcleo do host, plugins `companion-*`, app Android,
prompts), consolidadas e aprovadas pelo dono para correção: host JS, Android e prompts.
Decisão do dono: **manter** o `alex-session-bridge` no `dsh-tui` do lab. É o único caminho
para o Companion falar com agentes do `dsh-tui` (instância fechada) e o acesso já fica
dentro do tailnet. Risco aceito e registrado: `grant.key` é legível por qualquer processo do
usuário, inclusive o bash de um agente TUI `danger-full-access`, que poderia forjar grants e
injetar mensagens em outras sessões.

## Contrato compartilhado host ↔ app (A1)
`/api/session/uploadFileBinary` aceita até 20 MiB + folga com `Content-Length` obrigatório;
`Transfer-Encoding: chunked` continua 411; demais POSTs seguem com 1 MiB. O app passa a
enviar corpo com tamanho conhecido.

## Host JS (plugins/session, session-create, companion-*, frontend/mobile-companion/server,
## tools/session-companion)
- A1 lado host (proxy 3082 e `companion-transport/request-budget.mjs`).
- A4: aprovações (send, resume, session_create, Bash, download) escapam/recusam Unicode
  invisível (`\p{Cf}`, `\p{Co}`, tags U+E0000–E007F, bidi, CR) e mostram bytes + sha256.
- A5: negação de escalada de sandbox e de `workdir` com texto acionável para o modelo.
- Bridge: descoberta conta só `.json` e ignora/remove registros de processos mortos; handler
  não executa pedido cujo socket já caiu ou passou do prazo; falha `retrySafe`/sem efeito
  não vira UNKNOWN no ledger; `owner.lock` grava pid/startTime e reporta dono morto; resume
  com falha sem efeito não queima o recibo; `close()` com timeout e try/finally.
- Download: TTL renovado no commit; rate limit só após validar ticket (ou por peer);
  denylist ampliada (credenciais de CLIs, keyrings, chaves); testes do plugin (hoje 0).
- Push: status com motivo específico ao bater limite; detecção de lock órfão.
- `file-events`: decoder por frame (Node 25.7 decodifica só o 1º frame zstd).
- Descrição da tool `session`: aviso de conteúdo não confiável no início; `session_create`
  sem o ramo `new_project` indisponível; termo "dono" para o humano.
- Portabilidade: sem `/home/alex` em código/testes do Companion (homedir/XDG_DATA_HOME/
  DSH_HOME); testes que dependem de `.dumps` ausente passam a usar fixture.

## Android (android/companion/app)
- A1 lado app: upload com `Content-Length`.
- A2: ação "Reenviar" para envio UNKNOWN reutilizando `requestId` e literal; "Nova conversa"
  incerta liberada por ação do usuário; `onStop` ignora `isChangingConfigurations`.
- A3: reconexão do socket de eventos com backoff enquanto houver tela que responde
  aprovações; aviso "aprovações indisponíveis"; tratar `onClosing`.
- Item fora do vocabulário/limite não derruba a conexão (isolar e marcar "ver no PC").
- `openSocket` sem cookie não derruba o app (try/catch → falha tratada).
- Permit de controle do goal renovado quando velho; demais itens baixos se seguros.
- Testes unitários novos; build e testes Gradle rodam no lab (sem toolchain nesta máquina).

## Prompts (dotfiles)
- `~/.dsh/AGENTS-Companion.md`: cerca explícita de conteúdo não confiável e de não pôr
  conteúdo lido do PC em consultas web sem pedido; remover duplicações e regras impossíveis
  com as tools reais; quebrar bullets longos. Método de pesquisa mantido até o dono decidir.

## Aceite
Suítes dos diretórios tocados verdes nesta máquina (sem `/home/alex`) e no lab; Gradle
`testDebugUnitTest` verde no lab; deploy no lab com reinício combinado do `dsh-companion`.

## Estado (2026-10-16)
- [x] Host JS: todos os itens; suítes do escopo verdes (session 160/160, session-create 67/67,
      companion-download 13/13 novos, push 37/37, native-host 53/53, workspace 37/37).
- [x] Android: todos os itens exceto push (decisão de design documentada em NOTIFICATIONS.md);
      build/testes Gradle no lab.
- [x] Prompts: `AGENTS-Companion.md` enxuto (8051 → 6182 bytes) e revisado por crítico.
- [x] Extensão aprovada (abc5b3e): `ask`/`recap` (btw) pelo bridge, sem aprovação, `session` com
      `ask`/`recap` primeiro e `read` como último recurso; CRLF normalizado para LF.
- [x] Deploy no lab com reinício do `dsh-companion`; APK debug 0.16.0 instalado via `adb` do lab.
- [x] Auditoria de prompt (3445bd5): `npm run prompt:audit`, baseline do companion gerado no
      lab (nesta máquina o companion difere por caminhos só do lab: esperado).
- [x] Latch `stale`: o ConfigEditor do SDK reconcilia a linha do host com caminho cru (boot usa
      URL `file:`); o host comparava `name` byte a byte. Agora compara o módulo importado.
