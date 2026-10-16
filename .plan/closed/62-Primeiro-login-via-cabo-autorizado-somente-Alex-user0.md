# Primeiro login local autorizado por cabo

O proprietário autorizou explicitamente passar o link privado ao app pelo ADB local via cabo, substituindo a restrição anterior para esta ação pontual.

1. Conferir serial ZY22F2395W e usuário atual0; não instalar/abrir nada no Work10.
2. Ler connection.json somente dentro de helper local em RAM, validando arquivo privado/owned e URL HTTPS exata8443. Não devolver token/link ao modelo, stdout, logs, clipboard ou arquivo novo.
3. Inspecionar hierarquia UI em RAM, sem screenshots/dump persistido; devolver somente estado e bounds necessários. Focar campo mascarado e passar link por stdin do ADB, não argumentos do comando no host; efetuar apenas login explícito.
4. Verificar somente estado autenticado/lista por metadados UI sanitizados, sem chats/mensagens/envios/approvals. Não capturar conteúdo privado, não alterar TTL/profile/serviço/publicação.
5. Teste de reabertura/force-stop exige confirmar que não há envio pendente; não fazer nesta ação de login. Registrar resultado sem segredo e manter goal ativo até validação completa.