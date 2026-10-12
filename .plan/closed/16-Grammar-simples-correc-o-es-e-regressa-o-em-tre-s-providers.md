# Grammar simples: correções e regressão em três providers

## Objetivo
Revisar o plugin grammar-fix, preservar as alterações existentes e manter uma implementação pequena, com testes reproduzíveis no GPT, Gemini Flash e modelo local. Usar o goal ativo para orientar a execução até a verificação.

## Escopo
- Corrigir configuração de idioma: `auto` preserva o original e códigos suportados viram nomes inequívocos no prompt.
- Aceitar IDs de modelo com barras internas (comum em modelos locais), mantendo `provider/model` como formato.
- Garantir cancelamento no descarte do plugin, limpeza de listeners/busy e rejeição de streaming vazio, incompleto ou com erro; remover código morto.
- Manter fallback de reasoning limitado ao erro específico de esforço incompatível, sem adicionar retry genérico ou alterar integração visual.
- Adicionar testes determinísticos do bridge e uma rotina real opt-in que usa o serviço LLM e credenciais do perfil instalado, sem copiar segredos, alterar a rota padrão ou enviar conteúdo privado.
- Testar português, inglês/auto e preservação de tokens técnicos nos três modelos disponíveis; salvar relatórios temporários em `.dumps/` e documentar comandos e limitações.

## Critérios
Testes unitários passando, cancelamento permitindo nova correção, nenhum resultado parcial aplicado e três rotas reais com resultados verificáveis. Se provider estiver indisponível, registrar a falha sem declarar aprovação. Não implementar o redesenho visual do plano 15 nesta tarefa nem fechar aquele plano. Sem commit/push.