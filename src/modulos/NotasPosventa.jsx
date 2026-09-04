import { useState, useEffect, useCallback, useRef } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";

// ═══════════════════════════════════════════════════════════════════════════
// TABLERO DE NOTAS
//
// Dos cosas con la forma que le sirve a cada una:
//
//   NOTAS DEL EQUIPO — pines en una cuadrícula, como post-it pegados. Un
//   post-it dice "leéme esto": son pocas al día y cada una importa.
//
//   REGISTRO DE BIGGY — una lista. Un aviso automático dice "esto pasó", y con
//   18 en un día como pines serían un muro ilegible. En lista se escanean en
//   segundos.
//
// LOS PINES NO SE ARRASTRAN
//   Se acomodan solos en la cuadrícula. Guardar coordenadas por nota obliga a
//   recalcularlas en cada tamaño de pantalla, y el efecto visual se consigue
//   igual con el color y una rotación mínima derivada del id: el mismo pin sale
//   siempre igual inclinado, así que no baila al recargar.
//
// EL DÍA FILTRA EL HISTORIAL, NO EL PENDIENTE
//   El calendario elige un día. Pero las notas SIN LEER se muestran siempre,
//   con su fecha a la vista, aunque sean de otro día: si eliges hoy y ayer
//   quedó una nota sin leer, esconderla es justo lo que no debe pasar con una
//   nota de turno.
//
// NO SE EDITA NI SE BORRA
//   Una nota es el registro de un turno. Lo que se lee mañana tiene que ser lo
//   que se escribió ayer.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  navy: "#1B2A4A",
  naranja: "#E8632A",
  gris: "#6B7A90",
  verde: "#1a7f5a",
  lavanda: "#EEF2FF",
};

// Colores de post-it. El del pin sale del id, así que una nota conserva su
// color entre recargas y el analista la reconoce de un vistazo.
const PAPELES = [
  { fondo: "#FFF8C4", borde: "#E8D97A" },
  { fondo: "#FFE0E6", borde: "#F0B8C2" },
  { fondo: "#D6F5E3", borde: "#A8DCC0" },
  { fondo: "#DBEAFE", borde: "#AFCDF5" },
  { fondo: "#FFE8CC", borde: "#F2C99B" },
  { fondo: "#EDE4FF", borde: "#C9B8ED" },
];

function papelDe(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return PAPELES[h % PAPELES.length];
}

function giroDe(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 17 + id.charCodeAt(i)) % 601;
  return ((h % 5) - 2) * 0.4;   // entre -0.8 y 0.8 grados
}

function cuando(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }) + " CDMX";
}

function diaMX(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function pesa(bytes) {
  if (!bytes) return "";
  return bytes < 1048576
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;
}

// ── Adjuntos ───────────────────────────────────────────────────────────────
// El bucket es privado, así que cada archivo necesita una URL firmada. Se pide
// al abrir y no al cargar el tablero: firmar veinte archivos que nadie va a
// abrir es trabajo perdido, y una URL que caduca sin usarse.
function Adjunto({ a }) {
  const [abriendo, setAbriendo] = useState(false);
  const esImagen = (a.tipo || "").startsWith("image/");

  async function abrir() {
    setAbriendo(true);
    const { data } = await sb.storage.from("pnr-notas")
      .createSignedUrl(a.ruta, 300);
    setAbriendo(false);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  return (
    <button onClick={abrir} disabled={abriendo} title={a.nombre}
      style={{ fontSize: 10.5, padding: "3px 8px", borderRadius: 6,
        border: "1px solid rgba(0,0,0,.12)", background: "rgba(255,255,255,.65)",
        maxWidth: 155, overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap", cursor: "pointer" }}>
      {abriendo ? "…" : `${esImagen ? "🖼" : "📄"} ${a.nombre}`}
    </button>
  );
}

// ── Un pin ─────────────────────────────────────────────────────────────────
function Pin({ n, yo, onLeer, marcando }) {
  const papel = papelDe(n.id);
  const lecturas = n.lecturas || [];
  const adjuntos = n.archivos || [];
  const miLectura = lecturas.find((l) => l.analista_id === yo?.id);
  const esMia = n.autor_id && n.autor_id === yo?.id;

  return (
    <div style={{
      background: papel.fondo,
      border: `1px solid ${miLectura ? papel.borde : C.naranja}`,
      borderRadius: 3,
      padding: "13px 14px 11px",
      transform: `rotate(${giroDe(n.id)}deg)`,
      boxShadow: miLectura
        ? "0 1px 3px rgba(0,0,0,.1)"
        : "0 2px 9px rgba(232,99,42,.22)",
      display: "flex", flexDirection: "column", gap: 7,
    }}>
      {/* Una nota de otro día que sigue sin leer aparece igual, y avisa que no
          es del día elegido para que nadie la lea fuera de contexto. */}
      {n.fueraDelDia && (
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
          textTransform: "uppercase", color: C.naranja }}>
          sin leer · {new Date(n.creada_en).toLocaleDateString("es-MX",
            { timeZone: "America/Mexico_City", day: "2-digit", month: "long" })}
        </span>
      )}

      <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap",
        flex: 1 }}>
        {n.texto}
      </div>

      {adjuntos.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {adjuntos.map((a) => <Adjunto key={a.id} a={a} />)}
        </div>
      )}

      {n.case_id && (
        <span style={{ fontSize: 11, fontWeight: 700, color: C.navy,
          fontVariantNumeric: "tabular-nums" }}>
          caso {n.case_id}
        </span>
      )}

      <div style={{ borderTop: "1px solid rgba(0,0,0,.08)", paddingTop: 6,
        fontSize: 10.5, color: "rgba(0,0,0,.55)", lineHeight: 1.4 }}>
        <div style={{ fontWeight: 700 }}>{n.autor_nombre}</div>
        <div>{cuando(n.creada_en)}</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 7,
        flexWrap: "wrap" }}>
        {/* El autor no marca su propia nota: la escribió, ya la vio. */}
        {!miLectura && !esMia && (
          <button onClick={() => onLeer(n.id)} disabled={marcando}
            style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6,
              fontWeight: 700, color: C.navy, background: "rgba(255,255,255,.7)",
              border: "1px solid rgba(0,0,0,.15)", cursor: "pointer" }}>
            {marcando ? "…" : "✓ La leí"}
          </button>
        )}
        {lecturas.length > 0 ? (
          <span style={{ fontSize: 10, color: "rgba(0,0,0,.5)" }}>
            {lecturas.map((l) => `${l.nombre} · ${cuando(l.leida_en)}`).join(" | ")}
          </span>
        ) : !esMia && (
          <span style={{ fontSize: 10, color: C.naranja, fontWeight: 600 }}>
            Nadie la ha leído
          </span>
        )}
      </div>
    </div>
  );
}

// ── Una línea del registro de Biggy ────────────────────────────────────────
const ETIQUETA = {
  aviso: { texto: "avisó", color: C.naranja },
  aprobacion: { texto: "aprobó", color: C.verde },
  rechazo: { texto: "rechazó", color: "#a4131f" },
  chat: { texto: "respondió", color: C.navy },
};

function LineaBiggy({ n, yo, onLeer, marcando }) {
  const leida = (n.lecturas || []).some((l) => l.analista_id === yo?.id);
  const et = ETIQUETA[n.accion] || { texto: n.accion || "hizo", color: C.gris };

  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 9,
      padding: "7px 4px", borderBottom: "1px solid var(--borde)",
      fontSize: 12.5, background: leida ? "transparent" : "#FFF7F3" }}>
      <span style={{ fontSize: 10.5, color: C.gris, minWidth: 92,
        fontVariantNumeric: "tabular-nums" }}>
        {cuando(n.creada_en).replace(" CDMX", "")}
      </span>
      <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: 0.3, color: et.color, minWidth: 68 }}>
        {et.texto}
      </span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{n.texto}</span>
      {!leida && (
        <button onClick={() => onLeer(n.id)} disabled={marcando}
          style={{ fontSize: 10.5, padding: "2px 8px", borderRadius: 6 }}>
          {marcando ? "…" : "✓"}
        </button>
      )}
    </div>
  );
}

export default function NotasPosventa() {
  const { analista } = useAuth();
  const [notas, setNotas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [dia, setDia] = useState(() => diaMX());
  const [texto, setTexto] = useState("");
  const [caso, setCaso] = useState("");
  const [adjuntos, setAdjuntos] = useState([]);
  const [guardando, setGuardando] = useState(false);
  const [marcando, setMarcando] = useState(null);
  const [error, setError] = useState(null);
  const [verBiggy, setVerBiggy] = useState(false);
  const inputArchivo = useRef(null);

  // Se traen las del día elegido MÁS todas las sin leer. Filtrar solo por día
  // escondería un pendiente de ayer, que es justo lo que una nota de turno no
  // debe permitir.
  const cargar = useCallback(async () => {
    const ini = new Date(`${dia}T00:00:00`).toISOString();
    const fin = new Date(`${dia}T23:59:59.999`).toISOString();
    const { data, error: e } = await sb.from("vw_pnr_notas")
      .select("*").limit(400);
    if (e) { setError(e.message); setCargando(false); return; }
    const yo = analista?.id;
    setNotas((data || []).filter((n) => {
      const delDia = n.creada_en >= ini && n.creada_en <= fin;
      const pendiente = yo && n.autor_id !== yo
        && !(n.lecturas || []).some((l) => l.analista_id === yo);
      return delDia || pendiente;
    }).map((n) => ({
      ...n,
      fueraDelDia: !(n.creada_en >= ini && n.creada_en <= fin),
    })));
    setCargando(false);
  }, [dia, analista?.id]);

  useEffect(() => {
    cargar();
    // Si otra analista deja una nota mientras esta pantalla está abierta,
    // aparece sola. Es el caso de uso: dos turnos que se cruzan.
    const canal = sb.channel("pnr-notas-tablero")
      .on("postgres_changes", { event: "*", schema: "public", table: "pnr_notas" }, cargar)
      .on("postgres_changes", { event: "*", schema: "public", table: "pnr_notas_lecturas" }, cargar)
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargar]);

  async function crear() {
    if (!texto.trim() || !analista?.id) return;
    setGuardando(true);
    setError(null);
    try {
      const { data: notaId, error: e } = await sb.rpc("fn_pnr_nota_crear", {
        p_texto: texto,
        p_analista_id: analista.id,
        p_case_id: caso.trim() ? Number(caso.trim()) : null,
      });
      if (e) throw new Error(e.message);

      // Los archivos van DESPUÉS de crear la nota: la ruta los agrupa por
      // nota, y si una subida falla el texto igual quedó guardado. Al revés se
      // perdería la nota entera por un archivo pesado.
      for (const f of adjuntos) {
        const ruta = `${notaId}/${Date.now()}-${f.name.replace(/[^\w.\-]/g, "_")}`;
        const { error: eSub } = await sb.storage.from("pnr-notas")
          .upload(ruta, f, { contentType: f.type || undefined });
        if (eSub) {
          setError(`La nota se guardó, pero "${f.name}" no subió: ${eSub.message}`);
          continue;
        }
        await sb.rpc("fn_pnr_nota_archivo", {
          p_nota_id: notaId, p_ruta: ruta, p_nombre: f.name,
          p_tipo: f.type || null, p_bytes: f.size || null,
        });
      }

      setTexto(""); setCaso(""); setAdjuntos([]);
      if (inputArchivo.current) inputArchivo.current.value = "";
      await cargar();
    } catch (e) {
      setError("No se pudo guardar: " + e.message);
    } finally {
      setGuardando(false);
    }
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

  const delEquipo = notas.filter((n) => n.origen === "analista");
  const deBiggy = notas.filter((n) => n.origen === "biggy");
  const sinLeerBiggy = deBiggy.filter(
    (n) => !(n.lecturas || []).some((l) => l.analista_id === analista?.id)).length;

  // Marcar el bloque de Biggy de una vez: son de lectura rápida y hacerlo una
  // por una es trabajo sin valor.
  async function leerTodasBiggy() {
    if (!analista?.id) return;
    const pend = deBiggy.filter(
      (n) => !(n.lecturas || []).some((l) => l.analista_id === analista.id));
    setMarcando("biggy");
    for (const n of pend) {
      await sb.rpc("fn_pnr_nota_leer", { p_nota_id: n.id, p_analista_id: analista.id });
    }
    setMarcando(null);
    await cargar();
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

      {/* ── Día y nota nueva ─────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap",
        alignItems: "flex-start", marginBottom: 18 }}>

        <div style={{ border: "1px solid var(--borde)", borderRadius: 12,
          padding: "11px 13px", background: "#fff" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
            textTransform: "uppercase", color: C.gris, marginBottom: 6 }}>
            Día
          </div>
          <input type="date" value={dia} max={diaMX()}
            onChange={(e) => setDia(e.target.value)}
            style={{ fontSize: 12.5, padding: "5px 8px", borderRadius: 7,
              border: "1px solid var(--borde)", width: 142 }} />
          <div style={{ fontSize: 10.5, color: C.gris, marginTop: 6,
            maxWidth: 152, lineHeight: 1.35 }}>
            Las notas sin leer se muestran igual, aunque sean de otro día.
          </div>
        </div>

        <div style={{ flex: "1 1 380px", border: "1px solid var(--borde)",
          borderRadius: 12, padding: "11px 13px", background: "#fff" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy,
            marginBottom: 7 }}>
            Pegar una nota
          </div>
          <textarea value={texto} onChange={(e) => setTexto(e.target.value)}
            placeholder="Qué queda pendiente, qué revisar, qué pasó en el turno…"
            rows={3}
            style={{ width: "100%", fontSize: 13, padding: "8px 10px",
              borderRadius: 8, border: "1px solid var(--borde)",
              fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }} />

          {adjuntos.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
              {adjuntos.map((f, i) => (
                <span key={i} style={{ fontSize: 10.5, padding: "3px 8px",
                  borderRadius: 6, background: C.lavanda, color: C.navy }}>
                  {f.name} · {pesa(f.size)}
                  <button onClick={() => setAdjuntos(adjuntos.filter((_, j) => j !== i))}
                    style={{ marginLeft: 5, border: "none", background: "transparent",
                      cursor: "pointer", color: C.gris, padding: 0 }}>×</button>
                </span>
              ))}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8,
            marginTop: 8, flexWrap: "wrap" }}>
            <input value={caso}
              onChange={(e) => setCaso(e.target.value.replace(/\D/g, ""))}
              placeholder="N° de caso (opcional)"
              style={{ fontSize: 12.5, padding: "6px 10px", borderRadius: 7,
                border: "1px solid var(--borde)", width: 162 }} />
            <input ref={inputArchivo} type="file" multiple
              onChange={(e) => setAdjuntos([...adjuntos, ...Array.from(e.target.files || [])])}
              style={{ display: "none" }} />
            <button onClick={() => inputArchivo.current?.click()}
              style={{ fontSize: 11.5, padding: "6px 11px", borderRadius: 7 }}>
              Adjuntar
            </button>
            <button onClick={crear} disabled={guardando || !texto.trim()}
              className="btn-navy"
              style={{ fontSize: 12, fontWeight: 600, padding: "7px 15px",
                borderRadius: 8 }}>
              {guardando ? "Guardando…" : "Pegar nota"}
            </button>
            <span style={{ fontSize: 10.5, color: C.gris, marginLeft: "auto" }}>
              Firma {analista?.nombre || "—"} · no se puede editar
            </span>
          </div>
        </div>
      </div>

      {/* ── El corcho ────────────────────────────────────────────────── */}
      {cargando ? (
        <div style={{ fontSize: 12.5, color: C.gris }}>Cargando…</div>
      ) : delEquipo.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.gris, padding: "26px 0",
          textAlign: "center", border: "1px dashed var(--borde)",
          borderRadius: 12, marginBottom: 22 }}>
          Ninguna nota este día.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, marginBottom: 24,
          gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))" }}>
          {delEquipo.map((n) => (
            <Pin key={n.id} n={n} yo={analista} onLeer={leer}
              marcando={marcando === n.id} />
          ))}
        </div>
      )}

      {/* ── Registro de Biggy ────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10,
        flexWrap: "wrap", marginBottom: 6 }}>
        <button onClick={() => setVerBiggy((v) => !v)}
          style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
            textTransform: "uppercase", color: C.gris, padding: "4px 9px",
            borderRadius: 7 }}>
          {verBiggy ? "▾" : "▸"} Lo que hizo Biggy ({deBiggy.length})
        </button>
        {sinLeerBiggy > 0 && (
          <>
            <span style={{ fontSize: 10.5, fontWeight: 700, background: C.naranja,
              color: "#fff", borderRadius: 10, padding: "2px 8px" }}>
              {sinLeerBiggy} sin ver
            </span>
            <button onClick={leerTodasBiggy} disabled={marcando === "biggy"}
              style={{ fontSize: 11.5, padding: "4px 11px", borderRadius: 7 }}>
              {marcando === "biggy" ? "…" : "✓ Marcar todo como visto"}
            </button>
          </>
        )}
      </div>

      {verBiggy && (
        deBiggy.length === 0 ? (
          <div style={{ fontSize: 12.5, color: C.gris }}>
            Biggy no registró nada este día.
          </div>
        ) : (
          <div style={{ border: "1px solid var(--borde)", borderRadius: 11,
            background: "#fff", padding: "4px 10px" }}>
            {deBiggy.map((n) => (
              <LineaBiggy key={n.id} n={n} yo={analista} onLeer={leer}
                marcando={marcando === n.id} />
            ))}
          </div>
        )
      )}
    </div>
  );
}
