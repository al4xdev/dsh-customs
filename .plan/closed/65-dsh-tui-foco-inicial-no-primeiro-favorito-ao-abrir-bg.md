# Foco inicial de /bg em Favoritas

Pedido: manter Favoritas como aba padrão e iniciar o cursor na primeira sessão favorita, não na coluna de projetos.

- Preservar todas as alterações existentes do fork e não commit/push sem novo pedido.
- Ajustar somente o estado inicial/foco da tela de sessões: coluna de sessões ao entrar com initialView=favorites, primeiro favorito após catálogo/cache disponível; não tomar foco após navegação do usuário. Sem favoritos, manter fallback utilizável; /home e outros backends preservados.
- Acrescentar regressões no script headless existente para abertura, Enter no favorito correto e favoritos carregados assincronamente/sem favoritos; documentação EN/ZH curta se necessário.
- Compilar e rodar as regressões focadas/boundary sem login, providers ou inferência. Não editar lib gerado manualmente, não reiniciar TUIs existentes.
- Goal acompanha até validação e instrução para usuário reabrir /bg em nova execução.