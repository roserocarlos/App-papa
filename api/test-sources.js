// api/test-sources-v2.js – v4: sin soil_moisture, variables corregidas
export const config = { maxDuration: 60 };

async function testOpenMeteo(lat, lon, nombre) {
  const hoy    = new Date();
  const hace30 = new Date(hoy); hace30.setDate(hoy.getDate() - 32);
  const ayer   = new Date(hoy); ayer.setDate(hoy.getDate() - 2);
  const fmt = d => d.toISOString().split('T')[0];

  // Variables diarias válidas (sin soil_moisture que es solo horaria)
  const vars = 'precipitation_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration,rain_sum,precipitation_hours';
  const varsFcst = 'precipitation_sum,temperature_2m_max,temperature_2m_min,precipitation_probability_max,rain_sum,weathercode';
  const tz = 'America%2FBogota';

  const urls = {
    forecast_past30: `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${vars}&past_days=30&forecast_days=1&timezone=${tz}`,
    archive:         `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${fmt(hace30)}&end_date=${fmt(ayer)}&daily=${vars}&timezone=${tz}`,
    pronostico7d:    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${varsFcst}&forecast_days=7&timezone=${tz}`,
  };

  const resultados = {};
  for (const [key, url] of Object.entries(urls)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      if (j.error) {
        resultados[key] = { ok: false, error: j.reason };
      } else {
        const dias = j.daily?.time?.length || 0;
        resultados[key] = {
          ok: dias > 0,
          diasDisponibles: dias,
          variables: j.daily ? Object.keys(j.daily).filter(k => k !== 'time') : [],
          ultimoDia: j.daily ? {
            fecha:       j.daily.time?.at(-1),
            lluvia_mm:   j.daily.precipitation_sum?.at(-1),
            temp_max:    j.daily.temperature_2m_max?.at(-1),
            temp_min:    j.daily.temperature_2m_min?.at(-1),
            evapotrans:  j.daily.et0_fao_evapotranspiration?.at(-1),
          } : null,
        };
      }
    } catch (e) {
      resultados[key] = { ok: false, error: e.message };
    }
  }
  return { nombre, metodos: resultados };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const [ipiales, tuquerres, pasto] = await Promise.allSettled([
    testOpenMeteo(0.8304,  -77.6441, 'Ipiales'),
    testOpenMeteo(1.0833,  -77.6167, 'Túquerres'),
    testOpenMeteo(1.2136,  -77.2811, 'Pasto'),
  ]);

  const v = p => p.status === 'fulfilled' ? p.value : { error: p.reason?.message };
  const ri = v(ipiales);

  const ok = (loc) => {
    const r = v(loc);
    return Object.entries(r.metodos || {})
      .filter(([, m]) => m.ok)
      .map(([k, m]) => `${k}: ${m.diasDisponibles}d`);
  };

  return res.status(200).json({
    generado: new Date().toISOString(),
    ipiales:   ri,
    tuquerres: v(tuquerres),
    pasto:     v(pasto),
    resumen: {
      ipiales:   ok(ipiales),
      tuquerres: ok(tuquerres),
      pasto:     ok(pasto),
    },
  });
}
