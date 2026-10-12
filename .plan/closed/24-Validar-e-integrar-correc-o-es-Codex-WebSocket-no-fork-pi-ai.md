# Validar e integrar correções Codex WebSocket no fork pi-ai

## Objetivo e escopo autorizado
Integrar correções de transporte Codex pertinentes no fork `/home/alex/git/my/pi`, base v0.87.1+c043ded, preferindo cherry-pick e corrigindo patches conforme autorização explícita do usuário. Sem implantação no host, push, publicação, LLM requests ou alterações de outros providers.

## Seleção e evidência
- Revisar PR7648 (head51ba89acfdd134b8582325ec4ea991ce0faccd23): recuperação após metadata antes de assistant output; avaliar diff e commits, não aplicar indiscriminadamente retries genéricos de erros desconhecidos.
- Revisar fork fitchmultz commit732d7c07f18a739bd7103883b01b272392fd7314: fallback SSE persistente apenas1009, recuperação WS na chamada seguinte.
- Procurar outras correções diretamente relacionadas (lifecycle/replay/transporte), verificar se já presentes; excluir features e alterações não justificadas. Merged PR4133 já está incluída e não deve ser reaplicada.

## Implementação segura
1. Verificar árvore limpa, preservar fix reasoning e refs atuais. Buscar refs candidatos sem mover a branch de uso.
2. Criar worktree/branch de revisão isolada sob `.dumps/pi-ai-fork/` do workspace. Inspecionar integralmente os arquivos alvo e regras locais; não sobrescrever outras mudanças.
3. Rodar baseline offline de testes focados. Aplicar candidato via cherry-pick sem commit imediato na revisão quando adequado; resolver apenas arquivos autorizados. Ajustar testes/patch antes de commit.
4. Distinguir metadata observada de assistant output; qualquer bloco de texto/refusal/reasoning/ferramenta, inclusive vazio ou assinatura criptografada, impede replay. Manter um único start/terminal, limpar estado de tentativa quando recuperável, conexão nova/full history e recuperação limitada com cancelamento respeitado.
5. Proteger retry missing_previous_response contra replay após output; não ignorar fechamento1000 globalmente. Avaliar mudança de sticky SSE apenas1009 separadamente, preservando diagnóstico/cancelamento e testes de lifecycle.
6. Executar testes focados mockados e `npm run check` conforme regras pi; nenhum E2E/live. Provar falhas regressivas no baseline quando possível e sucesso no patch, sem modificar dependências/catalog metadata desnecessariamente.
7. Commitar apenas caminhos próprios explicitamente, mantendo autoria/proveniência de cherry-picks; após validação integrar commits à branch pessoal original com cherry-pick se árvore continuar limpa. Se árvore mudar, parar em vez sobrescrever. Registrar commits/resultados e manter revisão recuperável.

## Critérios de aceitação
- Metadata+close1000 recupera antes de output; text/reasoning/tool/customtool, mesmo vazios, nunca repetem.
- Completed/done/incomplete+close1000 não vira falha extra; cancelamento não faz retry.
- Missing_previous após conteúdo não duplica output; asserts de request count/start/terminal e preservação parcial.
- Sticky SSE e conexão descartada têm testes pertinentes; TTL/idade/reuse já existentes continuam passando.
- Fix reasoning preservado, testes offline e check passam; working tree/commits reportados. Uso do goal ativo para acompanhamento. Host instalado permanece inalterado; implantação é etapa separada.