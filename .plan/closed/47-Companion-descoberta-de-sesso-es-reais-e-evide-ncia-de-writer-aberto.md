# Companion: descoberta de sessões reais e evidência de writer aberto

## Objetivo atualizado
Validar o conceito antes de portar para Kotlin/Compose/Material 3 exclusivamente Android14/API34. Sem novos refinamentos de animação. Corrigir descoberta/listagem e diagnóstico das sessões que o usuário vê abertas nos terminais/TUI.

## Investigar e implementar
1. Comparar sem payloads privados a raiz/encoding pública da persistência companion e TUI, os filtros/ordenação/paginação da tool session e os bridges ativos. Identificar a causa real de sessões ausentes; não inferir que profiles são isolados por nome.
2. Inspecionar a origem nativa do rótulo TUI `held by pid` e APIs de leitura disponíveis. Acrescentar evidência read-only de writer/lock aberto quando verificável, separada de agente vivo, aguardando, histórico e capacidade de envio. Nunca testar via open(write), adquirir/tomar locks ou converter/regravar logs.
3. Corrigir listagem/filtros/paginação e contexto retornado à LLM conforme diagnóstico; preservar API restrita companion, previews limitados, sem autoaprovação. Sessões bloqueadas sem bridge controlável não recebem `send=true`; native allowed-once continua obrigatório e resultado desconhecido nunca é repetido automaticamente.
4. Testar cross-profile, sessões mantidas por outros PIDs, locks stale/PID reuse, sessões idle, páginas além do limite e ausência de bridge. Comparar os IDs esperados com dados do runtime sem imprimir histórico/credenciais. Alterar só arquivos próprios; não editar runtime DSH instalado nem reiniciar terminais do usuário.
5. Se atualização do backend companion for necessária, validar testes antes e reiniciar somente seu serviço dedicado, explicando efeito sobre conexões; preservar Web443/3080, TUI e frontend publicado8443/3082. Documentar limitações concretas e provas.

## Fora do escopo
Port Kotlin nesta etapa, novas animações, takeover de writer, mudanças de políticas/profiles/modelos, chamadas/mensagens a sessões reais para teste, auto-answer de confirmação, commit/push.

## Aceite
Tool lista sessões relevantes com paginação e evidência clara. `writer aberto` não é confundido com `agente acessível` nem `travado`; envio só usa agente/bridge confirmado após aprovação humana. Regressões passam e publicação/conceito existentes continuam saudáveis.