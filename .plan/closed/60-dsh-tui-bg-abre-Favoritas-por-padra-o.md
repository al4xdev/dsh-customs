# /bg abre Favoritas por padrão

## Pedido
Pequeno ajuste complementar ao plano 55 concluído: o dono quer entrar em Favoritas diretamente com `/bg`, sem precisar pressionar Tab. Preparar no mesmo checkout, sem instalação nova, alteração de PATH/perfil, restart de sessões ou atualização upstream.

## Escopo
- No DSH, `/bg` e seu alias `/background` abrem a vista Favoritas após o background existente concluir com sucesso.
- `/resume`, `/agentview`, `/home`, botão de sessões e seta esquerda com prompt vazio mantêm sua entrada normal. Outros backends continuam com uma vista apenas.
- Esc mantém o retorno à sessão anterior; pinning, Tab, ordenação, filtro, setas/Enter e runtime de background não mudam.
- Sem preferência persistida, sem lembrar a última aba, sem mover automaticamente sessões para favoritos. Favoritas vazia mantém a mensagem e card atuais.

## Implementação mínima
1. Em Chat, representar a abertura do supervisor junto com sua vista inicial, mantendo o setter booleano existente com argumento opcional de vista (padrão sessions). Cada abertura comum continua explicitamente normal por construção; apenas o caminho dos comandos bg/background solicita favorites. A rota compartilhada com a seta recebe argumento opcional para não mudar esse atalho acidentalmente.
2. Passar `initialView` opcional ao SessionSupervisor e ao hook; inicializar em favorites apenas quando solicitado e backend DSH, mantendo sessions como default e não reagindo às mudanças de prop após montagem.
3. Acrescentar regressões: mount padrão DSH, mount solicitado Favorites, nonDSH ignores favorite initial view; integração real Chat /bg + alias, handoff/erro/Esc e /resume normal depois de sair de Favorites. Preservar a suíte anterior.
4. Corrigir notas bilíngues que atualmente dizem que /bg nunca abre Favorites automaticamente; sincronizar guia usando o script existente.

## Validação e entrega
- Ler contributing/ADAPTER e cabeçalhos dos scripts antes de editar/rodar.
- TypeScript e build/gates existentes, regressões de supervisor/Chat/background e backend, perguntas/layout/toolcards obrigatórios por tocar Chat, guia e diff check.
- Somente arquivos do checkout e artefatos gerados já existentes; nada de dependências/instalações/PATH, commit/push ou reinício de processos.
- Build regenera lib no checkout já ligado ao perfil; avisar quando a versão estiver pronta para uma nova instância, não reiniciar a que o dono usa.
- Usar o goal ativo para guiar execução e concluí-lo apenas após verificar a preparação.