# Gemma fixo no catálogo local do DSH

## Diagnóstico
O fish `dsh` chama `/home/alex/.local/share/dsh-cli/local-model-launch.mjs`. Esse launcher mantém Bonsai 2 27B (QW) no catálogo offline e acrescenta o modelo atualmente descoberto. Qwen Dirk e Gemma já aparecem em web/headless, mas não são um catálogo persistente do launcher dsh-tui.

O usuário iniciou `gen gmmed`; leituras de status/logs e GET locais `/v1/models` e `/props`, sem geração, confirmaram Gemma4 26B Q4_K_XXL: id GGUF completo, contexto65536, visão=true e supports_reasoning_effort=false.

## Alteração autorizada
1. Acrescentar registro fixo Gemma ao launcher, com id exato retornado pelo servidor, label legível, contexto65536, maxTokens32768 (mesma regra live existente), imagem e sem níveis de reasoning artificiais.
2. Inicializar catálogo com Bonsai/QW e Gemma; descoberta live continua atualizando o registro correspondente e acrescentando outros modelos.
3. Não alterar modelos padrão, outros cadastros/perfis, launcher gen, backend, sampling ou processos. Não gerar inferência nem fazer commit.

## Validação
Backup privado do arquivo original e alteração pontual com leitura prévia. Teste isolado do próprio launcher com fetch/spawn/dump simulados: offline mantém ambos; Gemma live atualiza sem duplicar; modelo desconhecido é adicionado sem apagar os fixos; nenhum patch de default sem override explícito. Checagem de sintaxe e preservação do serviço gen ativo. Evidências locais ignoradas em `.dumps/`.