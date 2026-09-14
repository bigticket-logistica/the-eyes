import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// HISTORIAL DE SLA · por qué un caso no cumplió
//
// PARA QUÉ EXISTE
//   Cuando un supervisor reclama que sí cumplió, responderle exigía cruzar a
//   mano tres tablas: los avisos que salieron, los intentos de evidencia con
//   sus rechazos, y el veredicto. El analista no puede hacer eso, así que cada
//   reclamo terminaba en una consulta pedida a alguien más.
//
// LA HISTORIA, NO LA TABLA
//   Se cuenta en orden y en palabras: el caso nace, se avisa, el supervisor
//   responde, la torre rechaza. Una tabla con las mismas filas obliga a
//   reconstruir la secuencia mentalmente; el relato ya la trae.
//
// SOLO LOS QUE NO CUMPLEN
//   Es la lista de trabajo del analista. Los que cumplen no necesitan
//   explicación, y mezclarlos escondería los que sí.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  navy: "#1B2A4A",
  naranja: "#E8632A",
  ladrillo: "#B54634",
  gris: "#6B7A90",
  verde: "#1a7f5a",
  lavanda: "#EEF2FF",
};

// Por qué no cumplió, en la frase que el analista le diría al supervisor.
const MOTIVO = {
  sin_gestion:
    "Nadie abrió ni respondió la tarea en la bitácora dentro de las 40 horas.",
  evidencia_rechazada_sin_corregir:
    "Subió evidencia, la torre se la rechazó y no volvió a cargar antes de que "
    + "venciera el plazo.",
  cerro_sin_motivo:
    'Cerró la tarea con "No hay pruebas" sin escribir por qué no las tenía. '
    + "La norma pide el motivo para que el cierre cuente como gestión.",
  evidencia:
    "Entregó la evidencia, pero fuera de las 40 horas.",
  evidencia_corregida:
    "Corrigió la evidencia después del rechazo, pero fuera de plazo.",
  cerro_con_motivo:
    "Cerró con motivo, pero fuera de las 40 horas.",
};

// Cómo se lee cada acción de la línea de tiempo.
const ACCION = {
  "nace el PNR":          { texto: "Mercado Libre abre el reclamo", color: C.navy, peso: 700 },
  "aviso inicial":        { texto: "Aviso inicial",                 color: C.naranja },
  "recordatorio":         { texto: "Recordatorio",                  color: C.gris },
  "alerta 3 horas":       { texto: "Alerta de 3 horas",             color: C.ladrillo, peso: 600 },
  "evidencia enviada":    { texto: "El supervisor envía evidencia", color: C.verde, peso: 600 },
  "evidencia rechazada":  { texto: "La torre rechaza la evidencia", color: C.ladrillo, peso: 600 },
  "pruebas aprobadas":    { texto: "La torre aprueba las pruebas",  color: C.verde, peso: 600 },
};

function hora(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function dinero(n) {
  return "$" + Number(n || 0).toLocaleString("es-MX",
    { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ── La historia de un caso ─────────────────────────────────────────────────
function Historia({ caso }) {
  const [lineas, setLineas] = useState(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data } = await sb.from("vw_pnr_bitacora_caso")
        .select("*").eq("case_id", caso.pnr_case_id).order("cuando");
      if (vivo) setLineas(data || []);
    })();
    return () => { vivo = false; };
  }, [caso.pnr_case_id]);

  const motivo = MOTIVO[caso.gesto]
    || "No se registró gestión válida dentro del plazo.";

  return (
    <div style={{ borderTop: "1px solid var(--borde)", padding: "12px 14px",
      background: "#FBFCFD" }}>

      {/* El veredicto primero: es la respuesta a la pregunta que trajo al
          analista hasta acá. La secuencia viene después, como respaldo. */}
      <div style={{ border: `1px solid ${C.ladrillo}`, borderRadius: 10,
        padding: "10px 12px", background: "#FFF7F3", marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ladrillo,
          marginBottom: 4 }}>
          Por qué no cumple
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>{motivo}</div>
        <div style={{ fontSize: 11.5, color: C.gris, marginTop: 6 }}>
          El plazo venció el {hora(caso.vence_en)}
          {caso.entregado_en
            ? ` · respondió el ${hora(caso.entregado_en)}, a las ${caso.horas} horas`
            : " · nunca respondió"}
          {caso.rechazadas > 0
            && ` · ${caso.rechazadas} rechazo${caso.rechazadas > 1 ? "s" : ""} de la torre`}
        </div>
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
        textTransform: "uppercase", color: C.gris, marginBottom: 8 }}>
        Qué pasó, en orden
      </div>

      {lineas === null ? (
        <div style={{ fontSize: 12.5, color: C.gris }}>Cargando…</div>
      ) : lineas.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.gris }}>
          No hay registro de acciones para este caso.
        </div>
      ) : (
        <div>
          {lineas.map((l, i) => {
            const a = ACCION[l.accion] || { texto: l.accion, color: C.gris };
            const anterior = i > 0 ? lineas[i - 1] : null;
            // El salto de tiempo entre una acción y la siguiente: es lo que
            // explica un caso, más que las acciones mismas. Trece horas de
            // silencio dicen más que cualquier etiqueta.
            const salto = anterior
              ? Math.round((new Date(l.cuando) - new Date(anterior.cuando)) / 3600000)
              : 0;

            return (
              <div key={i}>
                {salto >= 4 && (
                  <div style={{ fontSize: 10.5, color: C.gris, fontStyle: "italic",
                    padding: "3px 0 3px 14px", borderLeft: "2px dotted var(--borde)",
                    marginLeft: 4 }}>
                    … {salto} horas sin movimiento …
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, alignItems: "baseline",
                  padding: "5px 0", borderLeft: "2px solid var(--borde)",
                  paddingLeft: 12, marginLeft: 4 }}>
                  <span style={{ fontSize: 11, color: C.gris, minWidth: 92,
                    fontVariantNumeric: "tabular-nums" }}>
                    {hora(l.cuando)}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: a.peso || 400,
                    color: a.color, minWidth: 190 }}>
                    {a.texto}
                    {l.destino && ["aviso inicial", "recordatorio", "alerta 3 horas"]
                      .includes(l.accion) && (
                      <span style={{ fontWeight: 400, color: C.gris }}>
                        {" "}al {l.destino}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 11.5, color: C.gris, flex: 1 }}>
                    {l.horas_restantes != null && l.accion !== "nace el PNR"
                      && `quedaban ${l.horas_restantes} h`}
                    {l.detalle && l.accion === "evidencia enviada" && l.detalle}
                    {l.motivo && (
                      <span style={{ color: "var(--texto)", display: "block",
                        marginTop: 2, lineHeight: 1.4 }}>
                        {l.motivo}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function HistorialSla() {
  const [casos, setCasos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState(null);
  const [busca, setBusca] = useState("");
  const [error, setError] = useState(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error: e } = await sb.from("vw_pnr_sla_tareas")
      .select("*").eq("cumple", "NO CUMPLE").order("vence_en", { ascending: false });
    setCargando(false);
    if (e) { setError(e.message); return; }
    setCasos(data || []);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // El buscador acepta el número de caso o el nombre del supervisor: son las
  // dos formas en que llega un reclamo — "el caso tal" o "los míos".
  const q = busca.trim().toLowerCase();
  const lista = q
    ? casos.filter((c) => String(c.pnr_case_id).includes(q)
        || (c.supervisor || "").toLowerCase().includes(q)
        || (c.sc || "").toLowerCase().includes(q))
    : casos;

  return (
    <div>
      {error && (
        <div style={{ background: "#fdecea", border: "1px solid #f5c6cb",
          color: "#a4131f", padding: "8px 12px", borderRadius: 8,
          fontSize: 12.5, marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10,
        flexWrap: "wrap", marginBottom: 12 }}>
        <input value={busca} onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por caso, supervisor o centro"
          style={{ flex: "1 1 280px", maxWidth: 380, fontSize: 12.5,
            padding: "7px 11px", borderRadius: 8,
            border: "1px solid var(--borde)" }} />
        <span style={{ fontSize: 12, color: C.gris }}>
          {cargando ? "cargando…"
            : `${lista.length} caso(s) sin cumplir${q ? " · filtrado" : ""}`}
        </span>
        <button onClick={cargar} style={{ fontSize: 11.5, padding: "5px 11px",
          borderRadius: 7 }}>Actualizar</button>
      </div>

      {!cargando && lista.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.gris, padding: "26px 0",
          textAlign: "center", border: "1px dashed var(--borde)",
          borderRadius: 12 }}>
          {q ? "Ningún caso coincide con la búsqueda."
             : "Ningún caso sin cumplir."}
        </div>
      ) : (
        <div style={{ border: "1px solid var(--borde)", borderRadius: 12,
          background: "#fff", overflow: "hidden" }}>
          {lista.map((c) => {
            const activo = abierto === c.pnr_case_id;
            return (
              <div key={c.tarea_id || c.pnr_case_id}
                style={{ borderBottom: "1px solid var(--borde)" }}>
                <button onClick={() => setAbierto(activo ? null : c.pnr_case_id)}
                  style={{ width: "100%", textAlign: "left", border: "none",
                    background: activo ? "#F7F9FC" : "#fff", cursor: "pointer",
                    padding: "9px 13px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 9,
                    flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: C.gris, width: 10 }}>
                      {activo ? "▾" : "▸"}
                    </span>
                    <strong style={{ fontSize: 12.5, color: C.navy,
                      fontVariantNumeric: "tabular-nums" }}>
                      {c.pnr_case_id}
                    </strong>
                    <span style={{ fontSize: 12, minWidth: 150 }}>{c.supervisor}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 700 }}>{c.sc}</span>
                    {/* El motivo resumido en la fila: con 44 casos, tener que
                        abrir cada uno para saber de qué se trata es lento. */}
                    <span style={{ fontSize: 11, color: C.ladrillo }}>
                      {c.gesto === "sin_gestion" ? "no gestionó"
                        : c.gesto === "evidencia_rechazada_sin_corregir" ? "rechazada, no corrigió"
                        : c.gesto === "cerro_sin_motivo" ? "cerró sin motivo"
                        : "fuera de plazo"}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 12,
                      fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                      {dinero(c.monto)}
                    </span>
                  </div>
                </button>
                {activo && <Historia caso={c} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
