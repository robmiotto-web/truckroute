/* TruckRoute — motor próprio de restrições para veículos pesados.
 * Não depende do Google: decodifica a rota, indexa a geometria,
 * busca restrições (OpenStreetMap/Overpass), cruza com a base da ANTT
 * e com os reportes dos motoristas, e avalia tudo contra o perfil do veículo.
 */
(function (root) {
  'use strict';

  var R_EARTH = 6371008.8;
  var DEG = Math.PI / 180;

  // ---------- Geometria ----------
  function haversine(a, b) {
    var dLat = (b.lat - a.lat) * DEG, dLng = (b.lng - a.lng) * DEG;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearing(a, b) {
    var y = Math.sin((b.lng - a.lng) * DEG) * Math.cos(b.lat * DEG);
    var x = Math.cos(a.lat * DEG) * Math.sin(b.lat * DEG) -
      Math.sin(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lng - a.lng) * DEG);
    return (Math.atan2(y, x) / DEG + 360) % 360;
  }

  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // Decodificador do formato "encoded polyline" (precisão 1e5 Google, 1e6 Valhalla)
  function decodePolyline(str, precision) {
    var f = Math.pow(10, precision || 5);
    var pts = [], i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      var res = 0, shift = 0, b;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (res & 1) ? ~(res >> 1) : (res >> 1);
      res = 0; shift = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (res & 1) ? ~(res >> 1) : (res >> 1);
      pts.push({ lat: lat / f, lng: lng / f });
    }
    return pts;
  }

  // Projeção local em metros (equirretangular por ponto)
  function toXY(p) {
    return { x: p.lng * DEG * R_EARTH * Math.cos(p.lat * DEG), y: p.lat * DEG * R_EARTH };
  }

  // Índice espacial da rota: grade de células ~1 km para achar o ponto mais próximo rápido
  var CELL = 0.01;
  function cellKey(lat, lng) { return Math.floor(lat / CELL) + ':' + Math.floor(lng / CELL); }

  function buildRouteIndex(points) {
    var cum = [0];
    for (var i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
    var grid = {};
    for (var s = 0; s < points.length - 1; s++) {
      var a = points[s], b = points[s + 1];
      var la0 = Math.floor(Math.min(a.lat, b.lat) / CELL), la1 = Math.floor(Math.max(a.lat, b.lat) / CELL);
      var ln0 = Math.floor(Math.min(a.lng, b.lng) / CELL), ln1 = Math.floor(Math.max(a.lng, b.lng) / CELL);
      for (var la = la0; la <= la1; la++) for (var ln = ln0; ln <= ln1; ln++) {
        var k = la + ':' + ln;
        (grid[k] || (grid[k] = [])).push(s);
      }
    }
    return { points: points, cum: cum, total: cum[cum.length - 1], grid: grid };
  }

  function projectOnSegment(p, a, b) {
    var lat0 = p.lat * DEG, k = Math.cos(lat0) * R_EARTH * DEG, m = R_EARTH * DEG;
    var ax = (a.lng - p.lng) * k, ay = (a.lat - p.lat) * m;
    var bx = (b.lng - p.lng) * k, by = (b.lat - p.lat) * m;
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    var cx = ax + t * dx, cy = ay + t * dy;
    return { d: Math.sqrt(cx * cx + cy * cy), t: t };
  }

  // Ponto mais próximo da rota. hint = índice do segmento para busca local (navegação)
  function nearestOnRoute(idx, p, hint) {
    var best = null, pts = idx.points;
    function test(s) {
      var r = projectOnSegment(p, pts[s], pts[s + 1]);
      if (!best || r.d < best.d) {
        best = { d: r.d, seg: s, along: idx.cum[s] + r.t * (idx.cum[s + 1] - idx.cum[s]) };
      }
    }
    if (typeof hint === 'number') {
      var from = Math.max(0, hint - 30), to = Math.min(pts.length - 2, hint + 300);
      for (var s = from; s <= to; s++) test(s);
      if (best && best.d < 60) return best;
    }
    var la = Math.floor(p.lat / CELL), ln = Math.floor(p.lng / CELL), seen = {};
    for (var i = -1; i <= 1; i++) for (var j = -1; j <= 1; j++) {
      var list = idx.grid[(la + i) + ':' + (ln + j)];
      if (!list) continue;
      for (var q = 0; q < list.length; q++) { if (!seen[list[q]]) { seen[list[q]] = 1; test(list[q]); } }
    }
    return best; // null = longe da rota (> ~1 km)
  }

  function segBearing(idx, s) { return bearing(idx.points[s], idx.points[s + 1]); }

  // Douglas–Peucker em metros
  function simplify(points, tol) {
    if (points.length < 3) return points.slice();
    var keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
    var stack = [[0, points.length - 1]];
    while (stack.length) {
      var r = stack.pop(), a = r[0], b = r[1], maxD = 0, idx = -1;
      for (var i = a + 1; i < b; i++) {
        var d = projectOnSegment(points[i], points[a], points[b]).d;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    var out = [];
    for (var k = 0; k < points.length; k++) if (keep[k]) out.push(points[k]);
    return out;
  }

  // Densifica para que nenhum trecho fique maior que maxM (o "around" do Overpass segue a linha)
  function chunkForOverpass(points, perChunk) {
    var chunks = [];
    for (var i = 0; i < points.length - 1; i += perChunk - 1) {
      chunks.push(points.slice(i, Math.min(points.length, i + perChunk)));
    }
    return chunks;
  }

  // ---------- Parsers de unidades (tags OSM) ----------
  var NONE = { none: 1, 'default': 1, unsigned: 1, no_sign: 1, below_default: 1, 'no': 1 };

  function parseMeters(v) {
    if (v == null) return null;
    v = String(v).trim().toLowerCase();
    if (NONE[v]) return null;
    var ft = v.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''))?$/);
    if (ft) return +ft[1] * 0.3048 + (ft[2] ? +ft[2] * 0.0254 : 0);
    var m = v.replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(m|cm|ft|feet)?\b/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (m[2] === 'cm') n /= 100;
    if (m[2] === 'ft' || m[2] === 'feet') n *= 0.3048;
    return n > 0 && n < 30 ? n : null;
  }

  function parseTonnes(v) {
    if (v == null) return null;
    v = String(v).trim().toLowerCase();
    if (NONE[v]) return null;
    var m = v.replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(t|kg|st|lbs|lb)?\b/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (m[2] === 'kg') n /= 1000;
    if (m[2] === 'st') n *= 0.90718;
    if (m[2] === 'lbs' || m[2] === 'lb') n *= 0.000453592;
    return n > 0 && n < 500 ? n : null;
  }

  // ---------- Avaliação contra o perfil do veículo ----------
  // veh = { altura, largura, comprimento, pbt, perigoso }
  // retorna lista de problemas { nivel: 'bloqueio'|'atencao', motivo, texto }
  function evaluateTags(tags, veh) {
    var out = [];
    var h = parseMeters(tags.maxheight || tags['maxheight:physical']);
    if (h != null) {
      if (veh.altura > h) out.push({ nivel: 'bloqueio', motivo: 'altura', texto: 'Altura máxima ' + fmtNum(h) + ' m (seu veículo: ' + fmtNum(veh.altura) + ' m)' });
      else if (veh.altura > h - 0.2) out.push({ nivel: 'atencao', motivo: 'altura', texto: 'Altura máxima ' + fmtNum(h) + ' m — folga menor que 20 cm' });
    }
    var w = parseTonnes(tags.maxweight || tags['maxweight:hgv']);
    if (w != null && veh.pbt > w) out.push({ nivel: 'bloqueio', motivo: 'peso', texto: 'Peso máximo ' + fmtNum(w) + ' t (seu PBT: ' + fmtNum(veh.pbt) + ' t)' });
    var wd = parseMeters(tags.maxwidth || tags['maxwidth:physical']);
    if (wd != null && veh.largura > wd) out.push({ nivel: 'bloqueio', motivo: 'largura', texto: 'Largura máxima ' + fmtNum(wd) + ' m' });
    var len = parseMeters(tags.maxlength);
    if (len != null && veh.comprimento > len) out.push({ nivel: 'bloqueio', motivo: 'comprimento', texto: 'Comprimento máximo ' + fmtNum(len) + ' m (seu conjunto: ' + fmtNum(veh.comprimento) + ' m)' });
    var hgv = (tags.hgv || '').toLowerCase();
    if (hgv === 'no') out.push({ nivel: 'bloqueio', motivo: 'proibido', texto: 'Via proibida para caminhões' });
    else if (hgv === 'destination' || hgv === 'delivery') out.push({ nivel: 'atencao', motivo: 'proibido', texto: 'Caminhões só com destino local' });
    if (veh.perigoso && (tags.hazmat || '').toLowerCase() === 'no') out.push({ nivel: 'bloqueio', motivo: 'perigoso', texto: 'Proibido para produto perigoso' });
    return out;
  }

  function fmtNum(n) { return (Math.round(n * 100) / 100).toString().replace('.', ','); }

  // ---------- Casamento de uma via OSM com a rota ----------
  // Exige que a via "corra junto" com a rota (evita falso alerta de via que só cruza por cima/baixo)
  function matchWay(idx, geom, oneway, corridor) {
    var hits = [];
    for (var i = 0; i < geom.length; i++) {
      var r = nearestOnRoute(idx, geom[i]);
      if (r && r.d <= corridor) hits.push({ i: i, r: r });
    }
    if (!hits.length) return null;
    var wayLen = 0;
    for (var k = 1; k < geom.length; k++) wayLen += haversine(geom[k - 1], geom[k]);
    var aligned = false;
    for (var h = 0; h < hits.length; h++) {
      var i2 = hits[h].i, a = geom[Math.max(0, i2 - 1)], b = geom[Math.min(geom.length - 1, i2 + (i2 === 0 ? 1 : 0))];
      if (a === b) continue;
      var diff = angleDiff(bearing(a, b), segBearing(idx, hits[h].r.seg));
      if (diff < 35 || (!oneway && Math.abs(diff - 180) < 35)) { aligned = true; break; }
    }
    hits.sort(function (x, y) { return x.r.along - y.r.along; });
    if (hits.length >= 2 && aligned) return hits[0].r;
    if (hits.length === 1 && wayLen < 60 && hits[0].r.d < 12) return hits[0].r;
    return null;
  }

  // ---------- Overpass (OpenStreetMap) ----------
  function overpassQuery(chunk, corridor) {
    var c = chunk.map(function (p) { return p.lat.toFixed(5) + ',' + p.lng.toFixed(5); }).join(',');
    var a = '(around:' + corridor + ',' + c + ')';
    return '[out:json][timeout:40];(' +
      'way' + a + '["maxheight"];' +
      'way' + a + '["maxheight:physical"];' +
      'way' + a + '["maxweight"];' +
      'way' + a + '["maxweight:hgv"];' +
      'way' + a + '["maxwidth"];' +
      'way' + a + '["maxlength"];' +
      'way' + a + '["hgv"~"^(no|destination|delivery)$"];' +
      'way' + a + '["hazmat"="no"];' +
      'node' + a + '["maxheight"];' +
      ');out tags geom;';
  }

  // Converte a resposta do Overpass em achados na rota
  function findingsFromOverpass(json, idx, veh, corridor) {
    var out = [];
    (json.elements || []).forEach(function (el) {
      var probs = evaluateTags(el.tags || {}, veh);
      if (!probs.length) return;
      var r;
      if (el.type === 'node') {
        r = nearestOnRoute(idx, { lat: el.lat, lng: el.lon });
        if (!r || r.d > 15) return;
      } else if (el.geometry) {
        var geom = el.geometry.map(function (g) { return { lat: g.lat, lng: g.lon }; });
        var ow = (el.tags.oneway === 'yes' || el.tags.oneway === '1' || el.tags.junction === 'roundabout');
        r = matchWay(idx, geom, ow, corridor);
        if (!r) return;
      } else return;
      var p = pointAt(idx, r.along);
      out.push({
        id: 'osm:' + el.type + '/' + el.id, fonte: 'OpenStreetMap', along: r.along, lat: p.lat, lng: p.lng,
        nivel: probs.some(function (x) { return x.nivel === 'bloqueio'; }) ? 'bloqueio' : 'atencao',
        titulo: (el.tags.name || el.tags.ref || tituloPorMotivo(probs[0].motivo)),
        textos: probs.map(function (x) { return x.texto; }), motivo: probs[0].motivo
      });
    });
    return out;
  }

  function tituloPorMotivo(m) {
    return { altura: 'Restrição de altura', peso: 'Limite de peso', largura: 'Limite de largura', comprimento: 'Limite de comprimento', proibido: 'Restrição para caminhões', perigoso: 'Restrição a produto perigoso' }[m] || 'Restrição';
  }

  function pointAt(idx, along) {
    var cum = idx.cum, pts = idx.points, lo = 0, hi = cum.length - 1;
    if (along <= 0) return pts[0];
    if (along >= idx.total) return pts[pts.length - 1];
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= along) lo = mid; else hi = mid; }
    var t = (along - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
    return { lat: pts[lo].lat + t * (pts[hi].lat - pts[lo].lat), lng: pts[lo].lng + t * (pts[hi].lng - pts[lo].lng) };
  }

  // ---------- Base ANTT (obras de arte especiais das rodovias concedidas) ----------
  // A ANTT publica a localização de pontes e viadutos, mas não o gabarito (altura livre)
  // nem a capacidade. Por isso eles viram "atenção", e o motorista confere a placa.
  var SOBRE_PISTA = /passagem\s+superior|passarela|transversal/i;

  function findingsFromAntt(list, idx) {
    var out = [];
    (list || []).forEach(function (o) {
      var r = nearestOnRoute(idx, { lat: o.lat, lng: o.lng });
      if (!r || r.d > 40) return;
      var sobre = o.tipo === 'PASSARELA' || SOBRE_PISTA.test(o.nome || '');
      out.push({
        id: 'antt:' + o.id, fonte: 'ANTT', along: r.along, lat: o.lat, lng: o.lng,
        nivel: sobre ? 'atencao' : 'info',
        titulo: (o.nome || o.tipo) + (o.rodovia ? ' · ' + o.rodovia + (o.km != null ? ' km ' + fmtNum(o.km) : '') : ''),
        textos: [sobre ? 'Estrutura sobre a pista. A ANTT não informa a altura livre: confira a placa de gabarito.' : (o.tipo === 'PONTE' ? 'Ponte em rodovia concedida (' + (o.concessionaria || '') + ')' : 'Obra de arte em rodovia concedida')],
        motivo: sobre ? 'altura' : 'oae'
      });
    });
    return out;
  }

  // ---------- Reportes da comunidade ----------
  var REPORTE_TXT = {
    altura: 'Altura baixa reportada por motorista', peso: 'Limite de peso reportado por motorista',
    horario: 'Restrição de horário reportada', balanca: 'Balança aberta', obra: 'Obra ou interdição reportada',
    proibida: 'Via proibida reportada por motorista'
  };
  function findingsFromReports(reports, idx) {
    var out = [];
    (reports || []).forEach(function (rp) {
      var r = nearestOnRoute(idx, { lat: rp.lat, lng: rp.lng });
      if (!r || r.d > 30) return;
      out.push({
        id: 'rep:' + rp.id, fonte: 'Motoristas', along: r.along, lat: rp.lat, lng: rp.lng,
        nivel: rp.tipo === 'balanca' ? 'info' : 'atencao', titulo: REPORTE_TXT[rp.tipo] || 'Reporte',
        textos: ['Reportado em ' + new Date(rp.ts).toLocaleDateString('pt-BR')], motivo: rp.tipo
      });
    });
    return out;
  }

  // ---------- Base ANTT: conversão do CSV (usada também no script de atualização) ----------
  function parseAnttCsvRow(fields) {
    var num = function (s) { var n = parseFloat(String(s || '').replace(',', '.')); return isNaN(n) ? null : n; };
    var lat = null, lng = null, km = null, rod = null;
    for (var i = 5; i < fields.length - 1; i++) {
      var a = num(fields[i]), b = num(fields[i + 1]);
      if (a != null && b != null && a > -34.5 && a < 5.5 && b > -74.5 && b < -28.5) { lat = a; lng = b; km = num(fields[i - 1]); break; }
    }
    if (lat == null) for (var i2 = 5; i2 < fields.length - 1; i2++) { // lat/lng trocadas na origem
      var c = num(fields[i2]), d = num(fields[i2 + 1]);
      if (c != null && d != null && c > -74.5 && c < -28.5 && d > -34.5 && d < 5.5) { lat = d; lng = c; km = num(fields[i2 - 1]); break; }
    }
    for (var j = 5; j < fields.length; j++) { if (/^(BR|SP|MG|RJ|PR|SC|RS|GO|MT|MS|BA|ES|PE|TO)-?\d+/i.test(fields[j]) || /contorno/i.test(fields[j])) { rod = fields[j].trim(); break; } }
    if (lat == null) return null;
    return { concessionaria: (fields[0] || '').trim(), tipo: (fields[1] || '').trim().toUpperCase(), nome: (fields[2] || '').trim(), rodovia: rod, km: km, lat: lat, lng: lng, extensao: num(fields[4]) };
  }

  var api = {
    haversine: haversine, bearing: bearing, decodePolyline: decodePolyline, buildRouteIndex: buildRouteIndex,
    nearestOnRoute: nearestOnRoute, simplify: simplify, chunkForOverpass: chunkForOverpass,
    parseMeters: parseMeters, parseTonnes: parseTonnes, evaluateTags: evaluateTags, matchWay: matchWay,
    overpassQuery: overpassQuery, findingsFromOverpass: findingsFromOverpass, findingsFromAntt: findingsFromAntt,
    findingsFromReports: findingsFromReports, pointAt: pointAt, parseAnttCsvRow: parseAnttCsvRow, fmtNum: fmtNum,
    toXY: toXY, cellKey: cellKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TREngine = api;
})(this);
