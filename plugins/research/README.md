# Research

Ferramenta nativa de pesquisa com coleta paralela, leitura obrigatória, falhas parciais e evidências em disco. Não é um segundo agente: o agente do turno investiga e interpreta as evidências.

## Ciclo

1. `research({action:"config", config:{sources:["web","reddit","x","hackernews"]}})` cria snapshot imutável da estratégia e informa capacidades.
2. `research({action:"search", config_id:"…", query:"…"})` executa buscas e lê resultados selecionados automaticamente.
3. `research({action:"inspect", run_id:"…", ref:"…", limit:6000})` recupera somente evidência necessária.
4. `research({action:"inspect", run_id:"…", ref:"…", section:"comments", limit:6000})` recupera comentários separadamente.
5. `research({action:"continue", run_id:"…", query:"pergunta mais específica"})` aprofunda usando o mesmo orçamento e deduplicação.

`config.sources` aceita `web`, `reddit`, `x`, `hackernews`, `grep`, `context7`. Fontes técnicas são opt-in. `context7` requer `library` explícita na pesquisa; confirme a identidade e versão da biblioteca nos metadados. `grep` recebe padrões de código, não busca semântica universal; `filters` pode especificar `repo`, `path`, `language`, `matchCase` e `useRegexp` para evitar homônimos.

**Reddit:** API oficial somente leitura, com token OAuth fornecido pelo proprietário, busca/listagem de subreddit, tópicos, comentários e expansão serial. Sem credenciais retorna `AUTH_REQUIRED`, sem fallback silencioso. Veja [REDDIT.md](REDDIT.md) para configuração, navegação/cursors e limites. Não houve validação autenticada real: as credenciais estavam ausentes no processo de teste.

**Outras limitações:** X continua usando índice web e leitura pública, sem promessa de thread completa. HN usa Algolia somente para descoberta (campos mínimos, sem highlights) e API oficial Firebase para buscar post/comentários individualmente, evitando o JSON gigante da árvore completa. Até duas requisições por lote, compartilhando o limite de origem entre pesquisas; `maxComments` também limita tentativas (default40, cap200). Um comentário truncado ou artigo bloqueado não apaga o post nem respostas válidas. Texto dos comentários é HTML explícito; contagem disponível é `descendants` informado pelo HN, não enumeração completa. A fila é limitada a1000 e até200 IDs pendentes ficam no acervo; leitura/armazenamento seguem parciais. O deadline externo da pesquisa ainda pode interromper uma leitura inteira. Browser e expansão arbitrária de links continuam fora do escopo. Paginação de Reddit usa `reddit.after`; respostas pendentes podem ser recuperadas por `inspect` com `section:navigation`.

## Limites e falhas

Defaults: 180 segundos cumulativos de execução, 24 leituras, 20 buscas, quatro rodadas, até quatro resultados/duas leituras selecionadas por fonte, 40 comentários e 60 segundos por operação web. MCPs também possuem deadline interno de 25 segundos. O teste real mostrou que 15 segundos podem ser insuficientes para o backend Google. O agente pode reduzir limites, não elevar os tetos do plugin. O orçamento de tempo mede execução, não o intervalo em que o usuário está pensando.

Erros por provedor/etapa (quota, 429, autenticação, bloqueio ou timeout) aparecem em `errors`. Outras fontes continuam e seus resultados são preservados. A execução pode terminar com cobertura parcial ou sem evidências; isso não prova inexistência do assunto. Fontes nunca são declaradas plenamente lidas com base apenas em snippets. Não há retries ilimitados.

Pesquisas distintas podem rodar simultaneamente. Scheduler compartilhado no mesmo processo limita cada backend a2 workers (owner pode reduzir `providerWorkers` a1), `morechildren` a1, com fila limitada e cooldown de quota. Web/X compartilham backend; não ganham dois workers por rótulo. O limite não é distribuído entre processos DSH independentes. Operações canceladas não liberam slot até o trabalho real terminar.

## Acervo e contexto

`.dumps/research/` precisa estar ignorado pelo Git no projeto; a ferramenta recusa gravar se não puder verificar isso. Não altera `.gitignore` automaticamente. A sessão precisa permitir `workspace-write` para seu cwd ou `danger-full-access`; não há elevação automática. Nesta versão até `inspect` exige essa permissão porque a abertura do acervo prepara diretórios.

```text
.dumps/research/
├── configs/c-<uuid>.json
├── allocations/<contador>/
└── runs/r-<contador>-<assunto>-<sufixo>/
    ├── manifest.json
    ├── index.md
    ├── events/<id>.json
    └── evidence/e-<uuid>.json
```

O manifesto reúne configuração, orçamento e cobertura; cada evidência contém texto e metadados. Arquivos locais evitam despejo do acervo no contexto. Retornos de busca contêm refs/índice e erros limitados; `inspect` tem limites próprios. IDs são imutáveis e isolados pela sessão. Não há compartilhamento entre sessões implícito nem limpeza automática. A pasta é efêmera, não backup.

Locks de continuação impedem duas operações simultâneas na mesma pesquisa. Um lock abandonado após crash exige recuperação manual após confirmar que não há operação ativa; a ferramenta não apaga locks cegamente.

## Segurança e limites de garantia

- URLs externas são lidas pelo serviço HTTP seguro do DSH; conectores MCP usam destinos fixos e ferramentas permitidas.
- Dados externos continuam não confiáveis mesmo salvos em arquivos locais.
- Não usar credenciais de browser nem burlar bloqueios. Não habilitar API paga sem configuração/autorização do proprietário.
- Arquivos/diretórios privados, validação de paths, recusa a symlinks, escritas atômicas. Node não oferece openat/renameat portável: isto não é uma sandbox contra processo local hostil que disputa troca de ancestrais.
- Estado concluído indica término de uma rodada de coleta, não confirmação factual ou cobertura exaustiva.
- A busca `web` reutiliza o backend configurado no perfil, que pode ser Google/Antigravity ou outro. Não prometer Google nos perfis em que esse backend não está instalado.

## Ativação

A substituição usa `tool-web.config.search:false`, preservando `fetch` e o serviço `ctx.web` necessário ao plugin. Perfis com presets precisam da configuração dentro dos presets, não apenas no host. O migrador dedicado registra snapshots/recibo de recuperação e não deve sincronizar plugins alheios.

Reabrir o DSH/perfil pode ser necessário para carregar a nova ferramenta; salvar YAML não prova hot reload. Consulte o relatório final de ativação para os perfis efetivamente verificados.

## Testes

`node --test plugins/research/*.test.mjs`

Testes de conectores usam mocks; execução real precisa ser distinguida das fixtures. Configuração válida não comprova acesso a APIs remotas.
