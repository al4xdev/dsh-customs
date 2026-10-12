---
name: project-mcp
description: Configure, create, use, or troubleshoot project-local MCP servers in DSH, including builtin tools in .agents/tools or temporary .dumps modules, stdio commands and HTTP servers. Use when asked to set up local MCP, add a project tool, configure .agents/mcp.json, or diagnose missing project MCP tools.
---

# MCP local por projeto

Esta skill ensina a configurar o plugin `project-mcp` do dsh-customs. Use as tools
normais `read`, `list`, `edit`, `write` e `bash` para o trabalho; não existe
`mcp_add` ou `mcp_reload`, nem se deve criar essas tools para seguir este guia.
O SDK oficial implementa o servidor/protocolo. Não escreva JSON-RPC manual.

## Primeiro, identifique o projeto

1. Use o cwd da sessão e encontre o Git worktree mais próximo (incluindo `.git`
   de worktrees). O plugin lê somente `<raiz Git canônica>/.agents/mcp.json`.
   Sem raiz Git, não há contribuição MCP desse plugin.
2. Leia a configuração existente antes de editar. Preserve outros servidores,
   chaves, credenciais e decisões do usuário. Não habilite servidores restritos
   removendo campos legados de aprovação/sandbox para fazê-los passar na validação.
3. Confirme que o plugin está carregado no perfil DSH e que o checkout
   dsh-customs tem suas dependências instaladas. Se faltar, `npm ci` é executado
   **no checkout dsh-customs**, não indiscriminadamente no projeto de ferramentas.
   Builtin requer Node.js 20+; não copie o SDK do grafo privado do DSH.
4. Configurar MCP não exige ativar Plan mode nem mudar permissões. O arquivo
   `.agents/config.json` com `dshCustoms.managedPlans.autoApprove` pertence ao
   gerenciador de artefatos `.plan`, não ao MCP. Não altere essa preferência para
   configurar um servidor.

## Builtin: ferramentas estáticas

Crie o diretório antes de habilitar o servidor. Uma entrada lê um único diretório,
sem recursão. Exemplo de `.agents/mcp.json`:

```json
{
  "mcpServers": {
    "local": {
      "builtin": true,
      "toolsDir": ".agents/tools",
      "timeoutMs": 30000
    }
  }
}
```

- `toolsDir` é opcional: o padrão é `.agents/tools`. Deve existir, ser diretório
  e resolver dentro da raiz Git; caminhos relativos são relativos a essa raiz.
- `timeoutMs` é opcional: 30000 ms por padrão, inteiro de 1 a 2147483647.
  Esse valor configura o deadline do cliente e o sinal cooperativo do handler.
- Os únicos campos adicionais builtin são `enabled` e `failOnStartupError`
  (padrão true). Não misture `command`, `url`, `env`, `cwd`, `transport`,
  `serverName` ou `toolCallTimeoutMs` em uma entrada builtin.
- `enabled: false` ignora a entrada. Não prometa ferramentas de um servidor
  desativado. Chaves de servidor usam 1–32 caracteres `[A-Za-z0-9_-]`.

Cada arquivo imediato `*.mjs` exporta `tools[]`. Exemplo
`.agents/tools/sum.mjs`:

```js
export const tools = [{
  name: 'sum',
  description: 'Add two finite numbers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  async handler({ a, b }, ctx) {
    ctx.signal.throwIfAborted();
    return { total: a + b };
  },
}];
```

Contrato:

- `name`: string `[A-Za-z0-9_-]+`, única entre os módulos desse servidor.
- `description`: string descrevendo o propósito real e eventuais efeitos.
- `inputSchema`: JSON Schema objeto com `type: 'object'`. `outputSchema` é
  opcional e tem o mesmo requisito; o SDK valida entrada e saída.
- `handler(args, ctx)` recebe argumentos validados e
  `{ root, cwd, env, serverName, signal }`. `cwd` é a raiz do projeto.
- String retorna conteúdo MCP de texto. Valores JSON comuns tornam-se texto JSON;
  `undefined` torna-se texto vazio. Um resultado MCP com `content`,
  `structuredContent` ou `isError` é preservado, com conteúdo de texto de fallback
  quando omitido. Com `outputSchema`, o sucesso precisa conter
  `structuredContent` compatível. Erros do handler viram falhas da tool.
- Cancelamento não mata execução: use `ctx.signal` em `fetch`, timers abortáveis
  e IO compatível. Ignorar o sinal pode continuar produzindo efeitos depois de
  timeout. Não há worker, sandbox ou rollback de efeitos.
- Importações, definições/schemas inválidos, nomes duplicados e symlinks
  quebrados/externos causam falha de startup; não são ignorados silenciosamente.
  Diretório vazio é válido, mas não fornece ferramentas.

## Ferramentas temporárias em `.dumps`

`toolsDir` também pode apontar para `.dumps/mcp-tools`. Garanta que `.dumps/` é
local e gitignored. Não mova ferramentas persistentes para lá por padrão.

Para carregar persistentes **e** temporárias, use duas entradas de servidor —
não um campo inventado `toolsDirs`:

```json
{
  "mcpServers": {
    "local": { "builtin": true, "toolsDir": ".agents/tools" },
    "scratch": { "builtin": true, "toolsDir": ".dumps/mcp-tools" }
  }
}
```

Ambos os diretórios precisam existir. As ferramentas aparecem respectivamente
como `mcp__local__<nome>` e `mcp__scratch__<nome>`. Desative a entrada scratch ou
remova-a da configuração antes de apagar seu diretório. Diretórios apontando
para fora da raiz Git não são aceitos, mesmo por symlink.

## Servidores existentes: stdio ou HTTP

Não converta um servidor existente para builtin sem necessidade. Preserve o
transporte nativo. Exemplo (os placeholders precisam ser substituídos):

```json
{
  "mcpServers": {
    "external": {
      "command": "/absolute/path/to/server",
      "args": ["--example"],
      "toolCallTimeoutMs": 60000
    },
    "remote": {
      "url": "https://example.invalid/mcp",
      "enabled": false
    }
  }
}
```

Stdio aceita `command`, `args`, `env`, `cwd`; HTTP aceita `url`, `headers`.
Os campos comuns nativos incluem `toolCallTimeoutMs`, `failOnStartupError`,
`maxInstructionBytes` e `reconnect`. O transporte é inferido pelo `url`, ou
explicitado com `stdio`/`streamable-http`. Não trate placeholders como comandos
executáveis. Não registre nem imprima credenciais em exemplos/diagnósticos.

## Validar e usar

1. Confira sintaxe (`node --check <módulo>`) e contratos, sem executar módulo
   desconhecido só para inspecioná-lo. Os módulos são código confiado e não
   sandboxed; até uma importação de teste pode executar efeitos top-level.
2. No checkout dsh-customs, a suíte `npm run test:project-mcp` exercita o cliente
   DSH real e o builtin com fixtures. Passar essa suíte não comprova por si só
   um novo módulo de outro projeto; faça a validação específica do caso.
3. Depois de criar/editar configuração ou módulos, **feche e reabra o DSH/TUI**
   no projeto para criar um novo Agent/conexão. Não diga que foi recarregado
   só porque salvou o arquivo. Não há hot reload do builtin.
4. Confirme que as tools `mcp__<servidor>__<nome>` estão realmente disponíveis
   e faça uma chamada segura. O prefixo MCP não substitui tools nativas DSH;
   contribuições são isoladas no scope do Agent daquele projeto.
5. Falta de tools: confira raiz Git/cwd, arquivo exato, `enabled`, diretório,
   export `tools[]`, schema/nome, diagnósticos de startup e perfil carregado.
   Não conclua sucesso apenas porque o JSON foi parseado.

## Segurança e referências

Abrir um projeto opted-in pode importar/executar seus módulos ou iniciar seus
comandos com acesso Node completo. O path guard limita descoberta, **não** é
contenção de filesystem/rede nem de imports transitivos. Console logging do
builtin vai para stderr; módulos não devem escrever diretamente em stdout,
reservado ao transporte MCP do SDK. Não adicione código externo sem revisão.

Referências relativas ao diretório desta skill, no checkout dsh-customs:
`../../../plugins/project-mcp/README.md`,
`../../../plugins/project-mcp/config.mjs`,
`../../../plugins/project-mcp/server/generic.mjs` e
`../../../plugins/project-mcp/project-mcp.test.mjs`.
Esta skill vale para projetos que usam esse plugin; não presuma os mesmos campos
em outro cliente MCP.
