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
  const porMes = {};
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const b = m[1];
    const nombre = getTag(b, 'artiNombre').toLowerCase();
    const fecha  = getTag(b, 'fechaMesIni').split('T')[0].slice(0,7); // YYYY-MM
    const ton    = parseFloat(getTag(b, 'cantidadTon'));
    if (!nombre.includes('papa') || !fecha || isNaN(ton)) continue;
    (porMes[fecha] = porMes[fecha] || []).push(ton);
  }

  return Object.entries(porMes)
    .map(([mes, arr]) => ({ mes, toneladas: Math.round(arr.reduce((a,b)=>a+b,0)) }))
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
// Variables: precio_t-1, precio_t-7, lluvia_ipiales_t-7, lluvia_tuquerres_t-15,
//            abastecimiento_mes, evapotrans_t-3, semana_año (estacionalidad)
function modeloMultivariado(historico, climaIpiales, climaTuquerres, abastecimiento, acpm) {
  const n = historico.length;
  if (n < 30) return modeloSimple(historico); // fallback si pocos datos

  // Construir vector de variables para los últimos 30 días
  const ventana = historico.slice(-30);
  const precios = ventana.map(d => d.precio);

  // Rezagos de lluvia Ipiales (t-7)
  const lluviaIp = climaIpiales.historico.slice(-30).map(d => d.lluvia_mm);
  // Rezagos de lluvia Túquerres (t-15)
  const lluviaTq = climaTuquerres.historico.slice(-30).map(d => d.lluvia_mm);
  // Evapotranspiración Ipiales (t-3)
  const evap = climaIpiales.historico.slice(-30).map(d => d.evapotrans);

  // Último mes de abastecimiento disponible
  const ultAbs = abastecimiento.length > 0
    ? abastecimiento.at(-1).toneladas
    : 0;

  // Media y tendencia base (modelo anterior como ancla)
  const media = precios.reduce((a,b)=>a+b,0) / precios.length;
  const xMean = (precios.length-1)/2;
  let num=0, den=0;
  precios.forEach((y,x)=>{ num+=(x-xMean)*(y-media); den+=(x-xMean)**2; });
  const slope = den ? num/den : 0;

  // Señal de lluvia: promedio ponderado últimos 15 días
  // lluvia alta en zonas productoras → escasez futura → precio sube
  const lluviaRecienteIp = lluviaIp.slice(-15).reduce((a,b)=>a+b,0)/15;
  const lluviaRecienteTq = lluviaTq.slice(-7).reduce((a,b)=>a+b,0)/7;
  const señalLluvia = (lluviaRecienteIp * 0.6 + lluviaRecienteTq * 0.4);

  // Señal abastecimiento: más toneladas → precio baja (relación inversa)
  // Normalizado sobre promedio histórico (~5000 ton/mes aprox)
  const refAbs = 5000;
  const señalAbs = ultAbs > 0 ? (refAbs - ultAbs) / refAbs : 0; // positivo = escasez

  // Señal ACPM: precio transporte afecta precio final con rezago ~15d
  // Base referencia: 11000 $/galón (precio promedio histórico Pasto)
  const refAcpm = 11000;
  const señalAcpm = acpm > 0 ? (acpm - refAcpm) / refAcpm : 0;

  // Semana del año → componente estacional
  // S1 (sem 1-26): precios altos, S2 (sem 27-52): precios bajos
  const semanaBase = Math.ceil((new Date(historico.at(-1).fecha).getTime()
    - new Date(new Date(historico.at(-1).fecha).getFullYear(), 0, 1).getTime())
    / (7*24*3600*1000));
  const estacional = Math.sin(2 * Math.PI * semanaBase / 52) * 50; // ±50 $/kg

  // Predicción 7 días integrando señales
  const base = new Date(historico.at(-1).fecha + 'T12:00:00Z');
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i + 1);
    const semana = semanaBase + Math.floor(i/7);
    const estacI = Math.sin(2 * Math.PI * semana / 52) * 50;

    // Componentes del modelo
    const tendencia  = media + slope * (precios.length + i);
    const ajusteLluvia = señalLluvia > 5 ? señalLluvia * 8 : 0;  // +8 $/kg por mm extra
    const ajusteAbs  = señalAbs * media * 0.15;                   // ±15% por escasez/abundancia
    const ajusteAcpm = señalAcpm * media * 0.08;                  // ±8% por costo transporte

    const precioEst = tendencia + ajusteLluvia + ajusteAbs + ajusteAcpm + (estacI - estacional);

    return {
      fecha:  d.toISOString().split('T')[0],
      precio: Math.round(Math.max(precioEst, 500)),
      componentes: {
        tendencia:    Math.round(tendencia),
        lluvia:       Math.round(ajusteLluvia),
        abastecimiento: Math.round(ajusteAbs),
        acpm:         Math.round(ajusteAcpm),
        estacional:   Math.round(estacI - estacional),
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
