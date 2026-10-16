# Corrigir Hacker News: JSON truncado

## Diagnóstico

O conector lê `hn.algolia.com/api/v1/items/id`, que devolve árvore completa antes de aplicar maxComments. O leitor HTTP nativo limita corpo e marca truncated; json() corretamente recusa JSON incompleto. Resultado: título/snippet sobrevive, tópico grande não é lido. Aumentar limite global não resolve o desenho.

## Implementação autorizada pelo relato de bug

- Manter Algolia para descoberta, reduzir campos de busca para evitar corpos desnecessários.
- Usar API oficial Firebase item/id.json para ler post e comentários individualmente, com teto de nós/requisições/texto e no máximo2workers compartilhados via scheduler existente.
- Preservar relações parent/children, metadados, IDs pendentes e erros por comentário. Não abandonar post válido quando um comentário ou artigo falhar.
- Não analisar JSON parcial nem desativar limites globais. Sem mudança de credenciais ou perfis.
- Testes de thread grande, nó truncado, limite0/limite de comentários, comentários removidos, ciclos/IDs inválidos, falha artigo, concorrência e estrutura.
- Smoke real limitado usando API pública, evidências em .dumps e resumo compacto; documentação da recarga necessária.

## Aceite

Tópico com muitas respostas não exige baixar árvore inteira; post/comentários selecionados persistem mesmo com falhas parciais, contagens honestas e limites mantidos. Testes automatizados e smoke controlado registrados. Guiar execução pelo goal atual.