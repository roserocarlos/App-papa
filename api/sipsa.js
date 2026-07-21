// api/sipsa.js - AgroData IA v2
// Modelo AR(1) adaptativo ventana 14 dias
// Precio base: acopio local Ipiales > DANE Pasto fallback
// Unidades: $/kg y $/bulto 50kg
export const config = { maxDuration: 60 };

var _cache = null;
var CACHE_TTL = 6 * 60 * 60 * 1000;
var SOAP_URL = "https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService";
var CSV_URL  = "https://raw.githubusercontent.com/roserocarlos/App-papa/main/data/precios_ipiales.csv";
var BULTO_KG = 50;

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
  var end   = block.indexOf(close, start);
  return end === -1 ? "" : block.slice(start, end).trim();
}

function extraerBloques(xml) {
  var results = [];
  var pos = 0;
  while (true) {
    var s  = xml.indexOf("<", pos);
    if (s === -1) break;
    var gt = xml.indexOf(">", s);
    if (gt === -1) break;
    var tc = xml.slice(s + 1, gt);
    var ln = tc.split(":").pop().split(" ")[0];
    if (ln === "return") {
      var ca = "</" + ln + ">";
      var e  = xml.indexOf("</" + tc + ">", gt);
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

// Cargar CSV de precios locales Ipiales desde GitHub
async function fetchPreciosLocales() {
  try {
    var r = await fetch(CSV_URL + "?t=" + Date.now(), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return {};
    var txt = await r.text();
    var lines = txt.split("\n").slice(1).filter(Boolean);
    var mapa = {};
    lines.forEach(function(l) {
      var p = l.split(",");
      var fecha   = p[0] ? p[0].trim() : "";
      var acopio  = parseFloat(p[1]); // bulto
      var dane    = parseFloat(p[2]); // bulto
      if (!fecha) return;
      mapa[fecha] = {
        acopio_bulto: isNaN(acopio) || acopio === 0 ? null : acopio,
        dane_bulto:   isNaN(dane)   || dane   === 0 ? null : dane,
        acopio_kg:    isNaN(acopio) || acopio === 0 ? null : Math.round(acopio / BULTO_KG),
        dane_kg:      isNaN(dane)   || dane   === 0 ? null : Math.round(dane   / BULTO_KG),
      };
    });
    return mapa;
  } catch(e) {
    console.warn("[CSV] No se pudo cargar:", e.message);
    return {};
  }
}

// DANE Pasto: Papa negra, precio en $/kg
async function fetchPrecionDANE() {
  var xml = await fetchSOAP(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<soap:Envelope xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:ser=\"http://servicios.sipsa.co.gov.dane/\">" +
    "<soap:Header/><soap:Body><ser:promediosSipsaCiudad/></soap:Body></soap:Envelope>"
  );
  var pf = {};
  var bl = extraerBloques(xml);
  for (var i = 0; i < bl.length; i++) {
    var b      = bl[i];
    var prod   = getTag(b, "producto").toLowerCase();
    var ciudad = getTag(b, "ciudad").toLowerCase();
    var fecha  = getTag(b, "fechaCaptura").split("T")[0];
    var prec   = parseFloat(getTag(b, "precioPromedio"));
    // Papa negra en Pasto - precio viene en $/bulto desde SIPSA
    if (prod.indexOf("papa negra") === -1) continue;
    if (ciudad.indexOf("pasto") === -1) continue;
    if (!fecha || isNaN(prec) || prec <= 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
    if (!pf[fecha]) pf[fecha] = [];
    pf[fecha].push(prec);
  }
  var keys = Object.keys(pf);
  if (!keys.length) { console.warn("[DANE] Sin Papa negra Pasto"); return []; }
  return keys
    .map(function(f) {
      var arr  = pf[f];
      var bulto = Math.round(arr.reduce(function(a,b){return a+b;},0)/arr.length);
      return {
        fecha:      f,
        dane_bulto: bulto,
        dane_kg:    Math.round(bulto / BULTO_KG),
        fuente:     "dane",
      };
    })
    .sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
}

// Combinar fuentes: acopio local tiene prioridad sobre DANE
// Serie unificada en $/kg para el modelo
function combinarSeries(daneSerie, localMapa) {
  // Incluir todos los dias DANE y enriquecer con local
  var serie = daneSerie.map(function(d) {
    var local = localMapa[d.fecha] || {};
    var precio_kg = local.acopio_kg || d.dane_kg;
    return {
      fecha:        d.fecha,
      precio_kg:    precio_kg,
      precio_bulto: precio_kg * BULTO_KG,
      acopio_kg:    local.acopio_kg || null,
      acopio_bulto: local.acopio_bulto || null,
      dane_kg:      d.dane_kg,
      dane_bulto:   d.dane_bulto,
      fuente:       local.acopio_kg ? "acopio" : "dane",
    };
  });

  // Agregar dias con solo dato local que no esten en DANE
  Object.keys(localMapa).forEach(function(fecha) {
    var ya = serie.some(function(d){ return d.fecha === fecha; });
    if (ya) return;
    var local = localMapa[fecha];
    if (!local.acopio_kg) return;
    serie.push({
      fecha:        fecha,
      precio_kg:    local.acopio_kg,
      precio_bulto: local.acopio_kg * BULTO_KG,
      acopio_kg:    local.acopio_kg,
      acopio_bulto: local.acopio_bulto,
      dane_kg:      local.dane_kg || null,
      dane_bulto:   local.dane_bulto || null,
      fuente:       "acopio",
    });
  });

  return serie.sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
}

async function fetchClima(lat, lon) {
  var tz   = "America%2FBogota";
  var vars = "precipitation_sum,temperature_2m_max,temperature_2m_min,rain_sum";
  var u1 = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
    "&daily=" + vars + "&past_days=14&forecast_days=1&timezone=" + tz;
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

// Modelo AR(1) adaptativo - ventana 14 dias (alta volatilidad)
function modeloAR1(serie, climaIp, acpm) {
  if (serie.length < 7) return modeloSimple(serie);

  // Ventana 14 dias - mas sensible a cambios recientes
  var ventana  = serie.slice(-14).map(function(d){ return d.precio_kg; });
  var med14    = ventana.reduce(function(a,b){return a+b;},0) / ventana.length;
  var std14    = Math.sqrt(ventana.reduce(function(s,x){return s+(x-med14)*(x-med14);},0)/ventana.length);
  var hoy_kg   = serie[serie.length-1].precio_kg;
  var z        = std14 > 0 ? (hoy_kg - med14) / std14 : 0;
  var absZ     = Math.abs(z);

  // Alpha adaptativo calibrado sobre ventana 14d
  var alpha = absZ < 1.0 ? 0.88 : absZ < 1.5 ? 0.72 : 0.52;

  // Ajuste lluvia ultimos 7d - max +3%
  var llIp  = climaIp.historico.slice(-7).map(function(d){return d.lluvia_mm;});
  var llMed = llIp.length ? llIp.reduce(function(a,b){return a+b;},0)/llIp.length : 0;
  var ajLl  = llMed > 10 ? Math.min((llMed-10)/20, 1) * 0.03 : 0;

  // Ajuste ACPM - max +-2%
  var ajAcpm = acpm > 0 ? Math.max(-0.02, Math.min(0.02, (acpm-11000)/11000*0.3)) : 0;

  // Estacionalidad - max +-2%
  var fu  = new Date(serie[serie.length-1].fecha + "T12:00:00Z");
  var ini = new Date(Date.UTC(fu.getUTCFullYear(), 0, 1));
  var sem = Math.ceil((fu - ini) / (7*24*3600*1000));
  var ajEst = Math.sin(2*Math.PI*(sem-13)/52) * 0.02;

  // Perturbacion total calculada sobre precio hoy, se amortigua con distancia
  var pert = hoy_kg * (ajLl + ajAcpm + ajEst);

  var base = new Date(fu);
  var prev = hoy_kg;
  var pred = [];

  for (var i = 0; i < 7; i++) {
    var d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i + 1);
    var ar1       = alpha * prev + (1 - alpha) * med14;
    var amort     = Math.exp(-0.15 * i);
    var precio_kg = Math.round(Math.max(ar1 + pert * amort, 300));
    prev = ar1;
    pred.push({
      fecha:        d.toISOString().split("T")[0],
      precio_kg:    precio_kg,
      precio_bulto: precio_kg * BULTO_KG,
      componentes: {
        ar1_kg:      Math.round(ar1),
        alpha:       alpha,
        z_score:     Math.round(z*100)/100,
        media14_kg:  Math.round(med14),
        perturbacion_kg: Math.round(pert * amort),
      },
    });
  }
  return pred;
}

function modeloSimple(serie) {
  var v  = serie.slice(-14).map(function(d){return d.precio_kg;});
  var n  = v.length;
  var m  = v.reduce(function(a,b){return a+b;},0)/n;
  var base = new Date(serie[serie.length-1].fecha + "T12:00:00Z");
  var res = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(base); d.setUTCDate(d.getUTCDate()+i+1);
    var kg = Math.round(Math.max(m, 300));
    res.push({ fecha: d.toISOString().split("T")[0], precio_kg: kg, precio_bulto: kg*BULTO_KG, componentes: null });
  }
  return res;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
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
      // Cargar fuentes en paralelo - CSV local no bloquea si falla
      var results = await Promise.allSettled([
        fetchPrecionDANE(),
        fetchPreciosLocales(),
        fetchClima(ZONAS.ipiales.lat, ZONAS.ipiales.lon).catch(function(){ return { historico:[], pronostico:[] }; }),
      ]);

      var daneSerie  = results[0].status === "fulfilled" ? results[0].value : [];
      var localMapa  = results[1].status === "fulfilled" ? results[1].value : {};
      var climaIp    = results[2].status === "fulfilled" ? results[2].value : { historico:[], pronostico:[] };

      if (!daneSerie.length && !Object.keys(localMapa).length) {
        throw new Error("Sin datos disponibles de ninguna fuente");
      }

      // Serie combinada: acopio local > DANE Pasto
      var serie = combinarSeries(daneSerie, localMapa);

      var prediccion = modeloAR1(serie, climaIp, acpm);

      // Stats de la serie
      var precios14 = serie.slice(-14).map(function(d){return d.precio_kg;});
      var med14 = Math.round(precios14.reduce(function(a,b){return a+b;},0)/precios14.length);

      var respuesta = {
        ok:          true,
        generado:    new Date().toISOString(),
        fromCache:   false,
        intento:     intento,
        historico:   serie,
        prediccion:  prediccion,
        contexto: {
          precio_actual_kg:     serie[serie.length-1].precio_kg,
          precio_actual_bulto:  serie[serie.length-1].precio_kg * BULTO_KG,
          media14_kg:           med14,
          media14_bulto:        med14 * BULTO_KG,
          fuente_precio_actual: serie[serie.length-1].fuente,
          dias_con_acopio:      serie.filter(function(d){return d.fuente==="acopio";}).length,
          dias_con_dane:        serie.filter(function(d){return d.fuente==="dane";}).length,
          clima_pronostico:     climaIp.pronostico.slice(0,7),
          acpm_gallon:          acpm,
          precio_frontera:      front,
          bulto_kg:             BULTO_KG,
          modelo:               "AR1-adaptativo-v2-ventana14d",
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
    error: ultimoError && ultimoError.name === "AbortError" ? "DANE no respondio a tiempo." : "Error: " + (ultimoError ? ultimoError.message : "desconocido"),
    sugerencia: "El DANE actualiza precios despues de las 2 p.m.",
  });
}
