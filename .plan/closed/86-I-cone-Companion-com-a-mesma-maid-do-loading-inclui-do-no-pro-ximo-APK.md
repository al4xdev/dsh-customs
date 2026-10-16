# Maid do loading como ícone do app

## Pedido e origem observada
Dono pediu 'mudar o ícone do app, usa a maid lá do gif de load' e mandou continuar sem celular, avisando quando for necessário. O loading Android usa PNGs próprios já empacotados em assets/companion/maid/{thinking,typing}; imagem original thinking/00.png foi inspecionada,301x288px, alpha/pixel art reconhecível, SHA256c4132f28c128c06d86874f61e7ba7ae8b6d305708127879cbc36c6ed3e7e4319. É arte fornecida pelo dono para uso pessoal, não logo oficial. Ícone atual é vector drawable/ic_companion.xml; manifesto aponta android:icon para ele.

## Implementação mínima
1. Reutilizar um quadro estático da MESMA maid já carregada (preferência thinking/00.png), sem gerar outra personagem, rede/image-generation, alterar loader, cores da personagem, tempos ou arquivos originais. Derivar recursos PNG de launcher com alpha/pixel art preservado, usando ferramentas já disponíveis e transformação offline documentada; sem dependência runtime nova.
2. Criar ícone adaptive com fundo grafite discreto alinhado à paleta85 e foreground maid centrada/padding seguro para máscaras circle/squircle. Não cortar rosto/laço; escala nearest-neighbor para pixel art. Se incluir monochrome, derivar da própria silhueta e garantir que não vire o símbolo antigo. Android icon é estático; animação do loading continua como está.
3. Apontar icon e roundIcon do Manifest para o recurso adequado. Manter applicationId/label/permissões/activities/UID/cofre/preset/assinatura. Não mexer em layout, tipografia, motion, toolbar ou loading. Eliminar referência de launcher ao símbolo antigo, sem apagar arquivos fora do escopo.
4. Documentar quadro-fonte/origem e transformação/attribution. Parent coordena versão9 junto à task85 (não outra versão conflitante), Gradle/ADB centralizados.

## Validação
Verificar recursos/manifest no build/lint estrito, testes de PackageManager/drawable adaptive e safe bounds/círculo+quadrado arredondado somente com imagens sintéticas da própria arte. Inspecionar imagem final via read_image; render de ícone no emulador próprio5039/5580 se necessário, sem conta/dados privados. Comprovar loader original inalterado/hash. Mesma assinatura do APK8; não alegar instalação/resultado físico.

## Entrega e limites
Incluir no próximo APK9 preparado com paleta/copy85. NÃO instalar/abrir/operar celular agora; avisar dono e obter nova condição segura antes do upgrade. Nenhum restart/ativação backend/perfil/tools82/83/modelo, sessão/projeto/grant/prompt/delete real, SDK/TUI/HA/rede/OAuth/global, commit/push/publicação. Não criar backup/miniaturas de prints privados. Plano aprovado e goal atual guiam execução.