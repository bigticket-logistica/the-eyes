import { useState, useEffect, useMemo, useCallback } from "react";
import { sbCL } from "../shared/supabase.js";
import { motivoLegible, estiloPrioridad } from "../shared/constantes.js";

// ═══════════════════════════════════════════════════════════════════════════
//  INCIDENCIAS CHILE · solo lectura
//
//  Los casos Last Mile de MELI Chile que captura incidencias-cl.cjs cada 5
//  minutos en el VPS de Chile, leídos de inc_casos_cl en el Supabase de Chile.
//
//  POR QUÉ UN ARCHIVO APARTE Y NO LA TICKETERA DE MÉXICO CON UN IF
//    La Ticketera de México toma casos, abre chats, asigna analistas y habla
//    con Biggy. Nada de eso existe todavía en Chile. Meterle un "si es Chile"
//    a cada una de esas piezas arriesga romper México por algo que en Chile ni
//    se usa. Cuando Chile tenga WhatsApp y Biggy, esto crece por su lado.
//
//  QUÉ MUESTRA
//    Los casos de ayer y hoy, los abiertos primero. No toma ni cierra nada:
//    los casos se trabajan en MELI y esta pantalla dice cómo van.
// ═══════════════════════════════════════════════════════════════════════════

// Estados de MELI en Chile. IN_PROGRESS no existe en México: apareció el
// 17-nov-2026 en un caso de La Serena. Cuenta como abierto — está en curso —
// y si no se nombrara acá ese caso quedaría como cerrado y fuera de la cola.
const ESTADOS_CL = {
  NEW:         { label: "Nuevo",               abierto: true,  bg: "#dbeafe", color: "#1e40af" },
  OPEN:        { label: "Abierto",             abierto: true,  bg: "#fef3c7", color: "#92400e" },
  IN_PROGRESS: { label: "En curso",            abierto: true,  bg: "#fef3c7", color: "#92400e" },
  ON_HOLD:     { label: "Esperando respuesta", abierto: true,  bg: "#f3e8ff", color: "#6b21a8" },
  CHECKING:    { label: "Comprobando",         abierto: true,  bg: "#e0f2fe", color: "#075985" },
  CLOSED:      { label: "Cerrado",             abierto: false, bg: "#dcfce7", color: "#166534" },
  CANCELLED:   { label: "Anulado",             abierto: false, bg: "#f1f5f9", color: "#475569" },
  EXPIRED:     { label: "Anulado",             abierto: false, bg: "#f1f5f9", color: "#475569" },
};

// Un estado que MELI agregue y no esté en la lista se trata como abierto: es
// mejor un caso de más en la cola que uno que nadie mira.
function estado(id) {
  return ESTADOS_CL[id] || { label: id || "—", abierto: true, bg: "#fef3c7", color: "#92400e" };
}

// Nombre de cada centro. Se completa a medida que se confirma; mientras
// tanto se muestra el código.
const SC_CL = {
  SLS1: "La Serena",
};
const nombreSC = (sc) => (SC_CL[sc] ? `${sc} · ${SC_CL[sc]}` : sc || "—");

function horaCL(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("es-CL", {
    timeZone: "America/Santiago", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Trae todo de a mil. Supabase corta cada respuesta en 1000 filas sin avisar;
// en México eso escondió pruebas de los supervisores el 16-nov. Acá son unos
// 200 casos por día, pero el tope no se nota hasta que se nota.
async function traerCasos(desde) {
  const filas = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sbCL.from("inc_casos_cl")
      .select("case_id, motivo_id, prioridad, fecha_caso, estado_id, sub_estado_id, "
            + "route_id, route_code, sc, route_progress, shipment_id, distancia_m, actualizado_en")
      .gte("fecha_caso", desde)
      .order("fecha_caso", { ascending: false })
      .order("case_id", { ascending: true })
      .range(i, i + 999);
    if (error) return { data: filas, error };
    filas.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: filas, error: null };
}

const PESO_PRIORIDAD = { VERY_HIGH: 4, HIGH: 3, MID: 2, MEDIUM: 2, LOW: 1 };

export default function IncidenciasCL() {
  const [casos, setCasos] = useState(null);
  const [error, setError] = useState(null);
  const [filtroSC, setFiltroSC] = useState("");
  const [soloAbiertos, setSoloAbiertos] = useState(true);
  const [visto, setVisto] = useState(null);

  const cargar = useCallback(async () => {
    if (!sbCL) { setError("Faltan las variables de Chile en el despliegue."); return; }
    const desde = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const { data, error } = await traerCasos(desde);
    if (error) { setError(error.message); return; }
    setError(null);
    setCasos(data);
    setVisto(new Date());
  }, []);

  useEffect(() => {
    cargar();
    // El proceso captura cada 5 minutos; releer cada minuto basta para que
    // un caso nuevo aparezca poco después de llegar a la base.
    const t = setInterval(() => { if (!document.hidden) cargar(); }, 60000);
    return () => clearInterval(t);
  }, [cargar]);

  const centros = useMemo(() =>
    [...new Set((casos || []).map((c) => c.sc).filter(Boolean))].sort(), [casos]);

  const resumen = useMemo(() => {
    const base = (casos || []).filter((c) => !filtroSC || c.sc === filtroSC);
    return {
      total: base.length,
      abiertos: base.filter((c) => estado(c.estado_id).abierto).length,
      cerrados: base.filter((c) => c.estado_id === "CLOSED").length,
      anulados: base.filter((c) => ["CANCELLED", "EXPIRED"].includes(c.estado_id)).length,
    };
  }, [casos, filtroSC]);

  // Abiertos primero; entre ellos, la prioridad de MELI y después el más
  // reciente. Un caso Muy alta de hace una hora va antes que uno Bajo de
  // recién.
  const lista = useMemo(() => {
    let l = (casos || []).filter((c) => !filtroSC || c.sc === filtroSC);
    if (soloAbiertos) l = l.filter((c) => estado(c.estado_id).abierto);
    return [...l].sort((a, b) =>
      (estado(b.estado_id).abierto ? 1 : 0) - (estado(a.estado_id).abierto ? 1 : 0)
      || (PESO_PRIORIDAD[b.prioridad] || 0) - (PESO_PRIORIDAD[a.prioridad] || 0)
      || new Date(b.fecha_caso) - new Date(a.fecha_caso));
  }, [casos, filtroSC, soloAbiertos]);

  if (error) {
    return <div style={{ padding: 20, color: "#791F1F", fontSize: 13 }}>
      No se pudieron leer las incidencias de Chile: {error}
    </div>;
  }
  if (casos === null) {
    return <div style={{ padding: 20, color: "var(--texto-suave)", fontSize: 13 }}>Cargando…</div>;
  }

  const Kpi = ({ titulo, valor, color }) => (
    <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10,
      padding: "9px 14px", minWidth: 120 }}>
      <div style={{ fontSize: 10.5, color: "var(--texto-suave)" }}>{titulo}</div>
      <div style={{ fontSize: 21, fontWeight: 600, color: color || "inherit" }}>{valor}</div>
    </div>
  );

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <strong style={{ fontSize: 15 }}>Incidencias · Chile</strong>
        <span style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>
          casos Last Mile de ayer y hoy
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--texto-tenue)" }}>
          {visto ? `visto ${visto.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Kpi titulo="Abiertos" valor={resumen.abiertos}
          color={resumen.abiertos ? "#C25A08" : "#1D9E75"} />
        <Kpi titulo="Cerrados" valor={resumen.cerrados} />
        <Kpi titulo="Anulados" valor={resumen.anulados} />
        <Kpi titulo="Total" valor={resumen.total} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <select value={filtroSC} onChange={(e) => setFiltroSC(e.target.value)}
          style={{ fontSize: 12.5, padding: "5px 8px", borderRadius: 7,
            border: "1px solid var(--borde)", background: "#fff" }}>
          <option value="">Todos los centros</option>
          {centros.map((sc) => <option key={sc} value={sc}>{nombreSC(sc)}</option>)}
        </select>
        <label style={{ fontSize: 12.5, display: "inline-flex", gap: 5, alignItems: "center",
          cursor: "pointer" }}>
          <input type="checkbox" checked={soloAbiertos}
            onChange={(e) => setSoloAbiertos(e.target.checked)} />
          Solo abiertos
        </label>
        <span style={{ fontSize: 11.5, color: "var(--texto-tenue)" }}>
          {lista.length} en pantalla
        </span>
      </div>

      {lista.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--texto-suave)", fontSize: 13,
          background: "#fff", border: "1px solid var(--borde)", borderRadius: 10 }}>
          {soloAbiertos ? "No hay incidencias abiertas." : "No hay incidencias en estos dos días."}
        </div>
      ) : (
        <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10,
          overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--fondo, #f7f8fa)", textAlign: "left",
                color: "var(--texto-suave)", fontSize: 10.5, textTransform: "uppercase",
                letterSpacing: 0.3 }}>
                <th style={{ padding: "7px 10px", fontWeight: 600 }}>Hora</th>
                <th style={{ padding: "7px 10px", fontWeight: 600 }}>Caso</th>
                <th style={{ padding: "7px 10px", fontWeight: 600 }}>Motivo</th>
                <th style={{ padding: "7px 10px", fontWeight: 600 }}>Centro</th>
                <th style={{ padding: "7px 10px", fontWeight: 600 }}>Ruta</th>
                <th style={{ padding: "7px 10px", fontWeight: 600 }}>Prioridad</th>
                <th style={{ padding: "7px 10px", fontWeight: 600 }}>Estado</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => {
                const e = estado(c.estado_id);
                // El listado trae la prioridad media como MID; la tabla de
                // colores de la torre la conoce como MEDIUM.
                const pr = estiloPrioridad(c.prioridad === "MID" ? "MEDIUM" : c.prioridad);
                return (
                  <tr key={c.case_id} style={{ borderTop: "1px solid var(--borde)",
                    opacity: e.abierto ? 1 : 0.7 }}>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap",
                      fontVariantNumeric: "tabular-nums" }}>{horaCL(c.fecha_caso)}</td>
                    <td style={{ padding: "7px 10px", fontVariantNumeric: "tabular-nums" }}>
                      {c.case_id}
                    </td>
                    <td style={{ padding: "7px 10px" }}>{motivoLegible(c.motivo_id)}</td>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>{nombreSC(c.sc)}</td>
                    <td style={{ padding: "7px 10px", fontVariantNumeric: "tabular-nums" }}>
                      {/* El id arriba porque es con lo que se busca en MELI;
                          el nombre abajo en chico. */}
                      <div>{c.route_id || "—"}</div>
                      {c.route_code && (
                        <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{c.route_code}</div>
                      )}
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      <span style={{ background: pr.bg, color: pr.color, fontSize: 10.5,
                        fontWeight: 600, padding: "2px 7px", borderRadius: 999,
                        whiteSpace: "nowrap" }}>{pr.label}</span>
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      <span style={{ background: e.bg, color: e.color, fontSize: 10.5,
                        fontWeight: 600, padding: "2px 7px", borderRadius: 999,
                        whiteSpace: "nowrap" }}>{e.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
