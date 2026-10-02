# TruckRoute — MVP fase 1 (versão 4)

App web instalável (PWA) de navegação para caminhões. Abre no navegador do celular e vai para a tela inicial como um app comum.

**Custo zero, sem chave e sem cartão:**

- **Mapa:** OpenFreeMap, com dados do OpenStreetMap.
- **Rotas:** Valhalla (servidor público da FOSSGIS), já calculadas com o perfil de caminhão: altura, largura, comprimento, peso e produto perigoso.
- **Busca de endereços:** Photon (OpenStreetMap), com sugestões enquanto você digita.
- **Segunda conferência:** o motor próprio (`engine.js`) confere a rota trecho a trecho no OpenStreetMap e cruza com a base da ANTT e com os reportes dos motoristas.

## O que ele faz

1. No primeiro acesso, o app pede o cadastro do veículo em 3 toques: conjunto (Toco, Truck, Carreta LS, Bitrem…), carroceria (Sider, Baú, Graneleiro, Grade baixa…) e confirmação das medidas. Fica salvo para as próximas rotas.
2. Para carrocerias em que a carga define a altura (grade baixa, prancha, porta-contêiner, cegonha, florestal), o app mostra o campo "Altura hoje" antes de cada rota.
3. Você digita o destino e o app sugere os lugares enquanto você escreve. Um toque confirma, como no Waze.
4. A rota já sai calculada para o seu caminhão, com até 3 alternativas.
5. O motor próprio confere cada trecho. Se achar algo incompatível, troca para uma alternativa livre.
6. Na navegação, o mapa gira e inclina como no Waze, mostra a próxima manobra e avisa por voz as restrições a 2,5 km e perto do ponto. Recalcula se você sair da rota e mantém a tela ligada.
7. O caminhão aparece no mapa em tempo real, com movimento suave, velocidade e precisão do GPS.
8. O botão **Simular viagem** percorre a rota sem sair do lugar.

**Limite importante:** a ANTT publica onde ficam as pontes e viadutos das rodovias concedidas, mas não a altura livre. Por isso esses pontos aparecem como "atenção". Os limites de altura e peso vêm do OpenStreetMap e dos reportes dos motoristas.

---

## Novidades da versão 4

- **Trânsito ao vivo (opcional):** toque em "Trânsito ao vivo" e cole a chave gratuita da TomTom. A rota passa a considerar o trânsito, mostra os trechos lentos em vermelho e amarelo e informa o atraso. Sem a chave, o app continua funcionando, sem trânsito.
- **Rota melhor durante a viagem:** a cada 3 minutos o app compara a rota atual com as alternativas e avisa "Caminho X min mais rápido". Um toque em Aceitar troca a rota. Ao sair da rota, o recálculo escolhe sempre a opção mais rápida.
- **Opções de trajeto:** cada alternativa mostra tempo, km, pedágios e atraso de trânsito.
- **Postos, polícia, balança, radar e pedágio** no mapa, com aviso falado antes de radar, balança, PRF e pedágio. Durante a viagem, o painel mostra a distância até o próximo posto.
- **Limite de velocidade da via:** placa na tela e aviso falado quando passar do limite. Para caminhão, usa o limite de pesados quando a via tem essa informação.
- **Falas antes das manobras:** a cerca de 1 km, a 300 m e "agora".
- **Carro de passeio e Fiorino** no cadastro, com rota de carro (sem as restrições de caminhão).

Fontes dos pontos e limites: OpenStreetMap, conferido ao longo de cada rota. A cobertura varia por região. Os reportes dos motoristas completam os pontos que faltam.

## Instalação (uns 10 minutos, só GitHub)

### 1. Subir os arquivos

1. Descompacte o `truckroute-mvp.zip` no computador.
2. Abra a pasta `truckroute`. Dentro dela estão `index.html`, `app.js`, `engine.js` e as pastas `data`, `icons` e `scripts`.
3. No repositório do GitHub, clique em **Adicionar arquivo → Carregar arquivos**.
4. Selecione **tudo o que está dentro** da pasta (Ctrl+A), arraste e clique em **Confirmar alterações**. O `index.html` precisa aparecer na lista principal do repositório.

### 2. Ativar o site

1. Vá em **Configurações → Pages**.
2. Em Branch, escolha `main` e `/ (root)` e clique em **Save**.
3. Espere 1 a 2 minutos e atualize a página. O link aparece no topo, por exemplo `https://robmiotto-web.github.io/Caminhorota/`.

### 3. Base da ANTT (opcional para o primeiro teste)

1. Clique em **Adicionar arquivo → Criar novo arquivo**.
2. No nome, digite `.github/workflows/atualizar-antt.yml` e cole o conteúdo do arquivo de mesmo nome que veio no pacote.
3. Na aba **Ações**, abra **Atualizar base ANTT** e clique em **Run workflow**. Depois disso, a base se atualiza sozinha todo dia 5.

### 4. No celular

1. Abra o link no Chrome (Android) ou Safari (iPhone).
2. Permita a localização.
3. Instale o app:
   - **Android:** menu ⋮ → Adicionar à tela inicial.
   - **iPhone:** Compartilhar → Adicionar à Tela de Início.
4. Toque no chip do veículo e confira as medidas.
5. Para o primeiro teste, use "Sair de outro lugar" com uma rota que você conhece e toque em **Simular viagem**.

## Limites desta versão de teste

- Os servidores gratuitos de rotas e de busca têm uso justo, com limite de pedidos. Para o teste do CEO e de um grupo pequeno, é suficiente. Antes da divulgação em massa, a empresa precisa de servidor próprio (custo baixo, decisão do CFO).
- Os reportes ficam salvos no próprio celular.
- Como é um app web, o GPS funciona com o app aberto na tela. Com a tela apagada ou o app minimizado, o celular pausa a localização. Durante a navegação, o app mantém a tela ligada.
- As medidas sugeridas no cadastro são referência por tipo de conjunto. Vale sempre a medida real do veículo.
- A conferência extra em rotas longas leva de 1 a 3 minutos. A rota já sai segura para o caminhão antes disso.
- É uma ferramenta de apoio: a sinalização da via sempre prevalece.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Telas e visual |
| `app.js` | Mapa, rotas, navegação, voz, reportes |
| `engine.js` | Motor próprio de restrições |
| `config.js` | Endereços dos serviços de mapa, rota e busca |
| `data/antt_oae.json` | Base da ANTT convertida |
| `scripts/atualizar_antt.py` | Baixa e converte a base da ANTT |
| `.github/workflows/atualizar-antt.yml` | Atualização automática mensal |
| `sw.js`, `manifest.webmanifest`, `icons/` | Instalação como app |
