// api/sipsa.js – Vercel Serverless Function
// Robusto: caché en memoria, reintento automático, timeout extendido, fallback

// ─── Configuración Vercel (extiende timeout al máximo del plan hobby) ────────
export const config = { maxDuration: 60 };

// ─── Caché en memoria (persiste entre requests del mismo worker) ─────────────
// Evita llamar al DANE en cada visita; se invalida cada 6 horas
let _cache = null; // { data, timestamp }
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 horas en ms

// ─── Helpers ─────────────────────────────────────────────────────────────────
const SOAP_URL = 'https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService';

const ENVELOPE = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:ser="http://servicios.sipsa.co.gov.dane/">
  <soap:Header/>
  <soap:Body><ser:promediosSipsaCiudad/></soap:Body>
</soap:Envelope>`;

// Extrae texto de una etiqueta XML sin librerías externas
function getTag(block, tag) {
  const m = block.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`));
  return m ? m[1].trim() : '';
}

// Llama al DANE con timeout configurable
async function fetchSOAP(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(SOAP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml;charset=UTF-8',
        'SOAPAction': '""',
      },
      body: ENVELOPE,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`DANE HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// Parsea el XML y devuelve { historico, prediccion }
function parsearYPredecir(xmlText) {
  // Soporta namespaces variables en las etiquetas return
  const blockRe = /<(?:[^:>\s]+:)?return>([\s\S]*?)<\/(?:[^:>\s]+:)?return>/g;
  const porFecha = {};
  let match;

  while ((match = blockRe.exec(xmlText)) !== null) {
    const block  = match[1];
    const prod   = getTag(block, 'producto').toLowerCase();
    const fecha  = getTag(block, 'fechaCaptura').split('T')[0];
    const precio = parseFloat(getTag(block, 'precioPromedio'));

    if (!prod.includes('papa') || !fecha || isNaN(precio) || precio <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    (porFecha[fecha] = porFecha[fecha] || []).push(precio);
  }

  if (Object.keys(porFecha).length === 0)
    throw new Error('El servicio SIPSA no devolvió registros de papa');

  // Promedio nacional diario
  const historico = Object.entries(porFecha)
    .map(([fecha, arr]) => ({
      fecha,
      precio: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  // Predicción: media móvil 30d + regresión lineal → 7 días
  const ventana = historico.slice(-30).map(d => d.precio);
  const n       = ventana.length;
  const media   = ventana.reduce((a, b) => a + b, 0) / n;
  const xMean   = (n - 1) / 2;
  let num = 0, den = 0;
  ventana.forEach((y, x) => {
    num += (x - xMean) * (y - media);
    den += (x - xMean) ** 2;
  });
  const slope = den ? num / den : 0;

  const base = new Date(historico.at(-1).fecha + 'T12:00:00Z');
  const prediccion = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i + 1);
    return {
      fecha:  d.toISOString().split('T')[0],
      precio: Math.round(Math.max(media + slope * (n + i), 500)),
    };
  });

  return { historico, prediccion };
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ahora = Date.now();

  // ── Servir desde caché si es válido ────────────────────────────────────────
  if (_cache && (ahora - _cache.timestamp) < CACHE_TTL) {
    return res.status(200).json({
      ..._cache.data,
      fromCache: true,
      cacheAge: Math.round((ahora - _cache.timestamp) / 60000),
    });
  }

  // ── Intentar llamar al DANE (2 intentos) ───────────────────────────────────
  let ultimoError = null;

  for (let intento = 1; intento <= 2; intento++) {
    try {
      const xml  = await fetchSOAP(25000);
      const data = parsearYPredecir(xml);

      const respuesta = {
        ok:        true,
        generado:  new Date().toISOString(),
        fromCache: false,
        intento,
        ...data,
      };

      _cache = { data: respuesta, timestamp: ahora };
      return res.status(200).json(respuesta);

    } catch (e) {
      ultimoError = e;
      console.error(`[sipsa] intento ${intento} falló:`, e.message);
      if (intento === 1) await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ── Ambos intentos fallaron: devolver caché vencida si existe ──────────────
  if (_cache) {
    const edadHoras = ((ahora - _cache.timestamp) / 3600000).toFixed(1);
    return res.status(200).json({
      ..._cache.data,
      fromCache:    true,
      cacheVencida: true,
      cacheAge:     Math.round((ahora - _cache.timestamp) / 60000),
      advertencia:  `Datos de hace ${edadHoras}h — el servicio DANE no respondió`,
    });
  }

  // ── Sin caché y sin datos ──────────────────────────────────────────────────
  const esCaida = ultimoError?.name === 'AbortError' ||
                  ultimoError?.message?.includes('abort');

  return res.status(503).json({
    ok:         false,
    error:      esCaida
      ? 'El servicio SIPSA del DANE no respondió a tiempo.'
      : `Error consultando DANE: ${ultimoError?.message}`,
    sugerencia: 'El DANE actualiza precios después de las 2 p.m. Los fines de semana el servicio puede estar inactivo.',
  });
}
