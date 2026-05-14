// api/test-sources.js – Vercel Serverless Function
// Prueba todos los endpoints de datos y devuelve respuesta cruda para inspección

export const config = { maxDuration: 60 };

const SOAP_URL = 'https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService';

// Coordenadas zonas paperas relevantes
const LOCATIONS = {
  ipiales:   { lat:  0.8304, lon: -77.6441, nombre: 'Ipiales (plaza mercado)' },
  tuquerres: { lat:  1.0833, lon: -77.6167, nombre: 'Túquerres (zona productora)' },
  pasto:     { lat:  1.2136, lon: -77.2811, nombre: 'Pasto (central mayorista)' },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function soapCall(methodName, params = {}, timeoutMs = 25000) {
  const paramsXml = Object.entries(params)
    .map(([k, v]) => `<ser:${k}>${v}</ser:${k}>`)
    .join('\n        ');

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:ser="http://servicios.sipsa.co.gov.dane/">
  <soap:Header/>
  <soap:Body>
    <ser:${methodName}>
        ${paramsXml}
    </ser:${methodName}>
  </soap:Body>
</soap:Envelope>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(SOAP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml;charset=UTF-8',
        'SOAPAction': '""',
      },
      body: envelope,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await r.text();
    const httpStatus = r.status;

    // Contar registros <return>
    const matches = text.match(/<[^:]*:?return>/g) || [];

    // Extraer primeros 2 bloques para muestra
    const blockRe = /<(?:[^:>\s]+:)?return>([\s\S]*?)<\/(?:[^:>\s]+:)?return>/g;
    const samples = [];
    let m;
    while ((m = blockRe.exec(text)) !== null && samples.length < 2) {
      // Parsear campos del bloque
      const fields = {};
      const fieldRe = /<([a-zA-Z][a-zA-Z0-9_]*)>([^<]*)<\/\1>/g;
      let fm;
      while ((fm = fieldRe.exec(m[1])) !== null) {
        fields[fm[1]] = fm[2].trim();
      }
      samples.push(fields);
    }

    // Detectar error SOAP
    const hasFault = text.includes('<soap:Fault>') || text.includes('<Fault>');

    return {
      ok: !hasFault && r.ok,
      httpStatus,
      totalRegistros: matches.length,
      hasFault,
      muestraPrimeros2: samples,
      xmlPreview: text.slice(0, 800), // primeros 800 chars del XML
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      error: e.name === 'AbortError' ? 'TIMEOUT (25s)' : e.message,
      totalRegistros: 0,
    };
  }
}

async function openMeteoTest(lat, lon, nombre) {
  // Histórico: últimos 30 días
  const hoy = new Date();
  const hace30 = new Date(hoy);
  hace30.setDate(hoy.getDate() - 30);
  const fmt = d => d.toISOString().split('T')[0];

  const histUrl = `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat}&longitude=${lon}` +
    `&start_date=${fmt(hace30)}&end_date=${fmt(hoy)}` +
    `&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,` +
    `soil_moisture_0_to_7cm,et0_fao_evapotranspiration` +
    `&timezone=America%2FBogota`;

  // Pronóstico: 7 días
  const fcstUrl = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,` +
    `precipitation_probability_max` +
    `&forecast_days=7&timezone=America%2FBogota`;

  const [histRes, fcstRes] = await Promise.allSettled([
    fetch(histUrl, { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
    fetch(fcstUrl, { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
  ]);

  const hist = histRes.status === 'fulfilled' ? histRes.value : { error: histRes.reason?.message };
  const fcst = fcstRes.status === 'fulfilled' ? fcstRes.value : { error: fcstRes.reason?.message };

  // Muestra: último día disponible
  const ultimoDia = hist.daily ? {
    fecha:          hist.daily.time?.at(-1),
    lluvia_mm:      hist.daily.precipitation_sum?.at(-1),
    temp_max:       hist.daily.temperature_2m_max?.at(-1),
    temp_min:       hist.daily.temperature_2m_min?.at(-1),
    humedad_suelo:  hist.daily.soil_moisture_0_to_7cm?.at(-1),
    evapotrans:     hist.daily.et0_fao_evapotranspiration?.at(-1),
  } : null;

  const proximoDia = fcst.daily ? {
    fecha:          fcst.daily.time?.[0],
    lluvia_mm:      fcst.daily.precipitation_sum?.[0],
    prob_lluvia_pct: fcst.daily.precipitation_probability_max?.[0],
    temp_max:       fcst.daily.temperature_2m_max?.[0],
    temp_min:       fcst.daily.temperature_2m_min?.[0],
  } : null;

  return {
    nombre,
    coordenadas: { lat, lon },
    historico: {
      ok:           !hist.error,
      diasDisponibles: hist.daily?.time?.length || 0,
      variablesRecibidas: hist.daily ? Object.keys(hist.daily).filter(k => k !== 'time') : [],
      ultimoDia,
      error:        hist.error,
    },
    pronostico: {
      ok:           !fcst.error,
      diasDisponibles: fcst.daily?.time?.length || 0,
      proximoDia,
      error:        fcst.error,
    },
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ahora = new Date().toISOString();
  const mesActual = new Date().getMonth() + 1;
  const anioActual = new Date().getFullYear();
  // Mes anterior para insumos (se publican con rezago)
  const mesAnterior = mesActual === 1 ? 12 : mesActual - 1;
  const anioAnterior = mesActual === 1 ? anioActual - 1 : anioActual;

  console.log('[test-sources] iniciando pruebas...');

  // ── Ejecutar todas las pruebas en paralelo donde sea posible ──────────────
  const [
    soapPrecios,
    soapAbastecimiento,
    soapInsumos,
    climaIpiales,
    climaTuquerres,
    climaPasto,
  ] = await Promise.allSettled([

    // 1. Precios diarios — ya probado y funciona
    soapCall('promediosSipsaCiudad', {}),

    // 2. Abastecimiento mensual — parámetros mes/año
    soapCall('promedioAbasSipsaMesMadr', {
      mes:  mesAnterior,
      anio: anioAnterior,
    }),

    // 3. Insumos agrícolas mensual — parámetros mes/año
    soapCall('consultarInsumosSipsaMesMadr', {
      mes:  mesAnterior,
      anio: anioAnterior,
    }),

    // 4-6. Clima Open-Meteo para 3 ubicaciones
    openMeteoTest(LOCATIONS.ipiales.lat,   LOCATIONS.ipiales.lon,   LOCATIONS.ipiales.nombre),
    openMeteoTest(LOCATIONS.tuquerres.lat, LOCATIONS.tuquerres.lon, LOCATIONS.tuquerres.nombre),
    openMeteoTest(LOCATIONS.pasto.lat,     LOCATIONS.pasto.lon,     LOCATIONS.pasto.nombre),
  ]);

  const resultado = {
    generado: ahora,
    parametrosUsados: {
      mesConsultado: mesAnterior,
      anioConsultado: anioAnterior,
    },

    fuentes: {

      sipsa_precios_diarios: {
        descripcion: 'promediosSipsaCiudad — precio mayorista diario por producto/ciudad',
        ...(soapPrecios.status === 'fulfilled' ? soapPrecios.value : { ok: false, error: soapPrecios.reason?.message }),
      },

      sipsa_abastecimiento_mensual: {
        descripcion: 'promedioAbasSipsaMesMadr — toneladas abastecidas por producto/ciudad/mes',
        parametros: { mes: mesAnterior, anio: anioAnterior },
        ...(soapAbastecimiento.status === 'fulfilled' ? soapAbastecimiento.value : { ok: false, error: soapAbastecimiento.reason?.message }),
      },

      sipsa_insumos_mensual: {
        descripcion: 'consultarInsumosSipsaMesMadr — precios fertilizantes/ACPM por municipio/mes',
        parametros: { mes: mesAnterior, anio: anioAnterior },
        ...(soapInsumos.status === 'fulfilled' ? soapInsumos.value : { ok: false, error: soapInsumos.reason?.message }),
      },

      clima_open_meteo: {
        descripcion: 'Open-Meteo — histórico 30d + pronóstico 7d para zonas paperas Nariño',
        sinApiKey: true,
        ubicaciones: [
          soapPrecios.status === 'fulfilled' ? climaIpiales.value   : { error: climaIpiales.reason?.message },
          soapPrecios.status === 'fulfilled' ? climaTuquerres.value : { error: climaTuquerres.reason?.message },
          soapPrecios.status === 'fulfilled' ? climaPasto.value     : { error: climaPasto.reason?.message },
        ].map((r, i) => {
          const ubicaciones = [climaIpiales, climaTuquerres, climaPasto];
          return ubicaciones[i].status === 'fulfilled'
            ? ubicaciones[i].value
            : { error: ubicaciones[i].reason?.message };
        }),
      },
    },

    resumen: {
      sipsa_precios:        soapPrecios.status === 'fulfilled'        && soapPrecios.value.ok        ? '✅ OK' : '❌ FALLO',
      sipsa_abastecimiento: soapAbastecimiento.status === 'fulfilled' && soapAbastecimiento.value.ok ? '✅ OK' : '❌ FALLO',
      sipsa_insumos:        soapInsumos.status === 'fulfilled'        && soapInsumos.value.ok        ? '✅ OK' : '❌ FALLO',
      clima_ipiales:        climaIpiales.status === 'fulfilled'       && climaIpiales.value.historico.ok ? '✅ OK' : '❌ FALLO',
      clima_tuquerres:      climaTuquerres.status === 'fulfilled'     && climaTuquerres.value.historico.ok ? '✅ OK' : '❌ FALLO',
      clima_pasto:          climaPasto.status === 'fulfilled'         && climaPasto.value.historico.ok ? '✅ OK' : '❌ FALLO',
    },
  };

  return res.status(200).json(resultado);
}
