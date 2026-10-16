# Instruções e skills do Companion

## Objetivo
Revisar ~/.dsh/AGENTS-Companion.md e criar guias práticos de sessões e pesquisa em /home/alex/git/my/dsh-companion-workspace/.agents/skills, com exemplos JSON válidos e situações concretas, sem alterar modelos, permissões, serviços ou executar intervenções reais.

## Descoberta
/home/alex/.dsh/Companion/AGENTS.md é symlink para ../AGENTS-Companion.md, não cópia. O perfil configura agent-instructions.dshHome nesse diretório e o SDK fixa o nome global AGENTS.md. Preservar a ligação necessária em vez de apagar e interromper carregamento; editar somente o original. O provedor nativo de skills descobre .agents/skills no projeto.

## Trabalho
1. Revisar instruções existentes preservando regras de goals, limites e aprovações; exigir leitura da skill pertinente, verificação das capacidades reais antes de alegar impossibilidade e distinção entre lock de escrita/leitura/envio.
2. Skill companion-sessions: list/find/read/context; IDs/títulos; cenários de terminal aberto com writer held, investigar teste/erro/JSON, paginação, pesquisa histórica parcial, send versus resume e criação atualmente Companion (não prometer dsh-tui). Exemplos conforme schemas atuais.
3. Skill companion-research: pergunta verificável, hipóteses rivais, plano de evidência, fontes distintas relevantes, leitura/continuação no mesmo run, contraevidência, tratamento de bloqueios/quotas e critérios de parada. Exemplos para erro técnico, release e experiência comunitária; não exigir fanout indiscriminado.
4. Validar descoberta dos dois SKILL.md pelo provedor SDK, exemplos session pelo parser e research pelo schema atual; revisão de situações óbvias e ambiguidades. Registrar evidência local em .dumps. Não enviar mensagens, criar sessões, pesquisar na rede nem reiniciar serviços para validar.

## Conclusão
Guias carregáveis e instruções curtas apontando para eles; relatar a ligação preservada e distinguir validação de descoberta de garantia de comportamento do modelo em produção.