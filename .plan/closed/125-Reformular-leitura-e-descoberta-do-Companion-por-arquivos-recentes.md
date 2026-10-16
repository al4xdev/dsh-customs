# Companion: descoberta por arquivos e navegação detalhada

## Escopo acordado

A tool session do Companion observa conversas principais do DSH/TUI, excluindo suas próprias conversas e subagentes. Usuário autorizou implementar: list útil por arquivos recentes, busca literal seletiva e leitura aprofundável, sem mudar send que já funciona.

## Implementação

1. Catalogar arquivos no root público configurado usando readdir/stat, sem decodificar todas as conversas. Selecionar geração suportada por sessão, recusar symlinks e não abrir caminhos arbitrários. Classificar pelo cabeçalho: Companion excluído; origin subagent/delegationDepth positivo excluídos; parentSession sozinho não exclui continuação. Metadados insuficientes explicitamente desconhecidos. Filtrar antes de contar limite, suportando50+subagentes.
2. list default10 principais por mtime, limit e paginação. Título atual (último session/title, incluindo rename user), ID/cwd/mtime e prévia útil apenas dos selecionados. Cache limitado por identidade/stat; sem SQLite obrigatório. Mudança de outra sessão não deve invalidar toda paginação; preservar filtros e snapshot explícito.
3. find como operação literal (search compatível): default100 arquivos principais recentes, ajustável com teto/budgets explícitos. Streaming/leitura somente do conjunto selecionado, resultados referenciados por sessão/seq, limites por chamada e continuação. Não prometer histórico inteiro.
4. read/context/inspect: páginas úteis de eventos, head/tail/seq e navegação antes/depois. Formato legível e opção JSON para eventos selecionados. Permitir aprofundar argumentos, resultados e erros de ferramentas, com trecho/paginação de conteúdo longo. Redigir credenciais; sem arquivo inteiro automaticamente nem payload arbitrário fora do root. Dados de logs continuam não confiáveis.
5. Preservar send/resume e gates de aprovação/origem/bridge. Estado ativo continua separado de mtime. Não criar superfície de subagentes separada; delegações da principal ficam navegáveis no log.
6. Atualizar contratos, descrição da tool e documentação. Compatibilidade com parâmetros existentes onde possível; limites/cursor semantics explicitados.

## Validação

- Tests de principais/continuações/forks,50+subagentes e Companion, rename, geração de arquivo, mtime, caches, logs zstd e escrita concorrente.
- Busca literal em somenteN principais, paginação e cobertura explícita.
- Navegação de resultados/argumentos/JSON longos, redaction, corte recuperável, erros e limites de saída.
- Regressão dos testes de session, roteamento e send/resume sem enfraquecer controles.
- Smoke somente leitura em logs reais via SDK/entrada da tool; resumo compacto em .dumps. Sem reiniciar serviços ou enviar mensagens sem pedido.

## Execução

Guiada pelo goal ativo. Separar catálogo físico e leitura de eventos para delegação independente; integrar e validar antes de encerrar. Não alterar outros trabalhos concorrentes.