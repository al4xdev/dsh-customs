# Imagens Markdown vinculadas somente a recibos nativos existentes

## Pedido e auditoria
Dono relatou que imagens tipadas já funcionam no APK8, mas não imagens dentro do Markdown da resposta. Task85 pediu investigação e correção somente com associação exata/proveniência. Exemplo ![...](...) foi solicitado e ainda não veio; NÃO afirmar que o caso real foi corrigido sem conhecê-lo. Readonly c8 confirmou Image.destination descartada em MarkdownProjection92 e nenhuma image tile. SDK público0.2.0-rc.2 dsh-tool-fs:202–210 resolve file_path no backend/sessão,973–995 define read_image,1007–1019 lê regularfile e salva bytes,1035–1045 retorna path/ref;955–962 renderiza exatamente uma Image tipada. ref.name é basename, não alias seguro. Canonical read_image é hipótese explícita deste deployment curado; wire não atesta package-id.

## Escopo implementável sem backend novo
Preservar alt/destination como dados inertes no AST/preparação de texto. Em plano posterior, resolver apenas em prosa assistant FINAL/DURÁVEL:
1. attachment:<opaqueId> exato de imagem proveniente de recibo nativo anterior, confirmado e não ambíguo na mesma conversa admitida.
2. destino EXATAMENTE igual ao ORIGINAL file_path de chamada canônica read_image realmente despachada, com args completos/estritos e uma única imagem tipada resultante, sucesso/resultSeq>callSeq. Sem comparar ref.name/basename, sem resolver cwd/realpath/URL/percent-decode/./ ou adivinhar caminho canônico retornado. Repetição do alias apontando refs diferentes falha fechada.
Nenhum URI genérico autoriza leitura. http(s), file, data, content, javascript, sandbox sem associação anterior exata permanecem inertes. Não instalar pacote/provedor/rede/RPC/alias server; não construir ImageReference a partir de JSON/texto/nomes. Reusar ImageReference completo já admitido e OwnedImageCard/transport attachment existente com suas verificações.

## Proveniência e cronologia obrigatórias
ToolTimelineProjection45–47 preenche nome/args ausentes a partir de preview assistant mesmo com callSeq: NÃO derivar alias do ToolPresentation pós-fallback. Derivar DTO imutável de recibo/call/path no RichTranscriptProjection ANTES desse fallback (ou de originais admitidos durante presenter), somente de par original despachado e resultado correspondente. Falta/orphan/preview/args parcial/duplicada/erro/truncado/offloaded/multi-image recusam associação. Verificar efetivamente duplicatas JSON (strict syntax por si não garante isso).
Ferramenta completa aparece na posição original da CALL e pode ter resultSeq futuro: não usar ordem das linhas para provar anterioridade. Exigir resultSeq < cut ORIGINAL da resposta. sourceSeqs finais reais existem; provenanceSeqs pode ser vazio. Live tem sourceSeqs vazio/seq sintética: manter imagens Markdown inertes no streaming se não houver corte durável comprovado; imagens nativas atuais não são atrasadas.

## Cache/revisão/performance
PreparedMarkdown/text cache guarda só alt/destination, NUNCA associação/autorização/ref. Resolver no plano atual off-main, por sessão/generation/revisão corrente. Novo image cell carrega dependência da origem assistant E recibo completo (sourceStableId/callId/callSeq/resultSeq/args/ref fingerprint). Filtro imediato de células exibidas deve revalidar em retirada/replace/compaction/prune/partial history, mesmo se texto assistant não mudar e mesmo ref continuar em outro lugar. VM knownNow sozinho não prova associação. Nenhum alias global/salvo; caps por mensagem, chaves estruturais estáveis, mesma LazyColumn/SelectionContainer/preview existente. Não parsear args/JSON grande na Main, nem alterar layout/fontes/motion/gestos/paleta/copy.

## Validação negativa/positiva
- Final com sourceSeqs real e provenance vazio aceita recibo anterior; live e receipt futuro na posição de call anterior recusam.
- Preview/orphan/callSeq ausente, chamada original nome/args null recuperados por Timeline, callId diferente, seq inválida, dupJSON, erro/truncado/offloaded/multi-image recusam.
- Mesmo basename em dirs diferentes, relativo/absoluto/.//percent encoding não fazem fuzzy-match. Sem imagem tipada, JSON/texto/path envelope não criam imagem.
- Alias ambíguo e repetidas leituras para refs diferentes ficam inertes; retirada/mudança args/path/ref remove célula antiga imediatamente durante replan, inclusive se mesmo ID permanece em outro recibo. Cross-session/generation/refmetadata falham.
- Verificar parser limites/Markdown imagem no meio de parágrafo, selection/lazy/pan/history/finalização, novas cap/revisão e Native OwnedImageCard no fixture sintético. Nunca imagem/URL/arquivo privado nem chamada real de modelo/HTTP/serviço.
Parent centraliza Gradle/lint/protocolo/JVM/Android no emulador próprio5039/5580. Coordenar freeze de85/86 e compilação; não editar fontes lidas por build em execução. Não instalar no telefone, alterar profile/backend/SDK/TUI/cofre/HA/rede/modelo, ou ativar82/83.

## Entrega honesta
Incluir subset seguro no APK9 se passar validação; documentar que URLs/arquivos arbitrários e caminhos resolvidos diferentes do ORIGINAL continuam sem suporte, e solicitar exemplo do caso real para determinar se precisa proposta de alias backend/permissão externa separada. Sem prometer correção universal. Goal corrente continua guiando execução e permanece ativo até validação integral/decisão necessária.