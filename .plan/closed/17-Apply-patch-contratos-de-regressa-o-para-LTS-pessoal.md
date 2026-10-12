# Apply-patch: contratos de regressão para LTS pessoal

## Intenção
Refino final pequeno para o LTS pessoal, não caça a bugs nem reescrita. Preservar todo o comportamento de produção e as alterações existentes. Guiar o trabalho pelo goal ativo.

## Observação
O plugin já documenta contexto exato, limites de sandbox, leitura prévia, resultados parciais e undo. Não encontrei uma rotina dedicada no package.json ou scripts de tools que proteja os módulos puros deste plugin.

## Mudança mínima
1. Adicionar um arquivo de testes `node:test` para contratos existentes: parser (Add/Delete/Move, contexto/âncoras, ambiguidade, fim de arquivo, newline e inserção), cobertura de leitura por sessão e apresentação de recibos válidos (sucesso, parcial, undo).
2. Adicionar `npm run test:apply-patch`, sem dependências novas ou chamadas a modelos.
3. Acrescentar na referência o comando, os contratos cobertos e o limite: testes puros não exercitam escrita real, recuperação, sandbox ou races de filesystem.

## Fora do escopo
Nenhuma alteração em index.mjs, parser.mjs, observation.mjs ou presentation.mjs; nenhuma migração, feature nova, nova política ou revisão dos demais plugins. Sem commit/push.

## Aceite
Rotina dedicada passando, alterações limitadas aos testes/comando/documentação e verificação de whitespace. Não declarar estes testes como validação completa do filesystem. Se um teste exigir mudar comportamento de produção, interromper esse item e discutir com o usuário antes de ampliar o escopo.