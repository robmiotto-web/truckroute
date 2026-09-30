/* TruckRoute — app (mapa Google + motor próprio de restrições) */
(function () {
  'use strict';
  var E = window.TREngine;
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
    chave: (window.TRUCKROUTE_CONFIG && window.TRUCKROUTE_CONFIG.googleMapsApiKey) || LS.get('chave', ''),
    veh: Object.assign({}, VEH_PADRAO, LS.get('veiculo', {})),
    reportes: LS.get('reportes', []),
    antt: [], anttInfo: null,
    mapa: null, pos: null, marcaPos: null, marcaDestino: null,
    rotas: [], sel: 0, linhas: [], marcas: [], marcasRep: [],
    tokenRota: 0, nav: null, voz: LS.get('voz', true), seguir: true, wake: null
  };

  // ---------- utilidades de texto ----------
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

  // ---------- telas ----------
  function painel(qual) {
    ['inicio', 'rota', 'nav'].forEach(function (p) { $('#p-' + p).classList.toggle('oculto', p !== qual); });
    $('#caixa-busca').classList.toggle('oculto', qual === 'nav');
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

  // ---------- chave e carga do Google Maps ----------
  function iniciar() {
    chipsVeiculo('#chips-veiculo');
    carregarAntt();
    if (!S.chave) { abrir('#setup'); return; }
    carregarGoogle();
  }
  $('#salvar-chave').addEventListener('click', function () {
    var k = $('#campo-chave').value.trim();
    if (k.length < 20) { $('#erro-chave').textContent = 'Essa chave parece incompleta. Copie de novo no Google Cloud.'; return; }
    S.chave = k; LS.set('chave', k); fechar('#setup'); carregarGoogle();
  });
  window.gm_authFailure = function () {
    LS.set('chave', ''); S.chave = '';
    $('#erro-chave').textContent = 'O Google recusou a chave. Confira se a Maps JavaScript API está ativada e se o endereço deste site está liberado na chave.';
    abrir('#setup');
  };
  function carregarGoogle() {
    window.__trMapa = criarMapa;
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(S.chave) + '&language=pt-BR&region=BR&v=weekly&callback=__trMapa';
    s.async = true; s.onerror = function () { toast('Sem internet para carregar o mapa.'); };
    document.head.appendChild(s);
  }

  var ESTILO_NOITE = [
    { elementType: 'geometry', stylers: [{ color: '#1a1f24' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#9aa3ad' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#12161a' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a3138' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1a1f24' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3d4650' }] },
    { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#d5dae0' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d2233' }] },
    { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#3a4148' }] }
  ];

  function criarMapa() {
    var ultimo = LS.get('ultimaPos', { lat: -19.93, lng: -44.05 });
    S.mapa = new google.maps.Map($('#mapa'), {
      center: ultimo, zoom: 12, disableDefaultUI: true, clickableIcons: false,
      gestureHandling: 'greedy', styles: ESTILO_NOITE, backgroundColor: '#12161A'
    });
    S.mapa.addListener('dragstart', function () { S.seguir = false; });
    S.mapa.addListener('click', function (ev) {
      if (S.nav) return;
      var p = { lat: ev.latLng.lat(), lng: ev.latLng.lng() };
      $('#destino').value = p.lat.toFixed(5) + ', ' + p.lng.toFixed(5);
      marcarDestino(p);
      toast('Destino marcado no mapa. Toque em Traçar rota.');
    });
    desenharReportes();
    iniciarGPS();
    painel('inicio');
  }

  // ---------- GPS ----------
  function iniciarGPS() {
    if (!('geolocation' in navigator)) { toast('Este aparelho não informa a localização. Preencha a saída.'); return; }
    navigator.geolocation.watchPosition(function (g) {
      if (S.nav && S.nav.sim) return;
      var p = { lat: g.coords.latitude, lng: g.coords.longitude, heading: g.coords.heading, speed: g.coords.speed };
      var primeira = !S.pos;
      aoPosicionar(p);
      if (primeira && !S.rotas.length) S.mapa.setCenter(p);
    }, function (err) {
      if (err.code === 1) toast('Localização bloqueada. Libere nas configurações do navegador ou preencha a saída.', 6000);
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }

  function aoPosicionar(p) {
    if (S.pos && p.heading == null) {
      var d = E.haversine(S.pos, p); if (d > 3) p.heading = E.bearing(S.pos, p); else p.heading = S.pos.heading;
    }
    S.pos = p; LS.set('ultimaPos', { lat: p.lat, lng: p.lng });
    var icone = { path: 'M0 -14 L10 11 L0 5 L-10 11 Z', fillColor: '#FFFFFF', fillOpacity: 1, strokeColor: '#4C9BFF', strokeWeight: 3, scale: 1.3, rotation: p.heading || 0, anchor: new google.maps.Point(0, 0) };
    if (!S.marcaPos) S.marcaPos = new google.maps.Marker({ map: S.mapa, position: p, icon: icone, zIndex: 999, clickable: false });
    else { S.marcaPos.setPosition(p); S.marcaPos.setIcon(icone); }
    if (S.nav) passoNavegacao(p);
  }

  $('#btn-centro').addEventListener('click', function () {
    S.seguir = true;
    if (S.pos) { S.mapa.panTo(S.pos); if (S.mapa.getZoom() < 14) S.mapa.setZoom(16); }
    else toast('Ainda sem sinal de GPS.');
  });

  // ---------- base ANTT ----------
  function carregarAntt() {
    fetch('data/antt_oae.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (j) {
      S.antt = (j.itens || []).map(function (o) { return o; });
      S.anttInfo = { total: j.total || 0, atualizado: j.atualizado };
    }).catch(function () { S.anttInfo = { total: 0 }; });
  }

  // ---------- rota (Google Routes API) ----------
  function waypoint(txt, pos) {
    if (!txt && pos) return { location: { latLng: { latitude: pos.lat, longitude: pos.lng } } };
    var m = String(txt).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { location: { latLng: { latitude: +m[1], longitude: +m[2] } } };
    return { address: txt + (/brasil/i.test(txt) ? '' : ', Brasil') };
  }

  function pedirRotas(origem, destino) {
    var corpo = {
      origin: origem, destination: destino, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE',
      computeAlternativeRoutes: true, languageCode: 'pt-BR', units: 'METRIC', routeModifiers: { avoidFerries: true }
    };
    return fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Goog-Api-Key': S.chave,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.description,routes.legs.steps.distanceMeters,routes.legs.steps.startLocation,routes.legs.steps.navigationInstruction'
      },
      body: JSON.stringify(corpo)
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var msg = (j.error && j.error.message) || '';
          if (r.status === 403) throw new Error('A chave não tem acesso à Routes API. Ative a "Routes API" no Google Cloud.');
          if (/not found|NOT_FOUND|geocod/i.test(msg)) throw new Error('Não encontrei esse endereço. Tente cidade e estado, por exemplo: Santos SP.');
          throw new Error('O Google não calculou a rota (' + (msg || r.status) + ').');
        }
        if (!j.routes || !j.routes.length) throw new Error('Nenhuma rota encontrada entre esses pontos.');
        return j.routes;
      });
    });
  }

  function montarRota(raw, i) {
    var pts = E.decodePolyline(raw.polyline.encodedPolyline), idx = E.buildRouteIndex(pts);
    var passos = [], hint = 0;
    ((raw.legs || [])[0] || { steps: [] }).steps.forEach(function (st) {
      var ni = st.navigationInstruction; if (!ni || !st.startLocation) return;
      var ll = st.startLocation.latLng, n = E.nearestOnRoute(idx, { lat: ll.latitude, lng: ll.longitude }, hint);
      if (n) hint = n.seg;
      passos.push({ texto: ni.instructions || '', manobra: ni.maneuver || '', inicio: n ? n.along : 0 });
    });
    return {
      n: i, pontos: pts, idx: idx, dist: raw.distanceMeters || idx.total, dur: parseInt(raw.duration, 10) || 0,
      desc: raw.description || '', passos: passos, osm: {}, achados: [], estado: 'pendente', prog: 0, erro: null
    };
  }

  $('#mostrar-origem').addEventListener('click', function () {
    var l = $('#linha-origem'); l.classList.toggle('oculto');
    this.textContent = l.classList.contains('oculto') ? 'Sair de outro lugar' : 'Sair daqui';
    if (l.classList.contains('oculto')) $('#origem').value = '';
    posFlutuantes();
  });

  $('#form-rota').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!S.mapa) { toast('O mapa ainda está carregando.'); return; }
    var dTxt = $('#destino').value.trim(), oTxt = $('#origem').value.trim();
    if (!dTxt) { toast('Digite o destino.'); $('#destino').focus(); return; }
    if (!oTxt && !S.pos) { toast('Sem GPS ainda. Toque em "Sair de outro lugar" e preencha a saída.', 5000); return; }
    document.activeElement.blur();
    tracar(waypoint(oTxt, S.pos), waypoint(dTxt));
  });

  function tracar(origem, destino) {
    var token = ++S.tokenRota;
    S.destino = destino;
    $('#tracar').disabled = true; $('#tracar').textContent = 'Calculando…';
    pedirRotas(origem, destino).then(function (raws) {
      if (token !== S.tokenRota) return;
      S.rotas = raws.map(montarRota); S.sel = 0;
      desenharRotas(); enquadrar(); painel('rota'); atualizarPainelRota();
      verificarTodas(token);
    }).catch(function (err) { toast(err.message, 7000); })
      .then(function () { $('#tracar').disabled = false; $('#tracar').textContent = 'Traçar rota'; });
  }

  function marcarDestino(p) {
    if (S.marcaDestino) S.marcaDestino.setMap(null);
    S.marcaDestino = new google.maps.Marker({ map: S.mapa, position: p, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#6BCB77', fillOpacity: 1, strokeColor: '#10301A', strokeWeight: 3 } });
  }

  function desenharRotas() {
    S.linhas.forEach(function (l) { l.setMap(null); }); S.linhas = [];
    S.rotas.forEach(function (r, i) {
      var sel = i === S.sel;
      var l = new google.maps.Polyline({
        map: S.mapa, path: r.pontos, strokeColor: sel ? '#4C9BFF' : '#5B6570', strokeOpacity: sel ? 1 : 0.8,
        strokeWeight: sel ? 7 : 5, zIndex: sel ? 10 : 5, clickable: !S.nav
      });
      l.addListener('click', function () { escolher(i); });
      S.linhas.push(l);
    });
    var r = S.rotas[S.sel]; if (r) marcarDestino(r.pontos[r.pontos.length - 1]);
    desenharAchados();
  }

  function enquadrar() {
    var b = new google.maps.LatLngBounds();
    S.rotas.forEach(function (r) { r.pontos.forEach(function (p, i) { if (i % 20 === 0) b.extend(p); }); });
    S.mapa.fitBounds(b, { top: 170, bottom: 330, left: 30, right: 30 });
  }

  function escolher(i) {
    if (S.nav) return;
    S.sel = i; desenharRotas(); atualizarPainelRota();
  }

  // ---------- verificação das restrições ----------
  function juntarAchados(r) {
    var osm = [];
    Object.keys(r.osm).forEach(function (k) { osm.push(r.osm[k]); });
    var achOsm = E.findingsFromOverpass({ elements: osm }, r.idx, S.veh, CORREDOR);
    var achAntt = E.findingsFromAntt(S.antt, r.idx);
    var achRep = E.findingsFromReports(S.reportes, r.idx);
    r.achados = achOsm.concat(achAntt, achRep).sort(function (a, b) { return a.along - b.along; });
  }
  function contar(r) {
    var c = { bloqueio: 0, atencao: 0, info: 0 };
    r.achados.forEach(function (a) { c[a.nivel]++; }); return c;
  }

  function consultaOverpass(q, tentativa) {
    tentativa = tentativa || 0;
    var url = OVERPASS[tentativa % OVERPASS.length];
    return fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      .then(function (r) { if (!r.ok) throw new Error('overpass ' + r.status); return r.json(); })
      .catch(function (e) {
        if (tentativa >= 3) throw e;
        return new Promise(function (ok) { setTimeout(ok, 2500 * (tentativa + 1)); }).then(function () { return consultaOverpass(q, tentativa + 1); });
      });
  }

  function verificarRota(r, token) {
    if (r.estado === 'ok' || r.estado === 'verificando') return Promise.resolve();
    r.estado = 'verificando';
    juntarAchados(r); // ANTT e reportes já aparecem na hora
    var simples = E.simplify(r.pontos, 12), pedacos = E.chunkForOverpass(simples, 100), i = 0, falhas = 0;
    function proximo() {
      if (token !== S.tokenRota) return Promise.resolve();
      if (i >= pedacos.length) {
        r.estado = falhas ? 'parcial' : 'ok'; r.prog = 1; juntarAchados(r); atualizarTudo(r); return Promise.resolve();
      }
      var q = E.overpassQuery(pedacos[i], CORREDOR);
      return consultaOverpass(q).then(function (j) {
        (j.elements || []).forEach(function (e) { r.osm[e.type + e.id] = e; });
      }).catch(function () { falhas++; }).then(function () {
        i++; r.prog = i / pedacos.length;
        if (i % 3 === 0 || i === pedacos.length) { juntarAchados(r); atualizarTudo(r); }
        else atualizarPainelRota();
        return proximo();
      });
    }
    atualizarTudo(r);
    return proximo();
  }

  function atualizarTudo(r) {
    if (r.n === S.sel) desenharAchados();
    atualizarPainelRota();
  }

  function verificarTodas(token) {
    var r0 = S.rotas[0];
    verificarRota(r0, token).then(function () {
      if (token !== S.tokenRota) return;
      if (contar(r0).bloqueio === 0 || S.rotas.length < 2) return;
      // A rota mais rápida tem bloqueio: confere as alternativas e sugere a melhor
      var seq = Promise.resolve();
      S.rotas.slice(1).forEach(function (r) { seq = seq.then(function () { return verificarRota(r, token); }); });
      return seq.then(function () {
        if (token !== S.tokenRota || S.nav) return;
        var livre = S.rotas.filter(function (r) { return r.estado !== 'verificando' && contar(r).bloqueio === 0; })[0];
        if (livre && S.sel === 0) {
          escolher(livre.n);
          toast('A rota mais rápida tem restrição para o seu veículo. Selecionei uma alternativa livre.', 6000);
          falar('A rota mais rápida tem restrição para o seu veículo. Escolhi uma alternativa.');
        } else if (!livre) {
          toast('Todas as rotas do Google têm alguma restrição. Veja os alertas antes de sair.', 7000);
        }
      });
    });
  }

  function desenharAchados() {
    S.marcas.forEach(function (m) { m.setMap(null); }); S.marcas = [];
    var r = S.rotas[S.sel]; if (!r) return;
    r.achados.forEach(function (a) {
      var info = a.nivel === 'info';
      var m = new google.maps.Marker({
        map: S.mapa, position: { lat: a.lat, lng: a.lng }, zIndex: info ? 20 : 50, title: a.titulo,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: info ? 4 : 9, fillColor: COR[a.nivel], fillOpacity: 1, strokeColor: '#12161A', strokeWeight: 2 }
      });
      m.addListener('click', function () { toast(a.titulo + ': ' + a.textos.join(' '), 6000); });
      S.marcas.push(m);
    });
  }

  function seloRota(r) {
    var c = contar(r);
    if (r.estado === 'pendente') return ['selo selo-verif', 'Não conferida'];
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
    if (r.estado === 'verificando') st.textContent = 'Conferindo restrições ao longo da rota… ' + Math.round(r.prog * 100) + '%';
    else if (r.estado === 'parcial') st.textContent = 'Parte da rota não pôde ser conferida (servidor ocupado). Toque em Traçar rota de novo para completar.';
    else if (c.bloqueio) st.textContent = c.bloqueio + ' ponto(s) incompatível(is) com seu veículo nesta rota.';
    else if (r.estado === 'ok') st.textContent = 'Nenhum bloqueio encontrado para ' + (NOMES_TIPO[S.veh.tipo] || '') + ' de ' + E.fmtNum(S.veh.altura) + ' m e ' + E.fmtNum(S.veh.pbt) + ' t.' + (c.atencao ? ' ' + c.atencao + ' ponto(s) de atenção.' : '');
    else st.textContent = '';
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
    S.tokenRota++; S.rotas = [];
    S.linhas.forEach(function (l) { l.setMap(null); }); S.linhas = [];
    S.marcas.forEach(function (m) { m.setMap(null); }); S.marcas = [];
    if (S.marcaDestino) { S.marcaDestino.setMap(null); S.marcaDestino = null; }
    painel('inicio');
  }

  // ---------- lista de alertas ----------
  function abrirAlertas() {
    var r = S.rotas[S.sel]; if (!r) return;
    var c = contar(r), lista = $('#lista-alertas'), base = S.nav ? S.nav.along : 0;
    $('#al-resumo').textContent = c.bloqueio + ' bloqueio(s), ' + c.atencao + ' de atenção e ' + c.info + ' pontes/viadutos da ANTT nesta rota.' + (r.estado === 'verificando' ? ' Ainda conferindo…' : '');
    lista.textContent = '';
    var itens = r.achados.filter(function (a) { return a.along >= base - 50; });
    if (!itens.length) lista.appendChild(el('p', { class: 'dica', text: 'Nenhum alerta à frente.' }));
    itens.slice(0, 200).forEach(function (a) {
      lista.appendChild(el('button', { class: 'alerta-item', onclick: function () { fechar('#m-alertas'); S.seguir = false; S.mapa.panTo({ lat: a.lat, lng: a.lng }); S.mapa.setZoom(16); } }, [
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
    S.tokenRota++; // não troca de rota durante a viagem (a verificação em andamento termina sozinha)
    if (r.estado === 'verificando') { r.estado = 'pendente'; verificarRota(r, S.tokenRota); }
    S.nav = { r: r, sim: sim, hint: 0, along: 0, falou: {}, fora: 0, ultRecalc: Date.now(), passoFalado: -1 };
    S.rotas.forEach(function (x, i) { if (i !== S.sel) S.linhas[i].setMap(null); });
    S.seguir = true; S.mapa.setZoom(16);
    painel('nav'); chipsVeiculo('#chips-nav');
    pedirTelaLigada();
    falar(sim ? 'Simulação iniciada.' : 'Vamos lá. ' + resumoFala(r));
    if (sim) simular(r); else if (S.pos) aoPosicionar(S.pos);
  }
  function resumoFala(r) {
    var c = contar(r);
    return c.bloqueio ? 'Atenção, esta rota tem ' + c.bloqueio + ' ponto incompatível com seu veículo.' : 'Rota conferida para o seu veículo.';
  }

  function simular(r) {
    var vel = 22 * 8; // 80 km/h acelerado 8x
    S.nav.along = 0;
    S.nav.timer = setInterval(function () {
      if (!S.nav) return;
      var a = Math.min(r.idx.total, S.nav.along + vel);
      var p = E.pointAt(r.idx, a), q = E.pointAt(r.idx, Math.min(r.idx.total, a + 30));
      aoPosicionar({ lat: p.lat, lng: p.lng, heading: E.bearing(p, q), speed: 22 });
    }, 1000);
  }

  function passoNavegacao(p) {
    var n = S.nav, r = n.r, near = E.nearestOnRoute(r.idx, p, n.hint);
    if (!near || near.d > 80) {
      n.fora++;
      if (!n.sim && n.fora >= 3 && Date.now() - n.ultRecalc > 30000) recalcular(p);
      return;
    }
    n.fora = 0; n.hint = near.seg; n.along = Math.max(n.along - 30, near.along);
    if (S.seguir) S.mapa.panTo(p);
    var rest = r.idx.total - n.along, frac = rest / r.idx.total;
    $('#n-eta').textContent = fmtHora(new Date(Date.now() + r.dur * frac * 1000));
    $('#n-rest').textContent = 'chegada · faltam ' + fmtDist(rest) + ' · ' + fmtDur(r.dur * frac);
    if (rest < 40) { encerrarNav('Você chegou ao destino.'); falar('Você chegou ao destino.'); return; }

    // próxima manobra
    var prox = null, ip = -1;
    for (var i = 0; i < r.passos.length; i++) if (r.passos[i].inicio > n.along + 5) { prox = r.passos[i]; ip = i; break; }
    if (prox) {
      var dm = prox.inicio - n.along;
      $('#manobra-dist').textContent = fmtDist(dm);
      $('#manobra-txt').textContent = prox.texto.split('\n')[0];
      if (dm < 400 && n.passoFalado !== ip) { n.passoFalado = ip; falar('Em ' + Math.max(50, Math.round(dm / 50) * 50) + ' metros, ' + prox.texto.split('\n')[0]); }
    } else { $('#manobra-dist').textContent = fmtDist(rest); $('#manobra-txt').textContent = 'Siga até o destino'; }

    // próximo alerta
    var al = null;
    for (var k = 0; k < r.achados.length; k++) {
      var a = r.achados[k];
      if (a.nivel !== 'info' && a.along > n.along - 20) { al = a; break; }
    }
    var aviso = $('#aviso');
    if (al && al.along - n.along < 2500) {
      var dist = Math.max(0, al.along - n.along);
      aviso.className = al.nivel; aviso.classList.remove('oculto');
      $('#aviso-titulo').textContent = al.titulo + ' em ' + fmtDist(dist);
      $('#aviso-txt').textContent = al.textos.join(' ');
      var faixa = dist < 600 ? 'perto' : 'longe';
      if (!n.falou[al.id + faixa]) {
        n.falou[al.id + faixa] = 1;
        falar((al.nivel === 'bloqueio' ? 'Cuidado. ' : 'Atenção. ') + 'Em ' + (dist < 1000 ? Math.round(dist / 50) * 50 + ' metros' : (dist / 1000).toFixed(1).replace('.', ',') + ' quilômetros') + ', ' + al.titulo + '. ' + al.textos[0]);
      }
    } else aviso.classList.add('oculto');
    posFlutuantes();
  }

  function recalcular(p) {
    var n = S.nav; n.ultRecalc = Date.now();
    toast('Saiu da rota. Recalculando…'); falar('Recalculando.');
    var token = ++S.tokenRota;
    pedirRotas(waypoint('', p), S.destino).then(function (raws) {
      if (!S.nav || token !== S.tokenRota) return;
      var r = montarRota(raws[0], 0);
      S.rotas = [r]; S.sel = 0; n.r = r; n.hint = 0; n.along = 0; n.falou = {}; n.passoFalado = -1;
      desenharRotas(); verificarRota(r, token);
    }).catch(function (e) { toast(e.message, 6000); });
  }

  function encerrarNav(msg) {
    if (!S.nav) return;
    clearInterval(S.nav.timer); S.nav = null; soltarTela();
    toast(msg); limparRota();
  }

  function pedirTelaLigada() {
    if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then(function (w) { S.wake = w; }).catch(function () { /* sem suporte */ });
  }
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
    $('#info-bases').textContent = a && a.total
      ? 'Base ANTT carregada: ' + a.total.toLocaleString('pt-BR') + ' pontes e viadutos das rodovias concedidas' + (a.atualizado ? ', atualizada em ' + new Date(a.atualizado).toLocaleDateString('pt-BR') : '') + '. Restrições de altura e peso: OpenStreetMap, conferido a cada rota.'
      : 'Base ANTT ainda não baixada neste site (veja o LEIA-ME). Restrições de altura e peso: OpenStreetMap, conferido a cada rota.';
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
    // Reavalia as rotas já baixadas sem consultar a internet de novo
    S.rotas.forEach(function (r) { juntarAchados(r); });
    if (S.rotas.length) { desenharAchados(); atualizarPainelRota(); }
    toast('Veículo salvo.');
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
    var c = S.pos || { lat: S.mapa.getCenter().lat(), lng: S.mapa.getCenter().lng() };
    S.reportes.push({ id: Date.now(), tipo: repEscolhido, lat: c.lat, lng: c.lng, ts: Date.now() });
    LS.set('reportes', S.reportes); fechar('#m-reportar');
    desenharReportes();
    S.rotas.forEach(function (r) { juntarAchados(r); }); if (S.rotas.length) desenharAchados();
    toast('Reporte salvo. Obrigado!'); falar('Reporte salvo.');
  });
  function desenharReportes() {
    if (!S.mapa) return;
    S.marcasRep.forEach(function (m) { m.setMap(null); }); S.marcasRep = [];
    S.reportes.forEach(function (rp) {
      S.marcasRep.push(new google.maps.Marker({ map: S.mapa, position: { lat: rp.lat, lng: rp.lng }, zIndex: 40, title: 'Reporte',
        icon: { path: 'M0 -10 L9 7 L-9 7 Z', fillColor: '#F2A900', fillOpacity: 1, strokeColor: '#14171A', strokeWeight: 2, scale: 1 } }));
    });
  }

  // ---------- instalar como app ----------
  var promptInstalar = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); promptInstalar = e; $('#btn-instalar').hidden = false; });
  $('#btn-instalar').addEventListener('click', function () { if (promptInstalar) { promptInstalar.prompt(); promptInstalar = null; this.hidden = true; } });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () { /* opcional */ });

  window.addEventListener('resize', posFlutuantes);
  iconeVoz();
  iniciar();
  painel('inicio');
})();
