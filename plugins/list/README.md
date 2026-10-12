# List — contrato para o LTS pessoal

Lista nomes e tipos, sem ler o conteúdo dos arquivos. Caminhos relativos usam o
cwd da sessão. `file_path` e `path` são aliases; quando ambos são fornecidos,
`file_path` tem preferência. É necessário fornecer um caminho não vazio.

## Comportamento preservado

- `depth`: padrão 1, máximo 8; profundidade 1 mostra somente os filhos imediatos.
- `limit`: padrão 200, máximo 1000. Ambos exigem inteiros positivos.
- Ocultos são incluídos por padrão. `hidden: false` também evita percorrer
  subdiretórios ocultos.
- Em cada diretório, a ordem é diretórios, arquivos e outros tipos; dentro de
  cada grupo, os nomes usam `localeCompare`. A recursão ocorre ao visitar cada
  diretório, não como uma ordenação global da árvore.
- Os caminhos exibidos são relativos à raiz solicitada; diretórios recebem `/`.
- Um mesmo diretório, identificado pelo `targetKey` do backend, é percorrido
  somente uma vez. Seus aliases ainda aparecem na listagem.
- A coleta respeita um orçamento de 64 KiB para caminhos UTF-8 e separadores,
  além do limite de entradas. Esse orçamento não inclui cabeçalho e rodapé.
- Resultados limitados mostram a contagem e o aviso `capped`, sem parecer completos.

**Limite de resultado não é limite de trabalho:** a ferramenta continua
percorrendo a profundidade pedida para calcular `total`, mesmo depois de atingir
`limit` ou o orçamento de caminhos. Para árvores grandes, reduza `depth` ou
escolha um subdiretório. `total` considera a filtragem de ocultos e a deduplicação
na recursão; não é uma contagem universal de todos os caminhos possíveis.

## Regressão

Na raiz do repositório, execute `npm run test:list`.

Os 13 testes usam a definição nativa `defineTool` do DSH instalado e um backend
em memória. Cobrem argumentos, defaults, cwd, ordenação, profundidade, ocultos,
limites, identidades repetidas, cancelamento, erros, renderização e orientação no
system prompt. Não usam modelos, credenciais ou operações reais de filesystem.
Não substituem testes de integração do backend, sandbox ou symlinks reais.

Este refinamento acrescenta documentação e testes, sem alterar `index.mjs` ou
`common.mjs`, nem instalar dependências novas.
