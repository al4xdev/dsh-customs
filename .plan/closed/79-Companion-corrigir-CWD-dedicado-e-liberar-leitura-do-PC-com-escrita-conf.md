# Companion — leitura ampla, escrita só no projeto próprio

## Pedido direto
Em paralelo ao redesign78, dono pediu remover restrição de leitura ao workspace, investigar por que agente aparenta iniciar em dsh-customs e usar o projeto dedicado, com escrita livre apenas dentro dele.

## Escopo
- Auditar código do perfil/launcher/controller e configurações instaladas somente em campos públicos de CWD/policy/tools; sem credenciais/env/argv/histórico privado. Diferenciar working directory do processo backend/repositorio do cwd efetivo da sessão/agente/ferramentas. Workspace dedicado existente: /home/alex/git/my/dsh-companion-workspace; não mover/renomear diretórios ou reescrever sessões antigas automaticamente.
- Corrigir criação de NOVAS conversas para CWD dedicado consistente em header/proveniência/Agent/tool execution. Usar contratos públicos reais do SDK/Gateway, não confiar só em fake controller com assinatura presumida. Validar fixture nativa isolada com a composição efetiva.
- Ferramentas de leitura/listagem/imagem podem observar paths do host fora do workspace conforme tarefa do dono. Não abrir segredos/dados privados reais para provar isso: arquivos sintéticos fora/dentro do workspace em fixture isolada bastam.
- Write/edit/create/exec continuam confinados por sandbox nativo workspace-write ao projeto dedicado; permitir uso normal de subpastas/arquivos sem allowlist artificial. Área temporária técnica nativa já prevista continua técnica, não permissão ampla sobre arquivos pessoais. Symlink/traversal não ampliam escrita.
- Manter ASK allowed-once para cada Bash literal+cwd e demais guardas de escalada/unknown; leitura ampla não significa autoaprovar comandos, rede ou mudanças globais. Modelo/perfil global/OAuth/SDK/TUI/HA não são modificados.
- Testes Node/publicSDK reais isolados para assinatura/CWD, reads fora e writes permitidos dentro/recusados fora, guardas symlink/cancel/ASK. Documentar source versus instalado. Nenhuma ativação/hotreload/restart de backend ou perfil instalado enquanto dono usa: obter condição segura sem envio/aprovação/rascunho pendente antes da ativação.

## Coordenação
Separar arquivos do trabalho Android78 para execução paralela. Se Android estiver enviando CWD errado, reportar ao integrador para mudança mínima coordenada e novo build; não editar arquivos Android simultaneamente. Não usar nem publicar conteúdo dos prints privados.