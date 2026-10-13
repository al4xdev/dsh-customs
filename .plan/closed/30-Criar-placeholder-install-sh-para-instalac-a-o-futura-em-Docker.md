# Criar placeholder install.sh para instalação futura em Docker

## Pedido
Confirmar que /home/alex/git/my/dsh-customs é a raiz de um repositório Git e criar install.sh intencionalmente sem lógica de instalação.

## Alteração mínima
Adicionar somente shebang Bash e comentários de lembrete: depois de terminar a limpeza, abrir um container Docker limpo e, com outro agente, preencher o script para instalar todos os componentes do projeto dentro desse container. Não iniciar Docker, instalar dependências nem implementar o instalador agora.

## Validação
Verificar sintaxe com bash -n install.sh e confirmar que o conteúdo contém somente shebang/comentários. Não incluir alterações de outras sessões; sem commit/push adicionais neste pedido.