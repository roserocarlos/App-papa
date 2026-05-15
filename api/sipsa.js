// api/sipsa.js - Modelo AR(1) adaptativo corregido
// Basado en analisis estadistico real de serie SIPSA 1332 dias:
// - Autocorrelacion lag1=0.946: alta persistencia
// - CV=27%, reversion promedio 16.5 dias
// - Alpha adaptativo por z-score, ajustes contextuales NO encadenados
export const config = { maxDuration: 60 };

var _cache = null;
var CACHE_TTL = 6 * 60 * 60 * 1000;
var SOAP_URL = "https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService";
var ZONAS = {
  ipiales:   { lat: 0.8304,  lon: -77.6441 },
  tuquerres: { lat: 1.0833,  lon: -77.6167 },
};

function getTag(block, tag) {
  var open  = "<" + tag + ">";
  var close = "</" + tag + ">";
  var a = block.indexOf(open);
  if (a === -1) {
    var re = new RegExp("<[^:>]+:" + tag + ">");
    var ma = block.match(re);
    if (!ma) return "";
    var b2 = block.indexOf(ma[0]) + ma[0].length;
    var e2 = block.indexOf("</", b2);
    return e2 === -1 ? "" : block.slice(b2, e2).trim();
  }
  var start = a + open.length;
  var end = block.indexOf(close, start);
  return end === -1 ? "" : block.slice(start, end).trim();
}

function extraerBloques(xml) {
  var results = [];
  var pos = 0;
  while (true) {
    var s = xml.indexOf("<", pos);
    if (s === -1) break;
    var gt = xml.indexOf(">", s);
    if (gt === -1) break;
    var tc = xml.slice(s + 1, gt);
    var ln = tc.split(":").pop().split(" ")[0];
    if (ln === "return") {
      var ca = "</" + ln + ">";
      var e = xml.indexOf("</" + tc + ">", gt);
      if (e === -1) e = xml.indexOf(ca, gt);
      if (e === -1) { pos = gt + 1; continue; }
      results.push(xml.slice(gt + 1, e));
      pos = e + ca.length;
    } else {
      pos = gt + 1;
    }
  }
  return results;
}

async function fetchSOAP(body, ms) {
  ms = ms || 25000;
  var ctrl = new AbortController();
  var t = setTimeout(function() { ctrl.abort(); }, ms);
  try {
    var r = await fetch(SOAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml;charset=UTF-8", "SOAPAction": '""' },
      body: body,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error("DANE HTTP " + r.status);
    return await r.text();
  } catch(e) { clearTimeout(t); throw e; }
}

async function fetchPrecios() {
  var xml = await fetchSOAP(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<soap:Envelope xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:ser=\"http://servicios.sipsa.co.gov.dane/\">" +
    "<soap:Header/><soap:Body><ser:promediosSipsaCiudad/></soap:Body></soap:Envelope>"
  );
  var pf = {};
  var bl = extraerBloques(xml);
  for (var i = 0; i < bl.length; i++) {
    var b = bl[i];
    var prod  = getTag(b, "producto").toLowerCase();
    var fecha = getTag(b, "fechaCaptura").split("T")[0];
    var prec  = parseFloat(getTag(b, "precioPromedio"));
    if (prod.indexOf("papa") === -1 || !fecha || isNaN(prec) || prec <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    if (!pf[fecha]) pf[fecha] = [];
    pf[fecha].push(prec);
  }
  var keys = Object.keys(pf);
  if (!keys.length) throw new Error("SIPSA sin registros de papa");
  return keys
    .map(function(f) {
      var arr = pf[f];
      return { fecha: f, precio: Math.round(arr.reduce(function(a,b){return a+b;},0)/arr.length) };
    })
    .sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
}

async function fetchAbastecimiento() {
  var xml = await fetchSOAP(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<soap:Envelope xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:ser=\"http://servicios.sipsa.co.gov.dane/\">" +
    "<soap:Header/><soap:Body><ser:promedioAbasSipsaMesMadr/></soap:Body></soap:Envelope>",
    10000
  );
  var pm = {};
  var bl = extraerBloques(xml);
  for (var i = 0; i < bl.length; i++) {
    var b = bl[i];
    var nom = getTag(b, "artiNombre").toLowerCase();
    var mes = getTag(b, "fechaMesIni").split("T")[0].slice(0, 7);
    var fid = getTag(b, "fuenId");
    var ton = parseFloat(getTag(b, "cantidadTon"));
    if (nom.indexOf("papa") === -1 || !mes || isNaN(ton) || ton <= 0) continue;
    if (!pm[mes]) pm[mes] = {};
    if (!pm[mes][fid]) pm[mes][fid] = ton;
  }
  return Object.keys(pm)
    .map(function(mes) {
      var vals = Object.values(pm[mes]);
      return { mes: mes, toneladas: Math.round(vals.reduce(function(a,b){return a+b;},0)) };
    })
    .sort(function(a,b){ return a.mes < b.mes ? -1 : 1; });
}

async function fetchClima(lat, lon) {
  var tz   = "America%2FBogota";
  var vars = "precipitation_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration,rain_sum";
  var u1 = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
    "&daily=" + vars + "&past_days=30&forecast_days=1&timezone=" + tz;
  var u2 = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
    "&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,precipitation_probability_max,rain_sum" +
    "&forecast_days=7&timezone=" + tz;
  var rs = await Promise.allSettled([
    fetch(u1, { signal: AbortSignal.timeout(10000) }).then(function(r){return r.json();}),
    fetch(u2, { signal: AbortSignal.timeout(10000) }).then(function(r){return r.json();}),
  ]);
  var h = rs[0].status === "fulfilled" && !rs[0].value.error ? rs[0].value : null;
  var f = rs[1].status === "fulfilled" && !rs[1].value.error ? rs[1].value : null;
  return {
    historico: h && h.daily && h.daily.time ? h.daily.time.map(function(fecha, i) {
      return { fecha: fecha, lluvia_mm: h.daily.precipitation_sum[i] || 0,
        temp_max: h.daily.temperature_2m_max[i] || 0, temp_min: h.daily.temperature_2m_min[i] || 0 };
    }) : [],
    pronostico: f && f.daily && f.daily.time ? f.daily.time.map(function(fecha, i) {
      return { fecha: fecha, lluvia_mm: f.daily.precipitation_sum[i] || 0,
        prob_lluvia: f.daily.precipitation_probability_max[i] || 0,
        temp_max: f.daily.temperature_2m_max[i] || 0, temp_min: f.daily.temperature_2m_min[i] || 0 };
    }) : [],
  };
}

// AR(1) adaptativo - CORRECCION: ajustes calculados una sola vez desde precio HOY
// no se acumulan en cada iteracion para evitar divergencia
function modeloAR1(historico, climaIp, climaTq, abast, acpm) {
  if (historico.length < 15) return modeloSimple(historico);

  var pr30  = historico.slice(-30).map(function(d){return d.precio;});
  var med30 = pr30.reduce(function(a,b){return a+b;},0) / pr30.length;
  var std30 = Math.sqrt(pr30.reduce(function(s,x){return s+(x-med30)*(x-med30);},0)/pr30.length);
  var hoy   = historico[historico.length-1].precio;
  var z     = std30 > 0 ? (hoy - med30) / std30 : 0;
  var absZ  = Math.abs(z);

  // Alpha: persistencia alta en rango normal, reversion cuando se aleja
  // Calibrado sobre reversion promedio observada de 16.5 dias
  var alpha = absZ < 1.0 ? 0.90 : absZ < 1.5 ? 0.75 : 0.55;

  // Ajustes contextuales - calculados UNA SOLA VEZ sobre precio actual
  // Son perturbaciones fijas, no se amplifican en cada paso
  var llIp = climaIp.historico.slice(-7).map(function(d){return d.lluvia_mm;});
  var llMed = llIp.length ? llIp.reduce(function(a,b){return a+b;},0)/llIp.length : 0;
  var ajLl = llMed > 10 ? Math.min((llMed-10)/20, 1) * 0.03 : 0;

  var ajAbs = 0;
  if (abast.length >= 3) {
    var tons   = abast.map(function(d){return d.toneladas;});
    var medAbs = tons.slice(0,-1).reduce(function(a,b){return a+b;},0)/(tons.length-1);
    var ratio  = medAbs > 0 ? (tons[tons.length-1] - medAbs) / medAbs : 0;
    ajAbs = Math.max(-0.04, Math.min(0.04, -ratio * 0.2));
  }

  var ajAcpm = acpm > 0 ? Math.max(-0.02, Math.min(0.02, (acpm-11000)/11000*0.3)) : 0;

  var fu  = new Date(historico[historico.length-1].fecha + "T12:00:00Z");
  var ini = new Date(Date.UTC(fu.getUTCFullYear(), 0, 1));
  var sem = Math.ceil((fu - ini) / (7*24*3600*1000));
  var ajEst = Math.sin(2*Math.PI*(sem-13)/52) * 0.02;

  // Perturbacion contextual total - aplicada una vez, constante para todos los dias
  var perturbacion = hoy * (ajLl + ajAbs + ajAcpm + ajEst);

  // Prediccion: AR(1) puro encadenado + perturbacion fija
  // AR(1) converge naturalmente a med30 sin diverger
  var base = new Date(fu);
  var prev = hoy;
  var pred = [];

  for (var i = 0; i < 7; i++) {
    var d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i + 1);

    // AR(1) puro: converge a med30 a tasa (1-alpha) por periodo
    var ar1 = alpha * prev + (1 - alpha) * med30;

    // Perturbacion contextual: se amortigua con la distancia (menos certeza)
    var factorAmort = Math.exp(-0.15 * i);
    var precioEst = ar1 + perturbacion * factorAmort;

    prev = ar1; // encadenar solo el AR(1), no la perturbacion

    pred.push({
      fecha:  d.toISOString().split("T")[0],
      precio: Math.round(Math.max(precioEst, 500)),
      componentes: {
        ar1:            Math.round(ar1),
        alpha:          alpha,
        z_score:        Math.round(z*100)/100,
        perturbacion:   Math.round(perturbacion * factorAmort),
      },
    });
  }
  return pred;
}

function modeloSimple(historico) {
  var v = historico.slice(-30).map(function(d){return d.precio;});
  var n = v.length;
  var m = v.reduce(function(a,b){return a+b;},0)/n;
  var xm=(n-1)/2, num=0, den=0;
  v.forEach(function(y,x){num+=(x-xm)*(y-m);den+=(x-xm)*(x-xm);});
  var sl = den ? num/den : 0;
  var base = new Date(historico[historico.length-1].fecha + "T12:00:00Z");
  var res = [];
  for (var i=0; i<7; i++) {
    var d = new Date(base); d.setUTCDate(d.getUTCDate()+i+1);
    res.push({ fecha: d.toISOString().split("T")[0], precio: Math.round(Math.max(m+sl*(n+i),500)), componentes: null });
  }
  return res;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  var ahora = Date.now();
  var acpm  = parseFloat(req.query.acpm)     || 11282;
  var front = parseFloat(req.query.frontera) || 0;

  if (_cache && (ahora - _cache.timestamp) < CACHE_TTL && !req.query.refresh) {
    var c = Object.assign({}, _cache.data, { fromCache: true, cacheAge: Math.round((ahora-_cache.timestamp)/60000) });
    return res.status(200).json(c);
  }

  var ultimoError = null;

  for (var intento = 1; intento <= 2; intento++) {
    try {
      var historico = await fetchPrecios();
      var abast     = await fetchAbastecimiento().catch(function(){ return []; });
      var climas    = await Promise.all([
        fetchClima(ZONAS.ipiales.lat,   ZONAS.ipiales.lon).catch(function(){ return { historico:[], pronostico:[] }; }),
        fetchClima(ZONAS.tuquerres.lat, ZONAS.tuquerres.lon).catch(function(){ return { historico:[], pronostico:[] }; }),
      ]);

      var prediccion = modeloAR1(historico, climas[0], climas[1], abast, acpm);
      var fcst = climas[0].pronostico.slice(0,7).map(function(d) {
        return { fecha:d.fecha, lluvia_mm:d.lluvia_mm, prob_lluvia:d.prob_lluvia, temp_max:d.temp_max, temp_min:d.temp_min };
      });

      var respuesta = {
        ok: true, generado: new Date().toISOString(), fromCache: false, intento: intento,
        historico: historico, prediccion: prediccion,
        contexto: {
          abastecimiento_ultimo:    abast.length ? abast[abast.length-1] : null,
          clima_pronostico_ipiales: fcst,
          acpm_gallon:              acpm,
          precio_frontera:          front,
          modelo:                   prediccion[0] && prediccion[0].componentes ? "AR1-adaptativo" : "simple",
        },
      };

      _cache = { data: respuesta, timestamp: ahora };
      return res.status(200).json(respuesta);

    } catch(e) {
      ultimoError = e;
      console.error("[sipsa] intento " + intento + ":", e.message);
      if (intento === 1) await new Promise(function(r){ setTimeout(r, 2000); });
    }
  }

  if (_cache) {
    var h = ((ahora-_cache.timestamp)/3600000).toFixed(1);
    var fb = Object.assign({}, _cache.data, {
      fromCache: true, cacheVencida: true,
      cacheAge: Math.round((ahora-_cache.timestamp)/60000),
      advertencia: "Datos de hace " + h + "h",
    });
    return res.status(200).json(fb);
  }

  return res.status(503).json({
    ok: false,
    error: ultimoError && ultimoError.name === "AbortError" ? "SIPSA no respondio a tiempo." : "Error: " + (ultimoError ? ultimoError.message : "desconocido"),
    sugerencia: "El DANE actualiza precios despues de las 2 p.m. Los fines de semana puede estar inactivo.",
  });
}
