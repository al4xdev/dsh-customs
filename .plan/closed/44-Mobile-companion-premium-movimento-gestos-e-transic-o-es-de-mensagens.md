# Mobile companion premium — animações e gestos

Complemento à task40r1 aprovada, por solicitação direta do usuário. Usar goal ativo atualizado para orientar implementação/verificação. Projeto permanece frontend independente, profile companion fixo, renderer oficial e políticas intactas.

## Experiência
- Motion language coesa e discreta estilo iOS: transição lista↔chat com depth/parallax e spring; botões/estado/loading com feedback breve, sem bounce ornamental em cada componente.
- Gesto horizontal de navegação com progresso ligado ao dedo e decisão por distância/velocidade; voltar da conversa à lista e avançar/reabrir a conversa previamente validada quando houver contexto. Não disparar troca de mensagens ou operações no backend pelo gesto, nem navegação para logs estrangeiros. Revalidar header antes de retain.
- Elasticidade nas bordas do scrollport da conversa/lista onde aplicável. Preservar rolagem nativa do browser e sua física iOS; fallback emulado pequeno/limitado que não duplica efeitos nativos. Nunca interceptar rolagem horizontal de código/tabelas, seleção, inputs, controles, dialogs ou confirmações; nada de prevenir todo touchmove globalmente.
- Ao enviar, animar a apresentação da mensagem saindo do composer para sua posição real no transcript e acompanhar a subida da conversa. Replica visual não contém credenciais nem interfere com a mensagem real; não inventar um envio antes da admissão nativa nem reenviar. Cancelar efeito se submit falhar/não resultar em mensagem. Sem travar input/reconciliação/scroll para sustentar o efeito.
- Resposta recebida: entrada breve uma vez por mensagem nova; streaming continua incremental no renderer, sem reanimar cada token, cada reload ou todo histórico antigo. Scroll preserva usuário lendo acima.

## Implementação delegada
- Delegar motion de telas/gestos/elasticidade a um subagente e movimento de mensagens/integração composer-transcript a outro, com arquivos separados e contrato comum; agente principal integra e audita.
- Usar APIs públicas dos serviços/DOM data attributes e observação de apresentação sem alterar parser/engine. Se precisar adaptação upstream adicional, manter exata/pinned/fail-closed e documentar; não editar runtime instalado ou TUI.
- WAAPI/CSS transforms+opacity onde possível; requestAnimationFrame somente para gesto ativo, cleanup de observers/listeners/animations ao trocar/desmontar. Evitar layout a cada frame, medir apenas pontos necessários, sem dependências pesadas ou loop infinito.
- Respeitar prefers-reduced-motion: transições mínimas/sem deslocamento, gestures navegam sem efeito elástico, animação de mensagem desligada. Nenhuma configuração nova exigida.
- Acessibilidade, targets>=44px, teclado/visualViewport/safe-area, foco/contraste e aprovação nativa permanecem prioritários. Touch vertical/native scrolling e seleção/cópia não podem regredir.

## Verificação
- Testes determinísticos de thresholds/velocidade/axis-lock/cancelamento, regras de targets excluídos, reduced-motion, cleanup, mensagem admitida uma única vez/erro/streaming sem repetir animação, foreignguard.
- Navegador mantido393x852/DPR2/touch: demonstrar lista↔chat, gesto commit/cancel, scroll nas bordas, envio/recebimento reais e histórico sem replay de efeitos. Verificar console/network/overflow e scroll stability. Dados sintéticos apenas.
- Captura curta de vídeo/frame inspection se ferramenta mantida permitir; screenshots isoladas não provam fluidez. Não instalar browser/dependencies para contornar capacidades desativadas. Não alegar física/teclado Android/iOS físico sem teste no dispositivo.
- Integrar com task40: build/test, auth/profile/confirmar-rejeitar/allowonce, publicação só após remover auth seam de auditoria, preservar443/3080/TUI e rollback8443.

## Conclusão
Motion premium implementado e observado no app real com dados sintéticos, sem alterar a segurança/renderer ou quebrar touch/scroll/acessibilidade. Registrar limites de emulação e resultados medidos; objetivo completo só após validação e integração de todo frontend.