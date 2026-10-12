# Project-mcp: regressão de cancelamento explícito para LTS

## Pedido e objetivo
Usuário autorizou adicionar o teste recomendado e conferir sugestões históricas da c_test2. Usar o goal ativo para executar e validar.

## Escopo mínimo
- Acrescentar teste em plugins/project-mcp/project-mcp.test.mjs com cliente DSH real e builtin SDK local.
- Esperar confirmação de que handler iniciou, abortar explicitamente via AbortController antes de um deadline longo, confirmar sinal recebido/sem conclusão tardia e conexão ainda utilizável.
- Fixture artificial local, sem servidores reais, chamadas LLM, credenciais ou configuração de produção. Artefatos novos ficam em .dumps conforme convenção.
- Ajustar descrição da cobertura no README se o teste passar. Sem alteração no código de produção, novas funcionalidades ou refatorações.
- Consultar histórico c_test2 para distinguir sugestões antigas da revisão atual. Sugestões extras não entram automaticamente na implementação.

## Validação e aceite
Executar teste focal e npm run test:project-mcp, conferir git diff --check. Reportar qualquer falha concreta em vez de presumir propagação do abort; não alterar core/perfis para fazer teste passar. Fechar o plano com evidências quando passar. Sem commit/push.