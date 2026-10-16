# Corrigir questionários após /bg

## Autorização
Usuário reproduziu: ask_user_question funcionou antes de /bg; após background retornou no user-questions answerer accepted the request. Autorizou correção autônoma e commit ao final, sem pedir push.

## Escopo
1. Rastrear eligibility do waterfall/answerer e ownership dos agentes da TUI, background handoff e projeção dos questionários ao retornar. Não concluir causa sem evidência de código/teste.
2. Corrigir apenas roteamento/lifecycle necessário: perguntas de sessões que esta TUI ainda possui devem ser aceitas/enfileiradas; perguntas de outro terminal/agent não pertencente devem continuar delegadas. Nada de capturar todos os agentes globalmente.
3. Preservar ordenação/cancelamento/cleanup da fila e comportamento agentless OAuth/legacy. Pergunta pendente deve reaparecer ao voltar à sessão quando aplicável, sem rejeição silenciosa.
4. Acrescentar regressões com mocks e headless para antes/depois /bg, retorno e isolamento/disposal. Não ler credentials/sessões reais nem chamar providers/modelos/login.
5. Compilar, executar testes focados e guards pertinentes, revisar diff, commitar somente arquivos relacionados no fork custom. Preservar mudanças de outros agentes, sem reset/stash/force/push e sem reiniciar TUIs.

## Aceitação
Regressão demonstra pergunta da sessão background owned não cair no terminal error, permanecer pendente e poder ser respondida ao retornar; agente estrangeiro continua delegado, cleanup/cancelamento preservados. Compilação e testes pertinentes passam; commit local entregue com instrução de reabrir TUI.