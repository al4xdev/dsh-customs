# React com TypeScript estrito e lint forte

Pedido humano adicional às tasks40/44: **manter React**, não migrar para Angular; tipagem e lint rigorosos complementam o acabamento premium, não o substituem. Reusar goal existente para orientar execução; respeitar estado atual do mecanismo de goals, sem criar objetivo duplicado.

## Execução
- Delegar a subagente focado os arquivos de configuração/dependências/tipos base, mantendo separados dos arquivos de animação.
- Adicionar TypeScript local com strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noFallthroughCasesInSwitch e demais checks apropriados. JSX mantém React e singleton oficial do DSH.
- ESLint flat config com regras type-aware typescript-eslint strict e stylistic, no-explicit-any, no-unsafe-* e promises rigorosas; incluir React hooks e acessibilidade relevantes. Lint também servidor/scripts/testes JS com regras Node/JS, sem inventar que JS possui verificação type-aware equivalente.
- Criar contratos explícitos da integração DSH/slots/sessionReference/connection e validação de dados de rede unknown. Tipar código próprio, não fingir que código vendorizado/upstream passa pelo lint do projeto. Não transformar declarações em any só para aprovar build.
- Corrigir problemas reais de tipagem/lint nos arquivos próprios, sem bypasses amplos/eslint-disable ou casts duplos não justificados. Observers/DOM/assertions guardados, eventos/motion APIs tipadas. Não interferir com renderer/streaming/approval/gestos.
- Scripts typecheck/lint/check claros, npmlock reproducível, README com comandos. Node >=22 permanece; não usar instalações globais.

## Verificação
- npm run typecheck, npm run lint, npm test e npm run build passam para a revisão atual. Check inclui animações quando os arquivos chegarem; não alegar todos passam enquanto houver workers em edição.
- Preservar testes de navegação/auth/perfil/confirmar-rejeitar; verificar UI real após correções de código, não só compile.
- Nunca migrar Angular, editar runtime/TUI/profiles ou configurar autoaprovação. Não commit/push.

## Coordenação e conclusão
Se agentes antigos não forem filhos desta sessão, não contornar controle de ownership nem afirmar mensagens entregues. Registrar orientação compartilhada e trabalhar apenas em arquivos sem disputa. Concluir só após evidência do check completo e integração das animações premium.