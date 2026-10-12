# List: refinamento leve de contratos e documentação LTS

## Objetivo
Continuar a revisão conservadora do LTS pessoal pelo plugin list. MCP fica por último. Não procurar features novas ou reescrever código; usar o goal ativo e preservar alterações existentes.

## Escopo mínimo
- Testar a definição real registrada por apply, com filesystem em memória: aliases de caminho/cwd, argumentos e limites, ordenação, profundidade, ocultos, contagem e truncamento, orçamento UTF-8 de caminhos, diretórios repetidos/loops por targetKey, cancelamento, erros de backend e saída/apresentação.
- Adicionar `npm run test:list` e um README curto descrevendo os contratos e limites observados.
- Manter index.mjs e common.mjs intactos, sem dependências novas nem chamadas a modelos.

## Esclarecimentos LTS
Depth máximo 8, limit máximo 1000 e orçamento de aproximadamente 64 KiB para caminhos coletados. `limit` é um limite de resultados, não um limite de trabalho: a contagem continua dentro da profundidade pedida. Evitar prometer teste de sandbox/FS real: a suíte usa o defineTool instalado e simula o backend.

## Aceite
Testes passando sem alterar comportamento, documentação e comando consistentes, diff restrito e whitespace válido. Se um teste sugerir mudança de produção, não expandir o escopo sem discutir com o usuário. Sem commit/push.