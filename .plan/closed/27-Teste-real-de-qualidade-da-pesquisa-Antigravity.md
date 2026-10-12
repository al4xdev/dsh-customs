# Teste real de qualidade da pesquisa Antigravity

## Objetivo
Executar uma pesquisa experimental a pedido do usuário, avaliar evidência de busca nativa e qualidade das fontes sem modificar plugins instalados ou perfil padrão.

## Execução
1. Criar runner temporário em `.dumps/` usando o serviço de credenciais e refresh OAuth existente; nunca imprimir ou gravar tokens.
2. Consultar modelos disponíveis e enviar uma pergunta técnica verificável (Node.js 24: lançamento, LTS e migração desde Node.js 22), solicitando Google Search no payload nativo.
3. Preservar somente texto, consultas e metadados públicos de grounding no relatório local; avaliar fontes reais e conferir páginas oficiais se houver resultados.
4. Reportar honestamente a qualidade ou a incompatibilidade do endpoint. Não substituir o provider nem desativar DeepSeek neste teste.

## Validação
HTTP de sucesso não basta: verificar groundingMetadata, consultas e URLs; não apresentar resposta sem grounding como pesquisa comprovada. Limitar timeout e tentativas. Concluir o goal após registrar resultado.