# Implementar research e substituir busca padrão

## Autorização humana

O proprietário autorizou explicitamente iniciar criação autônoma da ferramenta, substituir ao final a tool de busca padrão em todos os perfis e preservar resultados quando algum provedor falhar ou atingir limite. Esta autorização sucede a pausa para revisão do plano-base 116 r3. O plano-base permanece referência arquitetural; este artefato delimita a execução.

## Objetivo e goal

Executar sob goal `goal-088b322f-eac8-40f6-be0a-fc5c9b9d7f2e`: plugin research nativo, coleta persistente limitada ao contexto, continuidade e falhas parciais, testes e ativação em todos os perfis. Não marcar goal completo sem verificar entrega e registrar limitações.

## Escopo

1. Inspecionar interfaces reais de web, tools, cliente MCP, perfis e ativação. Preservar trabalho existente no checkout.
2. Implementar plugin em `plugins/research/`, testes e documentação: config, search, inspect e continue; snapshots e evidências em `.dumps/research`; orçamento cumulativo, limites de IO/retorno e isolamento.
3. Reutilizar `ctx.web.search` e `ctx.web.fetch` em vez de fork desnecessário. Google/web, Reddit/X com modos explícitos de fallback, Hacker News, grep.app e Context7 quando interfaces permitirem. Não inventar credenciais nem comprar serviço; conector indisponível deve aparecer como indisponível/degradado, não sucesso.
4. Falhas 429, quotas, timeout, autenticação ou bloqueio são registradas por fonte/etapa. Entregar resultados coletados das demais fontes e avisar o agente. Não deixar retry de longa duração bloquear toda pesquisa.
5. Leituras obrigatórias acontecem dentro da ferramenta; resultados são salvos antes de serem apresentados. Retorno compacto inclui índice, refs, cobertura, erros e consumo; conteúdo completo é recuperado seletivamente.
6. Testar concorrência, limites, cancelamento, falhas parciais, persistência, segurança e continuação. Validar integrações reais de forma controlada sem contratar APIs.
7. Atualizar ativação em todos os perfis, incluindo isolamento de companion conforme interface real. Retirar somente a exposição da busca padrão; preservar serviço backend necessário e leitura compatível. Configuração reversível, sem reiniciar à força uma sessão em uso.
8. Verificar ferramentas registradas em runtime de teste e configurações finais. Documentar necessidade de reabertura de perfis existentes se carregamento não for dinâmico; não alegar hot reload sem evidência.

## Decisões de implementação

Usar defaults conservadores configuráveis para limites ainda não definidos; agentes só podem reduzir tetos do proprietário. Fontes centrais: web, Reddit, X, HN. Fontes técnicas opt-in por pesquisa. Sem segundo LLM obrigatório. Nenhum contorno de bloqueios, scraping autenticado pessoal ou contratação sem autorização específica.

## Critérios de aceite

- Tool research utilizável com config/search/inspect/continue e referências estáveis.
- Pesquisa persiste localmente com proteção de caminhos e arquivos limitados; contexto não recebe acervo inteiro.
- Falha de um conector não impede resultados de outros, e distingue snippet de leitura real.
- Orçamento compartilhado entre chamadas; cancelamento e timeouts não deixam operações internas sem controle.
- Testes automatizados e smoke controlado; quotas/indisponibilidades reais explicitamente registradas.
- Nova ferramenta configurada em todos os perfis existentes/gerados e web_search não exposta nesses registros; backend preservado.
- Mudanças estranhas à tarefa não revertidas ou sobrescritas.

## Próxima ação

Continuar inspeção e implementação após aprovação desta revisão. Ao finalizar, fechar artefato com evidências, atualizar goal e entregar resumo de uso, testes e limitações.