# Configurable host for mobile companion

Add `--host 0.0.0.0` and keep `127.0.0.1` as default; preserve `--port` and fixed backend. Accept only IPv4 bind addresses and, for wildcard, allow Host of IPv4 IPs from local interfaces on the effective port, without accepting arbitrary domains. For network access, require Origin exactly matching Host, preserve native authentication, and block audit login outside loopback bind. Do not alter services, firewall, or Tailscale, nor start public listener automatically.

Add tests for CLI, bind, authentication, and Host/Origin; update README with command and HTTP/trusted network warning. Run `npm run check` and copy command for port 8889.
