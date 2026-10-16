# Ativação conjunta APK7 e perfil corrigido

## Autorização fresca
Na pergunta operacional safe-apk7-profile-activation, dono selecionou 'Sim, tudo livre: atualizar ambos' (custom 'x iss'), confirmando ausência de rascunho/envio/streaming/aprovação pendente e autorizando instalar/abrir APK7 e reiniciar somente backend Companion.

## Executar
1. Preservar configuração ACTUAL instalada: inspecionar apenas campos públicos de controller/default model e service WorkingDirectory. Backup privado local do arquivo de composição, sem imprimir segredos/credenciais. Não regenerar defaults. Aplicar mudança mínima: desativar stock session-controller e inserir companion-session-controller com módulo wrapper. Preservar escolha de modelo atual, música, OAuth/JWT refs, persistência, portas e proxy.
2. Reiniciar apenas unidade backend Companion já existente; não tocar web3080/proxy3082/443/TUI/SDK/HA/rede. Verificar active/health/read-only models sem imprimir auth. Fonte79 já tem 39 testes reais SDK/Gateway/FS passando; confirmar composição instalada correta e saúde sem enviar prompt, autorizar Bash ou migrar headers antigos.
3. ADB5037 apenas com serial físico ZY22F2395W/user0: confirmar presença, upgrade -r APK7 SHA2567fab4de7e6a4a2fd33e7e51dfcaff0ac59fd85f5a2928f88598e7762808fd931, sem uninstall/clear/grants/capture/logcat. Verificar versionCode7 e UID10318 preservado, abrir MainActivity como autorizado. Não tocar tela/enviar/conceder/apagar nada. Se transporte ausente, pedir replug em vez de resetar servidor compartilhado.
4. Registrar aplicado versus preparado, fatos verificados versus validação visual ainda com dono. CWD novo só novas conversas; legado mantém header e acesso de leitura, sem escrita/Bash no repo antigo. Nenhuma alegação FPS/perf real. Fechar79/80 e objetivo somente após resultado real ou decisão explícita do dono.
