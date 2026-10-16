# Reproduzir o perfil do host no Docker

## Pedido
Usuário pediu puxar o perfil atual para testar, após ausência de Gemini no perfil público da imagem. Corrigir a cobertura incompleta anterior, sem inferência automática.

## Execução
1. Inspecionar somente manifests, YAML e includes específicos de `/home/alex/.dsh/profiles/dsh-tui` e configuração raiz requerida pela composição. Não imprimir conteúdos sensíveis: leitura de YAML privado será programática com saída limitada a IDs, nomes de módulos, estrutura e referências redigidas. Nenhuma busca ampla de home/credenciais.
2. Exportar cópia sanitizada em `.dumps/`, preservando ordem, IDs, providers, presets e políticas; excluir tokens/keys/credentials/OAuth, histórico/sessões e endpoints/referências pessoais não necessários. Não alterar host. Caminhos de módulos públicos serão remapeados para fontes no container; includes adicionais auditados individualmente.
3. Aplicar ao container de teste existente (confirmar nome/estado), preservando login/credenciais que o usuário possa já ter criado nele. Não substituir diretório `.dsh` inteiro nem tocar credenciais. Atualizar wiring público da receita, caso necessário; somente arquivos explicitamente revisados entram em Git, nunca export privado/dumps.
4. Verificar composição offline e registro de providers sem iniciar modelo, autenticação, chamada de quota ou daemon. Usar APIs de composição sem avaliação de !js ou imports de providers quando houver risco. Distinguir registrado de autenticado/funcional.
5. Entregar comando fish e listar qualquer ajuste/config removida e capability não copiada. Goal acompanha até perfil testável sem spend automático.

## Aceitação
Gemini/Antigravity e demais módulos/providers do perfil auditado presentes na composição Docker, identidade dos SDKs canônica, teste sintético/estático pertinente aprovado. Nenhum token impresso/publicado/copied para imagem, nenhum modelo chamado. Login existente do container preservado.