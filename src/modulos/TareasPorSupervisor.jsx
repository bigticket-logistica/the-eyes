import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// TAREAS ABIERTAS POR SUPERVISOR
//
// La pregunta que responde es "a quién llamo", no "qué casos hay". Por eso se
// agrupa por supervisor y se ordena por su tarea más apretada: la lista por
// caso ya existe en la pestaña PNR y sirve para otra cosa.
//
// EL PLAZO ES EL DEL SUPERVISOR
//   No las 40 horas del reclamo. Su ventana termina antes, para que la torre
//   alcance a revisar la evidencia y cargarla en MELI. Mostrarle las horas de
//   MELI le haría creer que tiene más tiempo del que tiene.
//
// SOLO LAS ABIERTAS
//   Las cerradas son historia y se acumulan rápido — 25 en unos días. Juntas,
//   lo urgente se pierde entre lo resuelto.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  navy: "#1B2A4A",
  naranja: "#E8632A",
  ladrillo: "#B54634",
  gris: "#6B7A90",
  verde: "#1a7f5a",
};

function horasTexto(h) {
  if (h == null) return "—";
  if (h <= 0) return "vencida";
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${h} h`;
}

// El color es el semáforo. Vencida en ladrillo, tres horas o menos en naranja,
// el resto neutro: si todo se pinta, nada resalta.
function colorHoras(h) {
  if (h == null) return C.gris;
  if (h <= 0) return C.ladrillo;
  if (h <= 3) return C.naranja;
  return "var(--texto)";
}

function cuando(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function Caso({ c }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10,
      padding: "5px 2px", borderTop: "1px solid var(--borde)", fontSize: 12 }}>
      <span style={{ fontWeight: 700, color: C.navy, minWidth: 82,
        fontVariantNumeric: "tabular-nums" }}>
        {c.case_id}
      </span>
      <span style={{ minWidth: 62, fontWeight: 700,
        color: colorHoras(c.horas), fontVariantNumeric: "tabular-nums" }}>
        {horasTexto(c.horas)}
      </span>
      <span style={{ color: C.gris, minWidth: 118 }}>{c.route_code || "—"}</span>
      <span style={{ color: C.gris, flex: 1, minWidth: 130 }}>
        {c.conductor || "—"}
      </span>
      {/* Una tarea pedida dos veces es una evidencia que ya se rechazó: cambia
          la conversación con el supervisor, así que se marca. */}
      {c.veces_pedida > 1 && (
        <span style={{ fontSize: 10, fontWeight: 700, color: C.ladrillo }}>
          pedida {c.veces_pedida}×
        </span>
      )}
      {c.n_fotos > 0 && (
        <span style={{ fontSize: 10, fontWeight: 700, color: C.verde }}>
          {c.n_fotos} foto(s)
        </span>
      )}
      <span style={{ color: C.gris, fontSize: 11 }}>
        {c.vista_en ? "vista" : "sin abrir"}
      </span>
      <span style={{ fontWeight: 600, minWidth: 74, textAlign: "right",
        fontVariantNumeric: "tabular-nums" }}>
        ${Number(c.monto || 0).toLocaleString("es-MX",
          { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
      </span>
    </div>
  );
}

export default function TareasPorSupervisor() {
  const [filas, setFilas] = useState([]);
  const [abierto, setAbierto] = useState(new Set());
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);

  const cargar = useCallback(async () => {
    const { data, error: e } = await sb.from("vw_pnr_tareas_por_supervisor")
      .select("*");
    if (e) { setError(e.message); setCargando(false); return; }
    setFilas(data || []);
    setCargando(false);
  }, []);

  useEffect(() => {
    cargar();
    // Las horas corren solas, así que se relee cada dos minutos. Realtime no
    // ayudaría: lo que cambia con el tiempo es el cálculo, no la fila.
    const t = setInterval(() => { if (!document.hidden) cargar(); }, 120000);
    const canal = sb.channel("pnr-tareas-supervisor")
      .on("postgres_changes", { event: "*", schema: "public", table: "pnr_tareas_mx" }, cargar)
      .subscribe();
    return () => { clearInterval(t); sb.removeChannel(canal); };
  }, [cargar]);

  function alternar(clave) {
    setAbierto((prev) => {
      const s = new Set(prev);
      s.has(clave) ? s.delete(clave) : s.add(clave);
      return s;
    });
  }

  const totalAbiertas = filas.reduce((s, f) => s + Number(f.abiertas || 0), 0);
  const totalVencidas = filas.reduce((s, f) => s + Number(f.vencidas || 0), 0);
  const totalPorVencer = filas.reduce((s, f) => s + Number(f.por_vencer || 0), 0);

  if (cargando) {
    return <div style={{ fontSize: 12.5, color: C.gris }}>Cargando tareas…</div>;
  }

  return (
    <div>
      {error && (
        <div style={{ background: "#fdecea", border: "1px solid #f5c6cb",
          color: "#a4131f", padding: "8px 12px", borderRadius: 8,
          fontSize: 12.5, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "baseline", gap: 12,
        flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.navy }}>
          Tareas abiertas en bitácora
        </span>
        <span style={{ fontSize: 11.5, color: C.gris }}>
          {totalAbiertas} en {filas.length} centro(s)
          {totalVencidas > 0 && ` · ${totalVencidas} vencida(s)`}
          {totalPorVencer > 0 && ` · ${totalPorVencer} con 3 h o menos`}
        </span>
      </div>

      {filas.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.gris, padding: "18px 0",
          textAlign: "center", border: "1px dashed var(--borde)",
          borderRadius: 11 }}>
          Ningún supervisor tiene tareas abiertas.
        </div>
      ) : (
        <div style={{ border: "1px solid var(--borde)", borderRadius: 12,
          background: "#fff", overflow: "hidden" }}>
          {filas.map((f) => {
            const clave = `${f.supervisor_nombre}|${f.sc}`;
            const desplegado = abierto.has(clave);
            return (
              <div key={clave} style={{ borderBottom: "1px solid var(--borde)" }}>
                <button onClick={() => alternar(clave)}
                  style={{ width: "100%", display: "flex", alignItems: "center",
                    gap: 12, padding: "9px 13px", border: "none",
                    background: desplegado ? "#F7F9FC" : "#fff",
                    cursor: "pointer", textAlign: "left", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, color: C.gris, width: 10 }}>
                    {desplegado ? "▾" : "▸"}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 700, minWidth: 168 }}>
                    {f.supervisor_nombre || "sin supervisor"}
                  </span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: C.navy,
                    minWidth: 48 }}>
                    {f.sc}
                  </span>
                  <span style={{ fontSize: 12, minWidth: 88 }}>
                    {f.abiertas} abierta{f.abiertas === 1 ? "" : "s"}
                  </span>
                  {/* La más apretada es la que decide si hay que llamarlo, así
                      que va en el resumen y no escondida en el detalle. */}
                  <span style={{ fontSize: 12.5, fontWeight: 700,
                    color: colorHoras(Number(f.horas_min)), minWidth: 96 }}>
                    {Number(f.vencidas) > 0
                      ? `${f.vencidas} vencida(s)`
                      : `queda ${horasTexto(Number(f.horas_min))}`}
                  </span>
                  {Number(f.reabiertas) > 0 && (
                    <span style={{ fontSize: 10.5, fontWeight: 700,
                      color: C.ladrillo }}>
                      {f.reabiertas} reabierta(s)
                    </span>
                  )}
                  {Number(f.con_evidencia) > 0 && (
                    <span style={{ fontSize: 10.5, fontWeight: 700,
                      color: C.verde }}>
                      {f.con_evidencia} con evidencia
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontSize: 12.5,
                    fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    ${Number(f.monto_en_juego || 0).toLocaleString("es-MX",
                      { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </span>
                </button>

                {desplegado && (
                  <div style={{ padding: "0 13px 9px 35px" }}>
                    {(f.casos || []).map((c) => (
                      <Caso key={c.case_id} c={c} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
