# Plano 131 — Simplificação de Documentação e Matrizes de READMEs e Requisitos

## Objetivo
Melhorar a experiência de leitura do repositório para abertura pública ("open source"), adicionando uma visão introdutória amigável no topo do `README.md`, notas de contexto histórico nos READMEs de ferramentas internas em `tools/`, e matrizes completas de catálogo (caminhos dos READMEs) e requisitos dos plugins em `plugins/README.md`.

---

## 1. Simplificação e Introdução Amigável no `README.md` Raiz
- Adicionar no topo do `README.md` um resumo de alto nível explicando o repositório como um monorepo/laboratório com três frentes principais:
  1. Plugins e extensões modulares para o DSH (`plugins/`).
  2. Aplicativo nativo Android Companion em Jetpack Compose (`android/companion/`).
  3. Ferramentas de bootstrap, auditoria offline e integração (`tools/`).
- Manter as seções técnicas detalhadas existentes intactas logo abaixo dessa introdução.

---

## 2. Notas de Contexto Interno/Histórico em `tools/`
- Adicionar notas breves no topo dos READMEs de manutenção/histórico:
  - `tools/workshop/README.md`
  - `tools/installation-consolidation/README.md`
  - `tools/pi-ai-fork/README.md`
  - `tools/task10-profile/README.md`
- Esclarecer que documentam rotinas e migrações internas da máquina de desenvolvimento e não são passos obrigatórios para uso dos plugins ou apps.

---

## 3. Matriz de Requisitos dos Plugins (`plugins/README.md`)
Criar uma tabela categorizada mapeando:
- **Standalone:** Funciona de forma independente em qualquer DSH (ex: `trash`, `list`, `apply-patch`, `grammar-fix`, `codex-transient-close`, `workspace-context`).
- **Com Dependência Externa:** Requer binário ou serviço externo (ex: `browser` com Playwright, `music` com `simp_mcp` / `uv`, `gen-image` com AGY CLI).
- **Ecossistema Companion:** Requer o app Android ou o host de transporte (ex: `companion-api`, `companion-transport`, `companion-download`, `companion-workspace`).

---

## 4. Matriz do Índice de Documentações (Paths dos READMEs)
Compilar uma tabela com os caminhos dos principais READMEs rastreados no repositório, seu escopo e audiência alvo.
