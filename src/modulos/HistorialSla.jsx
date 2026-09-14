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
// Y por qué sí cumplió, cuando la búsqueda trae un caso que cumple.
const CUMPLE_MOTIVO = {
  evidencia: "Envió la evidencia dentro de las 40 horas.",
  evidencia_corregida:
    "La torre le rechazó la primera evidencia y volvió a cargar dentro del plazo.",
  cerro_con_motivo:
    'Cerró la tarea con "No hay pruebas" explicando el motivo, dentro de las 40 horas.',
  sin_gestion:
    "Mercado Libre anuló el reclamo dentro de las 40 horas, así que la entrega "
    + "quedó confirmada y no había nada que reclamarle al supervisor.",
};

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

  // El veredicto puede ser cualquiera: se busca un caso sin saber cómo salió.
  const no = caso.cumple === "NO CUMPLE";
  const enPlazo = caso.cumple === "EN PLAZO";
  const motivo = no
    ? (MOTIVO[caso.gesto] || "No se registró gestión válida dentro del plazo.")
    : enPlazo
      ? "El plazo todavía corre, así que no hay veredicto: el supervisor puede "
        + "resolverlo en las horas que quedan."
      : (CUMPLE_MOTIVO[caso.gesto] || "Gestionó dentro de las 40 horas.");

  return (
    <div style={{ borderTop: "1px solid var(--borde)", padding: "12px 14px",
      background: "#FBFCFD" }}>

      {/* El veredicto primero: es la respuesta a la pregunta que trajo al
          analista hasta acá. La secuencia viene después, como respaldo. */}
      <div style={{ borderRadius: 10, padding: "10px 12px", marginBottom: 12,
        border: `1px solid ${no ? C.ladrillo : enPlazo ? C.naranja : C.verde}`,
        background: no ? "#FFF7F3" : enPlazo ? "#FFFBF5" : "#F4FBF7" }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4,
          color: no ? C.ladrillo : enPlazo ? C.naranja : C.verde }}>
          {no ? "Por qué no cumple"
             : enPlazo ? "Todavía en plazo" : "Por qué cumple"}
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
  const [busca, setBusca] = useState("");
  const [casos, setCasos] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [abierto, setAbierto] = useState(null);
  const [error, setError] = useState(null);

  // No se lista nada hasta que el analista busque.
  //   Traer los 44 casos sin cumplir de entrada obliga a recorrerlos para
  //   encontrar uno, y este módulo existe para lo contrario: llega un reclamo
  //   por un caso puntual y hay que responderlo. El listado completo ya está
  //   en el tablero.
  async function buscar(e) {
    e?.preventDefault();
    const q = busca.trim();
    if (!q) return;
    setBuscando(true);
    setError(null);
    setAbierto(null);

    // Por número de caso si son solo dígitos, por supervisor o centro si no.
    const esCaso = /^\d+$/.test(q);
    const consulta = sb.from("vw_pnr_sla_tareas").select("*");
    const { data, error: err } = esCaso
      ? await consulta.eq("pnr_case_id", Number(q))
      : await consulta.or(`supervisor.ilike.%${q}%,sc.ilike.%${q}%`)
          .order("vence_en", { ascending: false }).limit(50);

    setBuscando(false);
    if (err) { setError(err.message); setCasos([]); return; }
    setCasos(data || []);
    // Un solo resultado se abre solo: buscar por número de caso y tener que
    // hacer un clic más para ver lo que pediste es un paso de sobra.
    if ((data || []).length === 1) setAbierto(data[0].pnr_case_id);
  }

  return (
    <div>
      {error && (
        <div style={{ background: "#fdecea", border: "1px solid #f5c6cb",
          color: "#a4131f", padding: "8px 12px", borderRadius: 8,
          fontSize: 12.5, marginBottom: 12 }}>{error}</div>
      )}

      <form onSubmit={buscar} style={{ display: "flex", alignItems: "center",
        gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} autoFocus
          placeholder="Número de caso, supervisor o centro"
          style={{ flex: "1 1 300px", maxWidth: 400, fontSize: 13,
            padding: "8px 12px", borderRadius: 8,
            border: "1px solid var(--borde)" }} />
        <button type="submit" disabled={buscando || !busca.trim()}
          className="btn-navy"
          style={{ fontSize: 12.5, fontWeight: 600, padding: "8px 16px",
            borderRadius: 8 }}>
          {buscando ? "Buscando…" : "Buscar"}
        </button>
        {casos !== null && (
          <span style={{ fontSize: 12, color: C.gris }}>
            {casos.length === 0 ? "sin resultados"
              : `${casos.length} caso(s)`}
          </span>
        )}
      </form>

      {casos === null ? (
        <div style={{ fontSize: 12.5, color: C.gris, padding: "40px 20px",
          textAlign: "center", border: "1px dashed var(--borde)",
          borderRadius: 12, lineHeight: 1.6 }}>
          Busca un caso para ver su historia completa: cuándo nació, qué avisos
          salieron, qué hizo el supervisor y por qué cumplió o no.
        </div>
      ) : casos.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.gris, padding: "30px 0",
          textAlign: "center", border: "1px dashed var(--borde)",
          borderRadius: 12 }}>
          No encontré nada con «{busca.trim()}».
        </div>
      ) : (
        <div style={{ border: "1px solid var(--borde)", borderRadius: 12,
          background: "#fff", overflow: "hidden" }}>
          {casos.map((c) => {
            const activo = abierto === c.pnr_case_id;
            const no = c.cumple === "NO CUMPLE";
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
                    {/* El veredicto en la fila: se busca un caso sin saber si
                        cumplió, así que la respuesta tiene que verse antes de
                        abrir nada. */}
                    <span style={{ fontSize: 11.5, fontWeight: 700,
                      color: c.cumple === "CUMPLE" ? C.verde
                           : c.cumple === "EN PLAZO" ? C.naranja : C.ladrillo }}>
                      {c.cumple}
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
