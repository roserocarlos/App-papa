export const config = { maxDuration: 60 };

var SOAP_URL = "https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService";

function getTag(block, tag) {
  var open = "<" + tag + ">";
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  try {
    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, 50000);
    var r = await fetch(SOAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml;charset=UTF-8", "SOAPAction": '""' },
      body: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
        "<soap:Envelope xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:ser=\"http://servicios.sipsa.co.gov.dane/\">" +
        "<soap:Header/><soap:Body><ser:promediosSipsaCiudad/></soap:Body></soap:Envelope>",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    var xml = await r.text();
    var bl = extraerBloques(xml);

    // Recolectar productos con "papa" y ciudades
    var productos = {};
    var ciudadesPapa = {};
    var ciudadesNarino = {};

    for (var i = 0; i < bl.length; i++) {
      var b = bl[i];
      var prod   = getTag(b, "producto").toLowerCase();
      var ciudad = getTag(b, "ciudad");
      var precio = parseFloat(getTag(b, "precioPromedio"));
      var fecha  = getTag(b, "fechaCaptura").split("T")[0];

      // Todas las ciudades del sur
      var ciudadLow = ciudad.toLowerCase();
      if (ciudadLow.indexOf("nari") !== -1 || ciudadLow.indexOf("pasto") !== -1 ||
          ciudadLow.indexOf("ipial") !== -1 || ciudadLow.indexOf("tumaco") !== -1 ||
          ciudadLow.indexOf("popay") !== -1 || ciudadLow.indexOf("cali") !== -1 ||
          ciudadLow.indexOf("sur") !== -1) {
        if (!ciudadesNarino[ciudad]) ciudadesNarino[ciudad] = { count: 0, precios: [] };
        ciudadesNarino[ciudad].count++;
        if (!isNaN(precio)) ciudadesNarino[ciudad].precios.push(precio);
      }

      if (prod.indexOf("papa") === -1) continue;

      // Productos papa unicos
      var prodOrig = getTag(b, "producto");
      if (!productos[prodOrig]) productos[prodOrig] = { count: 0, precios: [], ciudades: {} };
      productos[prodOrig].count++;
      if (!isNaN(precio)) productos[prodOrig].precios.push(precio);
      productos[prodOrig].ciudades[ciudad] = true;

      // Ciudades con papa
      if (!ciudadesPapa[ciudad]) ciudadesPapa[ciudad] = { count: 0, precios: [] };
      ciudadesPapa[ciudad].count++;
      if (!isNaN(precio)) ciudadesPapa[ciudad].precios.push(precio);
    }

    // Calcular promedios
    function resumen(obj) {
      var res = {};
      Object.keys(obj).forEach(function(k) {
        var d = obj[k];
        var pr = d.precios;
        var med = pr.length ? Math.round(pr.reduce(function(a,b){return a+b;},0)/pr.length) : 0;
        var max = pr.length ? Math.max.apply(null, pr) : 0;
        var min = pr.length ? Math.min.apply(null, pr) : 0;
        res[k] = { registros: d.count, precio_promedio: med, precio_max: max, precio_min: min };
        if (d.ciudades) res[k].n_ciudades = Object.keys(d.ciudades).length;
      });
      return res;
    }

    return res.status(200).json({
      generado: new Date().toISOString(),
      total_bloques: bl.length,
      productos_papa: resumen(productos),
      ciudades_con_papa: resumen(ciudadesPapa),
      ciudades_sur_colombia: resumen(ciudadesNarino),
    });

  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
