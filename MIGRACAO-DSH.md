# Corte DSH aplicado — guia histórico

**O corte e a retirada dos runtimes antigos já foram executados. Não repita os comandos de aplicação abaixo.** `finish.mjs`/`cold.mjs` preservam o procedimento histórico e seus testes; dependem de roots antigos que já saíram para `/tmp`.

Para conferir o estado atual, inclusive com esta TUI aberta:

```fish
cd /home/alex/git/my/dsh-customs
node tools/installation-consolidation/status.mjs
```

Resultado esperado: `state: "complete"`, `canonicalLinks: 404`, `localPackages: 1`, `blockers: []`. Veja o levantamento pós-limpeza em [LOCAIS-DSH.md](LOCAIS-DSH.md).

---

## Procedimento histórico executado

Comandos para **fish**, nesta máquina. Não reinstalam pacotes, não fazem login ou chamadas de modelos e não modificam sessões/configs. O frontend/Android/companion protótipo fica fora do escopo.

## O que já foi feito

- Web usa a CLI canônica em `~/.local/share/dsh-cli`.
- Fonte Pi centralizada em `dsh-customs/sources/pi-ai` como snapshot verificado, sem inventar Git HEAD.
- Dois builds antigos retirados do workspace; 597 diretórios de fixtures enviados para `/tmp`.
- SDK/self-heal com persistência e demais melhorias atuais preservados.

## 1. Fechar esta TUI

Saia normalmente desta conversa/TUI e execute os próximos comandos em **outro terminal fish**. Não use uma tool desta conversa para executar o corte: ela própria é o consumidor que o finalizador precisa encontrar encerrado.

O programa recusa aplicação se outra TUI DSH estiver ativa. Não contorne esse bloqueio nem use `kill -9`.

## 2. Conferir o código e a seleção

```fish
cd /home/alex/git/my/dsh-customs
node --test tools/installation-consolidation/finish.test.mjs
node tools/installation-consolidation/finish.mjs --preview
```

A seleção esperada é:

- **404 links para o runtime canônico**: 401 shared, 2 reparos `debug`/`ms`, 1 adapter TUI.
- **205 links obsoletos retirados**: 203 diretos e 2 aliases UI; seus destinos já não existem no cache antigo nem no canônico.
- Pacotes/diretórios regulares, inclusive o `dsh-llm-llamacpp` local, preservados.

Os reparos `debug`/`ms` usam os pacotes hoisted e locks públicos comprovados. Não pressupõem uma versão conhecida nos antigos destinos aninhados, que estão ausentes. Quatro versões já existentes no runtime canônico são adotadas explicitamente; nenhum download/upgrade é executado.

**Se testes falharem ou o preview mostrar blockers, não aplique.** Copie apenas o resumo do erro para esta conversa; não envie configs, tokens ou logs de sessões.

## 3. Aplicar

```fish
node tools/installation-consolidation/finish.mjs --apply
```

O finalizador confere os hashes das melhorias do SDK, valida o mapeamento inteiro antes da primeira alteração e revalida cada link. Pausa e retoma somente `dsh-web.service` se ele estava ativo. Não encerra TUIs nem altera o protótipo companion. Uma lista simples das ações fica num diretório privado em `/tmp`; não cria outro backup ou plano de rollback.

Se retornar erro, **pare**: não repita com flags inventadas, não limpe caches e não apague as pastas antigas manualmente.

## 4. Conferir e reabrir

```fish
node tools/installation-consolidation/finish.mjs --preview
systemctl --user is-active dsh-web.service
curl --max-time 5 --silent --show-error --output /dev/null --write-out 'web HTTP %{http_code}\n' http://127.0.0.1:3080/
dsh
```

No preview final, confira `stage: "completed"`, `complete: true`, `canonical: 404`, `retarget: 0` e `retire: 0`. Os números 404/205 da seleção inicial são ações **antes** do corte, não novas ações a repetir depois.

O web desta máquina retornava `HTTP 401` antes da migração: isso confirma que a barreira de autenticação continua presente, não uma falha do serviço. Não é teste de inferência.

A nova TUI passa a resolver adapter/Pi/peers no runtime canônico. A sessão antiga não é reescrita; reabra-a pela interface normal, se desejar.

## O que NÃO apagar junto

Não apague `.dumps` inteira, `~/.dsh`, `~/.npm`, os sources/candidates vencedores ou `workshop-build3-20261012` (compilador/proveniência ainda usados). Este corte muda o grafo dos perfis, **não remove automaticamente o root npx ou o runtime scratch**: só podem ir para `/tmp` depois de confirmar ausência de referências e processos. Não use `npm cache clean`, `npm install` ou `activate --write` para finalizar esta etapa.
