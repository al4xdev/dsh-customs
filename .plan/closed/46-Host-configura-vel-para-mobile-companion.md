# Host configurável para mobile companion

Adicionar `--host 0.0.0.0` e manter `127.0.0.1` como padrão; preservar `--port` e backend fixo. Aceitar apenas endereços IPv4 de bind e, para wildcard, permitir Host de IPs IPv4 das interfaces locais na porta efetiva, sem aceitar domínios arbitrários. Para acesso de rede exigir Origin exatamente correspondente ao Host, preservar autenticação nativa e bloquear login de auditoria fora do bind loopback. Não alterar serviços, firewall ou Tailscale nem iniciar listener público automaticamente.

Adicionar testes de CLI, bind, autenticação e Host/Origin; atualizar README com comando e alerta HTTP/rede confiável. Executar npm run check e copiar comando para porta 8889.