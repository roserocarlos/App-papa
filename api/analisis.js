// api/analisis.js – Análisis estadístico de la serie SIPSA papa
// Calcula RSI, Z-score, Bollinger Bands, autocorrelación y estacionalidad
// para decidir técnicamente el mejor modelo de predicción

export const config = { maxDuration: 60 };

const SOAP_URL = ‘https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService’;

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
const localName = tagContent.split(’:’).pop().split(’ ‘)[0];
if (localName === TAG) {
const closeAlt = ‘</’ + localName + ‘>’;
let end = xml.indexOf(’</’ + tagContent + ‘>’, gt);
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

async function fetchPrecios() {
const ctrl = new AbortController();
const t = setTimeout(function() { ctrl.abort(); }, 50000);
try {
const r = await fetch(SOAP_URL, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/soap+xml;charset=UTF-8’, ‘SOAPAction’: ‘””’ },
body: ‘<?xml version="1.0" encoding="UTF-8"?>’ +
‘<soap:Envelope xmlns:soap=“http://www.w3.org/2003/05/soap-envelope” xmlns:ser=“http://servicios.sipsa.co.gov.dane/”>’ +
‘<soap:Header/><soap:Body><ser:promediosSipsaCiudad/></soap:Body></soap:Envelope>’,
signal: ctrl.signal,
});
clearTimeout(t);
if (!r.ok) throw new Error(’DANE HTTP ’ + r.status);
const xml = await r.text();
const porFecha = {};
const bloques = extraerBloquesAbs(xml);
for (var i = 0; i < bloques.length; i++) {
const b = bloques[i];
const prod   = getTag(b, ‘producto’).toLowerCase();
const fecha  = getTag(b, ‘fechaCaptura’).split(‘T’)[0];
const precio = parseFloat(getTag(b, ‘precioPromedio’));
if (!prod.includes(‘papa’) || !fecha || isNaN(precio) || precio <= 0) continue;
if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
if (!porFecha[fecha]) porFecha[fecha] = [];
porFecha[fecha].push(precio);
}
const keys = Object.keys(porFecha);
if (!keys.length) throw new Error(‘Sin registros de papa’);
return keys
.map(function(fecha) {
const arr = porFecha[fecha];
return { fecha: fecha, precio: Math.round(arr.reduce(function(a,b){return a+b;},0)/arr.length) };
})
.sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
} catch(e) { clearTimeout(t); throw e; }
}

// ── Indicadores técnicos ──────────────────────────────────────────────────────

function calcRSI(precios, periodo) {
periodo = periodo || 14;
if (precios.length < periodo + 1) return null;
var ganancias = 0, perdidas = 0;
for (var i = 1; i <= periodo; i++) {
var diff = precios[i] - precios[i-1];
if (diff > 0) ganancias += diff;
else perdidas += Math.abs(diff);
}
var avgG = ganancias / periodo;
var avgP = perdidas / periodo;
for (var j = periodo + 1; j < precios.length; j++) {
var d = precios[j] - precios[j-1];
if (d > 0) { avgG = (avgG * (periodo-1) + d) / periodo; avgP = (avgP * (periodo-1)) / periodo; }
else { avgP = (avgP * (periodo-1) + Math.abs(d)) / periodo; avgG = (avgG * (periodo-1)) / periodo; }
}
if (avgP === 0) return 100;
var rs = avgG / avgP;
return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function calcBollinger(precios, periodo) {
periodo = periodo || 20;
var ventana = precios.slice(-periodo);
var media = ventana.reduce(function(a,b){return a+b;},0) / ventana.length;
var varianza = ventana.reduce(function(s,x){return s + (x-media)*(x-media);},0) / ventana.length;
var std = Math.sqrt(varianza);
return {
media:   Math.round(media),
upper:   Math.round(media + 2*std),
lower:   Math.round(media - 2*std),
std:     Math.round(std),
precioActual: precios[precios.length-1],
posicion: std > 0 ? Math.round(((precios[precios.length-1] - (media-2*std)) / (4*std)) * 100) : 50,
};
}

function calcZScore(precios, periodo) {
periodo = periodo || 30;
var ventana = precios.slice(-periodo);
var media = ventana.reduce(function(a,b){return a+b;},0) / ventana.length;
var varianza = ventana.reduce(function(s,x){return s + (x-media)*(x-media);},0) / ventana.length;
var std = Math.sqrt(varianza);
var ultimo = precios[precios.length-1];
return {
z:     std > 0 ? Math.round((ultimo - media) / std * 100) / 100 : 0,
media: Math.round(media),
std:   Math.round(std),
interpretacion: std > 0 ? (
(ultimo - media) / std > 1.5  ? ‘SOBRECOMPRADO — reversión bajista probable’ :
(ultimo - media) / std < -1.5 ? ‘SOBREVENDIDO — rebote alcista probable’ :
‘EN RANGO NORMAL — sin señal fuerte’
) : ‘Sin datos suficientes’,
};
}

function calcAutocorrelacion(precios, lag) {
var n = precios.length;
if (n < lag + 10) return null;
var media = precios.reduce(function(a,b){return a+b;},0) / n;
var num = 0, den = 0;
for (var i = lag; i < n; i++) {
num += (precios[i] - media) * (precios[i-lag] - media);
}
for (var j = 0; j < n; j++) {
den += (precios[j] - media) * (precios[j] - media);
}
return den > 0 ? Math.round(num/den * 1000) / 1000 : 0;
}

function calcEstacionalidad(serie) {
// Agrupar por semana del año y calcular precio promedio
var porSemana = {};
var mediaGlobal = serie.reduce(function(s,d){return s+d.precio;},0) / serie.length;
for (var i = 0; i < serie.length; i++) {
var d = serie[i];
var dt = new Date(d.fecha + ‘T12:00:00Z’);
var ini = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
var sem = Math.ceil((dt - ini) / (7*24*3600*1000));
if (!porSemana[sem]) porSemana[sem] = [];
porSemana[sem].push(d.precio);
}
var indices = [];
for (var s = 1; s <= 52; s++) {
if (porSemana[s] && porSemana[s].length >= 3) {
var mediaS = porSemana[s].reduce(function(a,b){return a+b;},0) / porSemana[s].length;
indices.push({ semana: s, indice: Math.round(mediaS/mediaGlobal*100), n: porSemana[s].length });
}
}
// Semanas con precio más alto y más bajo
var sorted = indices.slice().sort(function(a,b){return b.indice-a.indice;});
return {
semanas_caras:   sorted.slice(0,5).map(function(x){return ‘Sem ‘+x.semana+’: ‘+x.indice+’%’;}),
semanas_baratas: sorted.slice(-5).reverse().map(function(x){return ‘Sem ‘+x.semana+’: ‘+x.indice+’%’;}),
indice_semana_actual: indices.filter(function(x){
var hoy = new Date();
var ini = new Date(Date.UTC(hoy.getUTCFullYear(),0,1));
var s = Math.ceil((hoy-ini)/(7*24*3600*1000));
return x.semana === s;
})[0] || null,
};
}

function calcMeanReversionTest(precios) {
// Test simple de reversión: ¿cuántos días tarda en volver a la media tras desviarse?
var media = precios.reduce(function(a,b){return a+b;},0) / precios.length;
var std = Math.sqrt(precios.reduce(function(s,x){return s+(x-media)*(x-media);},0)/precios.length);
var eventos = [];
var i = 0;
while (i < precios.length - 20) {
var z = (precios[i] - media) / std;
if (Math.abs(z) > 1.5) {
var signo = z > 0 ? 1 : -1;
for (var j = i+1; j < Math.min(i+30, precios.length); j++) {
var zj = (precios[j] - media) / std;
if (signo * zj < 0.5) {
eventos.push(j - i);
break;
}
}
i += 5;
} else { i++; }
}
if (!eventos.length) return { dias_promedio: null, n_eventos: 0 };
return {
dias_promedio: Math.round(eventos.reduce(function(a,b){return a+b;},0)/eventos.length * 10)/10,
dias_mediana:  eventos.sort(function(a,b){return a-b;})[Math.floor(eventos.length/2)],
n_eventos:     eventos.length,
interpretacion: ‘El precio tarda ~’ + Math.round(eventos.reduce(function(a,b){return a+b;},0)/eventos.length) + ’ días en volver a la media tras desviarse >1.5σ’,
};
}

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
if (req.method === ‘OPTIONS’) { res.status(204).end(); return; }

try {
const serie = await fetchPrecios();
const precios = serie.map(function(d){return d.precio;});
const n = precios.length;

// Indicadores sobre toda la serie
const rsi14   = calcRSI(precios, 14);
const rsi7    = calcRSI(precios, 7);
const boll20  = calcBollinger(precios, 20);
const boll50  = calcBollinger(precios, 50);
const z30     = calcZScore(precios, 30);
const z90     = calcZScore(precios, 90);

// Autocorrelaciones para detectar ciclos
const acLags = {};
[1,2,3,5,7,10,14,21,30].forEach(function(lag){
  acLags['lag_' + lag + 'd'] = calcAutocorrelacion(precios, lag);
});

// Estacionalidad
const estacional = calcEstacionalidad(serie);

// Test de reversión a la media
const meanRev = calcMeanReversionTest(precios);

// Estadísticas básicas
var precioMax = Math.max.apply(null, precios);
var precioMin = Math.min.apply(null, precios);
var mediaTotal = Math.round(precios.reduce(function(a,b){return a+b;},0)/n);
var std = Math.round(Math.sqrt(precios.reduce(function(s,x){return s+(x-mediaTotal)*(x-mediaTotal);},0)/n));
var cv = Math.round(std/mediaTotal*100);

// Variaciones diarias
var variaciones = [];
for (var i = 1; i < precios.length; i++) {
  variaciones.push(Math.abs((precios[i]-precios[i-1])/precios[i-1]*100));
}
var varPromedio = Math.round(variaciones.reduce(function(a,b){return a+b;},0)/variaciones.length*100)/100;
var varMax = Math.round(Math.max.apply(null, variaciones)*100)/100;

// Conclusión del modelo recomendado
var recomendacion;
var zActual = z30.z;
var rsiActual = rsi14;
if (Math.abs(zActual) > 1.5 && (rsiActual > 65 || rsiActual < 35)) {
  recomendacion = 'REVERSIÓN + RSI: precio en extremo estadístico confirmado por RSI — señal fuerte de corrección';
} else if (Math.abs(zActual) > 1.0) {
  recomendacion = 'REVERSIÓN MODERADA: precio fuera de rango normal — corrección probable pero no garantizada';
} else {
  recomendacion = 'MEDIA MÓVIL: precio en rango normal — sin señal de reversión fuerte, seguir tendencia reciente';
}

return res.status(200).json({
  generado:    new Date().toISOString(),
  serie:       { total_dias: n, desde: serie[0].fecha, hasta: serie[n-1].fecha, precio_actual: precios[n-1] },
  estadisticas: { media: mediaTotal, std: std, cv_pct: cv, max: precioMax, min: precioMin, rango: precioMax-precioMin },
  volatilidad:  { variacion_diaria_promedio_pct: varPromedio, variacion_diaria_max_pct: varMax, clasificacion: cv > 30 ? 'ALTA' : cv > 15 ? 'MEDIA' : 'BAJA' },
  indicadores: {
    rsi_14d:    { valor: rsi14, señal: rsi14 > 70 ? 'SOBRECOMPRADO' : rsi14 < 30 ? 'SOBREVENDIDO' : 'NEUTRAL' },
    rsi_7d:     { valor: rsi7,  señal: rsi7  > 70 ? 'SOBRECOMPRADO' : rsi7  < 30 ? 'SOBREVENDIDO' : 'NEUTRAL' },
    bollinger_20d: boll20,
    bollinger_50d: boll50,
    zscore_30d:  z30,
    zscore_90d:  z90,
  },
  autocorrelaciones: acLags,
  estacionalidad:    estacional,
  mean_reversion:    meanRev,
  conclusion: {
    recomendacion_modelo: recomendacion,
    z_actual:   zActual,
    rsi_actual: rsiActual,
    señal_combinada: Math.abs(zActual) > 1.5 && rsiActual > 65 ? 'VENTA/BAJA ESPERADA' :
                     Math.abs(zActual) > 1.5 && rsiActual < 35 ? 'COMPRA/SUBA ESPERADA' :
                     'SIN SEÑAL FUERTE',
  },
});

} catch(e) {
return res.status(500).json({ ok: false, error: e.message });
}
}
