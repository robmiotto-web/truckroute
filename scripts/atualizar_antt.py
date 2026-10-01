#!/usr/bin/env python3
"""Baixa a base "Pontes e similares" do Portal de Dados Abertos da ANTT
e gera data/antt_oae.json, que o app TruckRoute carrega.

Uso:  python3 scripts/atualizar_antt.py
Roda sozinho todo mês pelo GitHub Actions (.github/workflows/atualizar-antt.yml).
"""
import csv, io, json, re, sys, urllib.request
from datetime import datetime, timezone
from pathlib import Path

CKAN = "https://dados.antt.gov.br/api/3/action/package_show?id=pontes-similares"
CSV_PADRAO = ("https://dados.antt.gov.br/dataset/f9cdb7dc-549f-4bd3-97aa-a35bdff94c26/"
              "resource/80cd0864-b0ca-4ab5-bf5a-ffcbeec33235/download/"
              "pontes-e-similares-das-rodovias-concedidas.csv")
SAIDA = Path(__file__).resolve().parent.parent / "data" / "antt_oae.json"
UA = {"User-Agent": "TruckRoute-MVP/1.0 (dados abertos ANTT)"}


def baixar(url, timeout=120):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def achar_csv():
    """Pergunta à API CKAN qual é o CSV atual; se falhar, usa o endereço conhecido."""
    try:
        pac = json.loads(baixar(CKAN, 60))
        for res in pac["result"]["resources"]:
            if (res.get("format") or "").upper() == "CSV" and res.get("url"):
                return res["url"]
    except Exception as e:  # noqa: BLE001
        print("Aviso: API CKAN indisponível (%s); usando endereço padrão." % e)
    return CSV_PADRAO


def num(s):
    try:
        return float(str(s).replace(",", "."))
    except (TypeError, ValueError):
        return None


ROD = re.compile(r"^(BR|SP|MG|RJ|PR|SC|RS|GO|MT|MS|BA|ES|PE|TO)-?\d+", re.I)


def converter_linha(f):
    """Mesma lógica de engine.js/parseAnttCsvRow: as colunas do arquivo não
    batem 100% com o cabeçalho, então localizamos o primeiro par lat/lng válido."""
    lat = lng = km = rod = None
    for i in range(5, len(f) - 1):
        a, b = num(f[i]), num(f[i + 1])
        if a is not None and b is not None and -34.5 < a < 5.5 and -74.5 < b < -28.5:
            lat, lng, km = a, b, num(f[i - 1])
            break
    if lat is None:  # alguns registros vêm com latitude e longitude trocadas
        for i in range(5, len(f) - 1):
            a, b = num(f[i]), num(f[i + 1])
            if a is not None and b is not None and -74.5 < a < -28.5 and -34.5 < b < 5.5:
                lat, lng, km = b, a, num(f[i - 1])
                break
    for j in range(5, len(f)):
        if ROD.match(f[j].strip()) or "contorno" in f[j].lower():
            rod = f[j].strip()
            break
    if lat is None:
        return None
    return {
        "concessionaria": f[0].strip(), "tipo": f[1].strip().upper(), "nome": f[2].strip(),
        "rodovia": rod, "km": km, "lat": round(lat, 6), "lng": round(lng, 6), "extensao": num(f[4]),
    }


def main():
    url = achar_csv()
    print("Baixando", url)
    bruto = baixar(url)
    for enc in ("utf-8", "latin-1"):
        try:
            texto = bruto.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    linhas = list(csv.reader(io.StringIO(texto), delimiter=";"))
    itens, descartadas = [], 0
    for n, f in enumerate(linhas[1:], start=1):
        item = converter_linha(f)
        if item:
            item["id"] = n
            itens.append(item)
        else:
            descartadas += 1
    if not itens:
        print("Nenhum registro válido; arquivo não foi alterado.")
        sys.exit(1)
    SAIDA.parent.mkdir(parents=True, exist_ok=True)
    SAIDA.write_text(json.dumps({
        "fonte": "ANTT - Portal de Dados Abertos - Pontes e similares das rodovias concedidas (CC-BY)",
        "url": url,
        "atualizado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": len(itens),
        "itens": itens,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("OK: %d obras de arte salvas em %s (%d linhas sem coordenada válida)" % (len(itens), SAIDA, descartadas))


if __name__ == "__main__":
    main()
