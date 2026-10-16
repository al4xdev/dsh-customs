# Coleta de desempenho durante uso real

Pedido direto: iniciar logs ADB de FPS/desempenho enquanto o proprietário usa o Companion, para localizar gargalos e corrigir depois.

- Verificar telefone autorizado e processo do Companion, sem ler interface/conversa.
- Iniciar coleta limitada de aproximadamente120s de gfxinfo framestats e contadores de renderização do pacote, em segundo plano; coletar somente métricas numéricas/categorias conhecidas, sem logcat bruto, tela, hierarquia UI, mensagens ou payloads. Resetar apenas contadores de gfxinfo no início, nunca processo/dados.
- Deduplicar frames do buffer circular, preservar deadline/vsync/CPU/GPU quando expostos; amostrar com baixo custo e registrar limitações. Uso real e refresh variável não permitem dividir frames por tempo de captura e chamar isso de FPS.
- Salvar resultados sanitizados em .dumps/tasks, analisar percentis/jank e indicadores UI/render/GPU, sem alegar causa exata não sustentada. Caso necessário, propor trace Perfetto específico posterior, não coletar trace amplo ou dados privados automaticamente.
- Não reiniciar/force-stop/app/backend/modelo, não executar toques/envios/grants nem instalar build durante a captura. Correções de código ficam para etapa posterior conforme pedido.