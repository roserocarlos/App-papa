// api/sipsa.js – Vercel Serverless Function
// Fuentes: SIPSA precios + SIPSA abastecimiento + Open-Meteo clima + variables manuales
// Modelo: regresión lineal múltiple con rezagos sobre variables confirmadas

export const config = { maxDuration: 60 };

// ─── Caché en memoria 6 horas ─────────────────────────────────────────────────
let _cache = null;
const CACHE_TTL = 6 * 60 * 60 * 1000;

const SOAP_URL = 'https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService';

// ─── Zonas paperas Nariño ─────────────────────────────────────────────────────
const ZONAS = {
  ipiales:   { lat:  0.8304, lon: -77.6441 },
  tuquerres: { lat:  1.0833, lon: -77.6167 },
  pasto:     { lat:  1.2136, lon: -77.2811 },
};

// ─── SOAP helper ──────────────────────────────────────────────────────────────
function getTag(block, tag) {
  const m = block.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`));
  return m ? m[1].trim() : '';
}

async function fetchSOAP(envelope, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(SOAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml;charset=UTF-8', 'SOAPAction': '""' },
      body: envelope,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`DANE HTTP ${r.status}`);
    return await r.text();
  } catch (e) { clearTimeout(t); throw e; }
}

// ─── SIPSA: precios diarios ───────────────────────────────────────────────────
async function fetchPrecios() {
  const xml = await fetchSOAP(`<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:ser="http://servicios.sipsa.co.gov.dane/">
  <soap:Header/><soap:Body><ser:promediosSipsaCiudad/></soap:Body>
</soap:Envelope>`);

  const blockRe = /<(?:[^:>\s]+:)?return>([\s\S]*?)<\/(?:[^:>\s]+:)?return>/g;
  const porFecha = {};
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const b = m[1];
    const prod  = getTag(b, 'producto').toLowerCase();
    const fecha = getTag(b, 'fechaCaptura').split('T')[0];
    const precio = parseFloat(getTag(b, 'precioPromedio'));
    if (!prod.includes('papa') || !fecha || isNaN(precio) || precio <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    (porFecha[fecha] = porFecha[fecha] || []).push(precio);
  }
  if (!Object.keys(porFecha).length) throw new Error('SIPSA no devolvió registros de papa');

  return Object.entries(porFecha)
    .map(([fecha, arr]) => ({ fecha, precio: Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) }))
    .sort((a,b) => a.fecha.localeCompare(b.fecha));
}

// ─── SIPSA: abastecimiento mensual ────────────────────────────────────────────
async function fetchAbastecimiento() {
  const xml = await fetchSOAP(`<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:ser="http://servicios.sipsa.co.gov.dane/">
  <soap:Header/><soap:Body><ser:promedioAbasSipsaMesMadr/></soap:Body>
</soap:Envelope>`, 25000);

  const blockRe = /<(?:[^:>\s]+:)?return>([\s\S]*?)<\/(?:[^:>\s]+:)?return>/g;
  // porMes: { 'YYYY-MM': { fuentes: Set(), ton: number } }
  // Usamos fuenId para no duplicar la misma fuente/ciudad en el mismo mes
  const porMes = {};
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const b      = m[1];
    const nombre = getTag(b, 'artiNombre').toLowerCase();
    const fecha  = getTag(b, 'fechaMesIni').split('T')[0].slice(0,7);
    const fuente = getTag(b, 'fuenId');
    const ton    = parseFloat(getTag(b, 'cantidadTon'));
    if (!nombre.includes('papa') || !fecha || isNaN(ton) || ton <= 0) continue;
    if (!porMes[fecha]) porMes[fecha] = { fuentesTon: {} };
    // Una sola entrada por fuente por mes (evita duplicados)
    if (!porMes[fecha].fuentesTon[fuente]) {
      porMes[fecha].fuentesTon[fuente] = ton;
    }
  }

  return Object.entries(porMes)
    .map(([mes, d]) => {
      const vals = Object.values(d.fuentesTon);
      // Total nacional = suma de todas las centrales de abasto
      const totalTon = vals.reduce((a,b) => a+b, 0);
      return { mes, toneladas: Math.round(totalTon), fuentes: vals.length };
    })
    .sort((a,b) => a.mes.localeCompare(b.mes));
}

// ─── Open-Meteo: clima histórico 30d + pronóstico 7d ─────────────────────────
async function fetchClima(lat, lon) {
  const vars = 'precipitation_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration,rain_sum';
  const tz   = 'America%2FBogota';

  const [histR, fcstR] = await Promise.allSettled([
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${vars}&past_days=30&forecast_days=1&timezone=${tz}`, { signal: AbortSignal.timeout(10000) }).then(r=>r.json()),
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,precipitation_probability_max,rain_sum&forecast_days=7&timezone=${tz}`, { signal: AbortSignal.timeout(10000) }).then(r=>r.json()),
  ]);

  const hist = histR.status === 'fulfilled' && !histR.value.error ? histR.value : null;
  const fcst = fcstR.status === 'fulfilled' && !fcstR.value.error ? fcstR.value : null;

  const historico = hist?.daily?.time?.map((fecha, i) => ({
    fecha,
    lluvia_mm:   hist.daily.precipitation_sum?.[i] ?? 0,
    temp_max:    hist.daily.temperature_2m_max?.[i] ?? 0,
    temp_min:    hist.daily.temperature_2m_min?.[i] ?? 0,
    evapotrans:  hist.daily.et0_fao_evapotranspiration?.[i] ?? 0,
  })) || [];

  const pronostico = fcst?.daily?.time?.map((fecha, i) => ({
    fecha,
    lluvia_mm:      fcst.daily.precipitation_sum?.[i] ?? 0,
    prob_lluvia:    fcst.daily.precipitation_probability_max?.[i] ?? 0,
    temp_max:       fcst.daily.temperature_2m_max?.[i] ?? 0,
    temp_min:       fcst.daily.temperature_2m_min?.[i] ?? 0,
  })) || [];

  return { historico, pronostico };
}

// ─── Modelo multivariado con rezagos ──────────────────────────────────────────
// Ancla: media móvil 30d + tendencia lineal (probado y estable)
// Ajustes contextuales pequeños: lluvia, abastecimiento, ACPM, estacionalidad
// Cada ajuste está LIMITADO para no superar ±8% del precio base
function modeloMultivariado(historico, climaIpiales, climaTuquertes, abastecimiento, acpm) {
  const n = historico.length;
  if (n < 30) return modeloSimple(historico);

  const precios = historico.slice(-30).map(d => d.precio);
  const media   = precios.reduce((a,b) => a+b, 0) / precios.length;
  const xMean   = (precios.length - 1) / 2;
  let num = 0, den = 0;
  precios.forEach((y, x) => { num += (x-xMean)*(y-media); den += (x-xMean)**2; });
  const slope = den ? num / den : 0;

  // ── Señal lluvia: promedio últimos 7 días en Ipiales ─────────────────────
  // Solo ajusta si lluvia es notablemente alta (>10mm/día promedio)
  // Efecto: lluvia intensa → puede afectar cosecha → leve presión alcista
  const lluviaIp = climaIpiales.historico.slice(-7).map(d => d.lluvia_mm);
  const lluviaMedia7 = lluviaIp.length
    ? lluviaIp.reduce((a,b)=>a+b,0) / lluviaIp.length
    : 0;
  // Ajuste máximo ±5% del precio base, solo si lluvia > 10mm/día
  const señalLluvia = lluviaMedia7 > 10
    ? Math.min((lluviaMedia7 - 10) / 10, 1) * 0.05  // +0 a +5%
    : 0;

  // ── Señal abastecimiento ─────────────────────────────────────────────────
  // Comparar último mes vs promedio histórico de los datos disponibles
  // Ajuste máximo ±6%
  let señalAbs = 0;
  if (abastecimiento.length >= 3) {
    const tonHist = abastecimiento.map(d => d.toneladas);
    const mediaAbs = tonHist.slice(0, -1).reduce((a,b) => a+b, 0) / (tonHist.length - 1);
    const ultTon   = tonHist.at(-1);
    if (mediaAbs > 0) {
      const ratio = (ultTon - mediaAbs) / mediaAbs; // positivo = más oferta
      señalAbs = Math.max(-0.06, Math.min(0.06, -ratio * 0.3)); // inverso, limitado ±6%
    }
  }

  // ── Señal ACPM ───────────────────────────────────────────────────────────
  // Base: ~$11.000/galón Pasto. Ajuste máximo ±3%
  const refAcpm  = 11000;
  const señalAcpm = acpm > 0
    ? Math.max(-0.03, Math.min(0.03, (acpm - refAcpm) / refAcpm * 0.5))
    : 0;

  // ── Señal estacional ─────────────────────────────────────────────────────
  // Semestre 1 (ene-jun): precios históricam. más altos en Colombia
  // Ajuste ±4% según semana del año
  const fechaUlt = new Date(historico.at(-1).fecha + 'T12:00:00Z');
  const semanaBase = Math.ceil((fechaUlt - new Date(fechaUlt.getUTCFullYear(), 0, 1)) / (7*24*3600*1000));
  const factorEst  = Math.sin(2 * Math.PI * (semanaBase - 13) / 52); // pico en semana 13 (abril)
  const señalEst   = factorEst * 0.04; // ±4%

  // ── Predicción 7 días ────────────────────────────────────────────────────
  const base = new Date(fechaUlt);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i + 1);

    const tendencia    = media + slope * (precios.length + i);
    // Ajustes como fracción del precio tendencia — nunca colapsan el precio
    const ajLluvia     = tendencia * señalLluvia;
    const ajAbs        = tendencia * señalAbs;
    const ajAcpm       = tendencia * señalAcpm;
    const ajEst        = tendencia * señalEst * (i / 6); // crece gradualmente

    const precioEst = tendencia + ajLluvia + ajAbs + ajAcpm + ajEst;

    // Límite de variación: predicción no puede alejarse >15% del último precio real
    const precioHoy   = historico.at(-1).precio;
    const precioClamp = Math.max(precioHoy * 0.85, Math.min(precioHoy * 1.15, precioEst));

    return {
      fecha:  d.toISOString().split('T')[0],
      precio: Math.round(Math.max(precioClamp, 500)),
      componentes: {
        tendencia:      Math.round(tendencia),
        lluvia:         Math.round(ajLluvia),
        abastecimiento: Math.round(ajAbs),
        acpm:           Math.round(ajAcpm),
        estacional:     Math.round(ajEst),
      },
    };
  });
}

// Modelo simple fallback (media móvil + tendencia lineal)
function modeloSimple(historico) {
  const ventana = historico.slice(-30).map(d => d.precio);
  const n = ventana.length;
  const media = ventana.reduce((a,b)=>a+b,0)/n;
  const xMean = (n-1)/2;
  let num=0, den=0;
  ventana.forEach((y,x)=>{ num+=(x-xMean)*(y-media); den+=(x-xMean)**2; });
  const slope = den ? num/den : 0;
  const base = new Date(historico.at(-1).fecha + 'T12:00:00Z');
  return Array.from({length:7},(_,i)=>{
    const d = new Date(base); d.setUTCDate(d.getUTCDate()+i+1);
    return { fecha: d.toISOString().split('T')[0], precio: Math.round(Math.max(media+slope*(n+i),500)), componentes: null };
  });
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ahora = Date.now();

  // Variables manuales del frontend (query params)
  const acpm         = parseFloat(req.query.acpm)     || 11282; // default mayo 2026
  const precioFrontera = parseFloat(req.query.frontera) || 0;

  // Caché válida
  if (_cache && (ahora - _cache.timestamp) < CACHE_TTL && !req.query.refresh) {
    return res.status(200).json({ ..._cache.data, fromCache: true, cacheAge: Math.round((ahora-_cache.timestamp)/60000) });
  }

  let ultimoError = null;

  for (let intento = 1; intento <= 2; intento++) {
    try {
      // Ejecutar todas las fuentes en paralelo (clima no bloquea si falla)
      const [
        historico,
        abastecimiento,
        climaIpiales,
        climaTuquerres,
      ] = await Promise.all([
        fetchPrecios(),
        fetchAbastecimiento().catch(() => []),
        fetchClima(ZONAS.ipiales.lat,   ZONAS.ipiales.lon).catch(() => ({ historico:[], pronostico:[] })),
        fetchClima(ZONAS.tuquerres.lat, ZONAS.tuquerres.lon).catch(() => ({ historico:[], pronostico:[] })),
      ]);

      const prediccion = modeloMultivariado(historico, climaIpiales, climaTuquerres, abastecimiento, acpm);

      // Clima pronóstico para mostrar en front
      const climaPronostico = climaIpiales.pronostico.slice(0,7).map(d => ({
        fecha:       d.fecha,
        lluvia_mm:   d.lluvia_mm,
        prob_lluvia: d.prob_lluvia,
        temp_max:    d.temp_max,
        temp_min:    d.temp_min,
      }));

      // Último abastecimiento disponible
      const ultAbs = abastecimiento.at(-1) || null;

      const respuesta = {
        ok:           true,
        generado:     new Date().toISOString(),
        fromCache:    false,
        intento,
        historico,
        prediccion,
        contexto: {
          abastecimiento_ultimo: ultAbs,
          clima_pronostico_ipiales: climaPronostico,
          acpm_gallon: acpm,
          precio_frontera: precioFrontera,
          modelo: prediccion[0]?.componentes ? 'multivariado' : 'simple',
        },
      };

      _cache = { data: respuesta, timestamp: ahora };
      return res.status(200).json(respuesta);

    } catch (e) {
      ultimoError = e;
      console.error(`[sipsa] intento ${intento}:`, e.message);
      if (intento === 1) await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Caché vencida como fallback
  if (_cache) {
    const h = ((ahora-_cache.timestamp)/3600000).toFixed(1);
    return res.status(200).json({ ..._cache.data, fromCache:true, cacheVencida:true, cacheAge:Math.round((ahora-_cache.timestamp)/60000), advertencia:`Datos de hace ${h}h` });
  }

  return res.status(503).json({
    ok: false,
    error: ultimoError?.name==='AbortError' ? 'SIPSA no respondió a tiempo.' : `Error: ${ultimoError?.message}`,
    sugerencia: 'El DANE actualiza precios después de las 2 p.m. Los fines de semana puede estar inactivo.',
  });
}
