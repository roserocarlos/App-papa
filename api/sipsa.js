// api/sipsa.js  –  Vercel Serverless Function (Node.js)
// Llama al servicio SOAP del DANE, filtra papa, calcula promedio diario
// y devuelve { historico, prediccion } como JSON con CORS abierto.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SOAP_URL =
    'https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService';

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
               xmlns:ser="http://servicios.sipsa.co.gov.dane/">
  <soap:Header/>
  <soap:Body><ser:promediosSipsaCiudad/></soap:Body>
</soap:Envelope>`;

  try {
    const upstream = await fetch(SOAP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml;charset=UTF-8',
        'SOAPAction': '""',
      },
      body: envelope,
      // Vercel functions tienen 10 s por defecto en hobby plan
      signal: AbortSignal.timeout(9000),
    });

    if (!upstream.ok)
      throw new Error(`DANE respondió HTTP ${upstream.status}`);

    const xmlText = await upstream.text();

    // ── Parse XML sin dependencias externas ──────────────────────────────
    // Extraer bloques <return>…</return>
    const blockRe = /<[^:]*:?return>([\s\S]*?)<\/[^:]*:?return>/g;
    const getTag  = (block, tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : '';
    };

    const porFecha = {};
    let match;
    while ((match = blockRe.exec(xmlText)) !== null) {
      const block   = match[1];
      const prod    = getTag(block, 'producto').toLowerCase();
      const fecha   = getTag(block, 'fechaCaptura').split('T')[0];
      const precioS = getTag(block, 'precioPromedio');
      const precio  = parseFloat(precioS);

      if (!prod.includes('papa') || !fecha || isNaN(precio)) continue;
      (porFecha[fecha] = porFecha[fecha] || []).push(precio);
    }

    if (Object.keys(porFecha).length === 0)
      throw new Error('No se encontraron registros de papa en la respuesta SOAP');

    // Promedio nacional diario
    const historico = Object.entries(porFecha)
      .map(([fecha, arr]) => ({
        fecha,
        precio: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
      }))
      .sort((a, b) => a.fecha.localeCompare(b.fecha));

    // ── Predicción: media móvil 30d + tendencia lineal → 7 días ─────────
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
        precio: Math.round(media + slope * (n + i)),
      };
    });

    return res.status(200).json({
      ok: true,
      generado: new Date().toISOString(),
      historico,
      prediccion,
    });

  } catch (err) {
    console.error('[sipsa]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
