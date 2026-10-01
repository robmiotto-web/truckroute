/* TruckRoute v2 — custo zero: mapa OpenFreeMap (MapLibre), rotas Valhalla com perfil de caminhão,
 * busca Nominatim, e o motor próprio de restrições (engine.js) como segunda camada de segurança. */
(function () {
  'use strict';
  var E = window.TREngine, ML = window.maplibregl;
  var CFG = Object.assign({
    estiloMapa: 'https://tiles.openfreemap.org/styles/dark',
    rotas: 'https://valhalla1.openstreetmap.de/route',
    busca: 'https://nominatim.openstreetmap.org/search'
  }, window.TRUCKROUTE_CONFIG || {});
  var $ = function (s) { return document.querySelector(s); };
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('tr:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('tr:' + k, JSON.stringify(v)); } catch (e) { /* sem espaço */ } }
  };
  var OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  var CORREDOR = 20;
  var VEH_PADRAO = { tipo: 'bitrem', altura: 4.4, largura: 2.6, comprimento: 19.8, pbt: 57, perigoso: false };
  var NOMES_TIPO = { truck: 'Truck', carreta: 'Carreta', bitrem: 'Bitrem', rodotrem: 'Rodotrem', vuc: 'VUC / toco' };
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
  function posFlutuantes() { $('#flutuantes').style.bottom = ($('#painel').offsetHeight + 14) + 'px'; }
  function abrir(id) { $(id).classList.remove('oculto'); }
  function fechar(id) { $(id).classList.add('oculto'); }
  document.addEventListener('click', function (e) {
    var f = e.target.closest('[data-fechar]'); if (f) fechar('#' + f.closest('.modal').id);
    if (e.target.classList.contains('modal')) fechar('#' + e.target.id);
  });
  function chipsVeiculo(alvo) {
    var v = S.veh, c = $(alvo); c.textContent = '';
    [NOMES_TIPO[v.tipo] || v.tipo, E.fmtNum(v.altura) + ' m altura', E.fmtNum(v.pbt) + ' t', E.fmtNum(v.comprimento) + ' m', v.perigoso ? 'Produto perigoso' : null]
      .forEach(function (t) { if (t) c.appendChild(el('span', { class: 'chip', text: t })); });
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
      aoPosicionar({ lat: g.coords.latitude, lng: g.coords.longitude, heading: g.coords.heading, speed: g.coords.speed });
      if (primeira && !S.rotas.length) S.mapa.jumpTo({ center: ll(S.pos), zoom: 14 });
    }, function (err) {
      if (err.code === 1) toast('Localização bloqueada. Libere nas configurações do navegador ou preencha a saída.', 6000);
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }

  function criarMarcaPos() {
    var d = document.createElement('div');
    d.className = 'marca-pos';
    d.innerHTML = '<svg width="40" height="40" viewBox="-20 -20 40 40" aria-hidden="true"><circle r="18" fill="#4C9BFF" fill-opacity="0.22"/><path d="M0 -13 L10 11 L0 5 L-10 11 Z" fill="#fff" stroke="#4C9BFF" stroke-width="3" stroke-linejoin="round"/></svg>';
    return new ML.Marker({ element: d, rotationAlignment: 'map', pitchAlignment: 'map' });
  }

  function aoPosicionar(p) {
    if (S.pos && (p.heading == null || isNaN(p.heading))) {
      p.heading = E.haversine(S.pos, p) > 3 ? E.bearing(S.pos, p) : S.pos.heading;
    }
    S.pos = p; LS.set('ultimaPos', { lat: p.lat, lng: p.lng });
    if (!S.mapa) return;
    if (!S.marcaPos) S.marcaPos = criarMarcaPos().setLngLat(ll(p)).addTo(S.mapa);
    S.marcaPos.setLngLat(ll(p)).setRotation(p.heading || 0);
    if (S.nav) passoNavegacao(p);
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

  // ---------- busca de endereço (Nominatim) ----------
  var COORD = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;]\s*(-?\d+(?:[.,]\d+)?)\s*$/;
  function buscarLugar(txt) {
    var m = txt.match(COORD);
    if (m) return Promise.resolve([{ lat: num(m[1]), lng: num(m[2]), nome: txt.trim(), sub: 'Coordenadas' }]);
    var url = CFG.busca + '?format=jsonv2&countrycodes=br&limit=5&accept-language=pt-BR&q=' + encodeURIComponent(txt);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('A busca de endereços está ocupada. Tente de novo em alguns segundos.');
      return r.json();
    }).then(function (lista) {
      return lista.map(function (x) {
        var partes = String(x.display_name || '').split(',');
        return { lat: +x.lat, lng: +x.lon, nome: (x.name || partes[0]).trim(), sub: partes.slice(1, 4).join(',').trim() };
      });
    });
  }

  function escolherDaLista(lista) {
    return new Promise(function (ok) {
      if (lista.length === 1) { ok(lista[0]); return; }
      var box = $('#resultados'); box.textContent = '';
      lista.forEach(function (x) {
        box.appendChild(el('button', { class: 'res', role: 'option', onclick: function () { box.classList.add('oculto'); ok(x); } },
          [el('div', { class: 't', text: x.nome }), el('div', { class: 's', text: x.sub })]));
      });
      box.classList.remove('oculto');
    });
  }

  // ---------- rotas (Valhalla, perfil caminhão) ----------
  function pedirRotas(origem, destino) {
    var v = S.veh;
    var corpo = {
      locations: [{ lat: origem.lat, lon: origem.lng, type: 'break' }, { lat: destino.lat, lon: destino.lng, type: 'break' }],
      costing: 'truck',
      costing_options: { truck: { height: v.altura, width: v.largura, length: v.comprimento, weight: v.pbt, hazmat: !!v.perigoso } },
      alternates: 2, units: 'kilometers', language: 'pt-BR',
      directions_options: { units: 'kilometers', language: 'pt-BR' }
    };
    // GET evita a checagem prévia de CORS e funciona em qualquer celular
    return fetch(CFG.rotas + '?json=' + encodeURIComponent(JSON.stringify(corpo))).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.trip) {
          var msg = String(j.error || '');
          if (r.status === 429) throw new Error('Servidor de rotas ocupado. Aguarde alguns segundos e tente de novo.');
          if (/no path|no suitable edges|cannot find/i.test(msg)) throw new Error('Não há rota possível para este veículo entre esses pontos. Confira as medidas ou escolha outro destino.');
          throw new Error('Não consegui calcular a rota agora' + (msg ? ' (' + msg + ')' : '') + '.');
        }
        return [j.trip].concat((j.alternates || []).map(function (a) { return a.trip; }).filter(Boolean));
      });
    });
  }

  function montarRota(trip, i) {
    var leg = trip.legs[0], pts = E.decodePolyline(leg.shape, 6), idx = E.buildRouteIndex(pts);
    var passos = (leg.maneuvers || []).map(function (m) {
      return { texto: m.instruction || '', voz: m.verbal_pre_transition_instruction || m.instruction || '', tipo: m.type, inicio: idx.cum[Math.min(m.begin_shape_index, idx.cum.length - 1)] };
    });
    var ruas = [];
    (leg.maneuvers || []).forEach(function (m) { (m.street_names || []).forEach(function (s) { if (/^(BR|[A-Z]{2})-\d/.test(s) && ruas.indexOf(s) < 0) ruas.push(s); }); });
    return {
      n: i, pontos: pts, idx: idx, dist: (trip.summary.length || 0) * 1000, dur: trip.summary.time || 0,
      desc: ruas.slice(0, 2).join(' e '), passos: passos, osm: {}, achados: [], estado: 'pendente', prog: 0
    };
  }

  $('#mostrar-origem').addEventListener('click', function () {
    var l = $('#linha-origem'); l.classList.toggle('oculto');
    this.textContent = l.classList.contains('oculto') ? 'Sair de outro lugar' : 'Sair daqui';
    if (l.classList.contains('oculto')) $('#origem').value = '';
    posFlutuantes();
  });
  $('#destino').addEventListener('input', function () { S.destino = null; });

  $('#form-rota').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!S.mapa) { toast('O mapa ainda está carregando.'); return; }
    var dTxt = $('#destino').value.trim(), oTxt = $('#origem').value.trim();
    if (!dTxt && !S.destino) { toast('Digite o destino ou toque no mapa.'); $('#destino').focus(); return; }
    if (!oTxt && !S.pos) { toast('Sem GPS ainda. Toque em "Sair de outro lugar" e preencha a saída.', 5000); return; }
    document.activeElement.blur();
    var botao = $('#tracar'); botao.disabled = true; botao.textContent = 'Buscando…';
    var pOrigem = oTxt ? buscarLugar(oTxt).then(function (l) { if (!l.length) throw new Error('Não encontrei a saída "' + oTxt + '".'); return escolherDaLista(l); }) : Promise.resolve(S.pos);
    pOrigem.then(function (o) {
      if (S.destino) return [o, S.destino];
      return buscarLugar(dTxt).then(function (l) { if (!l.length) throw new Error('Não encontrei "' + dTxt + '". Tente cidade e estado, ex.: Santos SP.'); return escolherDaLista(l); })
        .then(function (d) { S.destino = d; $('#destino').value = d.nome; return [o, d]; });
    }).then(function (od) { botao.textContent = 'Calculando…'; return tracar(od[0], od[1]); })
      .catch(function (err) { toast(err.message, 7000); })
      .then(function () { botao.disabled = false; botao.textContent = 'Traçar rota'; });
  });

  function tracar(origem, destino) {
    var token = ++S.tokenRota;
    S.origem = origem;
    return pedirRotas(origem, destino).then(function (trips) {
      if (token !== S.tokenRota) return;
      S.rotas = trips.map(montarRota); S.sel = 0;
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
    r.achados = E.findingsFromOverpass({ elements: osm }, r.idx, S.veh, CORREDOR)
      .concat(E.findingsFromAntt(S.antt, r.idx), E.findingsFromReports(S.reportes, r.idx))
      .sort(function (a, b) { return a.along - b.along; });
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
    return ['selo selo-ok', 'Livre'];
  }

  function atualizarPainelRota() {
    var r = S.rotas[S.sel]; if (!r) return;
    $('#r-tempo').textContent = fmtDur(r.dur);
    $('#r-dist').textContent = fmtDist(r.dist) + (r.desc ? ' · via ' + r.desc : '') + ' · chegada ' + fmtHora(new Date(Date.now() + r.dur * 1000));
    var c = contar(r), st = $('#r-status');
    var perfil = (NOMES_TIPO[S.veh.tipo] || '') + ' de ' + E.fmtNum(S.veh.altura) + ' m e ' + E.fmtNum(S.veh.pbt) + ' t';
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
        el('span', {}, [el('div', { class: 't', text: fmtDur(x.dur) + ' · ' + fmtDist(x.dist) }), el('div', { class: 's', text: x.desc ? 'via ' + x.desc : 'Rota ' + (i + 1) })]),
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
    S.nav = { r: r, sim: sim, hint: 0, along: 0, falou: {}, fora: 0, ultRecalc: Date.now(), passoFalado: -1 };
    S.seguir = true;
    painel('nav'); chipsVeiculo('#chips-nav');
    pedirTelaLigada();
    var c = contar(r);
    falar(sim ? 'Simulação iniciada.' : (c.bloqueio ? 'Atenção, a conferência achou ' + c.bloqueio + ' ponto incompatível nesta rota.' : 'Rota para caminhão calculada. Boa viagem.'));
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
    $('#n-rest').textContent = 'chegada · faltam ' + fmtDist(rest) + ' · ' + fmtDur(r.dur * frac);
    if (rest < 40) { falar('Você chegou ao destino.'); encerrarNav('Você chegou ao destino.'); return; }

    var prox = null, ip = -1;
    for (var i = 0; i < r.passos.length; i++) if (r.passos[i].inicio > n.along + 5) { prox = r.passos[i]; ip = i; break; }
    if (prox) {
      var dm = prox.inicio - n.along;
      $('#manobra-dist').textContent = fmtDist(dm);
      $('#manobra-txt').textContent = prox.texto;
      if (dm < 500 && n.passoFalado !== ip) { n.passoFalado = ip; falar('Em ' + falaDist(dm) + ', ' + prox.voz); }
    } else { $('#manobra-dist').textContent = fmtDist(rest); $('#manobra-txt').textContent = 'Siga até o destino'; }

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
    } else aviso.className = 'oculto';
    posFlutuantes();
  }

  function recalcular(p) {
    var n = S.nav; n.ultRecalc = Date.now();
    toast('Saiu da rota. Recalculando…'); falar('Recalculando.');
    var token = ++S.tokenRota;
    pedirRotas(p, S.destino).then(function (trips) {
      if (!S.nav || token !== S.tokenRota) return;
      var r = montarRota(trips[0], 0);
      S.rotas = [r]; S.sel = 0; n.r = r; n.hint = 0; n.along = 0; n.falou = {}; n.passoFalado = -1;
      desenharRotas(); verificarRota(r, token);
    }).catch(function (e) { toast(e.message, 6000); });
  }

  function encerrarNav(msg) {
    if (!S.nav) return;
    clearInterval(S.nav.timer); S.nav = null; soltarTela();
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

  // ---------- veículo ----------
  function abrirVeiculo() {
    var v = S.veh;
    $('#v-tipo').value = v.tipo; $('#v-altura').value = E.fmtNum(v.altura); $('#v-largura').value = E.fmtNum(v.largura);
    $('#v-comprimento').value = E.fmtNum(v.comprimento); $('#v-pbt').value = E.fmtNum(v.pbt); $('#v-perigoso').checked = !!v.perigoso;
    var a = S.anttInfo;
    $('#info-bases').textContent = (a && a.total
      ? 'Base ANTT: ' + a.total.toLocaleString('pt-BR') + ' pontes e viadutos das rodovias concedidas' + (a.atualizado ? ', atualizada em ' + new Date(a.atualizado).toLocaleDateString('pt-BR') : '') + '. '
      : 'Base ANTT ainda não baixada neste site (veja o LEIA-ME). ') + 'As rotas já saem calculadas para estas medidas.';
    abrir('#m-veiculo');
  }
  $('#btn-veiculo').addEventListener('click', abrirVeiculo);
  $('#chips-veiculo').addEventListener('click', abrirVeiculo);
  $('#form-veiculo').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = { tipo: $('#v-tipo').value, altura: num($('#v-altura').value), largura: num($('#v-largura').value), comprimento: num($('#v-comprimento').value), pbt: num($('#v-pbt').value), perigoso: $('#v-perigoso').checked };
    if (!v.altura || v.altura > 6 || !v.largura || v.largura > 4 || !v.comprimento || v.comprimento > 40 || !v.pbt || v.pbt > 200) {
      toast('Confira os números: altura em metros (ex.: 4,40) e peso em toneladas (ex.: 57).', 5000); return;
    }
    S.veh = v; LS.set('veiculo', v); chipsVeiculo('#chips-veiculo'); fechar('#m-veiculo');
    if (S.rotas.length && S.origem && S.destino && !S.nav) {
      toast('Veículo salvo. Recalculando a rota para as novas medidas…');
      tracar(S.origem, S.destino).catch(function (err) { toast(err.message, 7000); });
    } else toast('Veículo salvo.');
  });

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

  // ---------- instalar como app ----------
  var promptInstalar = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); promptInstalar = e; $('#btn-instalar').hidden = false; });
  $('#btn-instalar').addEventListener('click', function () { if (promptInstalar) { promptInstalar.prompt(); promptInstalar = null; this.hidden = true; } });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () { /* opcional */ });

  window.addEventListener('resize', posFlutuantes);
  iconeVoz();
  chipsVeiculo('#chips-veiculo');
  carregarAntt();
  painel('inicio');
  criarMapa();
})();
