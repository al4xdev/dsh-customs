# Deadline de chamadas unárias do Companion

Escopo pedido: estabilidade apenas; UI/refatoração pertence ao proprietário. Fonte OwnerHttpPolicy configura timeout de conexão/leitura/escrita, mas não prazo total. Um servidor/rede que entregue bytes lentamente pode manter RPC/login e busy/preflight ativos indefinidamente, pois readTimeout reinicia a cada progresso.

1. Adicionar deadline total45s por chamada HTTP unária (login e RPC), separado do cliente websocket de longa duração. Não mudar autoridade/TLS/auth/cookie/Origin/ping, limites de corpo, POSTretry, ACK/UNKNOWN/ledger ou política de envio.
2. Fixture local MockWebServer com resposta lenta provar encerramento total e exatamente um POST, sem segredo, modelo ou rede real. Fixture de configuração provar streamclient continua sem deadline global; testar valores inválidos do seam de teste.
3. Rodar regressões app/protocol/lint/build; registrar resultado. Mudanças apenas net e testes, sem alteração de UI. Ajuste de UI já preparado task63 fica separado e não será instalado.
4. Não atualizar telefone, force-stop app com intenções incertas, reiniciar serviço/PC, alterar TTL/profile/Tailscale ou implantar guard sem autorização específica. Timeout de POST significa resultado possivelmente desconhecido, nunca retry automático.

Aceite: unárias com prazo total finito, WSS longa duração intacta, testes sem replay passam e nenhum recurso real alterado.