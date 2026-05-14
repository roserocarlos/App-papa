// api/sipsa.js
export const config = { maxDuration: 60 };

let _cache = null;
const CACHE_TTL = 6 * 60 * 60 * 1000;
const SOAP_URL = ‘https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService’;

const ZONAS = {
ipiales:   { lat:  0.8304, lon: -77.6441 },
tuquerres: { lat:  1.0833, lon: -77.6167 },
};

function getTag(block, tag) {
const open  = ‘<’ + tag + ‘>’;
const close = ‘</’ + tag + ‘>’;
const a = block.indexOf(open);
if (a === -1) {
const re = new RegExp(’<[^:>]+:’ + tag + ‘>’);
const ma = block.match(re);
if (!ma) return ‘’;
const b2 = block.indexOf(ma[0]) + ma[0].length;
const e2 = block.indexOf(’</’, b2);
return e2 === -1 ? ‘’ : block.slice(b2, e2).trim();
}
const start = a + open.length;
const end   = block.indexOf(close, start);
return end === -1 ? ‘’ : block.slice(start, end).trim();
}

function extraerBloques(xml) {
const results = [];
const OPEN  = ‘>return>’;
const CLOSE = ‘>return>’;
let pos = 0;
while (true) {
const a = xml.indexOf(OPEN, pos);
if (a === -1) break;
const start = a + OPEN.length;
const end = xml.indexOf(’</’, start);
if (end === -1) break;
results.push(xml.slice(start, end));
pos = end + 1;
}
return results;
}

function extraerBloquesAbs(xml) {
const results = [];
const TAG = ‘return’;
let pos = 0;
while (true) {
const startTag = xml.indexOf(’<’, pos);
if (startTag === -1) break;
const gt = xml.indexOf(’>’, startTag);
if (gt === -1) break;
const tagContent = xml.slice(startTag + 1, gt);
const localName = tagContent.split(’:’).pop().split(’ ’)[0];
if (localName === TAG) {
const closeTag = ‘</’ + tagContent + ‘>’;
const closeAlt = ‘</’ + localName + ‘>’;
let end = xml.indexOf(closeTag, gt);
if (end === -1) end = xml.indexOf(closeAlt, gt);
if (end === -1) { pos = gt + 1; continue; }
results.push(xml.slice(gt + 1, end));
pos = end + closeAlt.length;
} else {
pos = gt + 1;
}
}
return results;
}

async function fetchSOAP(envelope, timeoutMs) {
const ms = timeoutMs || 25000;
const ctrl = new AbortController();
const t = setTimeout(function() { ctrl.abort(); }, ms);
try {
const r = await fetch(SOAP_URL, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/soap+xml;charset=UTF-8’, ‘SOAPAction’: ‘””’ },
body: envelope,
signal: ctrl.signal,
});
clearTimeout(t);
if (!r.ok) throw new Error(’DANE HTTP ’ + r.status);
return await r.text();
} catch (e) { clearTimeout(t); throw e; }
}

async function fetchPrecios() {
const xml = await fetchSOAP(
‘<?xml version="1.0" encoding="UTF-8"?>’ +
‘<soap:Envelope xmlns:soap=“http://www.w3.org/2003/05/soap-envelope” xmlns:ser=“http://servicios.sipsa.co.gov.dane/”>’ +
‘<soap:Header/><soap:Body><ser:promediosSipsaCiudad/></soap:Body></soap:Envelope>’
);

const porFecha = {};
const bloques = extraerBloquesAbs(xml);
for (const b of bloques) {
const prod   = getTag(b, ‘producto’).toLowerCase();
const fecha  = getTag(b, ‘fechaCaptura’).split(‘T’)[0];
const precio = parseFloat(getTag(b, ‘precioPromedio’));
if (!prod.includes(‘papa’) || !fecha || isNaN(precio) || precio <= 0) continue;
if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
if (!porFecha[fecha]) porFecha[fecha] = [];
porFecha[fecha].push(precio);
}
const keys = Object.keys(porFecha);
if (!keys.length) throw new Error(‘SIPSA no devolvio registros de papa’);
return keys
.map(function(fecha) {
const arr = porFecha[fecha];
return { fecha: fecha, precio: Math.round(arr.reduce(function(a,b){return a+b;},0)/arr.length) };
})
.sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
}

async function fetchAbastecimiento() {
const xml = await fetchSOAP(
‘<?xml version="1.0" encoding="UTF-8"?>’ +
‘<soap:Envelope xmlns:soap=“http://www.w3.org/2003/05/soap-envelope” xmlns:ser=“http://servicios.sipsa.co.gov.dane/”>’ +
‘<soap:Header/><soap:Body><ser:promedioAbasSipsaMesMadr/></soap:Body></soap:Envelope>’,
10000
);

const porMes = {};
const bloques = extraerBloquesAbs(xml);
for (const b of bloques) {
const nombre = getTag(b, ‘artiNombre’).toLowerCase();
const fechaRaw = getTag(b, ‘fechaMesIni’).split(‘T’)[0];
const mes    = fechaRaw.slice(0, 7);
const fuente = getTag(b, ‘fuenId’);
const ton    = parseFloat(getTag(b, ‘cantidadTon’));
if (!nombre.includes(‘papa’) || !mes || isNaN(ton) || ton <= 0) continue;
if (!porMes[mes]) porMes[mes] = {};
if (!porMes[mes][fuente]) porMes[mes][fuente] = ton;
}
return Object.keys(porMes)
.map(function(mes) {
const vals = Object.values(porMes[mes]);
return { mes: mes, toneladas: Math.round(vals.reduce(function(a,b){return a+b;},0)), fuentes: vals.length };
})
.sort(function(a,b){ return a.mes < b.mes ? -1 : 1; });
}

async function fetchClima(lat, lon) {
const vars = ‘precipitation_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration,rain_sum’;
const tz   = ‘America%2FBogota’;
const u1 = ‘https://api.open-meteo.com/v1/forecast?latitude=’ + lat + ‘&longitude=’ + lon +
‘&daily=’ + vars + ‘&past_days=30&forecast_days=1&timezone=’ + tz;
const u2 = ‘https://api.open-meteo.com/v1/forecast?latitude=’ + lat + ‘&longitude=’ + lon +
‘&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,precipitation_probability_max,rain_sum&forecast_days=7&timezone=’ + tz;

const results = await Promise.allSettled([
fetch(u1, { signal: AbortSignal.timeout(10000) }).then(function(r){return r.json();}),
fetch(u2, { signal: AbortSignal.timeout(10000) }).then(function(r){return r.json();}),
]);

const hist = results[0].status === ‘fulfilled’ && !results[0].value.error ? results[0].value : null;
const fcst = results[1].status === ‘fulfilled’ && !results[1].value.error ? results[1].value : null;

const historico = hist && hist.daily && hist.daily.time
? hist.daily.time.map(function(fecha, i) {
return {
fecha: fecha,
lluvia_mm:  hist.daily.precipitation_sum[i] || 0,
temp_max:   hist.daily.temperature_2m_max[i] || 0,
temp_min:   hist.daily.temperature_2m_min[i] || 0,
evapotrans: hist.daily.et0_fao_evapotranspiration[i] || 0,
};
})
: [];

const pronostico = fcst && fcst.daily && fcst.daily.time
? fcst.daily.time.map(function(fecha, i) {
return {
fecha: fecha,
lluvia_mm:   fcst.daily.precipitation_sum[i] || 0,
prob_lluvia: fcst.daily.precipitation_probability_max[i] || 0,
temp_max:    fcst.daily.temperature_2m_max[i] || 0,
temp_min:    fcst.daily.temperature_2m_min[i] || 0,
};
})
: [];

return { historico: historico, pronostico: pronostico };
}

function modeloMultivariado(historico, climaIpiales, climaTuquerres, abastecimiento, acpm) {
if (historico.length < 15) return modeloSimple(historico);

const precios30 = historico.slice(-30).map(function(d){ return d.precio; });
const media30   = precios30.reduce(function(a,b){return a+b;},0) / precios30.length;
const precioHoy = historico[historico.length - 1].precio;
const velRev    = 0.08;

const lluviaIp = climaIpiales.historico.slice(-7).map(function(d){ return d.lluvia_mm; });
const lluviaMedia = lluviaIp.length ? lluviaIp.reduce(function(a,b){return a+b;},0)/lluviaIp.length : 0;
const ajLluviaPct = lluviaMedia > 10 ? Math.min((lluviaMedia-10)/20, 1) * 0.03 : 0;

let ajAbsPct = 0;
if (abastecimiento.length >= 3) {
const tons     = abastecimiento.map(function(d){return d.toneladas;});
const mediaAbs = tons.slice(0,-1).reduce(function(a,b){return a+b;},0) / (tons.length-1);
const ultimo   = tons[tons.length-1];
const ratio    = mediaAbs > 0 ? (ultimo - mediaAbs) / mediaAbs : 0;
ajAbsPct = Math.max(-0.04, Math.min(0.04, -ratio * 0.2));
}

const ajAcpmPct = acpm > 0
? Math.max(-0.02, Math.min(0.02, (acpm - 11000) / 11000 * 0.3)) : 0;

const fechaUlt = new Date(historico[historico.length-1].fecha + ‘T12:00:00Z’);
const anoIni   = new Date(Date.UTC(fechaUlt.getUTCFullYear(), 0, 1));
const semana   = Math.ceil((fechaUlt - anoIni) / (7*24*3600*1000));
const ajEstPct = Math.sin(2*Math.PI*(semana-13)/52) * 0.02;

const base = new Date(fechaUlt);
let prev = precioHoy;
const prediccion = [];

for (let i = 0; i < 7; i++) {
const d = new Date(base);
d.setUTCDate(d.getUTCDate() + i + 1);
const gap       = media30 - prev;
const tendencia = prev + gap * velRev;
const ajLluvia  = tendencia * ajLluviaPct;
const ajAbs     = tendencia * ajAbsPct;
const ajAcpm    = tendencia * ajAcpmPct;
const ajEst     = tendencia * ajEstPct;
const precioEst = tendencia + ajLluvia + ajAbs + ajAcpm + ajEst;
prev = precioEst;
prediccion.push({
fecha:  d.toISOString().split(‘T’)[0],
precio: Math.round(Math.max(precioEst, 500)),
componentes: {
tendencia:      Math.round(tendencia),
lluvia:         Math.round(ajLluvia),
abastecimiento: Math.round(ajAbs),
acpm:           Math.round(ajAcpm),
estacional:     Math.round(ajEst),
},
});
}
return prediccion;
}

function modeloSimple(historico) {
const v = historico.slice(-30).map(function(d){return d.precio;});
const n = v.length;
const media = v.reduce(function(a,b){return a+b;},0)/n;
const xm = (n-1)/2;
let num=0, den=0;
v.forEach(function(y,x){ num+=(x-xm)*(y-media); den+=(x-xm)*(x-xm); });
const slope = den ? num/den : 0;
const base = new Date(historico[historico.length-1].fecha + ‘T12:00:00Z’);
const result = [];
for (let i=0; i<7; i++) {
const d = new Date(base); d.setUTCDate(d.getUTCDate()+i+1);
result.push({ fecha: d.toISOString().split(‘T’)[0], precio: Math.round(Math.max(media+slope*(n+i),500)), componentes: null });
}
return result;
}

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘GET, OPTIONS’);
res.setHeader(‘Cache-Control’, ‘s-maxage=21600, stale-while-revalidate’);
if (req.method === ‘OPTIONS’) { res.status(204).end(); return; }

const ahora          = Date.now();
const acpm           = parseFloat(req.query.acpm)     || 11282;
const precioFrontera = parseFloat(req.query.frontera) || 0;

if (_cache && (ahora - _cache.timestamp) < CACHE_TTL && !req.query.refresh) {
const cached = Object.assign({}, _cache.data, { fromCache: true, cacheAge: Math.round((ahora-_cache.timestamp)/60000) });
return res.status(200).json(cached);
}

let ultimoError = null;

for (let intento = 1; intento <= 2; intento++) {
try {
const historico      = await fetchPrecios();
const abastecimiento = await fetchAbastecimiento().catch(function(){ return []; });
const climaResults   = await Promise.all([
fetchClima(ZONAS.ipiales.lat,   ZONAS.ipiales.lon).catch(function(){ return { historico:[], pronostico:[] }; }),
fetchClima(ZONAS.tuquerres.lat, ZONAS.tuquerres.lon).catch(function(){ return { historico:[], pronostico:[] }; }),
]);
const climaIpiales   = climaResults[0];
const climaTuquerres = climaResults[1];

```
  const prediccion = modeloMultivariado(historico, climaIpiales, climaTuquerres, abastecimiento, acpm);

  const climaPronostico = climaIpiales.pronostico.slice(0,7).map(function(d) {
    return { fecha: d.fecha, lluvia_mm: d.lluvia_mm, prob_lluvia: d.prob_lluvia, temp_max: d.temp_max, temp_min: d.temp_min };
  });

  const ultAbs = abastecimiento.length ? abastecimiento[abastecimiento.length-1] : null;

  const respuesta = {
    ok:        true,
    generado:  new Date().toISOString(),
    fromCache: false,
    intento:   intento,
    historico: historico,
    prediccion: prediccion,
    contexto: {
      abastecimiento_ultimo:    ultAbs,
      clima_pronostico_ipiales: climaPronostico,
      acpm_gallon:              acpm,
      precio_frontera:          precioFrontera,
      modelo:                   prediccion[0] && prediccion[0].componentes ? 'multivariado' : 'simple',
    },
  };

  _cache = { data: respuesta, timestamp: ahora };
  return res.status(200).json(respuesta);

} catch (e) {
  ultimoError = e;
  console.error('[sipsa] intento ' + intento + ':', e.message);
  if (intento === 1) await new Promise(function(r){ setTimeout(r, 2000); });
}
```

}

if (_cache) {
const h = ((ahora-_cache.timestamp)/3600000).toFixed(1);
const fallback = Object.assign({}, _cache.data, {
fromCache: true, cacheVencida: true,
cacheAge: Math.round((ahora-_cache.timestamp)/60000),
advertencia: ’Datos de hace ’ + h + ‘h’,
});
return res.status(200).json(fallback);
}

return res.status(503).json({
ok: false,
error: ultimoError && ultimoError.name === ‘AbortError’ ? ‘SIPSA no respondio a tiempo.’ : ’Error: ’ + (ultimoError ? ultimoError.message : ‘desconocido’),
sugerencia: ‘El DANE actualiza precios despues de las 2 p.m. Los fines de semana puede estar inactivo.’,
});
}
