# Grammar-fix: fidelidade ao Pi e correção robusta

## Objetivo
Corrigir falhas intermitentes do grammar-fix e copiar a experiência de https://github.com/al4xdev/pi-grammar-fix, sem alterações no core do harness nem perda das modificações já presentes.

## Investigação observada
- O frontend local já tem integração de Ctrl+G no composer e Launchpad, mas só uma caneta, sete posições e quatro frases; Pi tem cinco temas, oito posições, 14 frases, ícones aleatórios e contexto de idioma/modelo.
- O bridge usa streaming separado, limite de tokens e deadline, mas precisa regressões de abort, busy, esforço, erros transitórios e término incompleto. Confirmar contratos reais de LLM antes de ajustar.
- Há alterações pré-existentes em ambos os repositórios; preservar e modificar apenas trechos relacionados.

## Implementação
1. Auditar contrato do streaming e evidências locais de falhas; corrigir causas reproduzíveis. Garantir cancelamento/deadline efetivos, liberação de busy, erros claros, nenhuma aplicação parcial e retries limitados apenas para falhas recuperáveis.
2. Portar os cinco temas emoji, 14 frases originais e ritmo de 150 ms do Pi em componente de atividade; exibir idioma/modelo selecionados e mensagens de sucesso/sem mudanças com ícones. Preservar tema do terminal, undo, draft/session guards e atalhos.
3. Usar metadata pelo bridge para manter contexto visual correto quando o modelo é configurado. Ajustar installer/documentação sem editar artefatos lib manualmente.
4. Adicionar testes determinísticos do bridge, animação e integração; compilar frontend e executar regressões focadas/CI pertinentes. Documentar limitações da validação real de provider.

## Direção visual
Não criar paleta ou tipografia nova: reutilizar tokens semânticos e monospace do TUI. Assinatura fiel ao Pi: trilha emoji que limpa erros e volta, seguida do contexto `(idioma · modelo)` e frase `💬`. Hierarquia compacta de duas linhas, clipping para terminais estreitos e opção sem movimento quando suportada.

## Critérios de aceite
- Cinco temas e frases do Pi disponíveis em ambos os editors.
- Cancelar preserva draft, não prende busy, e nova correção funciona.
- Falhas/incompletude não sobrescrevem draft; esforço incompatível tem fallback controlado.
- Testes e build passam ou falhas externas/pré-existentes são explicitamente reportadas.
- Não commit/push; fechar este plano e concluir o goal apenas após verificar os resultados.