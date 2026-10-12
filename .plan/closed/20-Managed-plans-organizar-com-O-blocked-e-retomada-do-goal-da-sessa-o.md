# Managed-plans: organizar com O, blocked e retomada do goal da sessão

## Pedido consolidado
- `O` deve organizar o plano escolhendo destino, não ser um atalho dedicado à reabertura.
- Acrescentar classificação `blocked` para trabalho interrompido por dependência, separada do estado do goal. Não criar um motor de dependências.
- Ao aprovar manualmente um plano de tasks, retomar o **goal atual da sessão aprovadora** se paused/blocked. Não vincular ao goal antigo da criação do plano: o usuário explicitamente espera mudança de goals.
- Aplicar recomendações pequenas de documentação/retomada e shell-reconsider. Usar o goal ativo para orientar execução; preservar alterações anteriores.

## Organização e compatibilidade
1. Adicionar blocked aos destinos reconhecidos, schemas, apresentação e browser. Blocked é save-only, sem autorização de execução enquanto nessa categoria. O movimento não cria/destrava goals.
2. `O` abre seletor compacto Tasks/Backlog/Blocked/Owner decisions/Closed, com Enter confirmar e Esc cancelar, preservando tokens e estilo monospace do TUI. Guardar draft, identidade/revisão/hash e idempotência.
3. Operação humana autenticada de organização: approved pode mudar categoria; staged/rejected mudam destino proposto sem aprovação. Closed ou imports que voltam a tarefas geram nova revisão staged com conteúdo idêntico e mesmo plan_id, preservando histórico e exigindo nova aprovação. Esse detalhe fica explícito no seletor; não reaproveitar aprovação velha de plano fechado.
4. Closed como destino arquiva/cancela por ação humana, não declara tarefa concluída nem fabrica evidência. API de reabertura existente continua disponível para o agente, sem tecla dedicada obrigatória.
5. Migração aditiva: criar diretório blocked na inicialização normal, manter estado SQLite e revisões existentes compatíveis; não editar mirrors/registry à mão nem inventar aprovação para conteúdo importado.

## Aprovação e goal
- Integração opcional com o serviço existente `ctx.get('goals')`; não mudar core nem tornar o serviço obrigatório.
- Somente comando humano root real, após CAS de aprovação autorizadora de tasks. UI avisa que retoma goal paused/blocked da sessão. Rejeição, save-only, autoApprove e notificações de background não retomam goals.
- Capturar snapshot host do goal atual antes de aprovar; enfileirar e persistir a instrução aprovada antes de chamar `goals.resume(agent,{id,revision})`.
- Depois dos awaits, revalidar sessão/live/id/revision/phase e budget. Se mudou, foi concluído, já ativo ou esgotado, não retomar nem retry silencioso. Aprovação já salva continua válida; retorno mostra status separado de retomada.
- Não usar update_goal do modelo para paused nem fabricar command/user events. A ação humana real de aprovação é a autoridade, conforme pedido do usuário.

## Recomendações e regressões
- Documentar backup consistente do .plan inteiro, inclusive .state/store.sqlite, e .agents/config.json com runtime parado para destino persistente; não copiar dados do usuário neste trabalho.
- Testar falha de flush/ack na entrega e retomada após reabertura do store, sem duplicação, em fixtures artificiais .dumps.
- Ajustar três frases documentais do shell-reconsider: leitura sem reconsideração, permit preso a todos os args, here-doc como heurística.
- Executar suites de config/store/native registry, novos contratos de organização e goals, viewer/cartões com renderer real e conjunto LTS existente. Não alegar teste manual do TUI instalado nem proteção absoluta de power-loss.

## Divisão de trabalho
Store/organização e seus testes por um subagente; helper goals e testes por outro. Principal integra index/TUI/apresentação/documentação/scripts/testes do browser e revisão final. Cada agente só edita seus arquivos atribuídos.

## Aceite
O escolhe destino, blocked não autoriza execução, closed→tasks não herda aprovação, approval→resume só goal atual da sessão humana com CAS e ordem durable, testes passam e nenhum core/credencial/profile é alterado. Reload/restart é necessário para runtime já carregado. Sem commit/push.