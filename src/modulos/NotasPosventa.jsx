import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";

// ═══════════════════════════════════════════════════════════════════════════
// NOTAS DE POSVENTA
//
// Dos cosas distintas en la misma pantalla, separadas a propósito:
//
//   NOTAS DE TURNO — lo que una analista deja escrito para quien entra
//   después. Pocas al día y cada una importa. Van arriba.
//
//   REGISTRO DE BIGGY — lo que hizo el respaldo automático con el toggle
//   abierto: qué avisó, qué aprobó, qué rechazó, qué respondió en el chat.
//   Muchas y de lectura rápida. Van abajo y se marcan en bloque.
//
// Si fueran una sola lista, un día movido de Biggy dejaría el badge en 40 y la
// nota de la analista del turno anterior se perdería entre avisos automáticos.
//
// LA LECTURA ES POR PERSONA, NO POR NOTA
//   Una fila por nota y lector en pnr_notas_lecturas, en vez de un booleano
//   "leída". Con varios analistas por turno, saber que alguien la leyó no dice
//   si la leyó QUIEN tenía que leerla, y el pendiente de cada uno es suyo.
//
// NO SE EDITA NI SE BORRA
//   Una nota es el registro de un turno. Poder cambiarla después le quita el
//   valor: lo que se lee mañana tiene que ser lo que se escribió ayer.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  navy: "#1B2A4A",
  naranja: "#E8632A",
  gris: "#6B7A90",
  verde: "#1a7f5a",
  lavanda: "#EEF2FF",
};

function cuando(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }) + " CDMX";
}

// ── Una nota ───────────────────────────────────────────────────────────────
function Nota({ n, yo, onLeer, marcando }) {
  const lecturas = n.lecturas || [];
  const miLectura = lecturas.find((l) => l.analista_id === yo?.id);
  const esMia = n.autor_id && n.autor_id === yo?.id;
  const deBiggy = n.origen === "biggy";

  return (
    <div style={{
      border: `1px solid ${miLectura ? "var(--borde)" : C.naranja}`,
      borderRadius: 11, padding: "11px 13px", marginBottom: 8,
      background: miLectura ? "#fff" : "#FFF7F3",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8,
        flexWrap: "wrap", marginBottom: 5 }}>
        <strong style={{ fontSize: 12.5, color: deBiggy ? C.navy : "var(--texto)" }}>
          {n.autor_nombre}
        </strong>
        {deBiggy && n.accion && (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px",
            borderRadius: 9, background: C.lavanda, color: C.navy }}>
            {n.accion}
          </span>
        )}
        <span style={{ fontSize: 11, color: C.gris }}>{cuando(n.creada_en)}</span>
        {n.case_id && (
          <span style={{ fontSize: 11, color: C.navy, fontWeight: 600,
            fontVariantNumeric: "tabular-nums" }}>
            caso {n.case_id}
          </span>
        )}
      </div>

      <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
        {n.texto}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10,
        flexWrap: "wrap", marginTop: 8 }}>
        {/* El autor no marca su propia nota: la escribió, ya la vio. Marcarla
            solo inflaría el registro de lecturas sin decir nada. */}
        {!miLectura && !esMia && (
          <button onClick={() => onLeer(n.id)} disabled={marcando}
            style={{ fontSize: 11.5, padding: "4px 11px", borderRadius: 7,
              fontWeight: 600, color: C.navy }}>
            {marcando ? "…" : "✓ La leí"}
          </button>
        )}

        {/* Quién la leyó y cuándo, a la vista. Es el punto de dejar una nota:
            saber que llegó. */}
        {lecturas.length > 0 && (
          <span style={{ fontSize: 11, color: C.gris }}>
            Leída por {lecturas.map((l) => `${l.nombre} (${cuando(l.leida_en)})`).join(" · ")}
          </span>
        )}
        {lecturas.length === 0 && !esMia && (
          <span style={{ fontSize: 11, color: C.naranja }}>Nadie la ha leído</span>
        )}
      </div>
    </div>
  );
}

export default function NotasPosventa() {
  const { analista } = useAuth();
  const [notas, setNotas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [texto, setTexto] = useState("");
  const [caso, setCaso] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [marcando, setMarcando] = useState(null);
  const [error, setError] = useState(null);
  const [verBiggy, setVerBiggy] = useState(false);

  // Rango de fechas. Arranca en los últimos 7 días y no en "todo": con 18 notas
  // el primer día, en una semana son más de cien y buscar algo se vuelve
  // scroll. El rango aplica a las dos secciones — las del equipo y las de
  // Biggy— porque una nota de turno de hace un mes tampoco sirve de nada.
  const [desde, setDesde] = useState(() => {
    const d = new Date(Date.now() - 7 * 86400000);
    return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  });
  const [hasta, setHasta] = useState(() =>
    new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }));

  const cargar = useCallback(async () => {
    // El rango se aplica en la consulta y no al pintar: traer todo para mostrar
    // una semana carga la pantalla con datos que nadie va a mirar.
    //
    // El "hasta" incluye el día completo en hora de México. Sin el ajuste, una
    // nota de las 18:00 del día elegido quedaba fuera porque la comparación
    // corta a las 00:00 UTC.
    const finDia = new Date(`${hasta}T23:59:59.999`);
    const { data, error: e } = await sb.from("vw_pnr_notas")
      .select("*")
      .gte("creada_en", new Date(`${desde}T00:00:00`).toISOString())
      .lte("creada_en", finDia.toISOString())
      .limit(500);
    if (e) { setError(e.message); setCargando(false); return; }
    setNotas(data || []);
    setCargando(false);
  }, [desde, hasta]);

  useEffect(() => {
    cargar();
    // Realtime: si otra analista deja una nota mientras esta pantalla está
    // abierta, aparece sola. Es el caso de uso — dos turnos que se cruzan.
    const canal = sb.channel("pnr-notas")
      .on("postgres_changes", { event: "*", schema: "public", table: "pnr_notas" }, cargar)
      .on("postgres_changes", { event: "*", schema: "public", table: "pnr_notas_lecturas" }, cargar)
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargar]);

  async function crear() {
    if (!texto.trim() || !analista?.id) return;
    setGuardando(true);
    setError(null);
    const { error: e } = await sb.rpc("fn_pnr_nota_crear", {
      p_texto: texto,
      p_analista_id: analista.id,
      p_case_id: caso.trim() ? Number(caso.trim()) : null,
    });
    setGuardando(false);
    if (e) { setError("No se pudo guardar: " + e.message); return; }
    setTexto("");
    setCaso("");
    await cargar();
  }

  async function leer(notaId) {
    if (!analista?.id) return;
    setMarcando(notaId);
    const { error: e } = await sb.rpc("fn_pnr_nota_leer", {
      p_nota_id: notaId, p_analista_id: analista.id,
    });
    setMarcando(null);
    if (e) { setError("No se pudo marcar: " + e.message); return; }
    await cargar();
  }

  // Marcar todo el bloque de Biggy de una vez: son de lectura rápida y
  // marcarlas una por una es trabajo sin valor.
  async function leerTodasBiggy() {
    if (!analista?.id) return;
    const pendientes = deBiggy.filter(
      (n) => !(n.lecturas || []).some((l) => l.analista_id === analista.id));
    setMarcando("biggy");
    for (const n of pendientes) {
      await sb.rpc("fn_pnr_nota_leer", { p_nota_id: n.id, p_analista_id: analista.id });
    }
    setMarcando(null);
    await cargar();
  }

  const deAnalistas = notas.filter((n) => n.origen === "analista");
  const deBiggy = notas.filter((n) => n.origen === "biggy");
  const sinLeerBiggy = deBiggy.filter(
    (n) => !(n.lecturas || []).some((l) => l.analista_id === analista?.id)).length;

  return (
    <div>
      {error && (
        <div style={{ background: "#fdecea", border: "1px solid #f5c6cb",
          color: "#a4131f", padding: "8px 12px", borderRadius: 8,
          fontSize: 12.5, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* ── Rango ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8,
        marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
          textTransform: "uppercase", color: C.gris }}>
          Notas de
        </span>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6,
          border: "1px solid var(--borde)", borderRadius: 9, padding: "4px 9px",
          background: "#fff" }}>
          <input type="date" value={desde} max={hasta}
            onChange={(e) => setDesde(e.target.value)}
            style={{ fontSize: 12, border: "none", outline: "none", padding: 0,
              background: "transparent", width: 116 }} />
          <span style={{ fontSize: 11, color: C.gris }}>→</span>
          <input type="date" value={hasta} min={desde}
            onChange={(e) => setHasta(e.target.value)}
            style={{ fontSize: 12, border: "none", outline: "none", padding: 0,
              background: "transparent", width: 116 }} />
        </div>
        <button onClick={() => {
          const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
          setDesde(hoy); setHasta(hoy);
        }} style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 7 }}>
          Hoy
        </button>
      </div>

      {/* ── Dejar una nota ────────────────────────────────────────────── */}
      <div style={{ border: "1px solid var(--borde)", borderRadius: 12,
        padding: "12px 14px", marginBottom: 18, background: "#fff" }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy,
          marginBottom: 7 }}>
          Dejar una nota
        </div>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)}
          placeholder="Qué queda pendiente, qué revisar, qué pasó en el turno…"
          rows={3}
          style={{ width: "100%", fontSize: 13, padding: "8px 10px",
            borderRadius: 8, border: "1px solid var(--borde)",
            fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8,
          marginTop: 8, flexWrap: "wrap" }}>
          <input value={caso} onChange={(e) => setCaso(e.target.value.replace(/\D/g, ""))}
            placeholder="N° de caso (opcional)"
            style={{ fontSize: 12.5, padding: "6px 10px", borderRadius: 7,
              border: "1px solid var(--borde)", width: 170 }} />
          <button onClick={crear} disabled={guardando || !texto.trim()}
            className="btn-navy"
            style={{ fontSize: 12, fontWeight: 600, padding: "7px 15px",
              borderRadius: 8 }}>
            {guardando ? "Guardando…" : "Dejar nota"}
          </button>
          <span style={{ fontSize: 11, color: C.gris, marginLeft: "auto" }}>
            Firma {analista?.nombre || "—"} · no se puede editar después
          </span>
        </div>
      </div>

      {/* ── Notas de analistas ────────────────────────────────────────── */}
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
        textTransform: "uppercase", color: C.gris, marginBottom: 8 }}>
        Notas del equipo
      </div>
      {cargando ? (
        <div style={{ fontSize: 12.5, color: C.gris }}>Cargando…</div>
      ) : deAnalistas.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.gris, marginBottom: 20 }}>
          Todavía no hay notas.
        </div>
      ) : (
        <div style={{ marginBottom: 22 }}>
          {deAnalistas.map((n) => (
            <Nota key={n.id} n={n} yo={analista} onLeer={leer}
              marcando={marcando === n.id} />
          ))}
        </div>
      )}

      {/* ── Registro de Biggy ─────────────────────────────────────────── */}
      {/* Plegado por defecto: es un registro para auditar, no algo que haya que
          leer todos los días. Lo importante —que pasó algo— ya está en el
          contador. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10,
        marginBottom: 8, flexWrap: "wrap" }}>
        <button onClick={() => setVerBiggy((v) => !v)}
          style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
            textTransform: "uppercase", color: C.gris, padding: "4px 9px",
            borderRadius: 7 }}>
          {verBiggy ? "▾" : "▸"} Lo que hizo Biggy ({deBiggy.length})
        </button>
        {sinLeerBiggy > 0 && (
          <span style={{ fontSize: 10.5, fontWeight: 700, background: C.naranja,
            color: "#fff", borderRadius: 10, padding: "2px 8px" }}>
            {sinLeerBiggy} sin ver
          </span>
        )}
        {sinLeerBiggy > 0 && (
          <button onClick={leerTodasBiggy} disabled={marcando === "biggy"}
            style={{ fontSize: 11.5, padding: "4px 11px", borderRadius: 7 }}>
            {marcando === "biggy" ? "…" : "✓ Marcar todo como visto"}
          </button>
        )}
      </div>

      {verBiggy && (
        deBiggy.length === 0 ? (
          <div style={{ fontSize: 12.5, color: C.gris }}>
            Biggy no ha registrado nada.
          </div>
        ) : (
          deBiggy.map((n) => (
            <Nota key={n.id} n={n} yo={analista} onLeer={leer}
              marcando={marcando === n.id} />
          ))
        )
      )}
    </div>
  );
}
