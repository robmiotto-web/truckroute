/* TruckRoute v2 — custo zero: mapa OpenFreeMap (MapLibre), rotas Valhalla com perfil de caminhão,
 * busca Nominatim, e o motor próprio de restrições (engine.js) como segunda camada de segurança. */
(function () {
  'use strict';
  var E = window.TREngine, ML = window.maplibregl;
  var CFG = Object.assign({
    estiloMapa: 'https://tiles.openfreemap.org/styles/dark',
    rotas: 'https://valhalla1.openstreetmap.de/route',
    busca: 'https://photon.komoot.io/api/'
  }, window.TRUCKROUTE_CONFIG || {});
  var $ = function (s) { return document.querySelector(s); };
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('tr:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('tr:' + k, JSON.stringify(v)); } catch (e) { /* sem espaço */ } }
  };
  var OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  var CORREDOR = 20;
  // Catálogo de conjuntos e carrocerias: valores são referência para pré-preencher; o motorista confirma a medida real
  var COMPOSICOES = [
    { id: 'carro', nome: 'Carro de passeio', sub: 'Entregas e aplicativos', comp: 4.5, pbt: 2, larg: 1.9, alt: 1.6, leve: true, semCarr: true },
    { id: 'fiorino', nome: 'Fiorino / utilitário', sub: 'Baú pequeno', comp: 4.5, pbt: 2.5, larg: 1.9, alt: 2.0, leve: true, carrs: ['bau', 'frigo'] },
    { id: 'vuc', nome: 'VUC / 3/4', sub: 'Urbano, 2 eixos', comp: 6.3, pbt: 8, larg: 2.2, semCarrs: ['conteiner'] },
    { id: 'toco', nome: 'Toco', sub: '2 eixos', comp: 10, pbt: 16, larg: 2.6 },
    { id: 'truck', nome: 'Truck', sub: '3 eixos', comp: 12, pbt: 23, larg: 2.6 },
    { id: 'bitruck', nome: 'Bitruck', sub: '4 eixos', comp: 14, pbt: 29, larg: 2.6 },
    { id: 'carreta4', nome: 'Carreta 4 eixos', sub: 'Cavalo 4x2 + 2 eixos', comp: 18.6, pbt: 33, larg: 2.6 },
    { id: 'carreta5', nome: 'Carreta 5 eixos', sub: 'Cavalo 4x2 + 3 eixos', comp: 18.6, pbt: 41.5, larg: 2.6 },
    { id: 'carreta6', nome: 'Carreta LS 6 eixos', sub: 'Cavalo 6x2 + 3 eixos', comp: 18.6, pbt: 48.5, larg: 2.6 },
    { id: 'vanderleia', nome: 'Vanderléia', sub: '6 eixos distanciados', comp: 18.6, pbt: 53, larg: 2.6 },
    { id: 'bitrem', nome: 'Bitrem', sub: '7 eixos', comp: 19.8, pbt: 57, larg: 2.6 },
    { id: 'rodotrem', nome: 'Rodotrem / Bitrem 9', sub: '9 eixos', comp: 25, pbt: 74, larg: 2.6 }
  ];
  var CARROCERIAS = [
    { id: 'sider', nome: 'Sider', sub: 'Lonado com cortina', alt: 4.4 },
    { id: 'bau', nome: 'Baú', sub: 'Carga seca fechada', alt: 4.3 },
    { id: 'frigo', nome: 'Baú frigorífico', sub: 'Refrigerado', alt: 4.3 },
    { id: 'graneleiro', nome: 'Graneleiro', sub: 'Grade alta', alt: 4.1 },
    { id: 'gradebaixa', nome: 'Grade baixa / aberta', sub: 'A carga define a altura', alt: 4.0, carga: true },
    { id: 'basculante', nome: 'Basculante', sub: 'Caçamba', alt: 3.6 },
    { id: 'tanque', nome: 'Tanque', sub: 'Líquidos ou gases', alt: 3.9 },
    { id: 'conteiner', nome: 'Porta-contêiner', sub: 'Muda com o contêiner', alt: 4.3, carga: true },
    { id: 'cegonha', nome: 'Cegonha', sub: 'Transporte de veículos', alt: 4.95, carga: true },
    { id: 'prancha', nome: 'Prancha / especial', sub: 'A carga define a altura', alt: 4.4, carga: true },
    { id: 'florestal', nome: 'Florestal', sub: 'Toras e madeira', alt: 4.2, carga: true },
    { id: 'boiadeiro', nome: 'Boiadeiro', sub: 'Gado vivo', alt: 4.2 }
  ];
  function achar(lista, id) { for (var i = 0; i < lista.length; i++) if (lista[i].id === id) return lista[i]; return null; }
  var VEH_PADRAO = { comp: null, carr: null, altura: 4.4, largura: 2.6, comprimento: 18.6, pbt: 48.5, perigoso: false };
  var NOME_POI = { radar: 'Radar', policia: 'Polícia Rodoviária', balanca: 'Balança', pedagio: 'Pedágio', posto: 'Posto de combustível' };
  var COR = { bloqueio: '#E5533D', atencao: '#F2A900', info: '#7FA8D9' };

  var S = {
    veh: Object.assign({}, VEH_PADRAO, LS.get('veiculo', {})),
    reportes: LS.get('reportes', []),
    antt: [], anttInfo: null,
    mapa: null, pronto: false, pos: null, marcaPos: null, marcaDestino: null,
    rotas: [], sel: 0, destino: null, tokenRota: 0, nav: null,
    voz: LS.get('voz', true), seguir: true, wake: null
  };

  // ---------- utilidades ----------
  function fmtDist(m) {
    if (m < 1000) return Math.max(0, Math.round(m / 10) * 10) + ' m';
    var km = m / 1000;
    return (km < 100 ? km.toFixed(1).replace('.', ',') : Math.round(km).toLocaleString('pt-BR')) + ' km';
  }
  function fmtDur(s) {
    var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return h ? h + 'h' + String(m).padStart(2, '0') : m + ' min';
  }
  function fmtHora(d) { return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  function num(v) { var n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; }
  var toastT;
  function toast(msg, ms) {
    var el = $('#aviso-geral'); el.textContent = msg; el.classList.remove('oculto');
    clearTimeout(toastT); toastT = setTimeout(function () { el.classList.add('oculto'); }, ms || 3500);
  }
  function falar(txt) {
    if (!S.voz || !('speechSynthesis' in window)) return;
    try { var u = new SpeechSynthesisUtterance(txt); u.lang = 'pt-BR'; u.rate = 1.02; speechSynthesis.speak(u); } catch (e) { /* sem voz */ }
  }
  function el(tag, attrs, filhos) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (filhos || []).forEach(function (f) { if (f) n.appendChild(f); });
    return n;
  }
  function ll(p) { return [p.lng, p.lat]; }

  // ---------- telas ----------
  function painel(qual) {
    ['inicio', 'rota', 'nav'].forEach(function (p) { $('#p-' + p).classList.toggle('oculto', p !== qual); });
    $('#caixa-busca').classList.toggle('oculto', qual === 'nav');
    $('#resultados').classList.add('oculto');
    $('#manobra').classList.toggle('oculto', qual !== 'nav');
    if (qual !== 'nav') $('#aviso').classList.add('oculto');
    requestAnimationFrame(posFlutuantes);
  }
  function posFlutuantes() {
    var b = ($('#painel').offsetHeight + 14) + 'px';
    $('#flutuantes').style.bottom = b; $('#velocimetro').style.bottom = b;
    $('#placa-vel').style.bottom = ($('#painel').offsetHeight + 20) + 'px';
  }
  function abrir(id) { $(id).classList.remove('oculto'); }
  function fechar(id) { $(id).classList.add('oculto'); }
  document.addEventListener('click', function (e) {
    var f = e.target.closest('[data-fechar]'); if (f) fechar('#' + f.closest('.modal').id);
    if (e.target.classList.contains('modal')) fechar('#' + e.target.id);
  });
  function nomeConjunto(v) {
    var c = achar(COMPOSICOES, v.comp), k = achar(CARROCERIAS, v.carr);
    return (c ? c.nome : 'Veículo') + (k ? ' ' + k.nome.toLowerCase() : '');
  }
  function carrAtual() { return achar(CARROCERIAS, S.veh.carr) || {}; }
  // Medidas desta viagem: para carroceria aberta, a altura com a carga do dia vale mais que a do cadastro
  function vehViagem() {
    var v = Object.assign({}, S.veh), h = num($('#altura-hoje').value);
    if (carrAtual().carga && h && h > 1.5 && h < 6) v.altura = h;
    return v;
  }
  function chipsVeiculo(alvo) {
    var v = vehViagem(), c = $(alvo); c.textContent = '';
    if (!v.comp) { c.appendChild(el('span', { class: 'chip', text: 'Toque para cadastrar seu veículo' })); return; }
    [nomeConjunto(v), E.fmtNum(v.altura) + ' m altura', E.fmtNum(v.pbt) + ' t', E.fmtNum(v.comprimento) + ' m', v.perigoso ? 'Produto perigoso' : null]
      .forEach(function (t) { if (t) c.appendChild(el('span', { class: 'chip', text: t })); });
  }
  function atualizarLinhaAltura() {
    var k = carrAtual(), linha = $('#linha-altura');
    linha.classList.toggle('oculto', !k.carga);
    $('#altura-hoje').placeholder = k.carga ? 'Com a carga de hoje (cadastro: ' + E.fmtNum(S.veh.altura) + ' m)' : '';
  }

  // ---------- mapa ----------
  function criarMapa() {
    if (!ML) { toast('Sem internet para carregar o mapa. Abra de novo quando tiver sinal.', 8000); return; }
    var ultimo = LS.get('ultimaPos', { lat: -19.93, lng: -44.05 });
    S.mapa = new ML.Map({
      container: 'mapa', style: CFG.estiloMapa, center: ll(ultimo), zoom: 12,
      attributionControl: false, pitchWithRotate: true, dragRotate: true, maxPitch: 60
    });
    S.mapa.on('dragstart', function () { S.seguir = false; });
    S.mapa.on('error', function (e) { if (e && e.error && /Failed to fetch|NetworkError/i.test(String(e.error.message))) toast('Sinal fraco: parte do mapa não carregou.'); });
    S.mapa.on('load', function () {
      S.mapa.addSource('rotas', { type: 'geojson', data: fc([]) });
      S.mapa.addLayer({ id: 'rotas-alt', type: 'line', source: 'rotas', filter: ['==', ['get', 'sel'], false], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#5B6570', 'line-width': 6, 'line-opacity': 0.85 } });
      S.mapa.addLayer({ id: 'rotas-borda', type: 'line', source: 'rotas', filter: ['==', ['get', 'sel'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0B3A80', 'line-width': 11 } });
      S.mapa.addLayer({ id: 'rotas-sel', type: 'line', source: 'rotas', filter: ['==', ['get', 'sel'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#4C9BFF', 'line-width': 7 } });
      S.mapa.addSource('transito', { type: 'geojson', data: fc([]) });
      S.mapa.addLayer({ id: 'transito', type: 'line', source: 'transito', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['match', ['get', 'cat'], 'JAM', '#E5533D', 'ROAD_CLOSURE', '#8B1A10', '#F2A900'], 'line-width': 7 } });
      S.mapa.addSource('pois', { type: 'geojson', data: fc([]) });
      S.mapa.addLayer({ id: 'pois', type: 'circle', source: 'pois', paint: {
        'circle-radius': 11, 'circle-stroke-color': '#12161A', 'circle-stroke-width': 2,
        'circle-color': ['match', ['get', 'tipo'], 'radar', '#E5533D', 'policia', '#2F6FD6', 'balanca', '#9B59D0', 'pedagio', '#7C868F', '#2E9E6A'] } });
      S.mapa.addLayer({ id: 'pois-txt', type: 'symbol', source: 'pois', layout: {
        'text-field': ['match', ['get', 'tipo'], 'radar', 'R', 'policia', 'PRF', 'balanca', 'B', 'pedagio', '$', 'P'],
        'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-allow-overlap': true, 'icon-allow-overlap': true },
        paint: { 'text-color': '#FFFFFF' } });
      S.mapa.on('click', 'pois', function (e) { var p = e.features[0].properties; toast(NOME_POI[p.tipo] + (p.nome ? ' · ' + p.nome : '') + (p.lim ? ' · limite ' + p.lim + ' km/h' : ''), 4000); });
      S.mapa.addSource('achados', { type: 'geojson', data: fc([]) });
      S.mapa.addLayer({ id: 'achados', type: 'circle', source: 'achados', paint: {
        'circle-radius': ['match', ['get', 'nivel'], 'info', 4, 9],
        'circle-color': ['match', ['get', 'nivel'], 'bloqueio', COR.bloqueio, 'atencao', COR.atencao, COR.info],
        'circle-stroke-color': '#12161A', 'circle-stroke-width': 2 } });
      S.mapa.addSource('reportes', { type: 'geojson', data: fc([]) });
      S.mapa.addLayer({ id: 'reportes', type: 'circle', source: 'reportes', paint: { 'circle-radius': 7, 'circle-color': '#F2A900', 'circle-stroke-color': '#14171A', 'circle-stroke-width': 3 } });
      S.mapa.on('click', 'achados', function (e) {
        var p = e.features[0].properties; toast(p.titulo + ': ' + p.texto, 6000);
      });
      S.mapa.on('click', 'rotas-alt', function (e) { escolher(e.features[0].properties.n); });
      S.mapa.on('click', function (e) {
        if (S.nav) return;
        var hit = S.mapa.queryRenderedFeatures(e.point, { layers: ['achados', 'rotas-alt'] });
        if (hit.length) return;
        var p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        S.destino = { lat: p.lat, lng: p.lng, nome: 'Ponto no mapa' };
        $('#destino').value = 'Ponto no mapa (' + p.lat.toFixed(4) + ', ' + p.lng.toFixed(4) + ')';
        marcarDestino(p);
        toast('Destino marcado no mapa. Toque em Traçar rota.');
      });
      S.pronto = true;
      desenharReportes();
    });
    iniciarGPS();
  }
  function fc(features) { return { type: 'FeatureCollection', features: features }; }
  function setDados(src, data) { if (S.pronto && S.mapa.getSource(src)) S.mapa.getSource(src).setData(data); }

  // ---------- GPS e marcador do caminhão ----------
  function iniciarGPS() {
    if (!('geolocation' in navigator)) { toast('Este aparelho não informa a localização. Preencha a saída.'); return; }
    navigator.geolocation.watchPosition(function (g) {
      if (S.nav && S.nav.sim) return;
      var primeira = !S.pos;
      aoPosicionar({ lat: g.coords.latitude, lng: g.coords.longitude, heading: g.coords.heading, speed: g.coords.speed, prec: g.coords.accuracy, t: g.timestamp || Date.now() });
      if (primeira && !S.rotas.length && S.mapa) S.mapa.jumpTo({ center: ll(S.pos), zoom: 15 });
    }, function (err) {
      if (err.code === 1) toast('Localização bloqueada. Libere nas configurações do navegador ou preencha a saída.', 6000);
      else toast('Procurando sinal de GPS…', 2500);
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  function criarMarcaPos() {
    var d = document.createElement('div');
    d.className = 'marca-pos';
    d.innerHTML = '<svg width="40" height="40" viewBox="-20 -20 40 40" aria-hidden="true"><circle r="18" fill="#4C9BFF" fill-opacity="0.22"/><path d="M0 -13 L10 11 L0 5 L-10 11 Z" fill="#fff" stroke="#4C9BFF" stroke-width="3" stroke-linejoin="round"/></svg>';
    return new ML.Marker({ element: d, rotationAlignment: 'map', pitchAlignment: 'map' });
  }

  function aoPosicionar(p) {
    var ant = S.pos;
    p.t = p.t || Date.now();
    if (ant) {
      var d = E.haversine(ant, p), dt = (p.t - (ant.t || p.t)) / 1000;
      if (p.heading == null || isNaN(p.heading)) p.heading = d > 3 ? E.bearing(ant, p) : ant.heading;
      if ((p.speed == null || isNaN(p.speed)) && dt > 0) p.speed = d / dt;
    }
    S.pos = p; LS.set('ultimaPos', { lat: p.lat, lng: p.lng });
    atualizarVelocimetro(p);
    if (!S.mapa) return;
    if (!S.marcaPos) { S.marcaPos = criarMarcaPos().setLngLat(ll(p)).setRotation(p.heading || 0).addTo(S.mapa); }
    else animarMarca(ant || p, p);
    if (S.nav) passoNavegacao(p);
    else if (S.seguir && !S.rotas.length) S.mapa.easeTo({ center: ll(p), duration: 800 });
  }

  // Movimento suave do caminhão entre uma leitura de GPS e a próxima (sem "pulos")
  var animId = null;
  function animarMarca(de, para) {
    if (animId) cancelAnimationFrame(animId);
    var t0 = performance.now(), dur = 900;
    var r0 = de.heading || 0, r1 = para.heading || r0, dr = ((r1 - r0 + 540) % 360) - 180;
    function quadro(agora) {
      var k = Math.min(1, (agora - t0) / dur);
      S.marcaPos.setLngLat([de.lng + (para.lng - de.lng) * k, de.lat + (para.lat - de.lat) * k]).setRotation(r0 + dr * k);
      if (k < 1) animId = requestAnimationFrame(quadro); else animId = null;
    }
    animId = requestAnimationFrame(quadro);
  }

  function atualizarVelocimetro(p) {
    var v = $('#velocimetro'); v.classList.remove('oculto');
    $('#vel').textContent = p.speed != null && !isNaN(p.speed) ? Math.max(0, Math.round(p.speed * 3.6)) : 0;
    var pr = $('#gps-prec');
    if (p.prec != null) { pr.textContent = 'GPS ±' + Math.round(p.prec) + ' m'; pr.style.color = p.prec > 50 ? '#F2A900' : ''; }
    else pr.textContent = S.nav && S.nav.sim ? 'simulação' : '';
  }

  $('#btn-centro').addEventListener('click', function () {
    S.seguir = true;
    if (!S.pos) { toast('Ainda sem sinal de GPS.'); return; }
    if (S.nav) seguirCamera(S.pos, true); else S.mapa.easeTo({ center: ll(S.pos), zoom: Math.max(S.mapa.getZoom(), 15) });
  });

  // Câmera estilo navegação: mapa gira com o caminhão, inclinado, caminhão no terço de baixo
  function seguirCamera(p, forcar) {
    if (!S.seguir && !forcar) return;
    var alt = window.innerHeight;
    S.mapa.easeTo({ center: ll(p), bearing: p.heading || S.mapa.getBearing(), pitch: 55, zoom: 16.3,
      padding: { top: Math.round(alt * 0.35), bottom: 120, left: 0, right: 0 }, duration: 900, essential: true });
  }

  // ---------- base ANTT ----------
  function carregarAntt() {
    fetch('data/antt_oae.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (j) {
      S.antt = j.itens || []; S.anttInfo = { total: j.total || 0, atualizado: j.atualizado };
    }).catch(function () { S.anttInfo = { total: 0 }; });
  }

  // ---------- busca de endereço com sugestões enquanto digita (Photon/OpenStreetMap) ----------
  var COORD = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;]\s*(-?\d+(?:[.,]\d+)?)\s*$/;
  var BRASIL = '-74.1,-33.9,-34.7,5.4';
  function textoLugar(p) {
    var rua = p.street ? p.street + (p.housenumber ? ', ' + p.housenumber : '') : '';
    var nome = p.name || rua || p.city || p.county || 'Local';
    var resto = [];
    if (rua && rua !== nome) resto.push(rua);
    [p.district, p.city, p.state].forEach(function (x) { if (x && x !== nome && resto.indexOf(x) < 0) resto.push(x); });
    return { nome: nome, sub: resto.join(' · ') };
  }
  function buscarLugar(txt) {
    var m = txt.match(COORD);
    if (m) return Promise.resolve([{ lat: num(m[1]), lng: num(m[2]), nome: txt.trim(), sub: 'Coordenadas' }]);
    var ref = S.pos || LS.get('ultimaPos', null);
    var url = CFG.busca + '?limit=6&bbox=' + BRASIL + '&q=' + encodeURIComponent(txt) + (ref ? '&lat=' + ref.lat.toFixed(4) + '&lon=' + ref.lng.toFixed(4) : '');
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('A busca de endereços está ocupada. Tente de novo em alguns segundos.');
      return r.json();
    }).then(function (j) {
      var vistos = {};
      return (j.features || []).map(function (f) {
        var t = textoLugar(f.properties || {});
        return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], nome: t.nome, sub: t.sub };
      }).filter(function (x) { var k = x.nome + '|' + x.sub; if (vistos[k]) return false; vistos[k] = 1; return true; });
    });
  }

  // Lista de sugestões compartilhada pelos campos Saída e Destino
  var sug = { campo: null, itens: [], ativo: -1, aoEscolher: null, token: 0, timer: null };
  function mostrarSugestoes(campo, itens, aoEscolher, titulo) {
    var box = $('#resultados'); box.textContent = '';
    sug.campo = campo; sug.itens = itens; sug.ativo = -1; sug.aoEscolher = aoEscolher;
    if (titulo) box.appendChild(el('div', { class: 'dica', style: 'margin:4px 8px 6px', text: titulo }));
    itens.forEach(function (x, i) {
      box.appendChild(el('button', { type: 'button', class: 'res', role: 'option', id: 'sug-' + i,
        onmousedown: function (e) { e.preventDefault(); },
        onclick: function () { escolherSugestao(i); } },
        [el('div', { class: 't', text: x.nome }), el('div', { class: 's', text: x.sub || '' })]));
    });
    box.classList.toggle('oculto', !itens.length);
    campo.setAttribute('aria-expanded', String(!!itens.length));
  }
  function esconderSugestoes() {
    $('#resultados').classList.add('oculto');
    if (sug.campo) sug.campo.setAttribute('aria-expanded', 'false');
    sug.token++;
  }
  function escolherSugestao(i) {
    var x = sug.itens[i], f = sug.aoEscolher; if (!x) return;
    sug.campo.value = x.nome; esconderSugestoes(); if (f) f(x);
  }
  function ligarAutocompletar(campo, aoEscolher) {
    campo.addEventListener('input', function () {
      aoEscolher(null);
      clearTimeout(sug.timer);
      var q = campo.value.trim();
      if (q.length < 3) { esconderSugestoes(); return; }
      var tk = ++sug.token;
      sug.timer = setTimeout(function () {
        buscarLugar(q).then(function (l) { if (tk === sug.token) mostrarSugestoes(campo, l, aoEscolher); }).catch(function () { /* tenta de novo na próxima letra */ });
      }, 280);
    });
    campo.addEventListener('keydown', function (e) {
      if ($('#resultados').classList.contains('oculto') || sug.campo !== campo) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sug.ativo = (sug.ativo + (e.key === 'ArrowDown' ? 1 : -1) + sug.itens.length) % sug.itens.length;
        document.querySelectorAll('.res').forEach(function (b, i) { b.style.background = i === sug.ativo ? 'var(--campo)' : ''; });
        campo.setAttribute('aria-activedescendant', 'sug-' + sug.ativo);
      } else if (e.key === 'Enter' && sug.ativo >= 0) { e.preventDefault(); escolherSugestao(sug.ativo); }
      else if (e.key === 'Escape') esconderSugestoes();
    });
    campo.addEventListener('blur', function () { setTimeout(esconderSugestoes, 150); });
  }

  // Sem sugestão escolhida: busca e pede para o motorista confirmar com um toque, como no Waze
  var SILENCIO = { silencioso: true };
  function enviarRota() {
    var f = $('#form-rota');
    if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit', { cancelable: true }));
  }
  function pedirConfirmacao(campo, txt, titulo, gravar) {
    return buscarLugar(txt).then(function (l) {
      if (!l.length) throw new Error('Não encontrei "' + txt + '". Tente cidade e estado, ex.: Santos SP.');
      mostrarSugestoes(campo, l, function (x) { gravar(x); enviarRota(); }, titulo);
      throw SILENCIO;
    });
  }

  // ---------- rotas: TomTom (com trânsito ao vivo) quando há chave; Valhalla (gratuito) como reserva ----------
  // Formato comum: { pts, dist, dur, atraso, passos:[{texto,voz,si}], transito:[{si,ei,cat}], desc }
  function chaveTomTom() { return (CFG.tomtomKey || LS.get('tomtom', '') || '').trim(); }
  function pedirRotas(origem, destino) {
    if (chaveTomTom()) return pedirTomTom(origem, destino).catch(function (e) {
      if (e && e.chave) { toast('Chave do trânsito recusada. Usando rotas sem trânsito.', 5000); return pedirValhalla(origem, destino); }
      if (e && e.semRota) throw e;
      return pedirValhalla(origem, destino);
    });
    return pedirValhalla(origem, destino);
  }
  function rodovias(lista) {
    var out = []; lista.forEach(function (s) { if (/^(BR|[A-Z]{2})-\d/.test(s) && out.indexOf(s) < 0) out.push(s); });
    return out.slice(0, 2).join(' e ');
  }
  function pedirTomTom(o, d) {
    var v = vehViagem(), q = {
      key: chaveTomTom(), traffic: 'true', maxAlternatives: '2', instructionsType: 'text', language: 'pt-BR',
      sectionType: 'traffic', routeType: 'fastest', travelMode: v.leve ? 'car' : 'truck'
    };
    if (!v.leve) {
      q.vehicleHeight = v.altura; q.vehicleWidth = v.largura; q.vehicleLength = v.comprimento;
      q.vehicleWeight = Math.round(v.pbt * 1000); q.vehicleCommercial = 'true';
      if (v.perigoso) q.vehicleLoadType = 'otherHazmatGeneral';
    }
    var url = 'https://api.tomtom.com/routing/1/calculateRoute/' + o.lat + ',' + o.lng + ':' + d.lat + ',' + d.lng + '/json?' +
      Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
    return fetch(url).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 403 || r.status === 401) throw { chave: true };
        if (!r.ok || !j.routes) {
          var msg = (j.error && j.error.description) || '';
          if (/no route|NO_ROUTE_FOUND|unreachable/i.test(msg)) { var e = new Error('Não há rota possível para este veículo entre esses pontos.'); e.semRota = true; throw e; }
          throw new Error('tomtom ' + r.status);
        }
        return j.routes.map(function (rt) {
          var pts = []; rt.legs.forEach(function (lg) { lg.points.forEach(function (p) { pts.push({ lat: p.latitude, lng: p.longitude }); }); });
          var ins = (rt.guidance && rt.guidance.instructions) || [], nomes = [];
          ins.forEach(function (i) { (i.roadNumbers || []).forEach(function (n) { nomes.push(n); }); });
          return {
            pts: pts, dist: rt.summary.lengthInMeters, dur: rt.summary.travelTimeInSeconds, atraso: rt.summary.trafficDelayInSeconds || 0,
            passos: ins.filter(function (i) { return i.message; }).map(function (i) { return { texto: i.message, voz: i.message, si: i.pointIndex || 0 }; }),
            transito: (rt.sections || []).filter(function (x) { return x.sectionType === 'TRAFFIC'; }).map(function (x) {
              return { si: x.startPointIndex, ei: x.endPointIndex, cat: x.simpleCategory || 'JAM', atraso: x.delayInSeconds || 0 };
            }),
            desc: rodovias(nomes), fonte: 'tomtom'
          };
        });
      });
    });
  }
  function pedirValhalla(origem, destino) {
    var v = vehViagem();
    var corpo = {
      locations: [{ lat: origem.lat, lon: origem.lng, type: 'break' }, { lat: destino.lat, lon: destino.lng, type: 'break' }],
      costing: v.leve ? 'auto' : 'truck', alternates: 2, units: 'kilometers', language: 'pt-BR',
      directions_options: { units: 'kilometers', language: 'pt-BR' }
    };
    if (!v.leve) corpo.costing_options = { truck: { height: v.altura, width: v.largura, length: v.comprimento, weight: v.pbt, hazmat: !!v.perigoso } };
    return fetch(CFG.rotas + '?json=' + encodeURIComponent(JSON.stringify(corpo))).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.trip) {
          var msg = String(j.error || '');
          if (r.status === 429) throw new Error('Servidor de rotas ocupado. Aguarde alguns segundos e tente de novo.');
          if (/no path|no suitable edges|cannot find/i.test(msg)) throw new Error('Não há rota possível para este veículo entre esses pontos. Confira as medidas ou escolha outro destino.');
          throw new Error('Não consegui calcular a rota agora' + (msg ? ' (' + msg + ')' : '') + '.');
        }
        return [j.trip].concat((j.alternates || []).map(function (a) { return a.trip; }).filter(Boolean)).map(function (t) {
          var leg = t.legs[0], nomes = [];
          (leg.maneuvers || []).forEach(function (m) { (m.street_names || []).forEach(function (n) { nomes.push(n); }); });
          return {
            pts: E.decodePolyline(leg.shape, 6), dist: (t.summary.length || 0) * 1000, dur: t.summary.time || 0, atraso: 0,
            passos: (leg.maneuvers || []).map(function (m) { return { texto: m.instruction || '', voz: m.verbal_pre_transition_instruction || m.instruction || '', si: m.begin_shape_index }; }),
            transito: [], desc: rodovias(nomes), fonte: 'valhalla'
          };
        });
      });
    });
  }

  function montarRota(nr, i) {
    var idx = E.buildRouteIndex(nr.pts), ult = idx.cum.length - 1;
    var em = function (si) { return idx.cum[Math.max(0, Math.min(si || 0, ult))]; };
    var pedagios = 0;
    return {
      n: i, pontos: nr.pts, idx: idx, dist: nr.dist || idx.total, dur: nr.dur, atraso: nr.atraso, desc: nr.desc, fonte: nr.fonte,
      passos: nr.passos.map(function (p) { return { texto: p.texto, voz: p.voz, inicio: em(p.si) }; }),
      transito: nr.transito.map(function (t) { return { si: t.si, ei: t.ei, cat: t.cat }; }),
      osm: {}, achados: [], pois: [], limites: [], pedagios: pedagios, estado: 'pendente', prog: 0
    };
  }

  $('#mostrar-origem').addEventListener('click', function () {
    var l = $('#linha-origem'); l.classList.toggle('oculto');
    this.textContent = l.classList.contains('oculto') ? 'Sair de outro lugar' : 'Sair daqui';
    if (l.classList.contains('oculto')) $('#origem').value = '';
    posFlutuantes();
  });
  ligarAutocompletar($('#destino'), function (x) { S.destino = x; if (x) $('#tracar').focus(); });
  ligarAutocompletar($('#origem'), function (x) { S.origemEscolhida = x; });
  $('#altura-hoje').addEventListener('change', function () { chipsVeiculo('#chips-veiculo'); });

  $('#form-rota').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!S.mapa) { toast('O mapa ainda está carregando.'); return; }
    if (!S.veh.comp) { abrirVeiculo(); toast('Cadastre seu veículo antes da primeira rota.'); return; }
    var dTxt = $('#destino').value.trim(), oTxt = $('#origem').value.trim();
    if (!dTxt && !S.destino) { toast('Digite o destino ou toque no mapa.'); $('#destino').focus(); return; }
    if (!oTxt && !S.pos) { toast('Sem GPS ainda. Toque em "Sair de outro lugar" e preencha a saída.', 5000); return; }
    if (carrAtual().carga && !num($('#altura-hoje').value)) toast('Dica: informe a altura com a carga de hoje para uma rota mais segura.', 4000);
    var botao = $('#tracar'); botao.disabled = true; botao.textContent = 'Buscando…';
    var passo;
    if (oTxt && !S.origemEscolhida) passo = pedirConfirmacao($('#origem'), oTxt, 'Confirme a saída:', function (x) { S.origemEscolhida = x; });
    else if (!S.destino) passo = pedirConfirmacao($('#destino'), dTxt, 'Confirme o destino:', function (x) { S.destino = x; });
    else {
      document.activeElement.blur(); botao.textContent = 'Calculando…';
      passo = tracar(oTxt ? S.origemEscolhida : S.pos, S.destino);
    }
    passo.catch(function (err) { if (err !== SILENCIO) toast(err.message, 7000); })
      .then(function () { botao.disabled = false; botao.textContent = 'Traçar rota'; });
  });

  function tracar(origem, destino) {
    var token = ++S.tokenRota;
    S.origem = origem;
    return pedirRotas(origem, destino).then(function (lista) {
      if (token !== S.tokenRota) return;
      S.rotas = lista.map(montarRota); S.sel = 0;
      desenharRotas(); enquadrar(); painel('rota'); atualizarPainelRota();
      verificarTodas(token);
    });
  }

  function marcarDestino(p) {
    if (!S.marcaDestino) {
      var d = document.createElement('div');
      d.innerHTML = '<svg width="34" height="44" viewBox="0 0 34 44" aria-hidden="true"><path d="M17 2C9 2 3 8 3 16c0 10 14 26 14 26s14-16 14-26C31 8 25 2 17 2z" fill="#6BCB77" stroke="#10301A" stroke-width="2.5"/><circle cx="17" cy="16" r="5" fill="#10301A"/></svg>';
      S.marcaDestino = new ML.Marker({ element: d, anchor: 'bottom' });
    }
    S.marcaDestino.setLngLat(ll(p)).addTo(S.mapa);
  }

  function desenharRotas() {
    setDados('rotas', fc(S.rotas.map(function (r, i) {
      return { type: 'Feature', properties: { n: i, sel: i === S.sel }, geometry: { type: 'LineString', coordinates: r.pontos.map(ll) } };
    })));
    var r = S.rotas[S.sel]; if (r) marcarDestino(r.pontos[r.pontos.length - 1]);
    desenharAchados();
  }

  function enquadrar() {
    var b = new ML.LngLatBounds();
    S.rotas.forEach(function (r) { r.pontos.forEach(function (p, i) { if (i % 10 === 0) b.extend(ll(p)); }); b.extend(ll(r.pontos[r.pontos.length - 1])); });
    S.mapa.fitBounds(b, { padding: { top: 170, bottom: Math.min(380, window.innerHeight * 0.45), left: 40, right: 40 }, bearing: 0, pitch: 0, duration: 800 });
  }

  function escolher(i) {
    if (S.nav || !S.rotas[i]) return;
    S.sel = i; desenharRotas(); atualizarPainelRota();
    verificarRota(S.rotas[i], S.tokenRota);
  }

  // ---------- segunda camada: motor próprio de restrições ----------
  function juntarAchados(r) {
    var osm = Object.keys(r.osm).map(function (k) { return r.osm[k]; });
    r.achados = E.findingsFromOverpass({ elements: osm }, r.idx, vehViagem(), CORREDOR)
      .concat(E.findingsFromAntt(S.antt, r.idx), E.findingsFromReports(S.reportes, r.idx))
      .sort(function (a, b) { return a.along - b.along; });
    r.pois = E.poisFromOverpass({ elements: osm }, r.idx);
    r.limites = E.speedLimits({ elements: osm }, r.idx, vehViagem(), CORREDOR);
    r.pedagios = r.pois.filter(function (x) { return x.tipo === 'pedagio'; }).length;
  }
  function contar(r) { var c = { bloqueio: 0, atencao: 0, info: 0 }; r.achados.forEach(function (a) { c[a.nivel]++; }); return c; }

  function consultaOverpass(q, tentativa) {
    tentativa = tentativa || 0;
    return fetch(OVERPASS[tentativa % OVERPASS.length], { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      .then(function (r) { if (!r.ok) throw new Error('overpass ' + r.status); return r.json(); })
      .catch(function (e) {
        if (tentativa >= 3) throw e;
        return new Promise(function (ok) { setTimeout(ok, 2500 * (tentativa + 1)); }).then(function () { return consultaOverpass(q, tentativa + 1); });
      });
  }

  function verificarRota(r, token) {
    if (!r || r.estado === 'ok' || r.estado === 'verificando') return Promise.resolve();
    r.estado = 'verificando'; r.dono = token; juntarAchados(r);
    var pedacos = E.chunkForOverpass(E.simplify(r.pontos, 12), 100), i = 0, falhas = 0;
    function proximo() {
      if (token !== S.tokenRota) { if (r.dono === token) r.estado = 'pendente'; return Promise.resolve(); }
      if (i >= pedacos.length) { r.estado = falhas ? 'parcial' : 'ok'; r.prog = 1; juntarAchados(r); atualizarTudo(r); return Promise.resolve(); }
      return consultaOverpass(E.overpassQuery(pedacos[i], CORREDOR)).then(function (j) {
        (j.elements || []).forEach(function (e) { r.osm[e.type + e.id] = e; });
      }).catch(function () { falhas++; }).then(function () {
        i++; r.prog = i / pedacos.length;
        if (i % 3 === 0 || i === pedacos.length) { juntarAchados(r); atualizarTudo(r); } else atualizarPainelRota();
        return proximo();
      });
    }
    atualizarTudo(r);
    return proximo();
  }
  function atualizarTudo(r) { if (r.n === S.sel) desenharAchados(); atualizarPainelRota(); }

  function verificarTodas(token) {
    var r0 = S.rotas[0];
    verificarRota(r0, token).then(function () {
      if (token !== S.tokenRota || S.nav || contar(r0).bloqueio === 0 || S.rotas.length < 2) return;
      var seq = Promise.resolve();
      S.rotas.slice(1).forEach(function (r) { seq = seq.then(function () { return verificarRota(r, token); }); });
      return seq.then(function () {
        if (token !== S.tokenRota || S.nav) return;
        var livre = S.rotas.filter(function (r) { return r.estado === 'ok' && contar(r).bloqueio === 0; })[0];
        if (livre && S.sel === 0) { escolher(livre.n); toast('A primeira rota tinha restrição para o seu veículo. Selecionei uma alternativa livre.', 6000); }
      });
    });
  }

  function desenharAchados() {
    var r = S.rotas[S.sel];
    setDados('pois', fc(!r ? [] : r.pois.map(function (x) { return { type: 'Feature', properties: { tipo: x.tipo, nome: x.nome, lim: x.lim || '' }, geometry: { type: 'Point', coordinates: [x.lng, x.lat] } }; })));
    setDados('transito', fc(!r ? [] : r.transito.map(function (t) {
      return { type: 'Feature', properties: { cat: t.cat }, geometry: { type: 'LineString', coordinates: r.pontos.slice(t.si, t.ei + 1).map(ll) } };
    })));
    setDados('achados', fc(!r ? [] : r.achados.map(function (a) {
      return { type: 'Feature', properties: { nivel: a.nivel, titulo: a.titulo, texto: a.textos.join(' ') }, geometry: { type: 'Point', coordinates: [a.lng, a.lat] } };
    })));
  }

  function seloRota(r) {
    var c = contar(r);
    if (r.estado === 'pendente') return ['selo selo-verif', 'Toque para conferir'];
    if (r.estado === 'verificando' && !c.bloqueio) return ['selo selo-verif', 'Conferindo ' + Math.round(r.prog * 100) + '%'];
    if (c.bloqueio) return ['selo selo-bloqueio', c.bloqueio + (c.bloqueio > 1 ? ' bloqueios' : ' bloqueio')];
    if (c.atencao) return ['selo selo-atencao', c.atencao + ' atenção'];
    return ['selo selo-ok', 'Sem restrição'];
  }

  function atualizarPainelRota() {
    var r = S.rotas[S.sel]; if (!r) return;
    $('#r-tempo').textContent = fmtDur(r.dur);
    $('#r-dist').textContent = fmtDist(r.dist) + (r.desc ? ' · via ' + r.desc : '') + ' · chegada ' + fmtHora(new Date(Date.now() + r.dur * 1000)) +
      (r.fonte === 'tomtom' ? (r.atraso > 60 ? ' · trânsito +' + fmtDur(r.atraso) : ' · trânsito livre') : '');
    var c = contar(r), st = $('#r-status');
    var vv = vehViagem(), perfil = nomeConjunto(vv) + ' de ' + E.fmtNum(vv.altura) + ' m e ' + E.fmtNum(vv.pbt) + ' t';
    if (r.estado === 'verificando') st.textContent = 'Rota calculada para ' + perfil + '. Conferindo de novo trecho a trecho… ' + Math.round(r.prog * 100) + '%';
    else if (r.estado === 'parcial') st.textContent = 'Rota calculada para ' + perfil + '. Parte da conferência extra não respondeu; toque em Traçar rota para completar.';
    else if (c.bloqueio) st.textContent = 'Atenção: a conferência extra achou ' + c.bloqueio + ' ponto(s) incompatível(is). Veja os alertas.';
    else if (r.estado === 'ok') st.textContent = 'Rota calculada e conferida para ' + perfil + '.' + (c.atencao ? ' ' + c.atencao + ' ponto(s) de atenção.' : '');
    else st.textContent = 'Rota calculada para ' + perfil + '.';
    $('#r-prog').classList.toggle('oculto', r.estado !== 'verificando');
    $('#r-prog i').style.width = Math.round(r.prog * 100) + '%';
    var lista = $('#lista-rotas'); lista.textContent = '';
    if (S.rotas.length > 1) S.rotas.forEach(function (x, i) {
      var s = seloRota(x);
      lista.appendChild(el('button', { class: 'rota-op', 'aria-pressed': String(i === S.sel), onclick: function () { escolher(i); } }, [
        el('span', {}, [el('div', { class: 't', text: fmtDur(x.dur) + ' · ' + fmtDist(x.dist) }),
          el('div', { class: 's', text: (x.desc ? 'via ' + x.desc : 'Rota ' + (i + 1)) + (x.pedagios ? ' · ' + x.pedagios + ' pedágio(s)' : '') }),
          x.atraso > 120 ? el('div', { class: 'trafego', text: '+' + fmtDur(x.atraso) + ' de trânsito' }) : null]),
        el('span', { class: s[0], text: s[1] })
      ]));
    });
    posFlutuantes();
  }

  $('#btn-limpar').addEventListener('click', limparRota);
  function limparRota() {
    S.tokenRota++; S.rotas = []; S.destino = null; $('#destino').value = '';
    setDados('rotas', fc([])); setDados('achados', fc([]));
    if (S.marcaDestino) S.marcaDestino.remove();
    S.mapa.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    painel('inicio');
  }

  // ---------- alertas ----------
  function abrirAlertas() {
    var r = S.rotas[S.sel]; if (!r) return;
    var c = contar(r), lista = $('#lista-alertas'), base = S.nav ? S.nav.along : 0;
    $('#al-resumo').textContent = c.bloqueio + ' bloqueio(s), ' + c.atencao + ' de atenção e ' + c.info + ' pontes/viadutos da ANTT nesta rota.' + (r.estado === 'verificando' ? ' Ainda conferindo…' : '');
    lista.textContent = '';
    var itens = r.achados.filter(function (a) { return a.along >= base - 50; });
    if (!itens.length) lista.appendChild(el('p', { class: 'dica', text: 'Nenhum alerta à frente.' }));
    itens.slice(0, 200).forEach(function (a) {
      lista.appendChild(el('button', { class: 'alerta-item', onclick: function () { fechar('#m-alertas'); S.seguir = false; S.mapa.easeTo({ center: [a.lng, a.lat], zoom: 16 }); } }, [
        el('span', { class: 'km num', style: 'color:' + COR[a.nivel], text: fmtDist(a.along - base) }),
        el('span', {}, [el('div', { class: 't', text: a.titulo }), el('div', { class: 'd', text: a.textos.join(' ') + ' · Fonte: ' + a.fonte })])
      ]));
    });
    abrir('#m-alertas');
  }
  $('#btn-alertas').addEventListener('click', abrirAlertas);
  $('#btn-alertas2').addEventListener('click', abrirAlertas);

  // ---------- navegação ----------
  $('#btn-iniciar').addEventListener('click', function () {
    if (!S.pos) { toast('Sem GPS ainda. Use "Simular viagem" para testar sem sair do lugar.', 5000); return; }
    iniciarNav(false);
  });
  $('#btn-simular').addEventListener('click', function () { iniciarNav(true); });
  $('#btn-encerrar').addEventListener('click', function () { encerrarNav('Navegação encerrada.'); });

  function iniciarNav(sim) {
    var r = S.rotas[S.sel]; if (!r) return;
    S.tokenRota++;
    if (r.estado !== 'ok') { r.estado = 'pendente'; verificarRota(r, S.tokenRota); }
    S.rotas = [r]; S.sel = 0; r.n = 0; desenharRotas();
    S.nav = { r: r, sim: sim, hint: 0, along: 0, falou: {}, fora: 0, ultRecalc: Date.now(), ultCheque: Date.now() };
    S.seguir = true;
    painel('nav'); chipsVeiculo('#chips-nav');
    pedirTelaLigada();
    var c = contar(r);
    falar(sim ? 'Simulação iniciada.' : (c.bloqueio ? 'Atenção, a conferência achou ' + c.bloqueio + ' ponto incompatível nesta rota.' : 'Rota calculada para o seu veículo. Boa viagem.'));
    if (sim) simular(r); else aoPosicionar(S.pos);
  }

  function simular(r) {
    var passo = 22 * 8; // 80 km/h acelerado 8 vezes
    S.nav.simAlong = 0;
    S.nav.timer = setInterval(function () {
      if (!S.nav) return;
      S.nav.simAlong = Math.min(r.idx.total, S.nav.simAlong + passo);
      var p = E.pointAt(r.idx, S.nav.simAlong), q = E.pointAt(r.idx, Math.min(r.idx.total, S.nav.simAlong + 40));
      aoPosicionar({ lat: p.lat, lng: p.lng, heading: E.bearing(p, q), speed: 22 });
    }, 1000);
  }

  function falaDist(d) { return d < 1000 ? Math.max(50, Math.round(d / 50) * 50) + ' metros' : (d / 1000).toFixed(1).replace('.', ',') + ' quilômetros'; }

  function minusc(t) { return t ? t.charAt(0).toLowerCase() + t.slice(1) : ''; }
  var POI_FALA = { radar: 'Radar', policia: 'Posto da Polícia Rodoviária', balanca: 'Balança', pedagio: 'Pedágio' };

  function passoNavegacao(p) {
    var n = S.nav, r = n.r, near = E.nearestOnRoute(r.idx, p, n.hint);
    if (!near || near.d > 80) {
      n.fora++;
      if (!n.sim && n.fora >= 3 && Date.now() - n.ultRecalc > 30000) recalcular(p);
      return;
    }
    n.fora = 0; n.hint = near.seg; n.along = Math.max(n.along - 30, near.along);
    seguirCamera(p);
    var rest = Math.max(0, r.idx.total - n.along), frac = rest / r.idx.total;
    $('#n-eta').textContent = fmtHora(new Date(Date.now() + r.dur * frac * 1000));
    var posto = null;
    for (var q = 0; q < r.pois.length; q++) if (r.pois[q].tipo === 'posto' && r.pois[q].along > n.along) { posto = r.pois[q]; break; }
    $('#n-rest').textContent = 'chegada · faltam ' + fmtDist(rest) + ' · ' + fmtDur(r.dur * frac) +
      (posto ? ' · posto em ' + fmtDist(posto.along - n.along) + (posto.nome ? ' (' + posto.nome + ')' : '') : '');
    if (rest < 40) { falar('Você chegou ao destino.'); encerrarNav('Você chegou ao destino.'); return; }

    // manobras: avisos a ~1 km, ~300 m e "agora", como no Waze
    var prox = null, ip = -1;
    for (var i = 0; i < r.passos.length; i++) if (r.passos[i].inicio > n.along + 5) { prox = r.passos[i]; ip = i; break; }
    if (prox) {
      var dm = prox.inicio - n.along;
      $('#manobra-dist').textContent = fmtDist(dm);
      $('#manobra-txt').textContent = prox.texto;
      var faixaM = dm <= 60 ? 'agora' : dm <= 350 ? '300' : dm <= 1100 && prox.inicio - (i > 0 ? r.passos[i - 1].inicio : 0) > 1300 ? '1000' : null;
      if (faixaM && !n.falou['m' + ip + faixaM]) {
        n.falou['m' + ip + faixaM] = 1;
        falar(faixaM === 'agora' ? 'Agora, ' + minusc(prox.voz) : 'Em ' + (faixaM === '1000' ? '1 quilômetro' : falaDist(dm)) + ', ' + minusc(prox.voz));
      }
    } else { $('#manobra-dist').textContent = fmtDist(rest); $('#manobra-txt').textContent = 'Siga até o destino'; }

    // limite de velocidade da via
    var lim = E.limitAt(r.limites, n.along), kmh = p.speed != null ? p.speed * 3.6 : 0;
    $('#placa-vel').classList.toggle('oculto', !lim);
    if (lim) $('#lim-vel').textContent = lim;
    var acima = lim && kmh > lim + 5;
    $('#velocimetro').classList.toggle('acima', !!acima);
    if (acima && n.limFalado !== lim + ':' + Math.round(n.along / 2000)) { n.limFalado = lim + ':' + Math.round(n.along / 2000); falar('Atenção, velocidade máxima ' + lim + '.'); }

    // alertas: restrições primeiro; depois radar, balança, polícia e pedágio
    var al = null;
    for (var k = 0; k < r.achados.length; k++) { var a = r.achados[k]; if (a.nivel !== 'info' && a.along > n.along - 20) { al = a; break; } }
    var aviso = $('#aviso');
    if (al && al.along - n.along < 2500) {
      var dist = Math.max(0, al.along - n.along);
      aviso.className = al.nivel;
      $('#aviso-titulo').textContent = al.titulo + ' em ' + fmtDist(dist);
      $('#aviso-txt').textContent = al.textos.join(' ');
      var faixa = dist < 600 ? 'perto' : 'longe';
      if (!n.falou[al.id + faixa]) { n.falou[al.id + faixa] = 1; falar((al.nivel === 'bloqueio' ? 'Cuidado. ' : 'Atenção. ') + 'Em ' + falaDist(dist) + ', ' + al.titulo + '. ' + al.textos[0]); }
    } else {
      var pi = null;
      for (var z = 0; z < r.pois.length; z++) { var x = r.pois[z]; if (x.tipo !== 'posto' && x.along > n.along - 20) { pi = x; break; } }
      if (pi && pi.along - n.along < 1200) {
        var dp = Math.max(0, pi.along - n.along), limR = pi.lim || (pi.tipo === 'radar' ? E.limitAt(r.limites, pi.along) : null);
        aviso.className = 'info';
        $('#aviso-titulo').textContent = NOME_POI[pi.tipo] + ' em ' + fmtDist(dp);
        $('#aviso-txt').textContent = (limR ? 'Limite ' + limR + ' km/h. ' : '') + (pi.nome || '');
        var chave = 'p' + pi.tipo + Math.round(pi.along);
        if (dp < 900 && !n.falou[chave]) { n.falou[chave] = 1; falar(POI_FALA[pi.tipo] + ' em ' + falaDist(dp) + (limR ? '. Limite ' + limR + '.' : '.')); }
      } else aviso.className = 'oculto';
    }
    if (!n.sim && Date.now() - n.ultCheque > 180000) { n.ultCheque = Date.now(); procurarRotaMelhor(p); }
    posFlutuantes();
  }

  // Ao recalcular, sempre pega a rota mais rápida entre as opções novas
  function recalcular(p) {
    var n = S.nav; n.ultRecalc = Date.now();
    toast('Saiu da rota. Recalculando…'); falar('Recalculando.');
    var token = ++S.tokenRota;
    pedirRotas(p, S.destino).then(function (lista) {
      if (!S.nav || token !== S.tokenRota) return;
      lista.sort(function (a, b) { return a.dur - b.dur; });
      trocarRota(montarRota(lista[0], 0), token);
    }).catch(function (e) { toast(e.message, 6000); });
  }
  function trocarRota(r, token) {
    var n = S.nav;
    S.rotas = [r]; S.sel = 0; n.r = r; n.hint = 0; n.along = 0; n.falou = {};
    desenharRotas(); verificarRota(r, token || S.tokenRota);
  }

  // A cada 3 min compara a rota atual com as alternativas e oferece a mais rápida (como o Waze)
  function sobreposicao(a, r, aPartir) {
    var amostra = 12, dentro = 0;
    for (var i = 1; i <= amostra; i++) {
      var pt = a.pts[Math.floor(i * (a.pts.length - 1) / (amostra + 1))], m = E.nearestOnRoute(r.idx, pt);
      if (m && m.d < 60 && m.along >= aPartir - 100) dentro++;
    }
    return dentro / amostra;
  }
  function procurarRotaMelhor(p) {
    var n = S.nav, r = n.r;
    pedirRotas(p, S.destino).then(function (lista) {
      if (!S.nav || S.nav.r !== r) return;
      var atual = null, melhor = null;
      lista.forEach(function (x) { if (sobreposicao(x, r, n.along) > 0.8) { if (!atual || x.dur < atual.dur) atual = x; } else if (!melhor || x.dur < melhor.dur) melhor = x; });
      var tempoAtual = atual ? atual.dur : r.dur * ((r.idx.total - n.along) / r.idx.total);
      if (melhor && melhor.dur < tempoAtual - 180 && melhor.dur < tempoAtual * 0.95) oferecerRota(melhor, Math.round((tempoAtual - melhor.dur) / 60));
    }).catch(function () { /* tenta de novo no próximo ciclo */ });
  }
  function oferecerRota(nr, min) {
    S.oferta = nr;
    $('#oferta-titulo').textContent = 'Caminho ' + min + ' min mais rápido';
    $('#oferta-txt').textContent = (nr.desc ? 'Via ' + nr.desc + '. ' : '') + 'Rota calculada para o seu veículo.';
    $('#oferta').classList.remove('oculto');
    falar('Encontrei um caminho ' + min + ' minutos mais rápido. Toque em aceitar para trocar.');
    clearTimeout(S.ofertaT); S.ofertaT = setTimeout(function () { $('#oferta').classList.add('oculto'); S.oferta = null; }, 25000);
  }
  $('#oferta-aceitar').addEventListener('click', function () {
    $('#oferta').classList.add('oculto');
    if (S.oferta && S.nav) { var t = ++S.tokenRota; trocarRota(montarRota(S.oferta, 0), t); falar('Rota atualizada.'); }
    S.oferta = null;
  });
  $('#oferta-manter').addEventListener('click', function () { $('#oferta').classList.add('oculto'); S.oferta = null; });

  function encerrarNav(msg) {
    if (!S.nav) return;
    clearInterval(S.nav.timer); S.nav = null; soltarTela();
    $('#placa-vel').classList.add('oculto'); $('#oferta').classList.add('oculto'); $('#velocimetro').classList.remove('acima');
    toast(msg); limparRota();
  }

  function pedirTelaLigada() { if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(function (w) { S.wake = w; }).catch(function () { /* sem suporte */ }); }
  function soltarTela() { if (S.wake) { S.wake.release(); S.wake = null; } }
  document.addEventListener('visibilitychange', function () { if (S.nav && document.visibilityState === 'visible') pedirTelaLigada(); });

  // ---------- voz ----------
  function iconeVoz() {
    $('#btn-voz').setAttribute('aria-label', S.voz ? 'Voz ligada' : 'Voz desligada');
    $('#ico-voz').innerHTML = S.voz ? '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/>' : '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>';
  }
  $('#btn-voz').addEventListener('click', function () { S.voz = !S.voz; LS.set('voz', S.voz); iconeVoz(); toast(S.voz ? 'Voz ligada' : 'Voz desligada', 1500); if (S.voz) falar('Voz ligada.'); });

  // ---------- veículo: cadastro em 3 etapas (conjunto → carroceria → medidas), salvo no aparelho ----------
  var wiz = { passo: 1, comp: null, carr: null };
  function abrirVeiculo() {
    wiz.comp = S.veh.comp; wiz.carr = S.veh.carr;
    irPasso(S.veh.comp ? 3 : 1);
    abrir('#m-veiculo');
  }
  function opcoes(alvo, lista, escolhido, aoClicar) {
    var box = $(alvo); box.textContent = '';
    lista.forEach(function (o) {
      box.appendChild(el('button', { type: 'button', class: 'opcao', 'aria-pressed': String(o.id === escolhido), onclick: function () { aoClicar(o); } },
        [el('span', { class: 't', text: o.nome }), el('span', { class: 's', text: o.sub })]));
    });
  }
  function carrPermitida(c, id) {
    if (!id) return false;
    if (c.carrs) return c.carrs.indexOf(id) >= 0;
    if (c.semCarrs) return c.semCarrs.indexOf(id) < 0;
    return true;
  }
  function sugestaoMedidas() {
    var c = achar(COMPOSICOES, wiz.comp), k = achar(CARROCERIAS, wiz.carr);
    var mesmo = S.veh.comp === wiz.comp && S.veh.carr === wiz.carr;
    if (mesmo) return S.veh;
    var alt = c.alt || (k ? k.alt : 4.4);
    if (c.id === 'vuc') alt = Math.min(alt, 3.3);
    return { altura: alt, largura: c.larg, comprimento: c.comp, pbt: c.pbt, perigoso: S.veh.perigoso };
  }
  function irPasso(n) {
    wiz.passo = n;
    [1, 2, 3].forEach(function (i) { $('#vp-' + i).classList.toggle('oculto', i !== n); $('#vp-ind-' + i).classList.toggle('on', i <= n); });
    var cc = achar(COMPOSICOES, wiz.comp) || {};
    if (n === 1) opcoes('#op-comp', COMPOSICOES, wiz.comp, function (o) {
      wiz.comp = o.id;
      if (o.semCarr) { wiz.carr = null; irPasso(3); } else { if (!carrPermitida(o, wiz.carr)) wiz.carr = null; irPasso(2); }
    });
    if (n === 2) opcoes('#op-carr', CARROCERIAS.filter(function (k) { return carrPermitida(cc, k.id); }), wiz.carr, function (o) { wiz.carr = o.id; irPasso(3); });
    if (n === 3) {
      var m = sugestaoMedidas(), k = achar(CARROCERIAS, wiz.carr);
      $('#v-resumo').textContent = nomeConjunto({ comp: wiz.comp, carr: wiz.carr }) + (k && k.carga ? '. Como a carga define a altura, o app vai pedir a altura do dia antes de cada rota.' : '.');
      $('#v-altura').value = E.fmtNum(m.altura); $('#v-largura').value = E.fmtNum(m.largura);
      $('#v-comprimento').value = E.fmtNum(m.comprimento); $('#v-pbt').value = E.fmtNum(m.pbt); $('#v-perigoso').checked = !!m.perigoso;
      var a = S.anttInfo;
      $('#info-bases').textContent = a && a.total ? 'Base ANTT: ' + a.total.toLocaleString('pt-BR') + ' pontes e viadutos das rodovias concedidas' + (a.atualizado ? ', atualizada em ' + new Date(a.atualizado).toLocaleDateString('pt-BR') : '') + '.' : '';
    }
    $('#v-voltar').textContent = n === 1 ? (S.veh.comp ? 'Cancelar' : 'Depois') : 'Voltar';
    $('#v-avancar').textContent = n === 3 ? 'Salvar veículo' : 'Continuar';
    $('#v-avancar').disabled = (n === 1 && !wiz.comp) || (n === 2 && !wiz.carr);
  }
  $('#v-voltar').addEventListener('click', function () {
    if (wiz.passo === 1) fechar('#m-veiculo');
    else if (wiz.passo === 3 && (achar(COMPOSICOES, wiz.comp) || {}).semCarr) irPasso(1);
    else irPasso(wiz.passo - 1);
  });
  $('#v-avancar').addEventListener('click', function () {
    if (wiz.passo === 1 && (achar(COMPOSICOES, wiz.comp) || {}).semCarr) irPasso(3);
    else if (wiz.passo < 3) irPasso(wiz.passo + 1); else salvarVeiculo();
  });
  $('#form-veiculo').addEventListener('submit', function (e) { e.preventDefault(); if (wiz.passo === 3) salvarVeiculo(); });
  function salvarVeiculo() {
    var v = { comp: wiz.comp, carr: wiz.carr, leve: !!(achar(COMPOSICOES, wiz.comp) || {}).leve, altura: num($('#v-altura').value), largura: num($('#v-largura').value), comprimento: num($('#v-comprimento').value), pbt: num($('#v-pbt').value), perigoso: $('#v-perigoso').checked };
    if (!v.altura || v.altura < 1.5 || v.altura > 6 || !v.largura || v.largura > 4 || !v.comprimento || v.comprimento > 40 || !v.pbt || v.pbt > 200) {
      toast('Confira os números: altura em metros (ex.: 4,40) e peso em toneladas (ex.: 57).', 5000); return;
    }
    S.veh = v; LS.set('veiculo', v); fechar('#m-veiculo');
    atualizarLinhaAltura(); chipsVeiculo('#chips-veiculo');
    if (S.rotas.length && S.origem && S.destino && !S.nav) {
      toast('Veículo salvo. Recalculando a rota para as novas medidas…');
      tracar(S.origem, S.destino).catch(function (err) { toast(err.message, 7000); });
    } else toast('Veículo salvo. Ele fica guardado para as próximas rotas.', 4000);
  }
  $('#btn-veiculo').addEventListener('click', abrirVeiculo);
  $('#chips-veiculo').addEventListener('click', abrirVeiculo);

  // ---------- reportes ----------
  var TIPOS_REP = [
    ['altura', 'Altura baixa', 'M3 6h18M3 18h18M12 9v6M9 12l3-3 3 3'],
    ['peso', 'Limite de peso', 'M6 20h12l-2-12H8zM9 8a3 3 0 0 1 6 0'],
    ['horario', 'Restrição de horário', 'M12 3a9 9 0 1 0 .01 0M12 7v5l3 2'],
    ['balanca', 'Balança aberta', 'M12 3v18M5 7h14M5 7l-3 7h6zM19 7l-3 7h6z'],
    ['obra', 'Obra ou interdição', 'M3 20h18M6 20l3-12h6l3 12M8 13h8'],
    ['proibida', 'Via proibida', 'M12 3a9 9 0 1 0 .01 0M5.6 5.6l12.8 12.8']
  ];
  var repEscolhido = null;
  TIPOS_REP.forEach(function (t) {
    var b = el('button', { class: 'tipo', 'aria-pressed': 'false', onclick: function () {
      repEscolhido = t[0];
      document.querySelectorAll('.tipo').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      $('#enviar-reporte').disabled = false;
    } });
    b.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + t[2] + '"/></svg>';
    b.appendChild(el('span', { text: t[1] }));
    $('#tipos-reporte').appendChild(b);
  });
  function abrirReporte() {
    repEscolhido = null; $('#enviar-reporte').disabled = true;
    document.querySelectorAll('.tipo').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
    $('#rep-local').textContent = S.pos ? 'No ponto onde você está agora.' : 'Sem GPS: o reporte vai para o centro do mapa.';
    abrir('#m-reportar');
  }
  $('#btn-reportar').addEventListener('click', abrirReporte);
  $('#btn-reportar2').addEventListener('click', abrirReporte);
  $('#enviar-reporte').addEventListener('click', function () {
    if (!repEscolhido || !S.mapa) return;
    var c = S.pos || { lat: S.mapa.getCenter().lat, lng: S.mapa.getCenter().lng };
    S.reportes.push({ id: Date.now(), tipo: repEscolhido, lat: c.lat, lng: c.lng, ts: Date.now() });
    LS.set('reportes', S.reportes); fechar('#m-reportar');
    desenharReportes();
    S.rotas.forEach(juntarAchados); desenharAchados();
    toast('Reporte salvo. Obrigado!'); falar('Reporte salvo.');
  });
  function desenharReportes() {
    setDados('reportes', fc(S.reportes.map(function (rp) { return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [rp.lng, rp.lat] } }; })));
  }

  // ---------- trânsito ao vivo (chave gratuita da TomTom, salva só neste aparelho) ----------
  function rotuloTransito() { $('#btn-transito').textContent = chaveTomTom() ? 'Trânsito: ligado' : 'Trânsito ao vivo'; }
  $('#btn-transito').addEventListener('click', function () {
    var atual = LS.get('tomtom', '');
    var k = window.prompt('Cole a chave gratuita da TomTom para ver o trânsito ao vivo.\nDeixe em branco para desligar.', atual || '');
    if (k === null) return;
    LS.set('tomtom', k.trim()); rotuloTransito();
    toast(k.trim() ? 'Trânsito ao vivo ligado. As próximas rotas já consideram o trânsito.' : 'Trânsito ao vivo desligado.', 4000);
  });
  rotuloTransito();

  // ---------- instalar como app ----------
  var promptInstalar = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); promptInstalar = e; $('#btn-instalar').hidden = false; });
  $('#btn-instalar').addEventListener('click', function () { if (promptInstalar) { promptInstalar.prompt(); promptInstalar = null; this.hidden = true; } });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () { /* opcional */ });

  window.addEventListener('resize', posFlutuantes);
  iconeVoz();
  carregarAntt();
  atualizarLinhaAltura();
  chipsVeiculo('#chips-veiculo');
  painel('inicio');
  criarMapa();
  // Abertura: motorista ou empresa (a escolha de motorista fica lembrada)
  function entrarMotorista() { LS.set('perfil', 'motorista'); fechar('#portas'); if (!S.veh.comp) setTimeout(abrirVeiculo, 300); }
  $('#porta-motorista').addEventListener('click', entrarMotorista);
  $('#porta-empresa').addEventListener('click', function () { location.href = 'painel.html'; });
  if (LS.get('perfil', '') === 'motorista') { if (!S.veh.comp) setTimeout(abrirVeiculo, 400); } else abrir('#portas');
})();
