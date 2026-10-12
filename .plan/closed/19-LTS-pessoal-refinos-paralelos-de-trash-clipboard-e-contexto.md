# LTS pessoal: refinos paralelos de trash, clipboard e contexto

## Intenção
Revisão final conservadora em paralelo, solicitada pelo usuário. Não caça a bugs, reescrita nem features. MCP fica por último. Usar o goal ativo até a verificação; preservar todas as alterações existentes.

## Revisões concluídas
Os três subagentes não identificaram necessidade concreta de mudar produção. A base já tem 50 testes passando para os contratos de apply-patch, list e grammar. Testes antigos registrados nos READMEs continuam sendo evidência histórica, não serão reconstruídos como suíte geral.

## Implementação independente por plugin
1. **Trash:** criar README próprio curto e trash.test.mjs apenas read-only para contratos públicos de política, entradas inválidas e caminhos protegidos. Não chamar trashOne/execute nem remover/mover/criar fixtures. Explicitar recuperação sem overwrite, tmpfs perdido no reboot e limites de cross-FS/metadados. Não prometer testes de rename/EXDEV/recuperação real.
2. **Clipboard:** criar README curto e clipboard.test.mjs com executável wl-copy FALSO em .dumps, PATH exclusivamente para esse stub e display fictício. Testar texto Unicode/newlines, vazio, falha, executável ausente, cancelamento/timeout; descoberta de socket somente se simples. Não acessar clipboard/compositor real. Fixtures/processos pertencem somente ao teste; limpeza limitada aos recursos identificados do teste. Não expandir para gerenciamento complexo de descendentes. Documentar Wayland/wl-clipboard, ambiente, ausência de fallback X11 e que cancelamento não é rollback.
3. **Workspace-context:** criar workspace-context.test.mjs focalizado nos contratos existentes de cwd/sessão e prompt; se conveniente, fixtures Git locais artificiais em .dumps para root/subdir/fora Git/symlink. Sem mudar index.mjs. Acrescentar ao README existente somente comando e limites dos testes, preservando toda documentação já boa.
4. **Integração pelo agente principal:** adicionar scripts test:trash, test:clipboard, test:workspace-context e test:lts:contracts para os seis plugins revisados, sem managed-plans/MCP e sem chamadas live a modelos. Documentar esse recorte atual em plugins/README.md sem confundir a evidência histórica com validação de todo harness.

## Restrições
Subagentes só editam testes/README do próprio plugin; package.json e README central ficam com o agente principal. index.mjs dos três e common.mjs intactos. Nenhum deploy/ativação, dependência nova, migração, cópia real de clipboard ou operação real de trash. Se aparecer necessidade de produção, reportar e discutir antes de expandir.

## Aceite
Suítes focadas e conjunto de contratos passando, outputs/falhas coletados, diff/whitespace verificados, limitações de mocks versus integração claras e arquivos de produção sem diff. Sem commit/push.