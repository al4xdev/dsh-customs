# Auditoria antes da refatoração final Compose

O proprietário pediu trabalho autônomo para refazer visuais e renderização do chat em Kotlin, usando interface premium de ha_app (paleta substituível, gestos/transições/estado de arrasto) e paridade funcional com frontend/tools DSH incluindo imagens de read. Autorização nova substitui a antiga limitação de motion nativo.

1. Auditar apenas leitura /home/alex/git/my/ha_app: identificar tela/componentes de referência, tokens/paleta, tipografia, gestos e state machine/reducedmotion. Não editar/deploy/operar HA ou ler secrets/câmeras.
2. Auditar frontend DSH e perfil dsh-tui por fontes públicas/symlinks resolvidos: renderer de tools/markdown/imagens e schemas/chunks JSON. Não executar tools, ler credentials/conversas reais nem alterar profile/runtime atual.
3. Auditar protocolo/presentation/Compose atual e criar matriz de paridade (tipos suportados, fallback seguro, limites, ferramentas/capabilities, lifecycle/gestos) com fixtures sintéticas previstas.
4. Gerar proposta concreta de refatoração por etapas e aceite com visual fiel à referência/tokens centralizados, não implementação improvisada. UI warning task63 e estabilidade task64 entram como pré-condições preservadas.
5. Somente após esta auditoria estagiar plano de implementação aprovado; validação JVM/Compose/SDK34/gestos/media sintéticos e APK final. Sem novo telefone install/force-stop, envio/grant/lock/resume/serviço/TTL/publicação, commit/push. ha_app permanece referência read-only.