// api/sipsa.js - AgroData IA v3
// Modelo adaptativo con anclaje temporal: funciona aunque el CSV tenga dias de retraso
// Si hay datos recientes los usa; si no, proyecta desde el ultimo dato conocido
export const config = { maxDuration: 60 };

var _cache = null;
var CACHE_TTL = 3 * 60 * 60 * 1000; // 3h - mas fresco
var SOAP_URL = "https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService";
var CSV_URL  = "https://raw.githubusercontent.com/roserocarlos/App-papa/main/data/precios_ipiales.csv";
var BULTO_KG = 50;
var ZONAS    = { ipiales: { lat: 0.8304, lon: -77.6441 } };

// -- Parser XML 
function getTag(block, tag) {
  var open = "<" + tag + ">", close = "</" + tag + ">";
  var a = block.indexOf(open);
  if (a === -1) {
    var re = new RegExp("<[^:>]+:" + tag + ">");
    var ma = block.match(re);
    if (!ma) return "";
    var b2 = block.indexOf(ma[0]) + ma[0].length;
    var e2 = block.indexOf("</", b2);
    return e2 === -1 ? "" : block.slice(b2, e2).trim();
  }
  return block.slice(a + open.length, block.indexOf(close, a + open.length)).trim();
}

function extraerBloques(xml) {
  var res = [], pos = 0;
  while (true) {
    var s = xml.indexOf("<", pos); if (s === -1) break;
    var gt = xml.indexOf(">", s); if (gt === -1) break;
    var tc = xml.slice(s + 1, gt);
    var ln = tc.split(":").pop().split(" ")[0];
    if (ln === "return") {
      var ca = "</" + ln + ">";
      var e = xml.indexOf("</" + tc + ">", gt);
      if (e === -1) e = xml.indexOf(ca, gt);
      if (e === -1) { pos = gt + 1; continue; }
      res.push(xml.slice(gt + 1, e));
      pos = e + ca.length;
    } else { pos = gt + 1; }
  }
  return res;
}

// -- Fetch SOAP 
async function fetchSOAP(body, ms) {
  ms = ms || 25000;
  var ctrl = new AbortController();
  var t = setTimeout(function() { ctrl.abort(); }, ms);
  try {
    var r = await fetch(SOAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml;charset=UTF-8", "SOAPAction": '""' },
      body: body, signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error("DANE HTTP " + r.status);
    return await r.text();
  } catch(e) { clearTimeout(t); throw e; }
}

// -- CSV local Ipiales 
async function fetchCSV() {
  try {
    var r = await fetch(CSV_URL + "?t=" + Date.now(), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    var lines = (await r.text()).split("\n").slice(1).filter(Boolean);
    var datos = [];
    lines.forEach(function(l) {
      var p = l.split(",");
      var fecha  = (p[0] || "").trim();
      var abulto = parseFloat(p[1]);
      var dabulto= parseFloat(p[2]);
      if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return;
      var akg = (!isNaN(abulto) && abulto > 0) ? Math.round(abulto / BULTO_KG) : null;
      var dkg = (!isNaN(dabulto) && dabulto > 0) ? Math.round(dabulto / BULTO_KG) : null;
      if (!akg && !dkg) return; // ignorar filas sin ningun dato
      datos.push({
        fecha: fecha,
        precio_kg:    akg || dkg,
        precio_bulto: (akg || dkg) * BULTO_KG,
        acopio_kg:    akg,
        acopio_bulto: akg ? akg * BULTO_KG : null,
        dane_local_kg: dkg,
        fuente:       akg ? "acopio" : "dane_local",
      });
    });
    return datos.sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
  } catch(e) {
    console.warn("[CSV]", e.message);
    return [];
  }
}

// -- DANE SIPSA Pasto 
async function fetchDANE() {
  try {
    var xml = await fetchSOAP(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
      "<soap:Envelope xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:ser=\"http://servicios.sipsa.co.gov.dane/\">" +
      "<soap:Header/><soap:Body><ser:promediosSipsaCiudad/></soap:Body></soap:Envelope>"
    );
    var pf = {};
    extraerBloques(xml).forEach(function(b) {
      var prod   = getTag(b, "producto").toLowerCase();
      var ciudad = getTag(b, "ciudad").toLowerCase();
      var fecha  = getTag(b, "fechaCaptura").split("T")[0];
      var prec   = parseFloat(getTag(b, "precioPromedio"));
      if (prod.indexOf("papa negra") === -1) return;
      if (ciudad.indexOf("pasto") === -1) return;
      if (!fecha || isNaN(prec) || prec <= 0) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return;
      if (!pf[fecha]) pf[fecha] = [];
      pf[fecha].push(prec);
    });
    return Object.keys(pf).map(function(f) {
      var bulto = Math.round(pf[f].reduce(function(a,b){return a+b;},0)/pf[f].length);
      var kg    = Math.round(bulto / BULTO_KG);
      return { fecha: f, precio_kg: kg, precio_bulto: bulto, fuente: "dane_pasto",
               acopio_kg: null, acopio_bulto: null };
    }).sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
  } catch(e) {
    console.warn("[DANE]", e.message);
    return [];
  }
}

// -- Combinar fuentes 
// Prioridad: acopio local > dane_local > dane_pasto
function combinar(csvDatos, daneDatos) {
  var mapa = {};
  // Base: DANE Pasto
  daneDatos.forEach(function(d) { mapa[d.fecha] = Object.assign({}, d); });
  // Sobrescribir con CSV (tiene prioridad)
  csvDatos.forEach(function(d) {
    if (!mapa[d.fecha]) mapa[d.fecha] = Object.assign({}, d);
    else {
      // Enriquecer: si CSV tiene acopio, usarlo como precio principal
      if (d.acopio_kg) {
        mapa[d.fecha].precio_kg    = d.acopio_kg;
        mapa[d.fecha].precio_bulto = d.acopio_kg * BULTO_KG;
        mapa[d.fecha].acopio_kg    = d.acopio_kg;
        mapa[d.fecha].acopio_bulto = d.acopio_bulto;
        mapa[d.fecha].fuente       = "acopio";
      }
      if (d.dane_local_kg) mapa[d.fecha].dane_local_kg = d.dane_local_kg;
    }
  });
  return Object.values(mapa)
    .filter(function(d){ return d.precio_kg > 0; })
    .sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
}

// -- Clima 
async function fetchClima() {
  var tz = "America%2FBogota";
  var lat = ZONAS.ipiales.lat, lon = ZONAS.ipiales.lon;
  try {
    var r = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
      "&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
      "&forecast_days=7&timezone=" + tz,
      { signal: AbortSignal.timeout(10000) }
    );
    var j = await r.json();
    if (j.error || !j.daily) return [];
    return j.daily.time.map(function(fecha, i) {
      return { fecha: fecha,
        lluvia_mm:   j.daily.precipitation_sum[i] || 0,
        prob_lluvia: j.daily.precipitation_probability_max[i] || 0,
        temp_max:    j.daily.temperature_2m_max[i] || 0,
        temp_min:    j.daily.temperature_2m_min[i] || 0 };
    });
  } catch(e) { return []; }
}

// -- Modelo predictivo 
// AR(1) con anclaje temporal: si el ultimo dato tiene mas de 14 dias de retraso,
// ancla la prediccion a HOY usando el ultimo precio como referencia con
// incertidumbre creciente segun el gap
function predecir(serie, fechaDesde, precioBase) {
  if (!serie.length) return [];

  var HOY = new Date();
  HOY.setUTCHours(12,0,0,0);

  // Fecha desde la que predecir (default: hoy)
  var baseDate = fechaDesde ? new Date(fechaDesde + "T12:00:00Z") : HOY;

  // Ultimo dato disponible
  var ultDato = serie[serie.length-1];
  var diasRetraso = Math.round((HOY - new Date(ultDato.fecha + "T12:00:00Z")) / (24*3600*1000));

  // Precio base para la prediccion
  // Si hay precio manual (del panel de validacion) lo usa; si no, el ultimo dato
  var precioHoy = precioBase || ultDato.precio_kg;

  // Ventana para calcular estadisticos: ultimos 14 datos disponibles
  var ventana = serie.slice(-14).map(function(d){ return d.precio_kg; });
  var med14   = ventana.reduce(function(a,b){return a+b;},0) / ventana.length;
  var std14   = Math.sqrt(ventana.reduce(function(s,x){return s+(x-med14)*(x-med14);},0)/ventana.length);

  // Z-score: que tan alejado esta el precio base de la media historica reciente
  var z    = std14 > 0 ? (precioHoy - med14) / std14 : 0;
  var absZ = Math.abs(z);

  // Alpha: persistencia del precio actual
  // Con retraso grande, reducir alpha (mas reversion a media, menos confianza en precio viejo)
  var alphaBase = absZ < 1.0 ? 0.88 : absZ < 1.5 ? 0.72 : 0.52;
  var factorRetraso = Math.max(0.5, 1 - diasRetraso * 0.01); // pierde 1% por dia de retraso
  var alpha = Math.round(alphaBase * factorRetraso * 100) / 100;

  // Incertidumbre crece con el retraso
  var incertidumbre = Math.min(diasRetraso * 5, 200); // hasta 200 $/kg de margen

  var pred = [];
  var prev = precioHoy;

  for (var i = 0; i < 7; i++) {
    var d = new Date(baseDate);
    d.setUTCDate(d.getUTCDate() + i + 1);
    var ar1 = alpha * prev + (1 - alpha) * med14;
    var kg  = Math.round(Math.max(ar1, 300));
    prev = ar1;
    pred.push({
      fecha:        d.toISOString().split("T")[0],
      precio_kg:    kg,
      precio_bulto: kg * BULTO_KG,
      margen_kg:    Math.round(incertidumbre * (1 + i * 0.15)),
      componentes: {
        alpha:        alpha,
        z_score:      Math.round(z * 100) / 100,
        media14_kg:   Math.round(med14),
        dias_retraso: diasRetraso,
        precio_base:  precioHoy,
      },
    });
  }
  return pred;
}

// Prediccion para una fecha especifica (herramienta de validacion)
function predecirFecha(serie, fechaObjetivo) {
  if (!serie.length || !fechaObjetivo) return null;

  // Encontrar datos disponibles ANTES de la fecha objetivo
  var antesDeObjetivo = serie.filter(function(d){ return d.fecha < fechaObjetivo; });
  if (antesDeObjetivo.length < 3) return null;

  // Usar los ultimos 14 datos disponibles antes de esa fecha
  var ventana = antesDeObjetivo.slice(-14).map(function(d){ return d.precio_kg; });
  var med14   = ventana.reduce(function(a,b){return a+b;},0) / ventana.length;
  var std14   = Math.sqrt(ventana.reduce(function(s,x){return s+(x-med14)*(x-med14);},0)/ventana.length);

  var ultAntes = antesDeObjetivo[antesDeObjetivo.length-1];
  var precioBase = ultAntes.precio_kg;
  var z = std14 > 0 ? (precioBase - med14) / std14 : 0;
  var absZ = Math.abs(z);
  var alpha = absZ < 1.0 ? 0.88 : absZ < 1.5 ? 0.72 : 0.52;

  // Calcular dias entre ultimo dato antes y fecha objetivo
  var d1 = new Date(ultAntes.fecha + "T12:00:00Z");
  var d2 = new Date(fechaObjetivo + "T12:00:00Z");
  var diasHasta = Math.round((d2 - d1) / (24*3600*1000));

  // Proyectar AR(1) dia a dia hasta la fecha objetivo
  var prev = precioBase;
  for (var i = 0; i < diasHasta; i++) {
    prev = alpha * prev + (1 - alpha) * med14;
  }

  var predicho = Math.round(Math.max(prev, 300));
  var margen   = Math.round(std14 * (1 + diasHasta * 0.05));

  // Buscar si hay dato real en esa fecha en la serie
  var datoReal = null;
  serie.forEach(function(d){ if (d.fecha === fechaObjetivo) datoReal = d.precio_kg; });

  return {
    fecha:         fechaObjetivo,
    predicho_kg:   predicho,
    predicho_bulto:predicho * BULTO_KG,
    margen_kg:     margen,
    real_kg:       datoReal,
    real_bulto:    datoReal ? datoReal * BULTO_KG : null,
    error_kg:      datoReal ? Math.abs(predicho - datoReal) : null,
    error_pct:     datoReal ? Math.round(Math.abs(predicho-datoReal)/datoReal*100*10)/10 : null,
    exacto:        datoReal ? Math.abs(predicho-datoReal) <= margen : null,
    basado_en: {
      ultimo_dato:  ultAntes.fecha,
      precio_base:  precioBase,
      dias_proyectados: diasHasta,
      alpha:        alpha,
      media14_kg:   Math.round(med14),
    },
  };
}

// -- Handler 
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  var ahora = Date.now();
  var refresh = req.query.refresh === "1";

  // Prediccion para fecha especifica (herramienta validacion)
  var fechaConsulta  = req.query.fecha  || null;
  var precioRealUser = req.query.precio ? parseFloat(req.query.precio) : null;
  var fechaDesde     = req.query.desde  || null;
  var precioDesde    = req.query.preciobase ? parseFloat(req.query.preciobase) : null;

  if (_cache && (ahora - _cache.timestamp) < CACHE_TTL && !refresh && !fechaConsulta) {
    var c = Object.assign({}, _cache.data, {
      fromCache: true,
      cacheAge:  Math.round((ahora - _cache.timestamp) / 60000),
    });
    if (fechaConsulta) {
      c.consulta_fecha = predecirFecha(c.historico, fechaConsulta);
      if (precioRealUser) c.consulta_fecha.real_kg = precioRealUser;
    }
    return res.status(200).json(c);
  }

  var ultimoError = null;
  for (var intento = 1; intento <= 2; intento++) {
    try {
      var results = await Promise.allSettled([
        fetchCSV(),
        fetchDANE(),
        fetchClima(),
      ]);

      var csvDatos  = results[0].status === "fulfilled" ? results[0].value : [];
      var daneDatos = results[1].status === "fulfilled" ? results[1].value : [];
      var clima     = results[2].status === "fulfilled" ? results[2].value : [];

      var serie = combinar(csvDatos, daneDatos);
      if (!serie.length) throw new Error("Sin datos de ninguna fuente");

      var ultDato     = serie[serie.length-1];
      var HOY         = new Date(); HOY.setUTCHours(12,0,0,0);
      var diasRetraso = Math.round((HOY - new Date(ultDato.fecha + "T12:00:00Z")) / (24*3600*1000));

      var prediccion = predecir(serie, fechaDesde, precioDesde);

      var ventana14  = serie.slice(-14).map(function(d){ return d.precio_kg; });
      var med14      = Math.round(ventana14.reduce(function(a,b){return a+b;},0)/ventana14.length);

      var respuesta = {
        ok:         true,
        generado:   new Date().toISOString(),
        fromCache:  false,
        intento:    intento,
        historico:  serie,
        prediccion: prediccion,
        contexto: {
          precio_actual_kg:     ultDato.precio_kg,
          precio_actual_bulto:  ultDato.precio_kg * BULTO_KG,
          fecha_ultimo_dato:    ultDato.fecha,
          dias_sin_actualizar:  diasRetraso,
          confianza:            diasRetraso <= 7  ? "alta" :
                                diasRetraso <= 30 ? "media" : "baja",
          media14_kg:           med14,
          media14_bulto:        med14 * BULTO_KG,
          fuente_ultimo:        ultDato.fuente,
          total_registros:      serie.length,
          registros_acopio:     serie.filter(function(d){return d.fuente==="acopio";}).length,
          clima_7dias:          clima,
          bulto_kg:             BULTO_KG,
        },
      };

      // Consulta para fecha especifica
      if (fechaConsulta) {
        respuesta.consulta_fecha = predecirFecha(serie, fechaConsulta);
        if (respuesta.consulta_fecha && precioRealUser) {
          respuesta.consulta_fecha.real_kg     = precioRealUser;
          respuesta.consulta_fecha.real_bulto  = precioRealUser * BULTO_KG;
          respuesta.consulta_fecha.error_kg    = Math.abs(respuesta.consulta_fecha.predicho_kg - precioRealUser);
          respuesta.consulta_fecha.error_pct   = Math.round(Math.abs(respuesta.consulta_fecha.predicho_kg-precioRealUser)/precioRealUser*100*10)/10;
          respuesta.consulta_fecha.exacto      = respuesta.consulta_fecha.error_kg <= respuesta.consulta_fecha.margen_kg;
        }
      }

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
    return res.status(200).json(Object.assign({}, _cache.data, {
      fromCache: true, cacheVencida: true,
      cacheAge: Math.round((ahora-_cache.timestamp)/60000),
      advertencia: "Datos de hace " + h + "h - el servicio DANE no respondio",
    }));
  }

  return res.status(503).json({
    ok: false,
    error: ultimoError && ultimoError.name === "AbortError"
      ? "El servicio del DANE no respondio. Intente despues de las 2 p.m."
      : "Error consultando datos: " + (ultimoError ? ultimoError.message : "desconocido"),
  });
}
