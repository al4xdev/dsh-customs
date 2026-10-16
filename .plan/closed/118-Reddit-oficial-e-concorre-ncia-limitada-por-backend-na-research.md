# Reddit oficial e concorrência limitada por backend

## Autorização e objetivo

O proprietário pediu implementar acesso pela API oficial do Reddit e liberar várias pesquisas simultâneas, mantendo um ou no máximo dois workers por provedor/fonte para reduzir429. Implementação autônoma autorizada, sem contratar serviços, criar contas ou obter credenciais sem autorização específica.

Goal: goal-7ea639f5-d373-4587-8165-8d5af2db9bcf.

## Escopo

1. Conector Reddit somente leitura: busca, listagem por subreddit, abertura de tópico e comentários, expansão limitada por morechildren. OAuth token fornecido pelo proprietário; suporte seguro a refresh token se viável. Não usar cookies pessoais, senha Reddit ou bypass de bloqueio.
2. Credenciais por ambiente do processo, nunca argumentos da tool, snapshots ou logs. Destinos fixos oficiais HTTPS, redirects recusados, respostas limitadas. Ausência de credenciais retorna erro explícito; não fingir API funcionando nem fazer fallback silencioso após401/403/429.
3. Persistir IDs, parent/link IDs, comentários, paginação/pendências e cobertura em .dumps com recuperação seletiva. Preservar post/comentários já lidos quando expansão falhar. Navegação incremental por parâmetros tipados da tool.
4. Scheduler compartilhado entre pesquisas/instâncias no mesmo processo: por padrão2 workers por backend, opção1; morechildren1. Web, fallback Reddit e X compartilham chave do backend web e não ganham seis workers disfarçados. Leituras HTTP limitadas por origem e MCPs por provedor. A limitação entre processos independentes deve ser explicitada, ou implementada se necessária para integração sem ampliar escopo indevidamente.
5. Habilitar concurrencySafe da tool somente após filas, locks de run e testes. Pesquisas distintas podem avançar; mesmo run continua protegido por lock. Filas limitadas, cancelamento e deadlines, cooldown429/Retry-After e rate-limit headers quando disponíveis. Não bloquear outras fontes durante cooldown nem descartar resultados existentes.
6. Testes com fixtures de OAuth/listings/comments/morechildren,429,403,token ausente,redirecionamento,segredos,cancelamento,concorrência compartilhada, múltiplas runs e persistência.
7. Documentar configuração/autorização necessária e limitações. Não afirmar validação autenticada se não há credenciais aprovadas; eventual teste real somente com acesso explicitamente disponível e autorizado.

## Critérios de aceite

- Conector oficial implementado, sem mutações de conta, com erro claro se não configurado.
- Dados parciais preservados quando página/expansão falha; comentários encadeados e contagem reais.
- Fonte independente continua quando outra atinge quota.
- Máximo2 trabalhos no backend compartilhado,1 morechildren; testes concorrentes comprovam e não liberam slot de operação ainda ativa por timeout prematuro.
- Esquema e documentação permitem explorar subreddit e tópico, não apenas procurar trechos na web.
- Ferramenta admite chamadas simultâneas para runs diferentes e mantém orçamento/lock por run.
- Sem alterações em backends/credenciais/perfis não necessárias; versão já ativada permanece no mesmo caminho e precisa recarga para código novo.

## Plano de execução

Inspecionar contratos atuais → implementar scheduler e Reddit em módulos isolados → integrar engine/tool/store → testar e revisar segurança → documentar evidências e pendências de acesso. Usar testes automatizados sem LLM; delegar smoke conversacional a Luna low se necessário, retornando amostras curtas.