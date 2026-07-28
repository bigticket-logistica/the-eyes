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
  meli:   { label: "MELI",   bg: "#e0f2fe", color: "#075985" },
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

  const cargar = useCallback(async (busqueda) => {
    setError("");
    let query = sb.from("vw_directorio_conductores")
      .select("driver_id, nombre, telefono, email, patente, notas, origen")
      .order("nombre", { ascending: true })
      .limit(80);
    const b = (busqueda ?? "").trim();
    if (b) query = query.or(`nombre.ilike.%${b}%,telefono.ilike.%${b}%,patente.ilike.%${b}%`);
    const { data, error } = await query;
    if (error) { setError("No pudimos cargar el directorio."); setCargando(false); return; }
    setFilas(data || []);
    setCargando(false);
  }, []);

  useEffect(() => { cargar(""); }, [cargar]);
  // búsqueda con debounce suave
  useEffect(() => {
    const t = setTimeout(() => cargar(q), 350);
    return () => clearTimeout(t);
  }, [q, cargar]);

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
            Padrón MELI + correcciones de la torre. Lo que edites aquí manda sobre lo que trae MELI.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nombre, teléfono o patente…"
            style={{ fontSize: 13, padding: "7px 12px", border: "1px solid var(--borde)", borderRadius: 7, width: 240 }} />
          <button onClick={() => { setErrorForm(""); setEditar({}); }}
            style={{ fontSize: 13, padding: "7px 14px", background: "var(--navy)", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer" }}>
            ➕ Agregar de prueba
          </button>
        </div>
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
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Email</th>
                <th style={{ padding: "8px 10px", fontWeight: 500 }}>Patente</th>
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
                    <td style={{ padding: "9px 10px" }}>{c.email || "—"}</td>
                    <td style={{ padding: "9px 10px" }}>{c.patente || "—"}</td>
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
