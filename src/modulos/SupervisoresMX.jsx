import { useState, useEffect, useMemo, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { puedeActuar } from "../shared/permisos.js";

// ═══════════════════════════════════════════════════════════════════════════
//  MANTENEDOR DE SUPERVISORES Y CENTROS · MÉXICO
//
//  Los supervisores y sus centros cambian seguido. Antes cada cambio era un SQL
//  a mano, sin rastro de quién lo pidió ni por qué. Ahora se hace acá:
//
//    · Todo cambio pide un comentario y queda en el historial con qué había
//      antes, qué quedó, quién y cuándo (mant_historial_mx).
//    · Los cambios pasan por fn_sup_guardar y fn_centro_guardar, que revisan
//      permiso y comentario en la base: la pantalla no puede saltárselos.
//    · Un supervisor solo puede tener centros que existan en el catálogo
//      (centros_mx): un solo nombre para cada centro.
//
//  Los cambios toman efecto al instante: la bitácora y los avisos de PNR leen
//  supervisores_bt en vivo. No hace falta tocar el VPS.
//
//  Editan admin y analista (decisión del 24-nov-2026, a revisar); el
//  observador solo mira.
// ═══════════════════════════════════════════════════════════════════════════

const fechaHora = (ts) => ts
  ? new Date(ts).toLocaleString("es-MX", { day: "2-digit", month: "2-digit", year: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false })
  : "—";

// Los campos que se muestran al comparar el antes y el después de un cambio.
const CAMPOS_SUP = { nombre: "Nombre", email: "Correo", telefono: "Teléfono", scs_asignados: "Centros", activo: "Activo" };
const CAMPOS_CEN = { nombre: "Nombre", direccion: "Dirección", mapa_url: "Mapa", activo: "Activo" };

const valorTexto = (v) => {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "boolean") return v ? "sí" : "no";
  return String(v);
};

function Chip({ children, fondo = "#eef3fa", color = "var(--navy)" }) {
  return (
    <span style={{ background: fondo, color, fontSize: 11, fontWeight: 600, padding: "2px 8px",
      borderRadius: 999, whiteSpace: "nowrap" }}>{children}</span>
  );
}

function Modal({ titulo, children, onCerrar }) {
  return (
    <div onClick={onCerrar} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.35)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12,
        width: "min(560px, 100%)", maxHeight: "90vh", overflow: "auto", padding: "18px 20px",
        boxShadow: "0 12px 40px rgba(15,23,42,.25)" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <strong style={{ fontSize: 15 }}>{titulo}</strong>
          <button onClick={onCerrar} style={{ marginLeft: "auto", border: "none", background: "none",
            fontSize: 18, cursor: "pointer", color: "var(--texto-suave)" }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const lbl = { fontSize: 12, fontWeight: 600, display: "block", margin: "10px 0 4px" };
const inp = { width: "100%", fontSize: 13, padding: "7px 9px", borderRadius: 7,
  border: "1px solid var(--borde)", boxSizing: "border-box" };
const btnPrimario = { fontSize: 13, padding: "8px 14px", borderRadius: 8, border: "none",
  background: "var(--navy)", color: "#fff", fontWeight: 600, cursor: "pointer" };
const btnSec = { fontSize: 12.5, padding: "6px 11px", borderRadius: 8, border: "1px solid var(--borde)",
  background: "#fff", cursor: "pointer" };

// ── Editor de supervisor ────────────────────────────────────────────────────
function EditorSupervisor({ sup, centros, supervisores, onCerrar, onGuardado }) {
  const nuevo = !sup;
  const [nombre, setNombre] = useState(sup?.nombre || "");
  const [email, setEmail] = useState(sup?.email || "");
  const [telefono, setTelefono] = useState(sup?.telefono || "");
  const [scs, setScs] = useState(() => new Set(sup?.scs_asignados || []));
  const [activo, setActivo] = useState(sup ? sup.activo : true);
  const [comentario, setComentario] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState(null);

  const alternar = (c) => setScs((prev) => {
    const n = new Set(prev);
    if (n.has(c)) n.delete(c); else n.add(c);
    return n;
  });

  // Centros que quedarían SIN NADIE con teléfono si se guarda este cambio: sus
  // PNR llegarían a la bitácora pero sin aviso por WhatsApp. Es lo que casi
  // pasó el 24-nov al mover SMX10/20/22 a Jonatan sin su número.
  const sinAviso = useMemo(() => {
    const telNuevo = telefono.replace(/[^0-9]/g, "").length > 0 && activo;
    const afectados = new Set([...(sup?.scs_asignados || []), ...scs]);
    const res = [];
    for (const c of afectados) {
      const otros = supervisores.some((s) => s.id !== sup?.id && s.activo && s.telefono
        && (s.scs_asignados || []).includes(c));
      const este = telNuevo && scs.has(c);
      if (!otros && !este) res.push(c);
    }
    return res.sort();
  }, [telefono, activo, scs, sup, supervisores]);

  async function guardar() {
    setError(null);
    if (comentario.trim().length < 5) {
      setError("El comentario es obligatorio: explica el cambio y quién lo pidió.");
      return;
    }
    setGuardando(true);
    const { error } = await sb.rpc("fn_sup_guardar", {
      p_id: sup?.id ?? null, p_nombre: nombre, p_email: email, p_telefono: telefono,
      p_scs: [...scs], p_activo: activo, p_comentario: comentario,
    });
    setGuardando(false);
    if (error) { setError(error.message); return; }
    onGuardado();
  }

  return (
    <Modal titulo={nuevo ? "Nuevo supervisor" : `Editar · ${sup.nombre}`} onCerrar={onCerrar}>
      <label style={lbl}>Nombre</label>
      <input value={nombre} onChange={(e) => setNombre(e.target.value)} style={inp} />
      <label style={lbl}>Correo</label>
      <input value={email} onChange={(e) => setEmail(e.target.value)} style={inp}
        placeholder="nombre.apellido@bigticket.mx" />
      {nuevo && (
        <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginTop: 3 }}>
          Tiene que tener usuario creado antes en Authentication con este mismo correo.
        </div>
      )}
      <label style={lbl}>Teléfono (para los avisos de PNR por WhatsApp)</label>
      <input value={telefono} onChange={(e) => setTelefono(e.target.value)} style={inp}
        placeholder="+5215512345678" />

      <label style={lbl}>Centros a cargo</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {centros.map((c) => {
          const on = scs.has(c.sc);
          return (
            <button key={c.sc} type="button" onClick={() => alternar(c.sc)}
              title={c.nombre && c.nombre !== c.sc ? c.nombre : undefined}
              style={{ fontSize: 12, padding: "4px 9px", borderRadius: 999, cursor: "pointer",
                border: on ? "1px solid var(--navy)" : "1px solid var(--borde)",
                background: on ? "var(--navy)" : "#fff", color: on ? "#fff" : "inherit",
                opacity: c.activo ? 1 : 0.5 }}>
              {c.sc}
            </button>
          );
        })}
      </div>

      <label style={{ ...lbl, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
        <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
        Activo
      </label>

      {sinAviso.length > 0 && (
        <div style={{ background: "#fff4e5", border: "1px solid #f6c77d", color: "#7a3d00", fontSize: 12,
          borderRadius: 8, padding: "8px 10px", marginTop: 10 }}>
          <strong>Ojo:</strong> con este cambio {sinAviso.length === 1 ? "el centro" : "los centros"}{" "}
          <strong>{sinAviso.join(", ")}</strong> {sinAviso.length === 1 ? "queda" : "quedan"} sin nadie con
          teléfono. Sus PNR llegarán a la bitácora, pero nadie recibirá el aviso por WhatsApp.
        </div>
      )}

      <label style={lbl}>Comentario del cambio (obligatorio)</label>
      <textarea value={comentario} onChange={(e) => setComentario(e.target.value)} rows={3} style={inp}
        placeholder="Qué cambia, por qué y quién lo pidió" />

      {error && <div style={{ color: "#b91c1c", fontSize: 12, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button onClick={onCerrar} style={btnSec}>Cancelar</button>
        <button onClick={guardar} disabled={guardando} style={btnPrimario}>
          {guardando ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </Modal>
  );
}

// ── Editor de centro ────────────────────────────────────────────────────────
function EditorCentro({ centro, onCerrar, onGuardado }) {
  const nuevo = !centro;
  const [sc, setSc] = useState(centro?.sc || "");
  const [nombre, setNombre] = useState(centro?.nombre || "");
  const [direccion, setDireccion] = useState(centro?.direccion || "");
  const [mapa, setMapa] = useState(centro?.mapa_url || "");
  const [activo, setActivo] = useState(centro ? centro.activo : true);
  const [comentario, setComentario] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState(null);

  async function guardar() {
    setError(null);
    if (comentario.trim().length < 5) {
      setError("El comentario es obligatorio: explica el cambio y quién lo pidió.");
      return;
    }
    setGuardando(true);
    const { error } = await sb.rpc("fn_centro_guardar", {
      p_sc: sc, p_nombre: nombre, p_direccion: direccion, p_mapa_url: mapa,
      p_activo: activo, p_comentario: comentario,
    });
    setGuardando(false);
    if (error) { setError(error.message); return; }
    onGuardado();
  }

  return (
    <Modal titulo={nuevo ? "Nuevo centro" : `Editar · ${centro.sc}`} onCerrar={onCerrar}>
      <label style={lbl}>Código</label>
      <input value={sc} onChange={(e) => setSc(e.target.value.toUpperCase())} style={inp}
        disabled={!nuevo} placeholder="SMX15" />
      <label style={lbl}>Nombre</label>
      <input value={nombre} onChange={(e) => setNombre(e.target.value)} style={inp} />
      <label style={lbl}>Dirección</label>
      <textarea value={direccion} onChange={(e) => setDireccion(e.target.value)} rows={2} style={inp} />
      <label style={lbl}>Link del mapa</label>
      <input value={mapa} onChange={(e) => setMapa(e.target.value)} style={inp}
        placeholder="https://maps.google.com/…" />
      <label style={{ ...lbl, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
        <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
        Activo
      </label>
      <label style={lbl}>Comentario del cambio (obligatorio)</label>
      <textarea value={comentario} onChange={(e) => setComentario(e.target.value)} rows={3} style={inp}
        placeholder="Qué cambia, por qué y quién lo pidió" />
      {error && <div style={{ color: "#b91c1c", fontSize: 12, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button onClick={onCerrar} style={btnSec}>Cancelar</button>
        <button onClick={guardar} disabled={guardando} style={btnPrimario}>
          {guardando ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </Modal>
  );
}

// ── Una línea del historial: qué cambió ─────────────────────────────────────
function Diferencias({ h }) {
  const campos = h.entidad === "centro" ? CAMPOS_CEN : CAMPOS_SUP;
  if (h.accion === "alta" || !h.antes) {
    return <span style={{ color: "var(--texto-suave)" }}>Alta</span>;
  }
  const cambios = Object.entries(campos)
    .filter(([k]) => JSON.stringify(h.antes?.[k] ?? null) !== JSON.stringify(h.despues?.[k] ?? null))
    .map(([k, etiqueta]) => (
      <div key={k}>
        <strong>{etiqueta}:</strong>{" "}
        <span style={{ color: "#a32d2d", textDecoration: "line-through" }}>{valorTexto(h.antes?.[k])}</span>
        {" → "}
        <span style={{ color: "#13724f" }}>{valorTexto(h.despues?.[k])}</span>
      </div>
    ));
  return cambios.length ? <>{cambios}</> : <span style={{ color: "var(--texto-tenue)" }}>sin cambios de datos</span>;
}

// ═══════════════════════════════════════════════════════════════════════════
export default function SupervisoresMX() {
  const { analista } = useAuth();
  const puedeEditar = puedeActuar(analista);

  const [vista, setVista] = useState("supervisores");
  const [sups, setSups] = useState(null);
  const [centros, setCentros] = useState([]);
  const [historial, setHistorial] = useState([]);
  const [error, setError] = useState(null);
  const [busca, setBusca] = useState("");
  const [verInactivos, setVerInactivos] = useState(false);
  const [editSup, setEditSup] = useState(undefined);      // undefined = cerrado, null = nuevo
  const [editCentro, setEditCentro] = useState(undefined);

  const cargar = useCallback(async () => {
    const [s, c, h] = await Promise.all([
      sb.rpc("fn_sup_listar"),
      sb.from("vw_centros_cobertura").select("*").order("sc"),
      sb.from("mant_historial_mx").select("*").order("hecho_en", { ascending: false }).limit(300),
    ]);
    const err = s.error || c.error || h.error;
    if (err) { setError(err.message); return; }
    setError(null);
    setSups(s.data || []);
    setCentros(c.data || []);
    setHistorial(h.data || []);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const nombreSup = useMemo(() => Object.fromEntries((sups || []).map((s) => [String(s.id), s.nombre])), [sups]);

  const supsVisibles = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (sups || []).filter((s) => (verInactivos || s.activo)
      && (!q || [s.nombre, s.email, ...(s.scs_asignados || [])].some((v) => String(v || "").toLowerCase().includes(q))));
  }, [sups, busca, verInactivos]);

  const centrosSinAviso = centros.filter((c) => c.activo && Number(c.con_telefono) === 0);

  const alGuardar = () => { setEditSup(undefined); setEditCentro(undefined); cargar(); };

  if (error) return <div style={{ padding: 20, color: "#791F1F", fontSize: 13 }}>No se pudo cargar: {error}</div>;
  if (sups === null) return <div style={{ padding: 20, color: "var(--texto-suave)", fontSize: 13 }}>Cargando…</div>;

  const th = { padding: "7px 10px", fontWeight: 600, textAlign: "left" };
  const td = { padding: "8px 10px", verticalAlign: "top" };
  const Pestana = ({ id, children }) => (
    <button onClick={() => setVista(id)} style={{ fontSize: 13, padding: "6px 12px", cursor: "pointer",
      border: "none", borderBottom: vista === id ? "2px solid var(--navy)" : "2px solid transparent",
      background: "none", fontWeight: vista === id ? 600 : 400 }}>{children}</button>
  );

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <strong style={{ fontSize: 15 }}>Supervisores y centros · México</strong>
        <span style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>
          cada cambio queda registrado con su comentario y quién lo hizo
        </span>
      </div>

      {centrosSinAviso.length > 0 && (
        <div style={{ background: "#fff4e5", border: "1px solid #f6c77d", color: "#7a3d00", fontSize: 12.5,
          borderRadius: 8, padding: "8px 12px", margin: "8px 0 12px" }}>
          <strong>{centrosSinAviso.length} {centrosSinAviso.length === 1 ? "centro activo" : "centros activos"} sin
          nadie con teléfono:</strong> {centrosSinAviso.map((c) => c.sc).join(", ")}. Sus PNR llegan a la bitácora
          pero sin aviso por WhatsApp.
        </div>
      )}

      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--borde)", marginBottom: 12 }}>
        <Pestana id="supervisores">Supervisores ({(sups || []).filter((s) => s.activo).length})</Pestana>
        <Pestana id="centros">Centros ({centros.length})</Pestana>
        <Pestana id="historial">Historial</Pestana>
      </div>

      {vista === "supervisores" && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nombre, correo o centro"
              style={{ ...inp, width: 240 }} />
            <label style={{ fontSize: 12.5, display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={verInactivos} onChange={(e) => setVerInactivos(e.target.checked)} />
              Ver inactivos
            </label>
            {puedeEditar && (
              <button onClick={() => setEditSup(null)} style={{ ...btnPrimario, marginLeft: "auto" }}>
                + Nuevo supervisor
              </button>
            )}
          </div>
          <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: "var(--fondo, #f7f8fa)", color: "var(--texto-suave)", fontSize: 10.5,
                  textTransform: "uppercase", letterSpacing: 0.3 }}>
                  <th style={th}>Supervisor</th>
                  <th style={th}>Teléfono</th>
                  <th style={th}>Centros</th>
                  <th style={th}>Estado</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {supsVisibles.map((s) => (
                  <tr key={s.id} style={{ borderTop: "1px solid var(--borde)", opacity: s.activo ? 1 : 0.55 }}>
                    <td style={td}>
                      <div style={{ fontWeight: 500 }}>{s.nombre}</div>
                      <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>{s.email}</div>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {s.telefono || <span style={{ color: "#9a4d00" }}>sin teléfono</span>}
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {(s.scs_asignados || []).length === 0
                          ? <span style={{ color: "var(--texto-tenue)" }}>ninguno</span>
                          : s.scs_asignados.map((c) => <Chip key={c}>{c}</Chip>)}
                      </div>
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {s.activo ? <Chip fondo="#e7f6ef" color="#13724f">activo</Chip>
                          : <Chip fondo="#f1f5f9" color="#475569">inactivo</Chip>}
                        {!s.tiene_usuario && <Chip fondo="#fdecea" color="#a32d2d">sin usuario</Chip>}
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {puedeEditar && <button onClick={() => setEditSup(s)} style={btnSec}>Editar</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {vista === "centros" && (
        <>
          {puedeEditar && (
            <div style={{ display: "flex", marginBottom: 10 }}>
              <button onClick={() => setEditCentro(null)} style={{ ...btnPrimario, marginLeft: "auto" }}>
                + Nuevo centro
              </button>
            </div>
          )}
          <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: "var(--fondo, #f7f8fa)", color: "var(--texto-suave)", fontSize: 10.5,
                  textTransform: "uppercase", letterSpacing: 0.3 }}>
                  <th style={th}>Centro</th>
                  <th style={th}>Dirección</th>
                  <th style={th}>Supervisores</th>
                  <th style={th}>Aviso PNR</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {centros.map((c) => (
                  <tr key={c.sc} style={{ borderTop: "1px solid var(--borde)", opacity: c.activo ? 1 : 0.55 }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{c.sc}</div>
                      {c.nombre && c.nombre !== c.sc && (
                        <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>{c.nombre}</div>
                      )}
                    </td>
                    <td style={{ ...td, maxWidth: 320 }}>
                      {c.direccion || <span style={{ color: "var(--texto-tenue)" }}>sin dirección</span>}
                      {c.mapa_url && (
                        <div><a href={c.mapa_url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>ver mapa</a></div>
                      )}
                    </td>
                    <td style={td}>{c.nombres || <span style={{ color: "#9a4d00" }}>nadie</span>}</td>
                    <td style={td}>
                      {!c.activo ? <Chip fondo="#f1f5f9" color="#475569">inactivo</Chip>
                        : Number(c.con_telefono) > 0 ? <Chip fondo="#e7f6ef" color="#13724f">con aviso</Chip>
                        : <Chip fondo="#fff4e5" color="#9a4d00">sin aviso</Chip>}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {puedeEditar && <button onClick={() => setEditCentro(c)} style={btnSec}>Editar</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {vista === "historial" && (
        <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden" }}>
          {historial.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>
              Todavía no hay cambios registrados.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: "var(--fondo, #f7f8fa)", color: "var(--texto-suave)", fontSize: 10.5,
                  textTransform: "uppercase", letterSpacing: 0.3 }}>
                  <th style={th}>Cuándo</th>
                  <th style={th}>Qué</th>
                  <th style={th}>Cambio</th>
                  <th style={th}>Comentario</th>
                  <th style={th}>Quién</th>
                </tr>
              </thead>
              <tbody>
                {historial.map((h) => (
                  <tr key={h.id} style={{ borderTop: "1px solid var(--borde)" }}>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{fechaHora(h.hecho_en)}</td>
                    <td style={td}>
                      <div style={{ fontWeight: 500 }}>
                        {h.entidad === "centro" ? h.clave : (nombreSup[h.clave] || `Supervisor ${h.clave}`)}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>{h.entidad}</div>
                    </td>
                    <td style={{ ...td, fontSize: 12 }}><Diferencias h={h} /></td>
                    <td style={{ ...td, maxWidth: 280 }}>{h.comentario}</td>
                    <td style={{ ...td, fontSize: 11.5, color: "var(--texto-suave)" }}>{h.hecho_por || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {editSup !== undefined && (
        <EditorSupervisor sup={editSup} centros={centros} supervisores={sups}
          onCerrar={() => setEditSup(undefined)} onGuardado={alGuardar} />
      )}
      {editCentro !== undefined && (
        <EditorCentro centro={editCentro} onCerrar={() => setEditCentro(undefined)} onGuardado={alGuardar} />
      )}
    </div>
  );
}
