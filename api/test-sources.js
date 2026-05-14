// api/test-sources-v2.js – v3
export const config = { maxDuration: 60 };

const SOAP_URL = 'https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService';

// ─── SOAP helper ─────────────────────────────────────────────────────────────
async function soapCall(methodName, params = {}, timeoutMs = 25000) {
  const paramsXml = Object.entries(params)
    .map(([k, v]) => `<ser:${k}>${v}</ser:${k}>`)
    .join('\n');

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:ser="http://servicios.sipsa.co.gov.dane/">
  <soap:Header/>
  <soap:Body>
    <ser:${methodName}>${paramsXml}</ser:${methodName}>
  </soap:Body>
</soap:Envelope>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(SOAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml;charset=UTF-8', 'SOAPAction': '""' },
      body: envelope,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    const matches = text.match(/<[^:]*:?return>/g) || [];

    const blockRe = /<(?:[^:>\s]+:)?return>([\s\S]*?)<\/(?:[^:>\s]+:)?return>/g;
    const samples = [];
    let m;
    while ((m = blockRe.exec(text)) !== null && samples.length < 3) {
      const fields = {};
      const fieldRe = /<([a-zA-Z][a-zA-Z0-9_]*)>([^<]*)<\/\1>/g;
      let fm;
      while ((fm = fieldRe.exec(m[1])) !== null) fields[fm[1]] = fm[2].trim();
      if (Object.keys(fields).length > 0) samples.push(fields);
    }

    return {
      ok: !text.includes('<soap:Fault>') && r.ok,
      httpStatus: r.status,
      totalRegistros: matches.length,
      campos: samples[0] ? Object.keys(samples[0]) : [],
      muestra: samples,
      xmlRaw: text.slice(0, 400),
    };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === 'AbortError' ? 'TIMEOUT 25s' : e.message };
  }
}

// ─── Open-Meteo: 4 métodos ───────────────────────────────────────────────────
async function testOpenMeteo(lat, lon, nombre) {
  const hoy    = new Date();
  const ayer   = new Date(hoy); ayer.setDate(hoy.getDate() - 2);
  const hace30 = new Date(hoy); hace30.setDate(hoy.getDate() - 32);
  const fmt = d => d.toISOString().split('T')[0];

  const vars = 'precipitation_sum,temperature_2m_max,temperature_2m_min,soil_moisture_0_to_7cm,et0_fao_evapotranspiration';
  const tz = 'America%2FBogota';

  const urls = {
    metodo1_forecast_past30: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${vars}&past_days=30&forecast_days=1&timezone=${tz}`,
    metodo2_archive: `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${fmt(hace30)}&end_date=${fmt(ayer)}&daily=${vars}&timezone=${tz}`,
    metodo3_era5: `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${fmt(hace30)}&end_date=${fmt(ayer)}&daily=${vars}&models=era5&timezone=${tz}`,
    metodo4_pronostico7d: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,precipitation_probability_max,soil_moisture_0_to_7cm&forecast_days=7&timezone=${tz}`,
  };

  const resultados = {};
  for (const [key, url] of Object.entries(urls)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      if (j.error) {
        resultados[key] = { ok: false, error: j.reason };
      } else {
        const dias = j.daily?.time?.length || 0;
        resultados[key] = {
          ok: dias > 0,
          diasDisponibles: dias,
          variables: j.daily ? Object.keys(j.daily).filter(k => k !== 'time') : [],
          primerDia: j.daily ? {
            fecha: j.daily.time?.[0],
            lluvia_mm: j.daily.precipitation_sum?.[0],
            temp_max: j.daily.temperature_2m_max?.[0],
            humedad_suelo: j.daily.soil_moisture_0_to_7cm?.[0],
          } : null,
          ultimoDia: j.daily ? {
            fecha: j.daily.time?.at(-1),
            lluvia_mm: j.daily.precipitation_sum?.at(-1),
            temp_max: j.daily.temperature_2m_max?.at(-1),
            humedad_suelo: j.daily.soil_moisture_0_to_7cm?.at(-1),
          } : null,
        };
      }
    } catch (e) {
      resultados[key] = { ok: false, error: e.message };
    }
  }
  return { nombre, coordenadas: { lat, lon }, metodos: resultados };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const [
    ins_mar26, ins_feb26, ins_ene26, ins_dic25, ins_vacio,
    clima_ipiales, clima_tuquerres, clima_pasto,
  ] = await Promise.allSettled([
    soapCall('consultarInsumosSipsaMesMadr', { mes: 3,  anio: 2026 }),
    soapCall('consultarInsumosSipsaMesMadr', { mes: 2,  anio: 2026 }),
    soapCall('consultarInsumosSipsaMesMadr', { mes: 1,  anio: 2026 }),
    soapCall('consultarInsumosSipsaMesMadr', { mes: 12, anio: 2025 }),
    soapCall('consultarInsumosSipsaMesMadr', {}),
    testOpenMeteo(0.8304,  -77.6441, 'Ipiales'),
    testOpenMeteo(1.0833,  -77.6167, 'Túquerres'),
    testOpenMeteo(1.2136,  -77.2811, 'Pasto'),
  ]);

  const v = p => p.status === 'fulfilled' ? p.value : { ok: false, error: p.reason?.message };

  const insumos = {
    mar_2026:   v(ins_mar26),
    feb_2026:   v(ins_feb26),
    ene_2026:   v(ins_ene26),
    dic_2025:   v(ins_dic25),
    sin_params: v(ins_vacio),
  };

  const insumosOk = Object.entries(insumos)
    .filter(([, val]) => val.ok && val.totalRegistros > 0)
    .map(([k, val]) => `${k}: ${val.totalRegistros} registros`);

  const ipiales = v(clima_ipiales);
  const metodosOk = ipiales.metodos
    ? Object.entries(ipiales.metodos).filter(([, val]) => val.ok).map(([k, val]) => `${k}: ${val.diasDisponibles} días`)
    : [];

  return res.status(200).json({
    generado: new Date().toISOString(),
    sipsa_insumos: { descripcion: 'consultarInsumosSipsaMesMadr — 5 variantes', resultados: insumos },
    open_meteo: {
      descripcion: '4 métodos histórico + pronóstico',
      ipiales:   v(clima_ipiales),
      tuquerres: v(clima_tuquerres),
      pasto:     v(clima_pasto),
    },
    resumen: {
      insumos_con_datos: insumosOk.length > 0 ? insumosOk : ['❌ ninguna variante devuelve datos'],
      open_meteo_metodos_ok: metodosOk.length > 0 ? metodosOk : ['❌ ningún método histórico funciona'],
      open_meteo_pronostico: ipiales.metodos?.metodo4_pronostico7d?.ok ? '✅ pronóstico 7d OK' : '❌ fallo',
    },
  });
}
