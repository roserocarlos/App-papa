// api/analisis.js
export const config = { maxDuration: 60 };

const SOAP_URL = "https://appweb.dane.gov.co/sipsaWS/SrvSipsaUpraBeanService";

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

async function fetchPrecios() {
  var ctrl = new AbortController();
  var t = setTimeout(function() { ctrl.abort(); }, 50000);
  try {
    var r = await fetch(SOAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml;charset=UTF-8", "SOAPAction": '""' },
      body: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
        "<soap:Envelope xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:ser=\"http://servicios.sipsa.co.gov.dane/\">" +
        "<soap:Header/><soap:Body><ser:promediosSipsaCiudad/></soap:Body></soap:Envelope>",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error("DANE HTTP " + r.status);
    var xml = await r.text();
    var pf = {};
    var bl = extraerBloques(xml);
    for (var i = 0; i < bl.length; i++) {
      var b = bl[i];
      var prod = getTag(b, "producto").toLowerCase();
      var fecha = getTag(b, "fechaCaptura").split("T")[0];
      var precio = parseFloat(getTag(b, "precioPromedio"));
      if (prod.indexOf("papa") === -1 || !fecha || isNaN(precio) || precio <= 0) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
      if (!pf[fecha]) pf[fecha] = [];
      pf[fecha].push(precio);
    }
    var keys = Object.keys(pf);
    if (!keys.length) throw new Error("Sin registros de papa");
    return keys
      .map(function(f) {
        var arr = pf[f];
        return { fecha: f, precio: Math.round(arr.reduce(function(a,b){return a+b;},0)/arr.length) };
      })
      .sort(function(a,b){ return a.fecha < b.fecha ? -1 : 1; });
  } catch(e) { clearTimeout(t); throw e; }
}

function calcRSI(pr, per) {
  per = per || 14;
  if (pr.length < per + 1) return null;
  var g = 0, p = 0;
  for (var i = 1; i <= per; i++) {
    var d = pr[i] - pr[i-1];
    if (d > 0) g += d; else p += Math.abs(d);
  }
  var ag = g/per, ap = p/per;
  for (var j = per+1; j < pr.length; j++) {
    var d2 = pr[j] - pr[j-1];
    if (d2 > 0) { ag=(ag*(per-1)+d2)/per; ap=(ap*(per-1))/per; }
    else { ap=(ap*(per-1)+Math.abs(d2))/per; ag=(ag*(per-1))/per; }
  }
  if (ap === 0) return 100;
  return Math.round((100 - 100/(1+ag/ap))*100)/100;
}

function calcBoll(pr, per) {
  per = per || 20;
  var v = pr.slice(-per);
  var m = v.reduce(function(a,b){return a+b;},0)/v.length;
  var s = Math.sqrt(v.reduce(function(s2,x){return s2+(x-m)*(x-m);},0)/v.length);
  var cur = pr[pr.length-1];
  return {
    media: Math.round(m), upper: Math.round(m+2*s), lower: Math.round(m-2*s),
    std: Math.round(s), precioActual: cur,
    posicion: s > 0 ? Math.round(((cur-(m-2*s))/(4*s))*100) : 50,
  };
}

function calcZ(pr, per) {
  per = per || 30;
  var v = pr.slice(-per);
  var m = v.reduce(function(a,b){return a+b;},0)/v.length;
  var s = Math.sqrt(v.reduce(function(s2,x){return s2+(x-m)*(x-m);},0)/v.length);
  var u = pr[pr.length-1];
  var z = s > 0 ? Math.round((u-m)/s*100)/100 : 0;
  var interp = s > 0 ? (
    (u-m)/s > 1.5  ? "SOBRECOMPRADO - reversion bajista probable" :
    (u-m)/s < -1.5 ? "SOBREVENDIDO - rebote alcista probable" :
    "EN RANGO NORMAL"
  ) : "Sin datos";
  return { z: z, media: Math.round(m), std: Math.round(s), interpretacion: interp };
}

function calcAC(pr, lag) {
  var n = pr.length;
  if (n < lag+10) return null;
  var m = pr.reduce(function(a,b){return a+b;},0)/n;
  var num=0, den=0;
  for (var i=lag; i<n; i++) num+=(pr[i]-m)*(pr[i-lag]-m);
  for (var j=0; j<n; j++) den+=(pr[j]-m)*(pr[j]-m);
  return den > 0 ? Math.round(num/den*1000)/1000 : 0;
}

function calcEstac(serie) {
  var ps = {};
  var mg = serie.reduce(function(s,d){return s+d.precio;},0)/serie.length;
  for (var i=0; i<serie.length; i++) {
    var dt = new Date(serie[i].fecha + "T12:00:00Z");
    var ini = new Date(Date.UTC(dt.getUTCFullYear(),0,1));
    var sw = Math.ceil((dt-ini)/(7*24*3600*1000));
    if (!ps[sw]) ps[sw]=[];
    ps[sw].push(serie[i].precio);
  }
  var idx=[];
  for (var w=1; w<=52; w++) {
    if (ps[w] && ps[w].length>=3) {
      var ms=ps[w].reduce(function(a,b){return a+b;},0)/ps[w].length;
      idx.push({ semana:w, indice:Math.round(ms/mg*100), n:ps[w].length });
    }
  }
  var srt=idx.slice().sort(function(a,b){return b.indice-a.indice;});
  var hoy=new Date();
  var hi=new Date(Date.UTC(hoy.getUTCFullYear(),0,1));
  var sh=Math.ceil((hoy-hi)/(7*24*3600*1000));
  var act=null;
  for (var k=0; k<idx.length; k++) { if(idx[k].semana===sh){act=idx[k];break;} }
  return {
    semanas_caras: srt.slice(0,5).map(function(x){return "Sem"+x.semana+":"+x.indice+"%";}),
    semanas_baratas: srt.slice(-5).reverse().map(function(x){return "Sem"+x.semana+":"+x.indice+"%";}),
    semana_actual: act,
  };
}

function calcMR(pr) {
  var m=pr.reduce(function(a,b){return a+b;},0)/pr.length;
  var s=Math.sqrt(pr.reduce(function(s2,x){return s2+(x-m)*(x-m);},0)/pr.length);
  var ev=[];
  var i=0;
  while (i < pr.length-20) {
    var z=(pr[i]-m)/s;
    if (Math.abs(z)>1.5) {
      var sg=z>0?1:-1;
      for (var j=i+1; j<Math.min(i+30,pr.length); j++) {
        if (sg*(pr[j]-m)/s < 0.5) { ev.push(j-i); break; }
      }
      i+=5;
    } else { i++; }
  }
  if (!ev.length) return { dias_promedio:null, n_eventos:0 };
  var prom=ev.reduce(function(a,b){return a+b;},0)/ev.length;
  var evs=ev.slice().sort(function(a,b){return a-b;});
  return {
    dias_promedio: Math.round(prom*10)/10,
    dias_mediana: evs[Math.floor(evs.length/2)],
    n_eventos: ev.length,
    nota: "El precio tarda ~" + Math.round(prom) + " dias en volver a la media tras desviarse >1.5s",
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    var serie = await fetchPrecios();
    var pr = serie.map(function(d){return d.precio;});
    var n = pr.length;
    var rsi14=calcRSI(pr,14), rsi7=calcRSI(pr,7);
    var b20=calcBoll(pr,20), b50=calcBoll(pr,50);
    var z30=calcZ(pr,30), z90=calcZ(pr,90);
    var ac={};
    var ll=[1,2,3,5,7,10,14,21,30];
    for (var li=0; li<ll.length; li++) ac["lag"+ll[li]+"d"]=calcAC(pr,ll[li]);
    var est=calcEstac(serie);
    var mr=calcMR(pr);
    var pmax=Math.max.apply(null,pr), pmin=Math.min.apply(null,pr);
    var med=Math.round(pr.reduce(function(a,b){return a+b;},0)/n);
    var std=Math.round(Math.sqrt(pr.reduce(function(s,x){return s+(x-med)*(x-med);},0)/n));
    var cv=Math.round(std/med*100);
    var vr=[];
    for (var vi=1; vi<pr.length; vi++) vr.push(Math.abs((pr[vi]-pr[vi-1])/pr[vi-1]*100));
    var vp=Math.round(vr.reduce(function(a,b){return a+b;},0)/vr.length*100)/100;
    var vm=Math.round(Math.max.apply(null,vr)*100)/100;
    var z=z30.z, rsi=rsi14;
    var rec = Math.abs(z)>1.5&&(rsi>65||rsi<35) ? "REVERSION+RSI: correccion fuerte esperada" :
              Math.abs(z)>1.0 ? "REVERSION MODERADA: correccion probable" :
              "MEDIA MOVIL: seguir tendencia reciente";
    return res.status(200).json({
      generado: new Date().toISOString(),
      serie: { total_dias:n, desde:serie[0].fecha, hasta:serie[n-1].fecha, precio_actual:pr[n-1] },
      estadisticas: { media:med, std:std, cv_pct:cv, max:pmax, min:pmin, rango:pmax-pmin },
      volatilidad: { var_diaria_prom:vp, var_diaria_max:vm, nivel: cv>30?"ALTA":cv>15?"MEDIA":"BAJA" },
      indicadores: {
        rsi14: { valor:rsi14, senal:rsi14>70?"SOBRECOMPRADO":rsi14<30?"SOBREVENDIDO":"NEUTRAL" },
        rsi7:  { valor:rsi7,  senal:rsi7>70?"SOBRECOMPRADO":rsi7<30?"SOBREVENDIDO":"NEUTRAL" },
        bollinger20: b20, bollinger50: b50,
        zscore30: z30, zscore90: z90,
      },
      autocorrelaciones: ac,
      estacionalidad: est,
      mean_reversion: mr,
      conclusion: {
        recomendacion: rec, z_actual:z, rsi_actual:rsi,
        senal: Math.abs(z)>1.5&&rsi>65?"BAJA ESPERADA":Math.abs(z)>1.5&&rsi<35?"SUBA ESPERADA":"SIN SENAL",
      },
    });
  } catch(e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
}
