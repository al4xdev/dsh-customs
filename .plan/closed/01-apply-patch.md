# Plano 1 — Ferramenta apply_patch baseada na oficial

## Objetivo

Adicionar ao harness uma ferramenta própria de `apply_patch`, usando a implementação oficial do Codex como base, sem modificar as ferramentas padrão `edit` e `write`.

Status: implementação autorizada posteriormente pelo usuário e disponível como plugin local. Testes, integração em instância separada, auditoria de segurança, ativação persistente e comparação prática via dispatcher foram concluídos. Mantidas edit/write como acordado; o teste comparativo confirmou textos idênticos com 3 chamadas de apply_patch, 5 de edit e 4 de write. Não se afirma benchmark de modelos nem ausência de corridas com escritores externos. Consulte `plugins/README.md` para evidências, desvios e pendências. Este plano preserva as decisões originais.

## Decisões acordadas

- Criar uma ferramenta separada para evitar conflitos com atualizações do harness e facilitar reversão.
- Usar a implementação/contrato oficial de `apply_patch` como referência, não inventar um formato incompatível.
- Manter `edit` e `write` habilitadas durante a avaliação inicial.
- Avaliar a desativação de ferramentas padrão no perfil somente após testes reais demonstrarem que isso faz sentido.
- MCP já foi testado pelo usuário e funciona; não faz parte deste plano.

## Papéis das ferramentas

- `edit`: substituição literal simples e precisa em arquivo existente.
- `write`: criação de arquivo ou substituição de conteúdo completo.
- `apply_patch`: alterações contextualizadas, com múltiplos trechos e potencialmente múltiplos arquivos em uma chamada.

## Etapas para futura execução

1. Localizar o código do harness, sua extensão de ferramentas e a configuração dos perfis.
2. Identificar a fonte oficial do Codex para `apply_patch`, registrar URL e revisão, conferir licença e estudar contrato, validações e semântica de falhas.
3. Definir a adaptação mínima ao harness: nome da ferramenta, formato de entrada, resolução de caminhos, política de arquivos e saída de sucesso/erro.
4. Implementar como ferramenta independente, preservando as padrões e permitindo ativação/desativação pelo perfil.
5. Testar criação, edição e remoção de arquivos, múltiplos trechos, múltiplos arquivos, contexto divergente e entradas inválidas. Confirmar na referência oficial quais operações adicionais são suportadas.
6. Verificar o comportamento diante de falha intermediária: não presumir atomicidade; documentar e testar se há mudanças parciais ou oferecer garantias explícitas na adaptação.
7. Experimentar em uma tarefa real e comparar ergonomia, confiabilidade e custo de chamadas com `edit` e `write`.
8. Decidir com o usuário se as três ferramentas ficam disponíveis ou se alguma padrão será desativada no perfil.

## Restrições e pontos de atenção

- Não alterar ferramentas padrão apenas para incorporar o experimento.
- Respeitar políticas de acesso do harness e as instruções aplicáveis ao workspace.
- Para operações destrutivas, considerar a preferência do usuário por arquivos recuperáveis em `/tmp` ou `.bak`; resolver explicitamente essa política antes de habilitar remoção.
- Erros devem distinguir formato inválido, contexto não encontrado, caminhos inválidos e falhas de acesso.
- Não prometer compatibilidade ou aplicação atômica sem verificar e testar.

## Contrato a definir antes de implementar

- **Leitura prévia obrigatória:** exigir observação do conteúdo original antes de alterar arquivo existente. Registrar no harness a versão observada e os intervalos efetivamente apresentados ao agente; leitura truncada não conta como leitura integral. Para patch, exigir cobertura dos trechos alterados e contexto; para substituição integral, exigir leitura integral. Definir tratamento explícito para arquivos recém-criados/editados pela própria sessão e para remoção. Arquivo novo não exige leitura prévia, mas a criação deve falhar se o destino já existir.
- **Conteúdo desatualizado:** associar a leitura a uma versão/hash do conteúdo, não apenas ao caminho ou horário. Se o arquivo mudar depois da observação, rejeitar a edição com erro de conflito e exigir nova leitura e reavaliação do patch; correspondência de contexto sozinha não prova que o arquivo continua na versão observada. Inicialmente preferir invalidar a observação do arquivo inteiro, mesmo que a mudança externa seja fora do trecho.
- **Concorrência no momento da escrita:** verificar a versão esperada tão perto da aplicação quanto possível e definir mecanismo de sincronização e seus limites. Não afirmar que hash seguido de escrita ou rename atômico elimina a corrida entre verificação e gravação contra escritores externos não cooperativos.
- **Proteção compartilhada:** estudar integração com a política de observação já existente no harness para aplicar a mesma regra a `edit`, `write` e `apply_patch`, sem modificar desnecessariamente as ferramentas padrão. Uma checagem apenas na ferramenta nova não protege sobrescritas pelas outras ferramentas; explicitar também o limite de comandos shell/MCP que alteram arquivos.
- **Testes de observação:** cobrir edição sem leitura, leitura parcial insuficiente, arquivo modificado externamente após leitura, nova leitura após conflito, mudanças feitas por subagentes e duas edições concorrentes. O conflito deve preservar as mudanças externas.
- **Falhas parciais:** definir se a validação ocorre antes de qualquer escrita, quais falhas ainda podem ocorrer durante a aplicação e como a resposta identifica arquivos alterados, não alterados e estado incerto. Usar a implementação oficial como referência não garante atomicidade automaticamente.
- **Caminhos:** definir a raiz de resolução, tratamento de caminhos absolutos, `..`, links simbólicos e destinos fora do workspace; validar os destinos efetivos conforme a política do harness antes de modificá-los.
- **Desfazer e recuperação:** decidir explicitamente se haverá rollback automático, operação de undo ou recuperação por backups. Definir escopo, armazenamento e duração dos backups, inclusive para criação e remoção; impedir que um undo sobrescreva alterações posteriores sem detectar o conflito. Não usar restauração Git indiscriminada, que poderia perder mudanças prévias do usuário.
- **Testes de falha:** simular falha após uma primeira escrita bem-sucedida, falha no próprio rollback, destinos inválidos e alterações concorrentes antes de desfazer. Documentar os limites das garantias oferecidas.

## Critérios de conclusão

- Ferramenta nova disponível em um perfil de teste, com origem oficial e licença registradas.
- Testes cobrindo operações suportadas e falhas relevantes.
- `edit` e `write` originais preservadas.
- Ativação reversível sem alterações no núcleo padrão, conforme os mecanismos disponíveis no harness.
- Avaliação prática registrada e decisão do usuário sobre manter ou substituir ferramentas no perfil.
