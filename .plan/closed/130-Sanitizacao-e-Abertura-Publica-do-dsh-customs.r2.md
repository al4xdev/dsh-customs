# Task: Sanitização e Preparação para Abertura Pública (Open Source) do dsh-customs

## Visão Geral e Objetivo
Preparar o repositório `dsh-customs` para ser tornado público, preservando seu caráter de monorepo/laboratório experimental sem vazar dados sensíveis, sem forçar caminhos locais de máquina (`/home/alex`), e documentando todas as variáveis de ambiente e requisitos dos plugins.

---

## 1. Mapeamento de Hardcodes de Usuário e Caminhos Locais (`alex`, `/home/alex`)

### A. Caminhos absolutos críticos no código de runtime
* **`plugins/companion-api/local-model-descriptors.mjs`** e **`local-model-variants.mjs`**:
  * Caminho hardcoded para snapshots do HuggingFace GGUF: `/home/alex/.cache/huggingface/hub/...`
  * *Ação:* Tornar configurável via variável de ambiente (ex: `DSH_LOCAL_MODEL_ID` ou `process.env.HF_HOME`).
* **`plugins/cordis.patch.yml`** e **`plugins/managed-plans/isolated-core.patch.yml`**:
  * Caminhos absolutos em `name: /home/alex/git/my/dsh-customs/...`
  * *Ação:* Usar paths relativos ao workspace ou variáveis parametrizadas pelo script de ativação (`tools/activate.mjs`).
* **`plugins/llm-resilience/lib/index-v*.mjs`** e **`plugins/agent-self-heal/lib/index-v*.mjs`**:
  * Fallbacks hardcoded para `"/home/alex/.local/share/dsh-cli/package.json"`.
  * *Ação:* Usar `process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share')`.
* **`frontend/mobile-companion/deploy/dsh-mobile-companion.service`**:
  * `WorkingDirectory=/home/alex/git/my/dsh-customs/frontend/mobile-companion`
  * *Ação:* Documentar template de serviço com placeholder `<REPO_DIR>`.

### B. scripts de ferramentas e testes (`tools/`)
* Vários testes e scripts utilitários (`tools/installation-consolidation/cold.mjs`, `tools/task10-profile/promotion.mjs`, `tools/pi-ai-fork/host-install.mjs`) usam `/home/alex` como valor default de fallback.
* *Ação:* Trocar fallback para `process.env.HOME || os.homedir()`.

### C. Nomes de pacotes e branding
* `package.json` raiz: `"name": "alex-dsh-machine-tools"`
* `frontend/mobile-companion/package.json`: `"name": "@alex/mobile-companion"`
* `android/companion`: package namespace `dev.alex.dsh.companion` (padrão aceitável em open source como identificador de autor, mas deve ser mantido ou renomeado se o autor desejar).

---

## 2. Auditoria de Segredos, Tokens e Identificadores Privados

### A. Domínio Privado / Tailscale (Identificador de Rede Pessoal)
* Encontrado hardcoded em múltiplos pontos: **`dsh.tail37b3d7.ts.net`** (porta 8443).
  * `android/companion/app/src/main/kotlin/dev/alex/dsh/companion/net/OwnerOrigin.kt`
  * `frontend/mobile-companion/server/index.mjs`
  * `tools/session-companion/connection.mjs`, `connect.mjs`, `profile.mjs`
  * `plugins/companion-transport/origin-policy.mjs`
  * `plugins/companion-download/host.mjs`, `proxy.mjs`
  * Vários testes em `android/companion` e `plugins/companion-transport`.
  * *Risco:* Expõe o endpoint exato e subdomínio do Tailscale MagicDNS da sua máquina pessoal.
  * *Ação:* Extrair para variável de ambiente/configuração (ex: `DSH_COMPANION_ORIGIN`, `DSH_TRUSTED_HOST`) e permitir que o app Android receba o endpoint por configuração ou link de pareamento.

### B. Chaves e Credenciais
* Não foram encontradas chaves de API reais commitadas em texto plano no código ativo (as referências em testes usam chaves sintéticas como `fixture-key`, `test-secret-not-for-results`, etc.).
* O arquivo `.gitignore` já ignora `.dumps/` e arquivos sensíveis, e foi atualizado com `z_image_universal.log`.
* *Recomendação de segurança:* Executar uma varredura com ferramenta de auditoria de git no histórico completo antes do push para o repositório remoto público.

---

## 3. Catálogo de Variáveis de Ambiente (Ocultas ou Não Documentadas)

Criar um arquivo `.env.example` e uma seção correspondente no `README.md` documentando:

### A. Caminhos & Diretórios Base
* `DSH_HOME`: Diretório de configuração e perfis do DSH (Default: `~/.dsh`).
* `XDG_DATA_HOME`: Diretório de dados de runtime do DSH (Default: `~/.local/share`).
* `XDG_CACHE_HOME`: Diretório de cache (Default: `~/.cache`).

### B. Companion & Conectividade Remota
* `DSH_COMPANION_ORIGIN`: URL base de acesso externo do Companion (substituindo o hardcode do Tailscale).
* `DSH_COMPANION_CLI`: Caminho customizado para o executável DSH companion.
* `DSH_RUNTIME_NODE_MODULES`: Caminho para node_modules do runtime.

### C. LLM Local & Modelos
* `DSH_LOCAL_URL`: URL do servidor local de inferência (Default: `http://127.0.0.1:8080/v1`).
* `DSH_LOCAL_MODEL`: ID do modelo local selecionado quando houver múltiplos anunciados.
* `DSH_DEFAULT_PROVIDER`: Provider padrão (Default: `openai-codex`).
* `DSH_DEFAULT_MODEL`: Modelo padrão selecionado.
* `DSH_DEFAULT_EFFORT`: Nível de raciocínio (Default: `low`).

### D. Plugins Específicos
* `CONTEXT7_API_KEY`: Token de autorização para queries de documentação no plugin `research`.
* `SIMP_MCP_PROJECT`: Caminho do projeto MCP de áudio para o plugin `music` (Default: `~/git/my/simp_mcp`).
* `SIMP_MCP_UV`: Binário do uv para o plugin `music` (Default: `uv`).
* `LLAMACPP_BASE_URL`: URL do backend llama.cpp para o plugin `grammar-fix` (Default: `http://127.0.0.1:8080`).
* `GRAMMAR_GPT_MODEL`, `GRAMMAR_GEMINI_MODEL`, `GRAMMAR_LOCAL_MODEL`: Modelos usados pelo plugin `grammar-fix`.
* `PROJECT_MCP_TEST_LOG`: Caminho de log para testes do `project-mcp`.

---

## 4. Próximos Passos Recomendados para Implementação
1. Parametrizar a URL do Tailscale (`dsh.tail37b3d7.ts.net:8443`) para que utilize variável de ambiente / flag de inicialização.
2. Substituir fallbacks de `/home/alex` por `os.homedir()` / `process.env.HOME`.
3. Criar `.env.example` com todas as variáveis acima devidamente explicadas.
4. Passar varredura de histórico `git` para validar que nenhum segredo do passado ficou preso em commits antigos.
