// api/analisis.js
export const config = { maxDuration: 60 };

const SOAP_URL = ‘https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService’;

function getTag(block, tag) {
var open  = ‘<’ + tag + ‘>’;
var close = ‘</’ + tag + ‘>’;
var a = block.indexOf(open);
if (a === -1) {
var re = new RegExp(’<[^:>]+:’ + tag + ‘>’);
var ma = block.match(re);
if (!ma) return ‘’;
var b2 = block.indexOf(ma[0]) + ma[0].length;
var e2 = block.indexOf(’</’, b2);
return e2 === -1 ? ‘’ : block.slice(b2, e2).trim();
}
var start = a + open.length;
var end   = block.indexOf(close, start);
return end === -1 ? ‘’ : block.slice(start, end).trim();
}

function extraerBloques(xml) {
var results = [];
var TAG = ‘return’;
var pos = 0;
while (true) {
var startTag = xml.indexOf(’<’, pos);
if (startTag === -1) break;
var gt = xml.indexOf(’>’, startTag);
if (gt === -1) break;
var tagContent = xml.slice(startTag + 1, gt);
var localName = tagContent.split(’:’).pop().split(’ ‘)[0];
if (localName === TAG) {
var closeAlt = ‘</’ + localName + ‘>’;
var end = xml.indexOf(’</’ + tagContent + ‘>’, gt);
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
var ctrl = new AbortController();
var t = setTimeout(function() { ctrl.abort(); }, 50000);
try {
var r = await fetch(SOAP_URL, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/soap+xml;charset=UTF-8’, ‘SOAPAction’: ‘””’ },
body: ‘<?xml version="1.0" encoding="UTF-8"?>’ +
‘<soap:Envelope xmlns:soap=“http://www.w3.org/2003/05/soap-envelope” xmlns:ser=“http://servicios.sipsa.co.gov.dane/”>’ +
‘<soap:Header/><soap:Body><ser:promediosSipsaCiudad/></soap:Body></soap:Envelope>’,
signal: ctrl.signal,
});
clearTimeout(t);
if (!r.ok) throw new Error(’DANE HTTP ’ + r.status);
var xml = await r.text();
var porFecha = {};
var bloques = extraerBloques(xml);
for (var i = 0; i < bloques.length; i++) {
var b = bloques[i];
var prod   = getTag(b, ‘producto’).toLowerCase();
var fecha  = getTag(b, ‘fechaCaptura’).split(‘T’)[0];
var precio = parseFloat(getTag(b, ‘precioPromedio’));
if (!prod.includes(‘papa’) || !fecha || isNaN(precio) || precio <= 0) continue;
if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
if (!porFecha[fecha]) porFecha[fecha] = [];
porFecha[fecha].push(precio);
}
var keys = Object.keys(porFecha);
if (!keys.length) throw new Error(‘Sin registros de papa’);
return keys
.map(function(f) {
var arr = porFecha[f];
return { fecha: f, precio: Math.round(arr.reduce(function(a,b){return a+b;},0)/arr.length) };
})
.sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
} catch(e) { clearTimeout(t); throw e; }
}

function calcRSI(precios, periodo) {
periodo = periodo || 14;
if (precios.length < periodo + 1) return null;
var g = 0, p = 0;
for (var i = 1; i <= periodo; i++) {
var d = precios[i] - precios[i-1];
if (d > 0) g += d; else p += Math.abs(d);
}
var ag = g / periodo, ap = p / periodo;
for (var j = periodo + 1; j < precios.length; j++) {
var d2 = precios[j] - precios[j-1];
if (d2 > 0) { ag = (ag*(periodo-1)+d2)/periodo; ap = (ap*(periodo-1))/periodo; }
else { ap = (ap*(periodo-1)+Math.abs(d2))/periodo; ag = (ag*(periodo-1))/periodo; }
}
if (ap === 0) return 100;
return Math.round((100 - 100/(1+ag/ap)) * 100) / 100;
}

function calcBollinger(precios, periodo) {
periodo = periodo || 20;
var v = precios.slice(-periodo);
var m = v.reduce(function(a,b){return a+b;},0) / v.length;
var vr = v.reduce(function(s,x){return s+(x-m)*(x-m);},0) / v.length;
var s = Math.sqrt(vr);
var cur = precios[precios.length-1];
return {
media: Math.round(m), upper: Math.round(m+2*s), lower: Math.round(m-2*s),
std: Math.round(s), precioActual: cur,
posicion: s > 0 ? Math.round(((cur-(m-2*s))/(4*s))*100) : 50,
};
}

function calcZScore(precios, periodo) {
periodo = periodo || 30;
var v = precios.slice(-periodo);
var m = v.reduce(function(a,b){return a+b;},0) / v.length;
var s = Math.sqrt(v.reduce(function(s2,x){return s2+(x-m)*(x-m);},0)/v.length);
var u = precios[precios.length-1];
var z = s > 0 ? Math.round((u-m)/s*100)/100 : 0;
return {
z: z, media: Math.round(m), std: Math.round(s),
interpretacion: s > 0 ? (
(u-m)/s > 1.5  ? ‘SOBRECOMPRADO - reversion bajista probable’ :
(u-m)/s < -1.5 ? ‘SOBREVENDIDO - rebote alcista probable’ :
‘EN RANGO NORMAL - sin senal fuerte’
) : ‘Sin datos suficientes’,
};
}

function calcAutocorrelacion(precios, lag) {
var n = precios.length;
if (n < lag + 10) return null;
var m = precios.reduce(function(a,b){return a+b;},0) / n;
var num = 0, den = 0;
for (var i = lag; i < n; i++) num += (precios[i]-m)*(precios[i-lag]-m);
for (var j = 0; j < n; j++) den += (precios[j]-m)*(precios[j]-m);
return den > 0 ? Math.round(num/den*1000)/1000 : 0;
}

function calcEstacionalidad(serie) {
var porSem = {};
var mg = serie.reduce(function(s,d){return s+d.precio;},0) / serie.length;
for (var i = 0; i < serie.length; i++) {
var dt = new Date(serie[i].fecha + ‘T12:00:00Z’);
var ini = new Date(Date.UTC(dt.getUTCFullYear(),0,1));
var s = Math.ceil((dt-ini)/(7*24*3600*1000));
if (!porSem[s]) porSem[s] = [];
porSem[s].push(serie[i].precio);
}
var indices = [];
for (var w = 1; w <= 52; w++) {
if (porSem[w] && porSem[w].length >= 3) {
var ms = porSem[w].reduce(function(a,b){return a+b;},0)/porSem[w].length;
indices.push({ semana: w, indice: Math.round(ms/mg*100), n: porSem[w].length });
}
}
var sorted = indices.slice().sort(function(a,b){return b.indice-a.indice;});
var hoy = new Date();
var hoyIni = new Date(Date.UTC(hoy.getUTCFullYear(),0,1));
var semHoy = Math.ceil((hoy-hoyIni)/(7*24*3600*1000));
var actual = null;
for (var k = 0; k < indices.length; k++) { if (indices[k].semana === semHoy) { actual = indices[k]; break; } }
return {
semanas_caras:   sorted.slice(0,5).map(function(x){return ‘Sem ‘+x.semana+’: ‘+x.indice+’%’;}),
semanas_baratas: sorted.slice(-5).reverse().map(function(x){return ‘Sem ‘+x.semana+’: ‘+x.indice+’%’;}),
indice_semana_actual: actual,
};
}

function calcMeanReversion(precios) {
var m = precios.reduce(function(a,b){return a+b;},0)/precios.length;
var s = Math.sqrt(precios.reduce(function(s2,x){return s2+(x-m)*(x-m);},0)/precios.length);
var eventos = [];
var i = 0;
while (i < precios.length - 20) {
var z = (precios[i]-m)/s;
if (Math.abs(z) > 1.5) {
var signo = z > 0 ? 1 : -1;
for (var j = i+1; j < Math.min(i+30,precios.length); j++) {
if (signo*(precios[j]-m)/s < 0.5) { eventos.push(j-i); break; }
}
i += 5;
} else { i++; }
}
if (!eventos.length) return { dias_promedio: null, n_eventos: 0 };
var prom = eventos.reduce(function(a,b){return a+b;},0)/eventos.length;
var sorted = eventos.slice().sort(function(a,b){return a-b;});
return {
dias_promedio: Math.round(prom*10)/10,
dias_mediana: sorted[Math.floor(sorted.length/2)],
n_eventos: eventos.length,
interpretacion: ‘El precio tarda ~’ + Math.round(prom) + ’ dias en volver a la media tras desviarse >1.5s’,
};
}

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
if (req.method === ‘OPTIONS’) { res.status(204).end(); return; }

try {
var serie   = await fetchPrecios();
var precios = serie.map(function(d){return d.precio;});
var n = precios.length;
var rsi14 = calcRSI(precios, 14);
var rsi7  = calcRSI(precios, 7);
var b20   = calcBollinger(precios, 20);
var b50   = calcBollinger(precios, 50);
var z30   = calcZScore(precios, 30);
var z90   = calcZScore(precios, 90);

var acLags = {};
var lagList = [1,2,3,5,7,10,14,21,30];
for (var li = 0; li < lagList.length; li++) {
  acLags['lag_' + lagList[li] + 'd'] = calcAutocorrelacion(precios, lagList[li]);
}

var estacional = calcEstacionalidad(serie);
var meanRev    = calcMeanReversion(precios);

var pMax = Math.max.apply(null, precios);
var pMin = Math.min.apply(null, precios);
var med  = Math.round(precios.reduce(function(a,b){return a+b;},0)/n);
var std  = Math.round(Math.sqrt(precios.reduce(function(s,x){return s+(x-med)*(x-med);},0)/n));
var cv   = Math.round(std/med*100);

var vars = [];
for (var vi = 1; vi < precios.length; vi++) {
  vars.push(Math.abs((precios[vi]-precios[vi-1])/precios[vi-1]*100));
}
var varProm = Math.round(vars.reduce(function(a,b){return a+b;},0)/vars.length*100)/100;
var varMax  = Math.round(Math.max.apply(null,vars)*100)/100;

var z = z30.z;
var rsi = rsi14;
var rec = Math.abs(z) > 1.5 && (rsi > 65 || rsi < 35)
  ? 'REVERSION + RSI: extremo estadistico confirmado por RSI - correccion fuerte esperada'
  : Math.abs(z) > 1.0
  ? 'REVERSION MODERADA: precio fuera de rango - correccion probable'
  : 'MEDIA MOVIL: precio en rango normal - seguir tendencia reciente';

return res.status(200).json({
  generado: new Date().toISOString(),
  serie: { total_dias: n, desde: serie[0].fecha, hasta: serie[n-1].fecha, precio_actual: precios[n-1] },
  estadisticas: { media: med, std: std, cv_pct: cv, max: pMax, min: pMin, rango: pMax-pMin },
  volatilidad: { var_diaria_prom_pct: varProm, var_diaria_max_pct: varMax, clasificacion: cv > 30 ? 'ALTA' : cv > 15 ? 'MEDIA' : 'BAJA' },
  indicadores: {
    rsi_14d: { valor: rsi14, senal: rsi14 > 70 ? 'SOBRECOMPRADO' : rsi14 < 30 ? 'SOBREVENDIDO' : 'NEUTRAL' },
    rsi_7d:  { valor: rsi7,  senal: rsi7  > 70 ? 'SOBRECOMPRADO' : rsi7  < 30 ? 'SOBREVENDIDO' : 'NEUTRAL' },
    bollinger_20d: b20,
    bollinger_50d: b50,
    zscore_30d: z30,
    zscore_90d: z90,
  },
  autocorrelaciones: acLags,
  estacionalidad: estacional,
  mean_reversion: meanRev,
  conclusion: {
    recomendacion: rec,
    z_actual: z,
    rsi_actual: rsi,
    senal: Math.abs(z) > 1.5 && rsi > 65 ? 'BAJA ESPERADA' :
           Math.abs(z) > 1.5 && rsi < 35 ? 'SUBA ESPERADA' : 'SIN SENAL FUERTE',
  },
});

} catch(e) {
return res.status(500).json({ ok: false, error: e.message });
}
}
