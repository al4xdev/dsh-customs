# Pesquisa Google no fork Antigravity com Flash low

## Pedido
Adicionar pesquisa ao plugin existente usando seu OAuth e `gemini-3.8-flash-low`.

## Implementação
1. Verificar estado do fork e executar probe controlado no endpoint Cloud Code Assist com Google Search nativo, sem expor tokens ou alterar perfil.
2. Adicionar ao fork um provider `ctx.web` opt-in que reutiliza o credential manager, fixa por configuração o modelo pedido, solicita `googleSearch` e normaliza texto e fontes de `groundingMetadata`.
3. Implementar testes para payload, OAuth, cancelamento, erros, SSE e metadados, recusando texto sem evidência de busca. Documentar opções e build.
4. Rodar testes/build e probe real pelo provider. Ativar no perfil dsh-tui mantendo web_fetch e desativando apenas pesquisa DeepSeek somente se busca real comprovada. Caso backend não suporte, entregar código opt-in testado, sem ativar, relatando limitação concreta.

## Segurança e validação
Não trocar silenciosamente de modelo, não considerar resposta de memória uma pesquisa, não registrar credenciais, limitar tempos/volume e não modificar dependências DSH instaladas. Usar goal para acompanhar até conclusão e registrar evidências reais.