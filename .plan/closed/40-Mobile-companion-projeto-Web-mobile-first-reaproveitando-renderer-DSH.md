# Mobile companion — frontend Web mobile-first

## Objetivo
Criar **frontend/mobile-companion/** como projeto de frontend, não plugin DSH nem fork do TUI. Usar o goal ativo para guiar execução após aprovação. Interface em português para Alex conversar com o profile **companion** no celular: lista de conversas, novo chat, conversa e confirmações nativas. Sem configurações, escolha de profile/modelo, terminal ou editor de projetos.

## Fatos e decisão técnica
- Backend companion já existe em loopback3081, Tailscale8443; Web original3080/443 e TUIs devem ficar intactos.
- Web DSH0.2.0-rc.2 é React18; packages client-ui-chat/conversation/renderer/session implementam histórico, streaming, cards e aprovação. Bundles ./client são módulos do __ModuleLoader__, não ReactESM isolados. ui-settings fornece infraestrutura configForms e pode existir sem telas de settings.
- Reusar módulos publicados do runtime Web, pinned0.2.0-rc.2, e bootstrap/shell upstream na tag dsh-v0.2.0-rc.2 (639ed015397290b3745d163aafe02ffee4aa3f84), preservando MIT/license/attribution. Não editar node_modules ou frontend/dsh-tui.
- Primeiro verificar APIs de composição root/slots públicas para shell próprio e módulos necessários. NÃO iframe do desktop nem simples CSS escondendo toda interface; usar renderer real com shell mobile. Se não houver seam pública adequada, recortar fontes exatas do shell/kernel e manter renderer/packages, sem fork do monorepo inteiro. Documentar fronteira vendorizada/dependências.

## Estrutura e integração
- package.json, código mobile shell/layout, assets, scripts build/serve, testes e README próprios no projeto. Artifacts/cache ignorados; dumps e capturas experimentais fora do produto.
- Serviço frontend loopback próprio (3082 a validar disponibilidade), same-origin proxy para backend fixo3081, autenticação cookie e RPC/WS/eventos/resources preservados. Nunca backend arbitrário recebido de query/string nem token em build, localStorage, console, screenshots ou journal.
- Seleção de conversas restrita aos chats companion; outras sessões/projetos são observadas através da tool session dentro da conversa, não montadas diretamente como agentes normais pelo frontend. Novo chat sempre companion; nenhum profile/model picker.
- Backend default/preset exclusivo companion já configurado: validar em runtime, não só esconder select. Deep links de chat estrangeiro não devem abrir/retomar esse destino; exibir retorno seguro à lista.
- Após validação local, publicar apenas companion8443 apontando para o frontend, mantendo443/3080 e backend3081. Rota anterior/serviço ficam disponíveis para rollback. Qualquer override backend necessário deve ser mínimo, preservar as políticas ask/read-only e único tool.

## UX mobile
- Uma coluna; lista de chats e conversa são duas telas, voltar acessível, novo chat claro, título/estado de conexão e reconexão.
- Reusar tema/tipografia/componentes do Web; reduzir chrome e telas que não pertencem ao chat. Toque>=44px, viewport/canvas sem overflow horizontal, safe-area e 100dvh/visualViewport para teclado. Input>=16px para evitar zoom iOS, enviar/cancelar/foco seguros.
- Renderer nativo para Markdown/código/tabelas/cards/tool results/streaming/histórico. Preservar seleção/cópia, scroll até fim que não puxa usuário ao ler acima, estados carregando/vazio/desconectado, diálogos e perguntas quando relevantes.
- **Confirmação de session send/resume é essencial ao chat**, não configuração: mostrar destino/ação/texto literal, botões legíveis de rejeitar/permitir uma vez; nunca autoaprovar ou inferir consentimento.
- Manifest/icon para adicionar à tela inicial se simples e compatível; sem cache offline de API/conversas/tokens. Sem APK ou integração nativa exigida.

## Validação
- Testes build/bootstrap/proxy/auth/WS, seleção/criação somentecompanion, estrangeiros/deeplinks, bodylimits e anti-SSRF/origin/cookie/secret leakage; regressão plugin session/profile existing.
- Browser mantido com viewport canônico393x852/DPR2/touch, também largura320/360, landscape e desktop como verificação; screenshot de dados sintéticos não sensíveis, erros console/network, overflow/element bounds.
- Fluxos reais: entrar com auth privado, lista -> criar/abrir chat -> enviar -> streaming -> resposta -> histórico -> voltar -> reabrir -> reconnect; scroll/code/table e aprovação rejeitada/allowed-once com destinos sintéticos exatos. Nada enviado a sessões reais observadas.
- Observar teclado/visualViewport pelo que o browser emulado permite; não alegar validação físicaAndroid/iOS se não usada. Não contornar operações de browser desabilitadas: usar seams próprias de ambiente teste, sem anexar perfil pessoal.
- Documentar comando de uso/build, versões, limites e rollback; verificar443/Web original intactos e serviço saudável, remover helpers de testes, coletar jobs. Não commit/push.

## Critério de conclusão
Frontend mobile próprio funcionando no endpoint companion, renderer reaproveitado e perfil fixo, listagem/chat/streaming/confirmações testados em navegador mobile com evidências, configuração desnecessária para usuário e serviços originais preservados. Não considerar screenshot mock ou apenasbuild como conclusão.