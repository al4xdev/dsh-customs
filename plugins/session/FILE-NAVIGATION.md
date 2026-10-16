# Companion: arquivos recentes e navegação de eventos

Contrato atual da tool pública `session` (plano125). Não exige SQLite nem varre o conteúdo de todas as sessões. O `send`/`resume` e seus controles continuam no caminho anterior.

## Descoberta

- `list` usa metadados POSIX dos arquivos no root público configurado de `session-persistence-jsonl`. Escolhe a maior geração física por diretório e ordena por `mtime` descendente.
- Cabeçalhos são lidos por prefixo limitado, inclusive em zstd. `origin:subagent` ou `delegationDepth>0` excluem subagentes antes de contar as vagas; `agentPreset:companion` exclui Companion. Profundidade0 admite principal/continuação mesmo com `parentSession`.
- Metadados insuficientes ficam `unknown` e não são inventados como principais. `skipped` informa exclusões. Versões futuras não fazem fallback silencioso para gerações antigas.
- Default10 principais, `limit` até100. Sessões comprovadamente vazias, sem título nem mensagens, não ocupam vagas. Um arquivo parcialmente legível não é declarado vazio.
- Só os selecionados são lidos para título e prévia. O título é o último `session/title` observado, incluindo rename com origem `user`. Títulos não são identidades únicas; ações usam ID.
- `mtime`, título/última mensagem e bridge são informações distintas. Arquivo recente não prova agente vivo. `writer:held` e `state:alive` conservam significados separados.
- Páginas de listagem congelam seleção/ordem, não o estado do mundo: alterações em outro arquivo não invalidam o cursor. Metadados exibidos podem ser atualizados ao visitar a página.

```json
{"operation":"list"}
{"operation":"list","project":"/home/alex/git/my/dsh-customs","limit":10}
{"operation":"list","cursor":"<nextCursor>","project":"/home/alex/git/my/dsh-customs","limit":10}
```

## Busca literal

`find` e `search` procuram texto literal, não regex ou SQL. Default: últimos100 arquivos principais **após classificação**, ajustável por `maxFiles` até1000. `scope` aceita `messages`, `tools` ou `all` (default). Textos/argumentos/resultados permitidos são redigidos antes da busca; envelopes internos e corpos de anexos não entram.

```json
{"operation":"find","query":"Hacker News","maxFiles":100,"limit":10}
{"operation":"find","sessionId":"<id>","query":"exit code: 1","scope":"tools"}
```

`candidateBudget` limita arquivos por chamada (default10, até100), inclusive os que falham. `durationMs` é orçamento cooperativo (default5000, até30000); o cancelamento do host também é respeitado. Retornos indicam arquivos selecionados, examinados, erros, cobertura e `nextCursor`. Para continuar, mantenha query/filtros/escopo. Uma página que parou no meio de um arquivo mantém seu snapshot; appends não deslocam os hits dessa continuação.

`complete-selected-files` significa somente o conjunto escolhido, nunca o histórico inteiro. Busca direta por `sessionId` abre uma sessão exata; Companion continua proibido. Subagentes não têm operação separada nem poluem a lista global, mas um ID exato permite aprofundamento quando necessário.

## Leitura e investigação

```json
{"operation":"read","sessionId":"<id>"}
{"operation":"inspect","sessionId":"<id>","view":"head"}
{"operation":"context","sessionId":"<id>"}
{"operation":"read","sessionId":"<id>","seq":120,"before":3,"after":3}
```

- `read` inicia no final; `inspect`, no início. `context` mostra janelas distintas de início/fim por padrão, sem alegar que são toda a conversa.
- `seq` identifica o evento lógico exato; `offset` começa nessa sequência ou na próxima existente. Não são números de linha física.
- Mensagens, chamadas/resultados de ferramentas, títulos e registros relevantes de execução são navegáveis. Registros desconhecidos podem aparecer apenas como metadados, com `omitted` explícito.
- `previousCursor`/`nextCursor` navegam no snapshot capturado. Uma chamada nova sem cursor atualiza o arquivo; `revision` permite polling sem retornar conteúdo idêntico.
- Cursores retêm seleção e conteúdo capturado, com cache limitado: expiram após15min sem uso ou por pressão de memória/quantidade. Nesse caso, reinicie a operação; não há invalidação global por qualquer append no acervo.

### Aprofundar uma chamada ou resultado

```json
{"operation":"read","sessionId":"<id>","seq":120,"section":"arguments","format":"json"}
{"operation":"read","sessionId":"<id>","seq":121,"section":"result","format":"json"}
{"operation":"read","sessionId":"<id>","seq":121,"section":"event","format":"json","textLimit":4096}
```

O JSON permitido vem serializado em `events[].text`, para poder paginar inclusive eventos muito longos. `format:json` não promete um objeto íntegro quando a página é um trecho. `textLength`, `textOffset`, `nextTextOffset` e `cutoff` deixam isso explícito. Para continuar conteúdo longo, repita **o mesmo ID, seq, section e format**, usando o `nextTextOffset`. Default2048 caracteres por evento; teto16384. Se a saída for curta por orçamento de bytes, o próximo offset corresponde ao trecho realmente retornado.

O agente pode localizar “rodei os testes”, abrir o resultado daquele teste, consultar eventos vizinhos e resumir o que aprendeu. Não recebe a conversa inteira automaticamente.

## Limites e proteção

- Saída padrão16384 bytes JSON, mínimo1024 e máximo32768; até100 linhas/eventos por chamada. Metadados ainda podem exigir orçamento maior que1024 em casos extremos; erro explícito em vez de despejo.
- Leitor: até64MiB descomprimidos por arquivo, até8MiB por linha, cache de snapshots32MiB/32entradas. Navegação: até24 estados/64MiB, TTL15min. Catálogo: até20000 entradas de metadados examinadas, cache de2048 cabeçalhos.
- Arquivo zstd selecionado é lido em streaming; não se promete seek arbitrário no final comprimido. Limite, EOF parcial ou alteração concorrente sinalizam `partial`, `titleComplete` e `tailComplete`, sem afirmar título/fim completo.
- Root vem do serviço público, não de argumento arbitrário do modelo. Recusa symlinks/identidades trocadas. Abertura de cabeçalhos usa descritores ancorados Linux/procfs; plataforma sem esse recurso falha explicitamente.
- Credenciais são redigidas recursivamente por chaves/padrões antes da paginação. Redação é best-effort, não prova de ausência de dados privados. Reasoning/envelopes de request e corpos de anexos ficam de fora. Logs continuam dados não confiáveis, inclusive instruções copiadas neles.
- Nenhuma escrita em logs canônicos, migração de banco, envio ou retomada acontece na leitura.

## Compatibilidade

A tool pública do Companion ativa o leitor por arquivos. `sources` e `paths` continuam como descoberta de metadados; para abrir conteúdo use `sessionId`. `pathRef`/`directory` não são aceitos nas novas operações de conteúdo e não permitem contornar exclusão do Companion. `describe` mostra o contrato exato de cada operação. `search` é alias literal; os antigos modos `phrase`/`substring` não ativam SQLite nesta rota.

As implementações legadas de leitura por serviços públicos permanecem para compatibilidade interna/testes, mas não substituem a nova rota pública nem alteram gates de `send`/`resume`.

## Validação

```sh
env SESSION_RESUME_REAL=0 node --test plugins/session/*.test.mjs tools/session-companion/profile.test.mjs
```

O teste de resume usa adaptador sintético, não envia mensagem a sessões reais.

Smoke somente leitura está em `.dumps/session-usability/recent-runtime-smoke.mjs`, com resultados compactos/artefato JSON local. Inclui listagem de principais reais, títulos renomeados, leitura de tail, um resultado de ferramenta em JSON e busca literal. Não foi forçado restart do serviço Companion; recarregue seu processo para garantir código novo em uma instância já aberta.
