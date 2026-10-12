# Configurar compactação automática do GPT perto de 190k

## Objetivo
Alterar somente `/home/alex/.dsh/profiles/dsh-tui/cordis.patch.yml`, sem código, para limitar o disparo automático de `openai-codex/gpt-6.1-sol` a aproximadamente 190000 tokens.

## Execução
- Acrescentar override do plugin existente `compaction-basic`, mantendo `auto: true` e política específica `provider: openai-codex`, `model: gpt-6.1-sol`, `thresholdRatio: 0.69853` (floor de 272000 × razão = 190000).
- Preservar reserva de saída, headroom e todas as demais opções; o limite de segurança pode disparar antes de 190k. Não forçar aumento de capacidade nem alterar catálogo.
- Preservar todo conteúdo não relacionado do perfil, demais modelos e sessões.
- Validar YAML usando parser do host e configuração usando serviço oficial sem inicializar runtime/LLM; verificar razão e isolamento da regra.

## Critérios de conclusão
Configuração gravada e validada offline; informar que processos novos carregam a regra e que a segurança pode antecipar o disparo. Nenhuma chamada LLM nem alteração de código. Usar o goal ativo para acompanhar conclusão.