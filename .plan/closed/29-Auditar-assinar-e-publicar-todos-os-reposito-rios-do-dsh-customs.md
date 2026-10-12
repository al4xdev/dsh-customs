# Auditar, assinar e publicar todos os repositórios do dsh-customs

## Objetivo e autorização
Atender pedido explícito de revisar todos os .git sob /home/alex/git/my/dsh-customs, commitar mudanças legítimas em inglês no padrão Google/Conventional Commits e dar push com assinatura criptográfica. Goal ativo orienta execução até validação final.

## Inventário
Enumerar repositório principal, frontend/dsh-tui, submódulos vendor, plugins/dsh-antigravity e worktrees/clones sob .dumps; agrupar por git-common-dir para não repetir o mesmo repositório. .dumps é scratch privado: auditar referências mas não incorporar/publicar dumps, caches, credenciais, logs, builds ou cópias geradas. Diretórios sem .git não serão inventados como repos. Respeitar AGENTS de cada raiz.

## Segurança e commits
- Revisar mudanças completas, detectar credenciais/dados privados e separar grupos coerentes. Manter arquivos e conteúdo de outros trabalhos; pedido agora autoriza commitar alterações existentes revisadas, não implementar tarefas novas arbitrárias.
- Não manipular diretamente o conteúdo de .plan mirrors/registry. Dados SQLite runtime ativos não devem ser publicados; se necessários, retirar apenas seu rastreamento Git e ignorar estado runtime, mantendo arquivo local intacto e documentos Markdown revisados. Não apagar ou reescrever planos.
- Rodar testes focados offline/read-only conforme cada alteração, sem probes LLM pagos, deploy ou reinício. Falhas novas bloqueiam grupo até causa identificada; falhas preexistentes registradas explicitamente.
- Commitar caminhos explícitos, evitando add . / -A, usando títulos type(scope): imperative English e corpo quando necessário. Usar git commit -S e verificar cada assinatura com git verify-commit/%G?. Não criar commits vazios apenas para assinar históricos, nem reescrever históricos publicados ou forçar pushes.
- Mudanças concorrentes detectadas por hashes/status precisam ser reavaliadas antes de stage/commit; nenhum stash/reset/clean.

## Remotos e publicação
Identidade gh atual al4xdev; remotos pessoais já presentes serão preferidos a upstreams de terceiros. Verificar auth/remote branches/ancestralidade antes de cada push, publicar branches de trabalho apropriados sem push --all/--mirror, respeitar dependências de submódulos (filho antes de pai). Se não houver remoto pessoal e existir upstream GitHub, usar gh para fork pessoal, preservando upstream; se repositório realmente novo sem upstream, criar repositório pessoal privado por padrão via gh. Não alterar visibilidade de remotos existentes e nunca publicar segredos. Tratar worktrees experimentais compartilhados como evidência local; publicar mudanças de código consolidadas no ramo apropriado quando já integradas.

## Aceitação
Lista de todas as raízes/canonical repos e classificação scratch; cada mudança pública segura commitada em grupo assinado e validado; cada branch destinada a publicação sincronizada com remoto pessoal e SHA local/remoto verificados. Pendências excluídas por privacidade, concorrência ou assinatura/autenticação serão relatadas precisamente, sem alegar limpeza/sincronização inexistente. Sem tags/releases/PRs nem force push.