# Organizar alterações pendentes em commits por assunto

## Pedido e goal
O usuário pediu explicitamente commitar tudo pendente aqui, separado em vários commits. Goal ativo: goal-5e620b81-e8d6-4edc-a6fc-81c3d2c09fc6.

## Escopo
Inventariar o working tree atual, arquivos novos e eventual fork Git aninhado Antigravity. Revisar diffs e arquivos para evitar segredos, node_modules, dumps, backups e artefatos privados ignorados. Preservar todas as alterações de outras tarefas, inclusive trabalho em andamento, sem implementar ou revertê-las. Planos são snapshots gerenciados: versionar o que já existe sem editar mirrors/registro.

Separar commits coesos para: instalação/ativação/perfis; retry e categorias Codex; self-healing v2; bridge/session companion; frontend mobile; documentação; snapshots de planos. Ajustar grupos conforme dependências reais do diff. Se o fork Antigravity tiver Git próprio e alterações pertinentes, criar seus commits no próprio repositório, sem forçar sua inclusão no root.

## Execução e segurança
Revisão independente somente leitura pode ser delegada. Checar testes existentes relevantes/whitespace, arquivos grandes e padrões de credenciais, sem imprimir segredos. Usar paths explícitos para staging; revisar diff staged antes de cada commit. Não usar git add -A indiscriminado, reset/rebase/amend, exclusão de arquivos, instalação, modificação do conteúdo do trabalho alheio ou push. Configuração de identidade Git existente; se faltar, pedir dados ao usuário, não inventar.

## Verificação final
Listar hashes e assuntos dos commits; conferir estado root e fork. Explicar exclusões intencionais e trabalho que tenha aparecido durante os commits. Não afirmar que tarefas abertas/WIP foram concluídas só por terem sido commitadas. Concluir o goal apenas com tudo apropriado do inventário commitado e resultados verificados.