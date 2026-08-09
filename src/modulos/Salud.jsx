import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { diaMX } from "../shared/fechas.js";

// ═══════════════════════════════════════════════════════════════════════════
// SALUD · torre de control de The Eyes
//
// Vigila el sistema, no la operación: cuánto tarda Biggy en responder, si hay
// conductores esperando, si algo se rompió sin que nadie lo viera.
//
// LA MEDIDA QUE IMPORTA ES LA LATENCIA, NO EL VOLUMEN
//   Biggy procesa una conversación a la vez, así que el problema no aparece
//   como "no da abasto" sino como respuestas que tardan cada vez más. Por eso
//   el p95 va destacado: si sube mientras la mediana se mantiene, hay consultas
//   lentas trabando la cola —típicamente buscar_paquete contra un MELI lento—
//   y se nota mucho antes de que alguien se queje.
//
// Los umbrales viven en crm_salud_umbrales, así se ajustan con un update.
// ═══════════════════════════════════════════════════════════════════════════

const COLORES = {
  ok:      { bg: "#ecfdf5", bd: "#a7f3d0", fg: "#15803d", icono: "✓" },
  aviso:   { bg: "#fffbeb", bd: "#fde68a", fg: "#92400e", icono: "▲" },
  critico: { bg: "#fef2f2", bd: "#fca5a5", fg: "#b91c1c", icono: "●" },
};

const n0 = (v) => (v == null ? 0 : Number(v));

function Alerta({ a }) {
  const c = COLORES[a.estado] || COLORES.ok;
  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 10,
      padding: "12px 14px", minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 3 }}>
        <span style={{ color: c.fg, fontSize: 11 }}>{c.icono}</span>
        <span style={{ fontSize: 11, color: "var(--texto-suave)", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.etiqueta}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: c.fg, lineHeight: 1.05 }}>
        {n0(a.valor)}{a.unidad}
      </div>
      <div style={{ fontSize: 10, color: "var(--texto-tenue)", marginTop: 3 }}>
        avisa en {n0(a.aviso)}{a.unidad} · crítico en {n0(a.critico)}{a.unidad}
      </div>
    </div>
  );
}

// Barra proporcional simple: evita traer una librería de gráficos para esto.
function Barra({ valor, max, color }) {
  const pct = max > 0 ? Math.min(100, (valor / max) * 100) : 0;
  return (
    <div style={{ background: "#eef2f7", borderRadius: 4, height: 7, overflow: "hidden", minWidth: 60 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4 }} />
    </div>
  );
}

export default function Salud() {
  const [alertas, setAlertas] = useState([]);
  const [horas, setHoras] = useState([]);
  const [fallos, setFallos] = useState([]);
  const [config, setConfig] = useState(null);
  const [fecha, setFecha] = useState(diaMX());
  const [error, setError] = useState(null);
  const [actualizado, setActualizado] = useState(null);

  const cargar = useCallback(async () => {
    setError(null);
    const [a, h, f, c] = await Promise.all([
      sb.rpc("fn_salud_alertas"),
      sb.rpc("fn_biggy_salud", { p_fecha: fecha }),
      sb.rpc("fn_biggy_fallos", { p_dias: 3 }),
      sb.from("biggy_config").select("*").eq("id", 1).maybeSingle(),
    ]);
    const err = a.error || h.error || f.error;
    if (err) {
      setError(/does not exist|no existe/i.test(err.message)
        ? "Faltan funciones en la base. Corre salud_corregida.sql."
        : err.message);
      return;
    }
    setAlertas(a.data || []);
    setHoras(h.data || []);
    setFallos(f.data || []);
    setConfig(c.data || null);
    setActualizado(new Date());
  }, [fecha]);

  useEffect(() => { cargar(); }, [cargar]);

  // Refresco automático: es una pantalla de vigilancia, tiene que estar al día
  // sin que nadie apriete nada.
  useEffect(() => {
    const t = setInterval(cargar, 30000);
    return () => clearInterval(t);
  }, [cargar]);

  const criticos = alertas.filter((a) => a.estado === "critico");
  const avisos = alertas.filter((a) => a.estado === "aviso");
  const maxEntrantes = Math.max(1, ...horas.map((h) => n0(h.entrantes)));
  const maxLat = Math.max(1, ...horas.map((h) => n0(h.seg_p95)));
  const totalEntrantes = horas.reduce((s, h) => s + n0(h.entrantes), 0);
  const totalBiggy = horas.reduce((s, h) => s + n0(h.resp_biggy), 0);
  const conFallos = fallos.filter((f) => n0(f.cuantos) > 0);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 18, background: "var(--fondo)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Salud del sistema</div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)", marginTop: 2 }}>
            {actualizado
              ? `Actualizado ${actualizado.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })} · se refresca solo cada 30 s`
              : "Cargando…"}
          </div>
        </div>
        {config && (
          <span style={{
            fontSize: 11.5, padding: "5px 11px", borderRadius: 20,
            background: config.nivel === "sombra" ? "#eef2f7" : "#ecfdf5",
            border: `1px solid ${config.nivel === "sombra" ? "var(--borde)" : "#a7f3d0"}`,
            color: config.nivel === "sombra" ? "var(--texto-suave)" : "#15803d",
          }}>
            Biggy · {config.nivel}{config.activo ? "" : " (apagado)"}
          </span>
        )}
        <input type="date" value={fecha} max={diaMX()}
          onChange={(e) => setFecha(e.target.value || diaMX())}
          style={{ fontSize: 12.5, padding: "7px 10px", border: "1px solid var(--borde)", borderRadius: 8 }} />
        <button onClick={cargar} style={{ fontSize: 12, padding: "7px 12px" }}>↻</button>
      </div>

      {error && (
        <div style={{ fontSize: 12.5, color: "#b91c1c", background: "#fef2f2",
          border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* Resumen en una línea: qué hay que mirar ahora */}
      <div style={{
        background: criticos.length ? "#fef2f2" : avisos.length ? "#fffbeb" : "#ecfdf5",
        border: `1px solid ${criticos.length ? "#fca5a5" : avisos.length ? "#fde68a" : "#a7f3d0"}`,
        color: criticos.length ? "#b91c1c" : avisos.length ? "#92400e" : "#15803d",
        borderRadius: 10, padding: "12px 15px", marginBottom: 14, fontSize: 13, lineHeight: 1.5,
      }}>
        {criticos.length > 0
          ? <><b>Requiere atención:</b> {criticos.map((c) => c.etiqueta.toLowerCase()).join(" · ")}</>
          : avisos.length > 0
            ? <><b>Vigilar:</b> {avisos.map((c) => c.etiqueta.toLowerCase()).join(" · ")}</>
            : <><b>Todo en orden.</b> Ningún indicador sobre su umbral.</>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))",
        gap: 10, marginBottom: 18 }}>
        {alertas.map((a) => <Alerta key={a.clave} a={a} />)}
      </div>

      {/* Latencia y volumen por hora */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 3 }}>Por hora · {fecha}</div>
        <div style={{ fontSize: 11.5, color: "var(--texto-suave)", marginBottom: 12, maxWidth: 780, lineHeight: 1.5 }}>
          {totalEntrantes} mensajes de conductores · {totalBiggy} respuestas de Biggy.
          El <b>p95</b> es el que anticipa problemas: si sube mientras la mediana se mantiene,
          hay consultas lentas trabando la cola.
        </div>

        {horas.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--texto-tenue)", padding: "16px 0" }}>
            Sin actividad ese día.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--navy)", color: "#fff" }}>
                  {["Hora", "Entrantes", "", "Fotos", "Audios", "Biggy", "Analistas",
                    "Mediana", "p95", "", "Máx", "Escalados"].map((h, i) => (
                    <th key={i} style={{ padding: "7px 9px", textAlign: i === 0 ? "left" : "center",
                      fontWeight: 600, fontSize: 10.5, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {horas.map((h) => {
                  const p95 = n0(h.seg_p95);
                  const colorLat = p95 >= 400 ? "#b91c1c" : p95 >= 180 ? "#b45309" : "#15803d";
                  return (
                    <tr key={h.hora} style={{ borderBottom: "1px solid var(--borde)" }}>
                      <td style={{ padding: "7px 9px", fontWeight: 600 }}>{h.hora}:00</td>
                      <td style={{ padding: "7px 9px", textAlign: "center", fontWeight: 600 }}>{h.entrantes}</td>
                      <td style={{ padding: "7px 9px", width: 90 }}>
                        <Barra valor={n0(h.entrantes)} max={maxEntrantes} color="var(--navy)" />
                      </td>
                      <td style={{ padding: "7px 9px", textAlign: "center" }}>{h.imagenes || "—"}</td>
                      <td style={{ padding: "7px 9px", textAlign: "center" }}>{h.audios || "—"}</td>
                      <td style={{ padding: "7px 9px", textAlign: "center", color: "#1a5fb4", fontWeight: 600 }}>
                        {h.resp_biggy || "—"}
                      </td>
                      <td style={{ padding: "7px 9px", textAlign: "center" }}>{h.resp_analista || "—"}</td>
                      <td style={{ padding: "7px 9px", textAlign: "center" }}>
                        {h.seg_mediana != null ? `${h.seg_mediana}s` : "—"}
                      </td>
                      <td style={{ padding: "7px 9px", textAlign: "center", fontWeight: 700, color: colorLat }}>
                        {h.seg_p95 != null ? `${h.seg_p95}s` : "—"}
                      </td>
                      <td style={{ padding: "7px 9px", width: 90 }}>
                        <Barra valor={p95} max={maxLat} color={colorLat} />
                      </td>
                      <td style={{ padding: "7px 9px", textAlign: "center", color: "var(--texto-suave)" }}>
                        {h.seg_max != null ? `${h.seg_max}s` : "—"}
                      </td>
                      <td style={{ padding: "7px 9px", textAlign: "center" }}>{h.escalados || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Fallos silenciosos */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12,
        padding: 16, marginTop: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 3 }}>
          Fallos de los últimos 3 días
        </div>
        <div style={{ fontSize: 11.5, color: "var(--texto-suave)", marginBottom: 12 }}>
          Cosas que se rompen sin que nadie se entere. Las categorías en cero también se
          muestran: si desaparecieran, no se sabría si es que no hay problema.
        </div>
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            {fallos.map((f) => {
              const hay = n0(f.cuantos) > 0;
              return (
                <tr key={f.tipo} style={{ borderBottom: "1px solid var(--borde)" }}>
                  <td style={{ padding: "8px 12px 8px 0", width: 22 }}>
                    <span style={{ color: hay ? "#b91c1c" : "#15803d" }}>{hay ? "●" : "✓"}</span>
                  </td>
                  <td style={{ padding: "8px 16px 8px 0", whiteSpace: "nowrap" }}>{f.tipo}</td>
                  <td style={{ padding: "8px 16px 8px 0", fontWeight: 700,
                    color: hay ? "#b91c1c" : "var(--texto-tenue)" }}>{f.cuantos}</td>
                  <td style={{ padding: "8px 16px 8px 0", fontSize: 11.5, color: "var(--texto-suave)" }}>
                    {f.detalle}
                  </td>
                  <td style={{ padding: "8px 0", fontSize: 11, color: "var(--texto-tenue)", whiteSpace: "nowrap" }}>
                    {f.ultimo
                      ? new Date(f.ultimo).toLocaleString("es-MX", {
                          timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit",
                          hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
                      : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {conFallos.length === 0 && (
          <div style={{ fontSize: 12, color: "#15803d", marginTop: 10 }}>
            Nada roto en los últimos 3 días.
          </div>
        )}
      </div>

      {config && (
        <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginTop: 14, lineHeight: 1.6 }}>
          Biggy espera {config.espera_seg}s sin analista · respaldo a los {config.respaldo_min} min ·
          tope de {config.max_mensajes_ia} intervenciones por conversación ·
          ventana {config.ventana_desde}:00 a {config.ventana_hasta}:59 ·
          avisos a supervisores {config.avisar_supervisor_activo ? "activos" : "apagados"}
          {config.enviar_aunque_escale ? " · envía aunque escale" : ""}
        </div>
      )}
    </div>
  );
}
