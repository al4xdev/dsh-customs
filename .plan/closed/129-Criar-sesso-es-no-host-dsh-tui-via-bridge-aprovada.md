# session_create com destino real dsh-tui

## Correção
A tool continua exposta apenas no Companion, mas não deve usar ctx.agents.create do host Companion. Estender o bridge privado para preparar e criar em um host dsh-tui já aberto. Não criar outro perfil fingindo nome/preset; não abrir worker/TUI/terminal automaticamente.

## Contrato e segurança
- Novo caminho público profile-aware, mantendo implementação legada interna/testada sem fallback público para Companion.
- Destino fixo dsh-tui/preset standard, modelo efetivo do destino validado sem salvar defaults. Reusar fronteiras atuais de cwd/projetos e prova do caller; não permitir cwd arbitrário.
- Descoberta somente leitura de hosts compatíveis. Seleção exata por host ID quando houver mais de um; nenhum primeiro-PID silencioso. Sem host atualizado/serviços públicos suficientes => erro explícito sem criação.
- prepare-create readonly captura identity/runtime/preset/model/policies/path facts; approval humana allowed-once mostra destino e políticas REAIS. dsh-tui atualmente usa danger-full-access/never: não ocultar isso nem mudar para workspace-write silenciosamente. Aprovação de criar continua no Companion mesmo que política do destino seja never.
- Grant MAC próprio para criação, vinculado a bridge/processo/preparação/cwd/model/preset/política/IDs/task/TTL; não reutilizar grant send sem assinatura dos novos campos. Consumir uma vez, reservar antes dos efeitos e manter journal/unknown; sem retry automático após desconexão.
- Agent handle criado e guardado pelo root host dsh-tui, independente do caller/aba. Não mudar foco. Empty padrão não envia prompt/draft, não executa modelo nem arma goal. Submit só admite literal aprovado e mantém controles. ACK de criação/admissão não é execução concluída.
- Lifecycle do host fecha seus próprios handles; cancelamento do Companion depois da admissão não mata a nova sessão.

## Implementação e validação
Separar módulo de criação do bridge, cliente/contrato e controller owner. Preservar caminhos de list/inspect/send/resume existentes. Testes de grants/adulteração/replay/drift/perfil errado/host ambíguo/empty/submit/owner lifetime/erros parciais, além de fixture SDK com perfil dsh-tui sintético e adapter sem rede. Atualizar guias retirando limitação antiga só após correção comprovada. Validar junto às regressões de session/session-create e skills.

## Ativação
Arquivos do plugin atualizados sem restart forçado. Hosts TUI já carregados com bridge antigo precisarão recarregar; a tool deve detectar falta de capacidade e explicar. Nenhuma criação/envio real será usada para teste. Skills têm plano128 separado.