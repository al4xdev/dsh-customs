# Companion: reutilizar maid da TUI nos loaders nativos

## Pedido e fonte já localizada
O proprietário pediu reutilizar o personagem maid do companion na sidebarDSH-TUI nas respostas carregando e nos loads do app, via GIF ou equivalente. Fonte readonly encontrada: `frontend/dsh-tui/assets/whaleGirl/img/{thinking,typing}/*.png` e `timings.json`. README identifica como pacote de GIFs fornecido pelo usuário, não oficial; PNGs RGBA301×288 preservam alpha e delays originais. Primeiro frame thinking inspecionado confirma personagem maid de cabelo azul.

## Implementação
- Reutilizar os frames PNG originais e seus timings em assets locais da APK; não inventar animação/baixar assets externos/nem alterar TUI/HA. Documentar origem de uso pessoal, não alegar licença oficial.
- Criar composable pequeno `MaidLoader` com moodsThinking/Typing, slot estável≈56dp, transparente na paleta azul/plum e renderpixelnative. Loading real = thinking, streaming real = typing; awaiting fila pode mostrar estado estático/idle sem inventar que o modelo executa.
- Carregar/decodificar fora do main quando necessário, dimensões/preload/cache limitados; PNG bundled separado do pipeline de anexos read_image. Não elevar limites globais/media nem fetching externo.
- Animar somente enquanto visível/active e lifecycleRESUMED; movimento reduzido/escala0 frame estático; parar clocks ao ocultar/dispose. Sem timer gerando estado falso do turno; ticker só anima arte de estado já confirmado.
- Integrar no loading de catálogo/login real e linha da respostaTask70; spinner redundante eliminado, stop contextual continua com48dp target; não carregar mascot em cada linha do histórico nem ícones permanentes.

## Validação
Teste determinístico frameat/durations/sample/dimensions/slot/imagens, ciclo started/stopped e reducedmotion, snapshots sintéticosCompose Android34 do catálogo loading e awaiting/streaming. Fullbuild/lint/protoc/JVM/Compose após integração. Nenhum screenshot privado/turno real/instalação enquanto ownerusaapp.

## Aceite
A mesma maid aparece nos loaders e resposta nativa com timings originais, alpha e tamanho estável; anima apenas estado real/visível, frame estático no reducedmotion, sem clocks de fundo. Origem e consumo limitados registrados, APK4/evidências integradas. Continua em paralelo comTask70UI eTask72r2sandboxworkspacewrite/Bashaprovado; nenhumcommit/push.