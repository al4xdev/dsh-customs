# Research — plano-base revisado da ferramenta orquestradora

## 1. Estado e escopo

**Aguardando revisão humana. Não implementar, instalar, conectar contas ou iniciar levantamento adicional por causa de autoApprove.** O proprietário esclareceu que a aprovação do projeto é automática e ainda examinará o plano. A próxima etapa depende de orientação humana explícita.

Revisão 3: incorpora grep.app e Context7 à arquitetura técnica. Consolida a arquitetura anterior, a simulação de uma pergunta sobre Gemini 4 e a persistência seletiva em `.dumps`. Nada foi implementado.

Objetivo: uma tool pública `research` para configuração prévia, descoberta paralela, leituras obrigatórias, coleta persistente e investigação incremental conduzida pelo agente do turno.

## 2. Preferências confirmadas

- Uma tool pública encapsula conectores especializados.
- `config` antecede `search`; leituras configuradas são executadas pelo código, não apenas recomendadas ao agente.
- Fontes independentes são consultadas em paralelo.
- **Hacker News (`news.ycombinator.com`), Reddit e X são fontes centrais**, podendo ser prioritárias em relação a Google dependendo da pergunta.
- O fórum desejado é Hacker News; Lobsters/Slashdot não são requisitos iniciais.
- Pesquisa persiste em `.dumps` do projeto, com padrão de árvore, contador, identificador e nome legível.
- O agente recebe índice compacto e recupera conteúdo seletivamente, evitando despejo de documentos no contexto.
- Proprietário propôs **grep.app e Context7 em lugar da busca genérica no GitHub**. Proposta refinada: grep.app para descobrir código, Context7 para documentação; GitHub direto permanece apenas como leitor/fallback para fontes que esses serviços não substituem, especialmente issues, PRs e discussions. Esse refinamento aguarda revisão.

## 3. Estado conhecido e verificação preliminar

Configuração local previamente inspecionada em `/home/alex/.dsh/profiles/dsh-tui/cordis.patch.yml`: busca `google-antigravity`, modelo auxiliar `gemini-3.8-flash-low`, provedor `web-search-deepseek` desativado, leitor `http`. Há browser separado. Usar modelo principal local não torna esse backend de busca local.

Reutilizar provedor atual antes de considerar fork. Implementação efetiva, interface, licença e quotas ainda precisam ser verificadas.

### Novos candidatos

- **grep.app:** há publicação oficial da Vercel intitulada “Grep a million GitHub repositories via MCP”. A consulta direta ao site grep.app retornou HTTP 429/checkpoint; não confundir esse bloqueio do site com teste de disponibilidade do MCP. Endpoint, schema, autenticação, quotas e cobertura do MCP ainda não foram validados.
- **Context7:** README oficial confirma MCP, ferramentas `resolve-library-id` e `query-docs`, documentação orientada a bibliotecas/versões e endpoint remoto `https://mcp.context7.com/mcp`. É necessário resolver identidade da biblioteca antes de consultar, salvo ID já conhecido. API key é recomendada para limites maiores. Não assumir cobertura ou versão disponível sem conferir o resultado.
- O README do Context7 informa que backend, parser e crawler não fazem parte do repositório público do servidor MCP. **Servidor MCP local não equivale a serviço integralmente local ou independente de backend externo.**

Fontes consultadas para esta revisão:
- https://vercel.com/blog/grep-a-million-github-repositories-via-mcp
- https://raw.githubusercontent.com/upstash/context7/master/README.md

Nenhuma instalação ou chamada real aos MCPs foi realizada.

## 4. Responsabilidades

### Política do proprietário

Define provedores, credenciais, permissões de acesso/browser, retenção e tetos de tempo/custo. O agente não pode elevar permissões ou orçamento via `config`.

### Estratégia escolhida pelo agente

Define assunto, intenção, janela temporal, fontes, comentários e profundidade dentro da política existente. Perguntas simples não devem exigir do usuário decisões técnicas a cada pesquisa.

### Orquestrador

Busca, seleciona por critérios explícitos, lê, pagina, expande links, persiste, deduplica e contabiliza orçamento. Na versão inicial proposta não há segundo LLM obrigatório escondido. O provedor Google atual pode usar seu próprio modelo auxiliar, explicitamente.

### Agente do turno

Julga significado, contradições, independência das fontes e suficiência da resposta; decide novas consultas e recuperação seletiva. Planejador LLM interno é evolução opcional, não requisito.

## 5. Arquitetura

```text
Agente do turno
├── research.config
│   ├── Política do proprietário + estratégia da pergunta
│   ├── Capacidades e degradações por conector
│   └── config_id + revisão imutável
├── research.search
│   └── Orquestrador com fila contínua
│       ├── Descoberta em paralelo, conforme intenção
│       │   ├── Google/Antigravity → web, notícias e fontes oficiais
│       │   ├── Reddit → tópicos e relatos
│       │   ├── X → posts e conversas acessíveis
│       │   ├── Hacker News → notícias e discussão técnica
│       │   ├── grep.app/MCP → ocorrências de código indexado
│       │   └── Context7/MCP → documentação de biblioteca/versão
│       ├── Leituras assim que resultados ficam disponíveis
│       │   ├── Web → HTTP; browser opcional autorizado
│       │   ├── Reddit/X/HN → tópicos, comentários e paginação
│       │   ├── Código → contexto de arquivo/repositório quando necessário
│       │   └── GitHub direto → raw, issues, PRs e discussions quando pertinente
│       ├── Persistência incremental em .dumps/research/
│       └── Retorno compacto: índice, refs, cobertura e orçamento
├── research.inspect → recuperar partes do acervo local
├── research.continue → aprofundar a mesma pesquisa e orçamento
└── Resposta com referências e limitações
```

MCP é transporte/interface de integração, não uma fonte adicional em si. Conectores MCP ficam encapsulados; o agente não precisa receber dezenas de tools públicas. Reutilização do cliente MCP do DSH e interceptação/persistência do retorno antes de entrar no contexto precisam de validação técnica.

Context7 possui dependência interna `resolve-library-id → query-docs`; não fingir que essas duas operações são independentes. Os diferentes conectores podem rodar em paralelo.

## 6. Contrato proposto

Os nomes abaixo são propostas, não schemas implementados.

### `config`

Registra configuração efetiva dentro da política, devolvendo `config_id`, revisão, capacidades, degradações e limites. Não testa APIs pagas inesperadamente nem armazena segredos. Configuração ausente/inválida causa erro explícito em `search`.

Distinguir capacidade de descoberta e de leitura: buscar Reddit via Google não significa conseguir coletar comentários. Fonte obrigatória exige tentativa verificável e prestação de contas, não acesso garantido.

### `search`

Cria `run_id` e diretório persistente; adapta consulta a cada fonte, seus filtros e sintaxe. Executa pipeline contínuo, sem esperar a fonte mais lenta para iniciar leituras. Reserva orçamento entre fontes para uma fonte rápida não consumir tudo.

Não disparar grep.app/Context7 indiscriminadamente em toda pesquisa. Uma pergunta sobre notícias de Gemini não exige busca de código; uma pergunta sobre SDK/API pode exigir documentação e exemplos de uso.

### Leitura obrigatória depende do tipo de resultado

- Resultado de busca com snippet: abrir fonte selecionada.
- Discussão: coletar post e comentários conforme política.
- Trecho de código grep.app: persistir repo/caminho/linhas/ref quando disponíveis; ampliar contexto quando insuficiente. Trecho não representa análise do arquivo inteiro nem cobertura de todos os repositórios.
- Context7: conteúdo documental efetivamente retornado pode ser persistido como leitura, sem scrape redundante obrigatório. Resolver fonte e versão, registrar limites; abrir documentação original quando necessário para confirmação/contexto.

Leitura obrigatória significa evidência acessada, não sempre uma segunda requisição HTTP. O schema deve indicar `snippet`, `document_excerpt`, `full_document`, `thread_partial` ou equivalente, sem declarar completude falsa.

### `inspect`

Consulta local por referência, fonte, rodada, busca textual ou trecho com offset/limite. Retorna proveniência e truncamento. Ferramentas nativas de leitura/busca também podem acessar os arquivos autorizados. Embeddings não são requisito inicial.

### `continue`

Recebe `run_id`, consultas e/ou referências a aprofundar. Herda revisão de configuração, evidências, cache e orçamento restante; não reinicia limites. Tipar separadamente referências de evidência e cursores de paginação.

### Progresso/cancelamento

Preferir jobs existentes do DSH após avaliar integração. Informar progresso compacto, permitir cancelamento de tarefas pendentes e preservar evidências válidas. Não depender de polling frequente. Ampliar orçamento requer política/autorização adequada; não contornar limite criando nova pesquisa automaticamente.

## 7. Persistência em `.dumps/research`

### Identificação proposta

`r-<contador>-<slug>-<sufixo-unico>`; exemplo fictício: `r-000042-novidades-gemini-4-a81f2c`.

Contador monotônico por projeto, alocação atômica entre processos/sessões, sufixo único e slug sanitizado/curto sem segredos. ID imutável; título pode mudar no manifesto. Evidências têm referências estáveis independentes da ordem do índice.

```text
<projeto>/.dumps/research/
├── registry.json                   # contador e catálogo mínimo
└── r-000042-novidades-gemini-4-a81f2c/
    ├── manifest.json               # identidade, sessão, estado e caminhos
    ├── config.json                 # snapshot efetivo, sem credenciais
    ├── index.md                    # mapa compacto e limitado
    ├── coverage.json               # cobertura e limitações por fonte
    ├── budget.json                 # consumo acumulado e reservas
    ├── events.jsonl                # eventos/checkpoints, não raciocínio privado
    ├── rounds/
    │   ├── 001/
    │   │   ├── queries.json
    │   │   └── results.jsonl
    │   └── 002/
    ├── evidence/
    │   ├── e-000001/
    │   │   ├── metadata.json       # URL, origem, datas, hash, refs e cobertura
    │   │   ├── content.md          # conteúdo normalizado
    │   │   └── comments.jsonl      # opcional; IDs e relações entre respostas
    │   └── e-000002/
    └── reports/
        └── answer.md               # síntese derivada opcional, não fonte primária
```

A árvore é um padrão proposto; não criá-la operacionalmente nesta revisão. Payload bruto opcional, sanitizado e limitado. Metadados técnicos podem incluir biblioteca/versão, repositório, arquivo, linhas, commit/ref e URL original, quando realmente disponibilizados.

### Retorno ao modelo

Somente `run_id`, revisão, estado, ref/caminho do índice, cobertura, orçamento e lista curta de evidências com título/URL/tipo/estado de leitura. Limitar explicitamente itens e tamanho de retorno; paginar índice por fonte/rodada. Sem resumo global obrigatório gerado por outro LLM.

Conteúdo de MCP também deve passar por esse armazenamento/limitação antes de entrar no contexto, e não chegar integralmente ao agente para só depois ser salvo.

### Integridade e segurança local

- Verificar `.dumps/` ignorada pelo Git e mantida local; não commitar pesquisas.
- Isolar projeto/sessão; compartilhamento e retomada entre sessões devem ser explícitos.
- Confinar caminhos à raiz autorizada; impedir traversal e escapes via symlink.
- Snapshots atômicos, checkpoints e detecção de arquivos incompletos; falha de escrita não é sucesso.
- Sanitizar tokens, cookies, headers e URLs com segredos.
- Definir retenção e limpeza; nunca apagar pesquisa ativa. `.dumps` não é backup.
- Arquivo removido deve produzir evidência ausente, não recuperação fictícia.
- Cache registra data de coleta e validade. Novidades podem exigir revalidação; não misturar conteúdo antigo e recente sem identificação.

## 8. Loops, limites e estados

Separar rodadas investigativas do agente, paginação de conectores e expansão de links. Definir cada contador sem misturá-los em um único `max_rounds` ambíguo.

Orçamento por pesquisa: tempo, chamadas, tentativas/retries, páginas, comentários, bytes, profundidade, rodadas e custo quando mensurável. Retry limitado com backoff; nada de espera infinita.

Eixos independentes:

- Execução: criada, em andamento, concluída, cancelada ou falhou.
- Cobertura: atendida, parcial ou indisponível por fonte/critério.
- Suficiência da resposta: avaliação do agente, não contagem de documentos.

Zero resultado, falta de credencial, timeout e bloqueio são condições diferentes. Não encontrar anúncio não prova inexistência do produto.

## 9. Evidências e escolha de fontes

Provedor de descoberta e origem do conteúdo são campos distintos. Google não é autoridade por si só; grep.app não é autor do código; Context7 não substitui automaticamente a documentação original.

- Anúncio/disponibilidade: priorizar evidência oficial.
- Experiência/falhas/percepção: priorizar Reddit, X e HN quando pertinente.
- Uso real de APIs/código: grep.app.
- Documentação de biblioteca/versão: Context7.
- Bugs e decisões de projeto: issue/PR/discussion original quando necessário.

Preservar publicação, atualização, acontecimento quando identificável e coleta; datas ausentes/incertas não são inventadas. Diferenciar relato, rumor e confirmação com avaliação do agente vinculada a fontes.

Deduplicar URLs/conteúdo preservando proveniência. Vários sites repetindo a mesma origem não representam confirmações independentes; detecção semântica depende do agente, não só de hashes.

Comentários preservam IDs, parents/roots, datas e autor público quando necessário. Declarar seleção por votos/recência/relevância e truncamento; amostra não representa comunidade inteira. Conteúdo indexado e versões documentadas não têm cobertura garantida.

## 10. Matriz preliminar de conectores

| Conector | Função | Pendências |
|---|---|---|
| Google/Antigravity | Descoberta web atual | Interface, licença, quotas e retorno estruturado |
| Reddit | Tópicos e comentários | API/acesso autorizado, termos, limites, paginação e fallback |
| X | Posts e conversas | Provedor/API exatos, custos e cobertura; app não implica API |
| Hacker News | Itens e discussões | Busca/leitura, limites, datas e itens removidos |
| grep.app MCP | Busca em código indexado | Endpoint/schema, autenticação, quotas, termos e contexto retornado |
| Context7 MCP | Identificação de biblioteca e documentação | Quotas, chave, versões disponíveis, proveniência e dependência externa |
| GitHub direto | Leitura/fallback específico | API/raw, paginação, quotas e acesso a issues/PRs/discussions |
| HTTP/browser | Leitura genérica | Segurança, extração, bloqueios e autorização de browser |

Discourse/RSS/outros fóruns são extensões futuras, não requisitos iniciais.

## 11. Simulação de aceitação

Pergunta hipotética: “Vê novidades sobre Gemini 4”. Não pressupõe existência ou lançamento real.

1. Agente escolhe intenção/janela temporal; `config` informa limites e disponibilidade.
2. `search` cria acervo, consulta fontes apropriadas em paralelo e inicia leituras progressivamente.
3. Comunidades têm prioridade conforme intenção; grep.app/Context7 não disparam sem necessidade técnica.
4. Evidências são persistidas; somente índice compacto entra no contexto.
5. `inspect` recupera evidências úteis; agente distingue fontes oficiais de relatos/rumores.
6. Alegação não verificada provoca `continue`, com orçamento restante, não nova pesquisa desconectada.
7. Resposta cita fontes e limitações.
8. Pergunta “o pessoal do Reddit gostou?” retoma comentários existentes e amplia seletivamente, sem afirmar representatividade indevida.
9. Pergunta “como uso isso no SDK?” pode ativar Context7/grep.app conforme configuração/permissões; eventual mudança exige revisão explícita de configuração, nunca mutação silenciosa de pesquisa em andamento. Definir se será pesquisa vinculada ou revisão derivada antes de implementar.
10. Após compactação/interrupção, referência explícita e checkpoints permitem recuperação sem reinjetar o acervo inteiro.

## 12. Levantamento futuro, ainda não autorizado a iniciar

- Inspecionar interfaces/licenças do provedor atual e decidir reutilização/fork com justificativa.
- Mapear plugins, cliente MCP, jobs, cancelamento, persistência e limites do DSH.
- Confirmar documentação oficial e custos das fontes; testar conectores somente no escopo autorizado.
- Verificar como capturar retorno MCP no orquestrador antes da exposição ao contexto.
- Definir schemas de configuração, evidência, referência, cursores, identidade de biblioteca/versão e estados.
- Validar contador concorrente, armazenamento atômico, isolamento e recuperação seletiva.
- Definir SSRF, redirects, URLs, browser e limites de permissões.
- Submeter implementação faseada, testes e custo estimado em nova revisão humana.

## 13. Decisões pendentes

1. Provedor/acesso/custo do X e credenciais autorizadas do Reddit.
2. Confirmar perfis de fontes: sempre tentar HN/Reddit/X ou selecionar por intenção; Google e fontes técnicas por contexto.
3. Confirmar grep.app + Context7 como descoberta técnica e GitHub direto apenas como leitor/fallback.
4. Confirmar primeira versão sem planejador LLM interno obrigatório.
5. Aprovar nomes de ações, árvore/contador, isolamento e compartilhamento de pesquisa.
6. Definir tempo, custo, armazenamento, comentários, concorrência e tamanho de retornos.
7. Definir retenção, atualização de cache e limpeza.
8. Browser/autenticação e integração com jobs.
9. Definir acesso/chave/quota de Context7 e grep.app após verificação, sem solicitar segredos no chat.

## 14. Critérios de aceite futuros

- Agente não amplia política do proprietário; config é validada/versionada.
- Leituras previstas são executadas na tool; snippets não contam como documentos completos.
- Conteúdo documental retornado por conector pode cumprir leitura parcial tipada, sem scrape redundante obrigatório.
- Pipeline paralelo respeita limites e diversidade de fontes.
- Conteúdo de qualquer transporte, inclusive MCP, é persistido e limitado antes do contexto.
- Continuação preserva referências, orçamento e proveniência.
- Falhas parciais, datas e limites de cobertura são explícitos.
- Conteúdo externo permanece não confiável inclusive em arquivos locais; nenhuma instrução embutida é executada.
- Segredos não aparecem em logs/acervo/retornos; paths/URLs são validados.
- IDs concorrentes não colidem; interrupção e cancelamento preservam evidências válidas sem trabalho órfão.
- Testes cobrem timeout, bloqueio, fontes vazias, duplicatas, paginação, comentários, orçamento, limites de contexto, prompt injection, SSRF, traversal, concorrência e recuperação.
- Testes específicos cobrem resolução de biblioteca ambígua, versão ausente, trecho de código insuficiente, quota MCP e metadados de origem incompletos.
- Validação real futura informa acesso/custo/cobertura efetivos, sem prometer equivalência automática a serviços comerciais.

## 15. Próxima ação

**Entregar esta revisão e aguardar leitura e orientação humana explícita. AutoApprove não autoriza avançar contra essa orientação.**
