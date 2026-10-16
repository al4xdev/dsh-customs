# Self-heal: compatibilidade de persistência e reabertura segura da task_84

## Objetivo e autorização
Corrigir o plugin e sua integração local de persistência; restaurar a capacidade de abrir a sessão `e8d530cf-b66a-46c9-82f2-272317e6f0ce` de `/home/alex/git/my/alex-tavern` (task_84). O usuário autorizou atualizar apenas essa sessão e pediu a solução mais segura. Não apagar ou modificar outras sessões. Usar o goal ativo como critério de conclusão.

## Diagnóstico confirmado
O plugin grava `agent/self-heal` como evento obrigatório. O SDK instalado permite append, mas seu catálogo estático não reconhece esse evento ao carregar o disco. O registro da task_84 contém 23 desses eventos, começando em seq 6976. A configuração dsh-tui aponta para `plugins/agent-self-heal/lib/index-v2.mjs`. Registrar uma projeção não altera o catálogo. O campo `ignorable` não é adequado sem prova de omissão segura: estes registros preservam orçamento consumido e recibos causais, não apenas mensagens informativas.

## Implementação proposta
1. Confirmar APIs e revisão independente; registrar hashes dos arquivos envolvidos e estado do repositório. Preservar mudanças alheias.
2. Implementar uma integração local estática e reproduzível, restrita ao SDK da instalação `/home/alex/.local/share/dsh-cli`: incluir exclusivamente `agent/self-heal` no vocabulário do build de `@deepseek-ai/dsh-session`, mantendo recusa de outros eventos desconhecidos. Manter sincronizados o bundle efetivo `lib/index.js` e a saída de catálogo `lib/types/known-event-types.js`. O patch downstream deve ficar versionável neste repositório, com preflight por hashes/contexto, backup durável, aplicação verificável e rollback que recusa sobrescrever mudanças posteriores. Não alterar permissões, retries, pi-ai, credenciais nem a instalação npx/web.
3. Corrigir o plugin com uma checagem explícita da compatibilidade do leitor antes de registrar middleware/gravar novos audits: em SDK incompatível, falhar claramente, sem criar mais sessões ilegíveis. Não mutar Sets internos em runtime nem renomear eventos para tipos nativos sem relação. Recompilar em novo bundle com dependências internas completas e promover o ponteiro dsh-tui somente após validação; preservar estadoVersion1, política V2 e maxCycles3.
4. Preservar eventos obrigatórios, sequências e dados de recuperação. Para task_84, preferir NÃO reescrever nada: o leitor corrigido deve aceitar seus eventos existentes. Fazer backup verificado do arquivo comprimido antes da validação final e registrar hashes antes/depois. Só se a investigação demonstrar necessidade real de migração, submeter revisão específica antes de alterar o histórico.

## Testes e evidência
- Testes puros atuais do plugin e contratos relevantes.
- Teste negativo: SDK original recusa agent/self-heal; plugin detecta incompatibilidade antes de hooks/audits.
- Teste positivo: SDK corrigido aceita evento obrigatório reconhecido, mas continua recusando outro evento obrigatório desconhecido.
- Round-trip real com backend JSONL/zstd instalado em workspace isolado `.dumps/`, não apenas Session em memória: append, flush, close, nova instância/processo, load.
- Replay de projeção preserva orçamento gasto, dedupe e recuperação V1/V2; episódio esgotado não ganha ciclos por reload. Mensagens, sourceEventSeqs e auditorias não são removidos.
- Leitura real read-only da task_84 e replay com plugin V2; os 23 audits e todos os eventos permanecem, hashes do arquivo original idênticos.
- Documentar escopo local e necessidade de novo processo TUI: processos antigos mantêm módulos ESM em cache. Não reiniciar nem encerrar processos alheios automaticamente.

## Publicação e conclusão
Publicar apenas artefatos aprovados e SDK/profile locais com backups e recibos de integridade; guardar fixtures e relatórios temporários em `.dumps/`, backups duráveis fora de `/tmp`. Não prometer upgrade de todos os processos já abertos. Fechar o plano e goal somente após comprovar round-trip e leitura nativa da task_84 com preservação de estado, relatando qualquer passo manual restante.