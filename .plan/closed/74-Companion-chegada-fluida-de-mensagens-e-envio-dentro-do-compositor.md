# Companion: chegada fluida de mensagens e envio dentro do compositor

## Pedido após teste físico bem-sucedido
O proprietário confirmou 'deu certo' no Android atualizado. Pediu: (1) chegada de mensagens menos abrupta quando resposta muito rápida, com pequena latência mínima de apresentação se necessário para completar animações fluidas; (2) botão enviar dentro da caixa de mensagem para aproveitar espaço. Perguntou também modelo usado.

## Escopo
- Inspecionar a cadeia atual de projeção/render/autoscroll/entrada220ms e identificar remounts/chaves ou saltos de layout que causam truncamento visual. Não esconder perda real de dados com animações: confirmar que a verdade do transcript e todos os tokens permanecem íntegros.
- Adicionar coalescência/ritmo mínimo apenas na publicação/apresentação visual e transição de entrada/settlement quando necessário. Não atrasar backend, fila, ACK/cancel/approvals, nem persistir/repetir submissões. Completar a animação de entrada antes de trocar abruptamente de estado; duração curta e previsível, sem reter artificialmente stop após fim real.
- Movimento reduzido/scale0 = apresentação imediata. Pausa/background/navegação/generation nova cancela ticker/latência e atualiza para verdade corrente, sem replay de histórico/paging nem deixar sequência antiga sobrepor nova.
- Melhorar follow-bottom: acompanhar suavemente apenas usuário já perto do fim; respeitar scroll manual, leitura histórica e seleção. Evitar jump/remount de live para durable que repita ou trunque conteúdos.
- Colocar send icon/button dentro da caixa do compositor com touch target48dp e descrição 'Enviar', preservando múltiplas linhas, IME, draft RAM, enabledguards SENDING/UNKNOWN/conexão/auth/busy e once-admission. Remover a linha extra do botão externo; não alterar política de envio automático/Enter.
- Verificar configuração de modelo do perfil dedicado e informar valor configurado, sem alegar modelo histórico por conversa nem trocar modelo sem pedido.

## Validação
Testes determinísticos de burst rápido/end antes da animação, partial→durable/chaves, redução de movimento, cancel/nova geração, leitura/scroll/seleção, composer botão interno e target48dp/disabled/doubletap. Build/lint/JVM/Compose no emulador e fixture sintética. Proprietário agora testa conversas reais: não instalar/reiniciar/capturar chat privado sem nova condição segura/confirmada.

## Aceite
Mensagens rápidas chegam com transição curta e contínua sem perda/duplicação/replay, compositor ocupa menos altura e enviar fica interno acessível; modelo atual informado. Nenhuma mudança no modelo, backend, sandbox/aprovação ou serviço necessária para esses ajustes.