import { useEffect, useState, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";

// ═══════════════════════════════════════════════════════════════════════════
// DIRECTORIO · Padrón de teléfonos de conductores
// Fuente: vw_directorio_conductores (padrón MELI + capa editable).
// Editar guarda un override en crm_directorio_conductores (lo manual gana).
// "Agregar de prueba" crea un conductor con driver_id negativo, para ensayar
// plantillas y el bot sin molestar a un chofer real.
// ═══════════════════════════════════════════════════════════════════════════

const ORIGEN = {
  meli:        { label: "MELI",      bg: "#e0f2fe", color: "#075985" },
  carga_excel: { label: "Padrón BT", bg: "#dcfce7", color: "#166534" },
  demo:        { label: "Prueba",    bg: "#f3e8ff", color: "#6b21a8" },
  ajuste: { label: "Ajuste", bg: "#FAEEDA", color: "#633806" },
  manual: { label: "Prueba", bg: "#f3e8ff", color: "#6b21a8" },
};

function Campo({ etiqueta, ...props }) {
  return (
    <label style={{ display: "block", fontSize: 12, color: "var(--texto-suave)", marginBottom: 10 }}>
      <span style={{ display: "block", marginBottom: 4 }}>{etiqueta}</span>
      <input {...props} style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px", border: "1px solid var(--borde)", borderRadius: 7 }} />
    </label>
  );
}

// Formulario de edición / creación
function FormConductor({ inicial, onGuardar, onCerrar, guardando, error }) {
  const [f, setF] = useState({
    nombre: inicial?.nombre || "",
    telefono: inicial?.telefono || "",
    email: inicial?.email || "",
    patente: inicial?.patente || "",
    notas: inicial?.notas || "",
  });
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const esNuevo = !inicial?.driver_id;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={onCerrar}>
      <div style={{ background: "#fff", borderRadius: 12, width: 420, maxWidth: "100%", padding: 18 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            {esNuevo ? "➕ Conductor de prueba" : `✏️ ${inicial.nombre || "Conductor"}`}
          </div>
          <button onClick={onCerrar} style={{ fontSize: 12, padding: "2px 10px" }}>✕</button>
        </div>

        {!esNuevo && (
          <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginBottom: 10 }}>
            driver_id {inicial.driver_id} · lo que edites aquí queda por sobre lo que trae MELI
          </div>
        )}

        <Campo etiqueta="Nombre" value={f.nombre} onChange={set("nombre")} placeholder="Nombre y apellido" />
        <Campo etiqueta="Teléfono (WhatsApp, con código de país)" value={f.telefono} onChange={set("telefono")} placeholder="521XXXXXXXXXX" />
        <Campo etiqueta="Email" value={f.email} onChange={set("email")} placeholder="correo@ejemplo.com" />
        <Campo etiqueta="Patente" value={f.patente} onChange={set("patente")} placeholder="SDD-XXXXXX" />
        <Campo etiqueta="Notas" value={f.notas} onChange={set("notas")} placeholder="Ej: número de prueba de la torre" />

        <div style={{ fontSize: 11.5, color: "var(--texto-tenue)", marginBottom: 8 }}>
        {cargando ? "Cargando…" : `${filas.length} conductor${filas.length === 1 ? "" : "es"}`}
        {!verTodos && !cargando && " con teléfono"}
      </div>

      {error && <div style={{ color: "#791F1F", fontSize: 12, marginBottom: 8 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCerrar} style={{ fontSize: 13, padding: "7px 14px" }}>Cancelar</button>
          <button onClick={() => onGuardar(f)} disabled={guardando || !f.nombre.trim()}
            style={{ fontSize: 13, padding: "7px 16px", background: "var(--navy)", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", opacity: guardando ? 0.6 : 1 }}>
            {guardando ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Directorio() {
  const { analista } = useAuth();
  const [q, setQ] = useState("");
  const [filas, setFilas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [editar, setEditar] = useState(null);   // fila en edición, {} = nuevo
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState("");
  const [verTodos, setVerTodos] = useState(false);

  // El padrón de MELI trae miles de nombres sin teléfono: son los conductores
  // que existen en el sistema pero de los que no tenemos forma de contacto.
  // Por defecto se muestran solo los CONTACTABLES, que son los que sirven para
  // trabajar; el resto queda detrás de un interruptor. Antes los sin teléfono
  // ahogaban la lista y el directorio parecía vacío de datos.
  const cargar = useCallback(async (busqueda, verTodos) => {
    setError("");
    let query = sb.from("crm_directorio_conductores")
      .select("driver_id, nombre, telefono, email, patente, notas, origen, sc, cargo, empresa, activo")
      .order("nombre", { ascending: true })
      .limit(verTodos ? 300 : 600);
    if (!verTodos) query = query.not("telefono", "is", null);
    const b = (busqueda ?? "").trim();
    if (b) {
      const dig = b.replace(/\D/g, "");
      query = query.or(
        `nombre.ilike.%${b}%${dig.length >= 4 ? `,telefono.ilike.%${dig}%` : ""}` +
        `,patente.ilike.%${b}%,sc.ilike.%${b}%,empresa.ilike.%${b}%`);
    }
    const { data, error } = await query;
    if (error) { setError("No pudimos cargar el directorio: " + error.message); setCargando(false); return; }
    // Con teléfono primero, después por nombre: lo utilizable arriba.
    const orden = (data || []).slice().sort((a, b2) => {
      const ta = a.telefono ? 0 : 1, tb = b2.telefono ? 0 : 1;
      if (ta !== tb) return ta - tb;
      return String(a.nombre || "").localeCompare(String(b2.nombre || ""), "es");
    });
    setFilas(orden);
    setCargando(false);
  }, []);

  // búsqueda con debounce suave
  useEffect(() => {
    const t = setTimeout(() => cargar(q, verTodos), 350);
    return () => clearTimeout(t);
  }, [q, verTodos, cargar]);

  async function guardar(f) {
    setGuardando(true);
    setErrorForm("");
    const esNuevo = !editar?.driver_id;
    const fila = {
      driver_id: esNuevo ? -Date.now() : editar.driver_id,   // negativos = prueba/manual
      nombre: f.nombre.trim(),
      telefono: f.telefono.replace(/\D/g, "") || null,
      email: f.email.trim() || null,
      patente: f.patente.trim() || null,
      notas: f.notas.trim() || null,
      origen: esNuevo ? "manual" : "ajuste",
      actualizado_en: new Date().toISOString(),
      actualizado_por: analista?.user_id || null,
    };
    const { error } = await sb.from("crm_directorio_conductores").upsert(fila, { onConflict: "driver_id" });
    setGuardando(false);
    if (error) { setErrorForm(error.message || "No se pudo guardar."); return; }
    setEditar(null);
    cargar(q);
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Directorio de conductores</div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
            {verTodos
              ? "Padrón completo de MELI + el padrón de Bigticket. Muchos no tienen teléfono."
              : "Solo conductores con teléfono, que son los contactables. Lo que edites acá manda sobre MELI."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nombre, teléfono o patente…"
            style={{ fontSize: 13, padding: "7px 12px", border: "1px solid var(--borde)", borderRadius: 7, width: 240 }} />
          <button onClick={() => setVerTodos(!verTodos)}
            title={verTodos ? "Ver solo los que tienen teléfono" : "Incluir el padrón de MELI sin teléfono"}
            style={{
              fontSize: 12, padding: "7px 12px", borderRadius: 7,
              border: `1px solid ${verTodos ? "var(--navy)" : "var(--borde)"}`,
              background: verTodos ? "#eef2f7" : "#fff", whiteSpace: "nowrap",
            }}>
            {verTodos ? "Solo contactables" : "Ver padrón completo"}
          </button>
          <button onClick={() => { setErrorForm(""); setEditar({}); }}
            style={{ fontSize: 13, padding: "7px 14px", background: "var(--navy)", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer" }}>
            ➕ Agregar de prueba
          </button>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: "var(--texto-tenue)", marginBottom: 8 }}>
        {cargando ? "Cargando…" : `${filas.length} conductor${filas.length === 1 ? "" : "es"}`}
        {!verTodos && !cargando && " con teléfono"}
      </div>

      {error && <div style={{ background: "#FCEBEB", color: "#791F1F", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>{error}</div>}

      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden" }}>
        {cargando ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--texto-suave)" }}>Cargando…</div>
        ) : filas.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>
            Sin resultados{q ? ` para "${q}"` : ""}.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "var(--texto-suave)", fontSize: 11, textAlign: "left" }}>
                <th style={{ padding: "8px 14px", fontWeight: 500 }}>Conductor</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Teléfono</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>SC</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Email</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Empresa</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Fuente</th>
                <th style={{ padding: "8px 14px" }} />
              </tr>
            </thead>
            <tbody>
              {filas.map((c) => {
                const o = ORIGEN[c.origen] || ORIGEN.meli;
                return (
                  <tr key={c.driver_id} style={{ borderTop: "1px solid var(--borde)" }}>
                    <td style={{ padding: "9px 14px", fontWeight: 600 }}>
                      {c.nombre || "—"}
                      {c.notas && <div style={{ fontWeight: 400, fontSize: 11, color: "var(--texto-tenue)" }}>{c.notas}</div>}
                    </td>
                    <td style={{ padding: "9px 10px" }}>{c.telefono || <span style={{ color: "var(--texto-tenue)" }}>sin teléfono</span>}</td>
                    <td style={{ padding: "9px 10px", fontWeight: 600 }}>{c.sc || "—"}</td>
                    <td style={{ padding: "9px 10px", fontSize: 12 }}>{c.email || "—"}</td>
                    <td style={{ padding: "9px 10px", fontSize: 12, color: "var(--texto-suave)" }}>
                      {c.empresa || "—"}
                      {c.cargo && <div style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{c.cargo}</div>}
                    </td>
                    <td style={{ padding: "9px 10px" }}><span className="pill" style={{ background: o.bg, color: o.color }}>{o.label}</span></td>
                    <td style={{ padding: "9px 14px", textAlign: "right" }}>
                      <button onClick={() => { setErrorForm(""); setEditar(c); }} style={{ fontSize: 12, padding: "4px 10px" }}>✏️ Editar</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editar !== null && (
        <FormConductor inicial={editar} guardando={guardando} error={errorForm}
          onGuardar={guardar} onCerrar={() => setEditar(null)} />
      )}
    </div>
  );
}
