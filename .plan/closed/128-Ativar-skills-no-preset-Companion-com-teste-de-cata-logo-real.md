# Corrigir composição de skills do Companion

## Causa comprovada
O bundle dsh-web-app desativa skill-filesystem e tool-skill globais. O preset Companion não os repõe; a validação anterior do provider isolado não cobria entrega ao agente.

## Implementação
1. Inserir skill-filesystem e tool-skill dentro de preset-companion.config.plugins no perfil instalado ~/.dsh/profiles/companion/cordis.patch.yml, sem regenerar o arquivo. Preservar modelo e todas demais configurações.
2. Configurar customSkillDirs para /home/alex/git/my/dsh-companion-workspace/.agents/skills, mantendo defaults, para servir também projetos filhos com git próprio.
3. Atualizar gerador tools/session-companion/profile.mjs e testes correspondentes para impedir regressão.
4. Fixture SDK instalada e isolada: schemas/tool skill disponíveis somente no preset; executar duas skills pela API pública; capturar primeiro request com adapter fake para comprovar source.kind skill-catalog e nomes. Testar cwd raiz e child repo com git próprio; sem rede ou modelos reais.
5. Sem restart manual nem mudanças de permissões. O perfil usa patchReload live; relatar limites da confirmação no processo já em execução.

A correção de session_create entre perfis será tratada em plano separado após análise do transporte e aprovação, sem confundir as duas validações.