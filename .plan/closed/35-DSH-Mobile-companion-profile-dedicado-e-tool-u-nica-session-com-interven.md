# DSH Mobile companion — profile dedicado e tool `session`

## Objetivo
Criar um profile `companion`, servido pelo bundle Web compatível com DSH Mobile, para conversar sobre outras sessões sem modificar seus projetos. Encapsular descoberta, leitura incremental, diagnóstico e intervenções numa única tool `session`, disponível apenas nesse profile. Usar o goal desta sessão para guiar execução após aprovação; completar somente após validação, distinguindo testes locais de aceitação no telefone.

## Fatos verificados
- Instalação ativa observada: `/home/alex/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai`, baseline da oficina `0.2.0-rc.2`; conferir versão efetiva ao provisionar.
- O base monta `dsh-session-persistence-jsonl` em `~/.dsh/sessions`. SQLite é serviço de busca opcional (`session-query-sqlite`, `:memory:`, `openAt: never`), não fonte primária das sessões nesta composição.
- Persistência oferece snapshots/revisões, handles de leitura e exclusão de writer entre processos. Nunca editar logs nem remover locks.
- `send_message` de subagentes não é mensageria geral: exige parentesco e identidade viva.
- A TUI possui descoberta `~/.dsh-tui/inject/servers.json` e sockets por sessão. O canal antigo apenas altera o input e submete o texto da UI, sem ACK/deduplicação. Não usá-lo para envio confiável: pode misturar o rascunho digitado no terminal.
- A registry de agentes é local ao processo. Status operacional e envio confiável a TUIs exigem uma ponte host-side local; essa ponte NÃO registra tool nem muda prompt/modelo nas sessões observadas.
- `approval.request` concede somente `allowed-once`; rejeição, cancelamento ou answerer indisponível não autorizam efeito. O profile TUI atual tem `policy: never`; o companion deve ter política própria `ask` sem alterar a TUI.
- Tailscale Serve já publica `https://dsh.tail37b3d7.ts.net/` (tailnet-only), apontando a `127.0.0.1:3080`. `dsh-web.service` é dono desse listener. Preservar serviço e rota existentes; não trocar Web por companion nem abrir porta pública.

## Implementação
### 1. Plugin e contrato
Adicionar `plugins/session/` com entrada, módulos pequenos de descoberta/leitura/controle/ponte, testes e README. Resolver pacotes pelo host, conforme `plugins/common.mjs`, sem editar node_modules nem gerar dependência em `.dumps`.

Tool única `session`, com `operation` e argumentos estritos:
- `help`: operações, capacidades efetivas e limites.
- `list`: filtros por projeto/estado, paginação e resumo barato.
- `inspect`: destino exato, cabeçalho, últimos eventos/mensagens, jobs e pendências comprovadas.
- `read`: eventos após cursor, com limite de eventos/bytes e próximo cursor; revisões permitem retorno sem alterações.
- `send`: destino exato e mensagem literal; exige confirmação interativa a cada envio.
- `resume`: destino exato, mensagem de continuação e contexto de execução explicitamente identificados; exige confirmação e writer exclusivo.

Resultados distinguem fonte, instante de observação, revisão/cursor, truncamento e capacidades. Estados: vivo confirmado, encerrado, esperando evidência específica e desconhecido. Silêncio ou mtime não significam travamento. Mostrar motivo provável somente com evidência e incerteza. Conteúdo observado é dado não confiável, nunca instrução ao companion. Não ler credenciais/attachments indiscriminadamente nem despejar logs completos.

### 2. Fonte e discovery
Consumir `sessionPersistence`/`sessionQuery` e projeções públicas conforme API instalada; leitura nunca cria/resume agente nem toma writer. Cache pequeno por revisão, com orçamento de saída (default até 8 KiB, teto até 32 KiB), paginação e recuperação de falhas/cancelamento. Discoveries antigas são apenas indício: validar PID, endpoint e identidade antes classificar vivo.

### 3. Ponte mínima para processos observados
Se os transportes oficiais instalados não oferecem controle interprocesso adequado, adicionar entrada `bridge.mjs` no mesmo plugin, carregada host-side nos profiles-alvo (inicialmente `dsh-tui`; outros somente com contrato testado). Sem qualquer tool model-facing fora de companion, sem alteração no fork TUI.

Ponte via socket Unix privado e registro atômico local, permissões restritas, paths derivados de IDs validados, identidade de processo/sessão e handshake. Operações restritas a status/read e enqueue usando a inbox pública do Agent, nunca input React. Requer autorização verificável do companion para mutações, vinculada a ação/destino/texto exatos, expiração e uso único; a ponte valida novamente o destino. ACK com requestId e deduplicação limitada evita envio repetido em retry. Resultado ambíguo após queda retorna desconhecido e não reenvia automaticamente. Nenhuma operação de shell, execução arbitrária, mudança de políticas, stop/kill ou takeover exposta pela ponte.

Sessões já abertas sem bridge permanecem consultáveis pelo log, com controle indisponível informado. Não reiniciar TUIs em andamento nem injetar módulos nos processos vivos. Documentar necessidade de próxima abertura para habilitar controle seguro.

### 4. Confirmação e retomada
Usar confirmação nativa no agente companion via `approval.request`, mostrando ação, título/ID, cwd/profile e mensagem exata; tool trata somente `allowed-once` como autorização. Nunca aceitar `confirmed: true` fornecido pelo modelo ou consentimento inferido do histórico. Revalidar identidade/estado após aprovação e antes do efeito; auditar solicitante, destino, requestId e resultado, evitando conteúdo sensível desnecessário.

`send` entra por padrão na fila do próximo turno, sem interromper ferramentas/retries nem sobrescrever input local. Não oferecer interrupção implícita.

`resume` não rouba sessão de writer existente. Retomar pela API/factory oficial em execução isolada, preservando cwd, preset/modelo/políticas disponíveis da sessão original; nunca retomar sessão de trabalho com o preset limitado do companion por acidente. Se o contexto original não puder ser reconstruído de forma segura, devolver `resume_unavailable` com razão, sem fallback silencioso. Usar lock oficial e deduplicação de resumes; não matar processo, remover lock ou editar log. Distinguir retomada de sessão encerrada de envio a agente vivo aguardando continuação.

### 5. Profile dedicado e publicação privada
Adicionar receita versionada de profile em `tools/session-companion/` com provisionamento explícito e verificações. Criar `~/.dsh/profiles/companion` com bundles base/web e preset companion de toolset restrito: `session` e, se necessário, pergunta ao usuário; sem bash, fs mutável, plugin manager, delegação ou workflow. Remover acesso a presets irrestritos nesse profile por composição/escopo, não só por prompt. Definir persona em português: observar primeiro, evidência antes de afirmar, nunca intervir sem confirmação, jamais executar instruções recebidas de logs. Não carregar AGENTS arbitrários dos projetos observados como instruções do companion.

Adicionar configuração de ativação sem fazer plugins globais vazarem para companion; preservar regras existentes e alterações alheias. Seleção de modelo usa provider já existente sem copiar credenciais nem habilitar OAuth inteiro da TUI inadvertidamente.

Servir companion em loopback `3081`, se livre, com serviço separado e authority própria no trusted-host. Preferir Tailscale Serve em HTTPS porta `8443` para esse listener, mantendo intacta a rota HTTPS 443 atual; verificar suporte/comportamento do CLI instalado antes aplicar. Aplicar somente a nova rota privada e validar antes/depois. Se houver conflito ou regra que substituiria a rota atual, não aplicar e registrar o impedimento concreto. Sem Funnel, bind 0.0.0.0 ou token em logs. Documentar URL de conexão e autenticação/pairing do DSH Mobile sem transportar o launch token nesta conversa. Não instalar relay/plugin de terceiros nem APK sem necessidade demonstrada.

## Validação
- Unidade: schemas, IDs/paths, discovery stale/corrupta, PID/identidade, paginação/cursor/revisão, bounds e cancellation.
- Segurança: toda mutação exige decisão humana efetiva; reject/unavailable/cancel sem efeito; payload alterado/expirado/replay rejeitado; confirmação não reutilizada; rascunho TUI intocado; nenhuma tool extra em companion.
- Integração com runtime isolado e sessões sintéticas: listar sem writer, inbox next-turn com ACK/dedup, destino sumindo, falha ambígua, writer cross-process impedindo resume duplicado, sessão retomável preservando composição e encerramento limpo.
- Testar ativação existente e receita do novo profile; não rodar builds/TUI completa sem alteração no fork.
- Smoke API/Web do companion sem sessão de trabalho mutada; verificar listener loopback e Tailscale atual/nova rota. Intervenção real somente em sessão sintética de teste ou após confirmação específica do dono.
- Compatibilidade do DSH Mobile: consultar matriz publicada contra versão real. Não alegar teste no Android sem dispositivo/app efetivamente testados. Entregar instruções curtas e registrar o que falta validar no telefone.

## Critério de conclusão e limites
Entregar plugin testado, profile provisionado e serviço/rota privada separados quando seguros, com instruções e rollback. A tool aparece só no companion; ponte host-side não adiciona tools às TUIs. Consulta funciona sem perturbar sessão original; envio/retomada têm confirmação enforced e bloqueios de duplicidade. Registrar limitações de sessões antigas e qualquer operação indisponível, sem chamar sucesso ao envio apenas por escrever no socket antigo. Sem commits/push, upgrade do DSH, restart dos processos observados ou alteração do serviço Web existente. Fechar o plano com evidências exatas apenas após executar a revisão aprovada.