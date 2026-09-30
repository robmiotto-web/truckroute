# TruckRoute — MVP fase 1 (navegação para caminhões)

App web instalável (PWA). Abre no navegador do celular e pode ser adicionado à tela inicial como um app comum. O mapa é do Google, e o motor de restrições é código próprio (`engine.js`).

## O que ele faz

1. Você cadastra o veículo: tipo, altura, largura, comprimento, PBT e se leva produto perigoso.
2. Você digita o destino (ou toca no mapa). O Google traça a rota e as alternativas.
3. O motor próprio confere cada rota contra o seu veículo usando três fontes:
   - **OpenStreetMap**: altura máxima, peso, largura, comprimento, vias proibidas para caminhão e para produto perigoso. Conferido pela internet a cada rota.
   - **ANTT (dados abertos)**: pontes e viadutos das rodovias concedidas, atualizados todo mês de forma automática.
   - **Reportes dos motoristas**, feitos no próprio app.
4. Se a rota mais rápida tiver bloqueio, ele escolhe sozinho uma alternativa livre.
5. Durante a navegação: próxima manobra, previsão de chegada, alertas falados de restrição a 2,5 km e perto do ponto, recálculo quando sai da rota, tela sempre ligada.
6. O botão **Simular viagem** percorre a rota sem sair do lugar. É ideal para a banca e para testes.

**Limite importante:** a ANTT publica onde ficam as pontes e viadutos, mas não publica a altura livre (gabarito) nem a capacidade. Por isso os viadutos sobre a pista aparecem como "atenção", e não como bloqueio. Os números de altura e peso vêm do OpenStreetMap e dos reportes. Isso é exatamente a lacuna de dados que o TCC aponta, e o investimento em base de dados do projeto é o que a resolve.

---

## Passo 1 — Chave do Google Maps (cerca de 15 min)

1. Entre em https://console.cloud.google.com com uma conta Google.
2. Crie um projeto (ex.: "TruckRoute").
3. Ative o faturamento. O Google exige cartão mesmo para ficar na cota gratuita mensal.
4. Em **APIs e serviços → Biblioteca**, ative estas duas:
   - **Maps JavaScript API**
   - **Routes API**
5. Em **APIs e serviços → Credenciais → Criar credenciais → Chave de API**, copie a chave (começa com `AIza`).
6. Proteja a chave: clique nela e faça o seguinte.
   - Em **Restrições de aplicativo**, escolha "Referenciadores HTTP" e adicione `https://SEU-USUARIO.github.io/*`.
   - Em **Restrições de API**, marque só as duas APIs acima.
7. Em **Faturamento → Orçamentos e alertas**, crie um alerta (ex.: R$ 50) para não ter surpresa.

## Passo 2 — Publicar no GitHub Pages (grátis, cerca de 10 min)

1. Crie uma conta em https://github.com.
2. Crie um repositório **público** chamado `truckroute`.
3. Clique em **Add file → Upload files** e arraste todos os arquivos e pastas deste pacote.
   - Se a pasta `.github` não subir (ela é oculta em alguns computadores), faça assim: **Add file → Create new file**, digite o nome `.github/workflows/atualizar-antt.yml` e cole o conteúdo do arquivo.
4. Vá em **Settings → Pages**. Em "Branch", escolha `main` e `/ (root)` e salve.
5. Em 1 ou 2 minutos, o app estará em `https://SEU-USUARIO.github.io/truckroute/`.

## Passo 3 — Baixar a base da ANTT (1 clique)

1. No repositório, abra a aba **Actions**. Se o GitHub pedir, clique em "I understand… enable".
2. Clique em **Atualizar base ANTT → Run workflow**.
3. Em cerca de 1 minuto, o arquivo `data/antt_oae.json` é preenchido. Depois disso, ele se atualiza sozinho todo dia 5.

Também dá para rodar no computador com `python3 scripts/atualizar_antt.py`.

## Passo 4 — Usar no celular

1. Abra o endereço do app no Chrome (Android) ou Safari (iPhone).
2. Cole a chave do Google na primeira tela. Ela fica salva só naquele aparelho. Se preferir, deixe a chave fixa no `config.js`.
3. Permita a localização.
4. Instale o app:
   - **Android**: botão "Instalar app" ou menu ⋮ → Adicionar à tela inicial.
   - **iPhone**: Compartilhar → Adicionar à Tela de Início.
5. Toque no chip do veículo e confira as medidas do seu conjunto.
6. Para testar, digite a saída (ex.: "Rondonópolis MT") e o destino (ex.: "Santos SP") e toque em **Simular viagem**.

## Custos

Para você testar e mostrar na banca, o uso fica dentro da cota gratuita mensal do Google. O OpenStreetMap, a ANTT e o GitHub Pages são gratuitos. Em escala, o custo do Google cresce com o número de rotas e mapas abertos. Isso entra no fluxo de caixa do plano de negócios.

## Limites desta versão de teste

- Os reportes ficam salvos no próprio celular. O compartilhamento entre motoristas precisa de um servidor, que é o próximo passo.
- A conferência de restrições usa o servidor público do OpenStreetMap. Em rotas muito longas, ela leva de 1 a 3 minutos e pode falhar se o servidor estiver ocupado. Nesse caso, o app avisa e basta traçar a rota de novo.
- As instruções de manobra vêm do Google. O recálculo acontece após cerca de 3 leituras de GPS fora da rota.
- É uma ferramenta de apoio: a sinalização da via sempre prevalece.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Telas e visual |
| `app.js` | Mapa, rotas, navegação, voz, reportes |
| `engine.js` | Motor próprio: geometria, leitura das restrições, avaliação contra o veículo |
| `config.js` | Onde a chave do Google pode ficar fixa (opcional) |
| `data/antt_oae.json` | Base da ANTT convertida |
| `scripts/atualizar_antt.py` | Baixa e converte a base da ANTT |
| `.github/workflows/atualizar-antt.yml` | Atualização automática mensal |
| `sw.js`, `manifest.webmanifest`, `icons/` | Instalação como app |
