# Companion: UX minimalista após teste real do proprietário

## Pedido e contexto
O proprietário confirmou login bem-sucedido na APK0.3 e testou turnos reais. Tailscale estava desligado no celular; após religar, login funcionou. Goal ativo e tasks67/68 preservam renderização, ownership, UNKNOWN e imagens admitidas. Não interromper nem capturar conversas privadas enquanto ele testa.

## Mudanças solicitadas
1. Remover botão permanente “Cancelar turno (mantém fila)”. Mostrar stop minimalista somente na linha da resposta realmente aguardando/streaming; usar o cancelamento existente, com latch para um pedido explícito por turno e sem retry. Manter UNKNOWN/SENDING e fila exatamente como contratos atuais.
2. Mensagem enviada aparece com animação discreta; criar indicador de resposta após admissão real e exibir deltas/tokens do stream existente, sem inventar conclusão, repetir prompt ou simular texto. Preferir projeções/eventos públicos para estado do turno. Motion reduzido/escala0 imediato, chaves e anchor estáveis.
3. Remover “Copiar texto” como botão permanente e “Ver uso registrado”. Cópia no menu de contexto nativo por toque longo/seleção de texto. Código/JSON também devem manter opção segura de cópia sem botão redundante quando aplicável.
4. Trocar “Expandir ferramenta” por ícone discreto com contentDescription e estado expandido acessíveis; preservar folds RAM e limites de conteúdo.
5. Chat com seta de voltar, título compacto e sem Nova/Sair. Essas ações pertencem ao catálogo.
6. Catálogo sem header/barra duplicados e sem botão “Atualizar conversas”; atualizar por pull-to-refresh no topo. Uma só seção de título, ícone + para criar e saída compacta, mantendo hit targets48dp, sem alterar credenciais/callbacks.

## Execução e responsabilidades
- Investigar estado público do agent/assistant e reducer antes de adicionar indicador/stop; não usar busy genérico de catálogo como “modelo pensando”. Introduzir modelos de apresentação testáveis somente se necessário, com geração/seleção no estado e cancel-once.
- Render rich/context menu/folds em arquivos dedicados; tela/catálogo/composer em outros arquivos para permitir trabalho independente.
- Atualizar fixtures sintéticas e asserts para ícones/contentDescription, contexto, ausência de controles redundantes, pull-refresh, streaming, stop-once e proteção de UNKNOWN. Nenhuma ação real no PC para testar.
- Compilar JVM/protocolo/lint estrito/APK/testAPK; validar em emulador próprio Android34. Capturar somente fixture. Incrementar versionCode para4/versionName0.4.0-refined para distinguir a atualização.
- Atualização física apenas após novo estado seguro ou confirmação do proprietário: ele agora está testando turnos reais, portanto não force-stop/instrumentar/instalar no app em uso. Preservar UID10318, assinatura e cofre; Work10 intacto.

## Aceite
UI minimalista conforme pedido, streaming real existente sem duplicação, stop contextual disponível só quando há resposta ativa/aguardada confirmada e protegido contra doubletap/retry. Histórico, approvals explícitos, parser/media bounds, ownership e UNKNOWN continuam corretos. Testes/lint aprovados e capturas sintéticas inspecionadas. Entrega/instalação segura e retorno ao Main real quando autorizado, com limites e evidências honestos.

## Fora de escopo
Nenhum deploy HA, alteração de Tailscale/DNS/publicação/services/profiles/TTL/SDK, takeover de writers, modelo/grant real de teste, captura privada, persistência/replay de intenções, commit ou push.