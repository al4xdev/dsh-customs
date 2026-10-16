# Adicionar função fish start_tty segura

## Objetivo
Criar `/home/alex/.config/fish/functions/start_tty.fish` para liberar os recursos da sessão gráfica sem reiniciar e sem matar indiscriminadamente processos da IA.

## Implementação
- Exigir execução em console Linux `/dev/ttyN`, recusando terminais gráficos, SSH e pipelines.
- Explicar que parar o SDDM encerra a sessão gráfica e seus aplicativos; pedir confirmação explícita.
- Executar somente `sudo systemctl stop sddm.service`, propagando falhas.
- Não alterar o padrão de boot, não descarregar o driver NVIDIA e não executar a função durante a implementação.
- Informar como verificar VRAM (`nvidia-smi`) e restaurar o login gráfico (`sudo systemctl start sddm`). Não prometer encerrar serviços independentes do desktop.

## Validação
Validar sintaxe com `fish --no-config --no-execute` e testar, num terminal não-TTY e sem carregar config pessoal, a recusa segura. Usar o goal para guiar o trabalho após aprovação e concluí-lo após a validação.
