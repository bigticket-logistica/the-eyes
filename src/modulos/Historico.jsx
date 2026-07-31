import { useState, useCallback, useEffect } from "react";
import { sb } from "../shared/supabase.js";
import { fechaHora } from "../shared/fechas.js";
import { motivoLegible, ESTADOS } from "../shared/constantes.js";

// ═══════════════════════════════════════════════════════════════════════════
// HISTÓRICO · Búsqueda de SOLO LECTURA sobre todos los tickets
// Cubre los tres tipos que existen en el sistema:
//   · Incidencias de MELI (case_id < 900.000.000)
//   · Consultas en ruta (BT-, case_id >= 900.000.000)
//   · Consultas anidadas en una incidencia (anidado_en_case_id no nulo)
// Deliberadamente NO reutiliza HiloTicket ni PanelContexto: son componentes
// interactivos (envío de mensajes, tomar ticket, scraping de detalle) que no
// corresponden a una vista histórica y rompían esta pantalla.
// ═══════════════════════════════════════════════════════════════════════════

const CAMPOS = "id, case_id, codigo, origen, motivo_id, motivo_label, estado_id, sub_estado_id, " +
  "prioridad, estacion_origen, route_code, conductor_nombre, conductor_telefono, " +
  "comentarios, etiquetas, analista_actual, anidado_en_case_id, fecha_caso, tomado_en, shipment_id";

const TIPOS = [
  { v: "", t: "Todos" },
  { v: "meli", t: "Incidencias" },
  { v: "consulta", t: "Consultas" },
  { v: "anidado", t: "Anidados" },
];

function Chip({ children, bg, color }) {
  return <span className="pill" style={{ background: bg, color }}>{children}</span>;
}

function tipoDe(c) {
  if (c.anidado_en_case_id) return { t: "ANIDADO", bg: "#e0e7f3", color: "#1a3a6b" };
  if (c.origen === "consulta") return { t: "CONSULTA", bg: "#f3e8ff", color: "#6b21a8" };
  return { t: "INCIDENCIA", bg: "#fef3c7", color: "#92400e" };
}

export default function Historico() {
  const [f, setF] = useState({ texto: "", desde: "", hasta: "", estado: "", sc: "", tipo: "" });
  const [resultados, setResultados] = useState([]);
  const [sel, setSel] = useState(null);
  const [mensajes, setMensajes] = useState([]);
  const [correos, setCorreos] = useState([]);
  const [anidadas, setAnidadas] = useState([]);
  const [nombres, setNombres] = useState({});
  const [cargando, setCargando] = useState(false);
  const [buscado, setBuscado] = useState(false);
  const [error, setError] = useState("");

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  useEffect(() => {
    sb.from("crm_analistas").select("id, nombre").then(({ data }) => {
      setNombres(Object.fromEntries((data || []).map((a) => [a.id, a.nombre])));
    });
  }, []);

  const buscar = useCallback(async () => {
    setCargando(true); setError(""); setBuscado(true); setSel(null);
    try {
      let q = sb.from("crm_inc_casos").select(CAMPOS)
        .order("fecha_caso", { ascending: false }).limit(200);

      const t = f.texto.trim();
      if (t) {
        const soloDigitos = t.replace(/\D/g, "");
        if (soloDigitos.length >= 6) {
          // número: puede ser case_id, BT (900M+), shipment o teléfono
          const posibles = [`case_id.eq.${soloDigitos}`, `shipment_id.eq.${soloDigitos}`,
            `conductor_telefono.ilike.%${soloDigitos.slice(-10)}%`];
          if (soloDigitos.length <= 8) posibles.push(`case_id.eq.${900000000 + Number(soloDigitos)}`);
          q = q.or(posibles.join(","));
        } else {
          // texto: conductor, ruta, SC, código o comentarios
          q = q.or([`conductor_nombre.ilike.%${t}%`, `route_code.ilike.%${t}%`,
            `codigo.ilike.%${t}%`, `estacion_origen.ilike.%${t}%`,
            `comentarios.ilike.%${t}%`].join(","));
        }
      }
      if (f.desde) q = q.gte("fecha_caso", f.desde + "T00:00:00");
      if (f.hasta) q = q.lte("fecha_caso", f.hasta + "T23:59:59");
      if (f.estado) q = q.eq("estado_id", f.estado);
      if (f.sc) q = q.ilike("estacion_origen", f.sc.trim());
      if (f.tipo === "meli") q = q.eq("origen", "meli");
      if (f.tipo === "consulta") q = q.eq("origen", "consulta");
      if (f.tipo === "anidado") q = q.not("anidado_en_case_id", "is", null);

      const { data, error } = await q;
      if (error) throw error;
      setResultados(data || []);
    } catch (e) {
      setError(e.message || "No pudimos buscar");
      setResultados([]);
    } finally { setCargando(false); }
  }, [f]);

  // al abrir un resultado: mensajes, correos y consultas anidadas (solo lectura)
  const abrir = useCallback(async (c) => {
    setSel(c); setMensajes([]); setCorreos([]); setAnidadas([]);
    const [m, co, an] = await Promise.all([
      sb.from("crm_inc_mensajes").select("id, direccion, emisor, texto, tipo_contenido, creado_en")
        .eq("case_id", c.case_id).order("creado_en", { ascending: true }).limit(200),
      sb.from("crm_inc_correos").select("id, direccion, asunto, cuerpo, remitente, destinatario, creado_en")
        .eq("case_id", c.case_id).order("creado_en", { ascending: true }).limit(50),
      sb.from("crm_inc_casos").select("case_id, codigo, conductor_nombre, fecha_caso")
        .eq("anidado_en_case_id", c.case_id).limit(20),
    ]);
    setMensajes(m.data || []);
    setCorreos(co.data || []);
    setAnidadas(an.data || []);
  }, []);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 0.85fr) 1.55fr", height: "100%", minHeight: 0, overflow: "hidden" }}>
      {/* ─── FILTROS + RESULTADOS ─── */}
      <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", minHeight: 0, background: "#fff" }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--borde)", position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Histórico</div>
          <input value={f.texto} onChange={set("texto")} onKeyDown={(e) => e.key === "Enter" && buscar()}
            placeholder="🔍 N° de caso, BT, paquete, conductor, ruta o SC…"
            style={{ width: "100%", boxSizing: "border-box", fontSize: 12.5, padding: "7px 10px",
              border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 6 }} />
          <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
            <input type="date" value={f.desde} onChange={set("desde")} title="Desde"
              style={{ flex: 1, fontSize: 11.5, padding: "5px 8px", border: "1px solid var(--borde)", borderRadius: 7 }} />
            <input type="date" value={f.hasta} onChange={set("hasta")} title="Hasta"
              style={{ flex: 1, fontSize: 11.5, padding: "5px 8px", border: "1px solid var(--borde)", borderRadius: 7 }} />
          </div>
          <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
            <select value={f.estado} onChange={set("estado")}
              style={{ flex: 1, fontSize: 11.5, padding: "5px 6px", border: "1px solid var(--borde)", borderRadius: 7 }}>
              <option value="">Todos los estados</option>
              {Object.keys(ESTADOS || {}).map((k) => <option key={k} value={k}>{ESTADOS[k]?.label || k}</option>)}
            </select>
            <input value={f.sc} onChange={set("sc")} placeholder="SC"
              style={{ width: 80, fontSize: 11.5, padding: "5px 8px", border: "1px solid var(--borde)", borderRadius: 7 }} />
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
            {TIPOS.map((o) => (
              <button key={o.v} onClick={() => setF((p) => ({ ...p, tipo: o.v }))}
                style={{ fontSize: 11, padding: "3px 10px", borderRadius: 12, cursor: "pointer",
                  border: `1px solid ${f.tipo === o.v ? "var(--naranja)" : "var(--borde)"}`,
                  background: f.tipo === o.v ? "var(--naranja-suave)" : "#fff",
                  fontWeight: f.tipo === o.v ? 600 : 400 }}>{o.t}</button>
            ))}
          </div>
          <button className="btn-navy" onClick={buscar} disabled={cargando}
            style={{ width: "100%", padding: "8px", fontSize: 13 }}>
            {cargando ? "Buscando…" : "Buscar"}
          </button>
          {buscado && !cargando && (
            <div style={{ fontSize: 11, color: "var(--texto-suave)", marginTop: 6 }}>
              {resultados.length} {resultados.length === 1 ? "resultado" : "resultados"}
              {resultados.length === 200 ? " (máximo, refina la búsqueda)" : ""}
            </div>
          )}
        </div>

        {error && <div style={{ padding: 14, fontSize: 12, color: "#791F1F" }}>{error}</div>}
        {!buscado ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--texto-suave)", fontSize: 12.5, lineHeight: 1.6 }}>
            Busca por número de caso, código BT, ID de paquete, conductor, ruta o SC.
            También puedes filtrar por fecha, estado y tipo de ticket.
          </div>
        ) : resultados.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--texto-suave)", fontSize: 12.5 }}>
            Sin resultados con esos filtros.
          </div>
        ) : resultados.map((c) => {
          const tp = tipoDe(c);
          const activo = sel?.id === c.id;
          return (
            <div key={c.id} onClick={() => abrir(c)}
              style={{ padding: "9px 14px", borderBottom: "1px solid #f1f2f4", cursor: "pointer",
                background: activo ? "var(--naranja-suave)" : "#fff",
                borderLeft: `3px solid ${activo ? "var(--naranja)" : "transparent"}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                <Chip bg={tp.bg} color={tp.color}>{tp.t}</Chip>
                <span style={{ fontSize: 11, color: "var(--texto-tenue)" }}>{c.estacion_origen || "—"}</span>
                <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--texto-tenue)" }}>
                  {fechaHora(c.fecha_caso)}
                </span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {motivoLegible(c.motivo_id, c.motivo_label)}
              </div>
              <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
                {c.codigo || "#" + c.case_id}
                {c.conductor_nombre ? ` · ${c.conductor_nombre}` : ""}
                {c.route_code ? ` · ${c.route_code}` : ""}
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── DETALLE (SOLO LECTURA) ─── */}
      <div style={{ overflowY: "auto", minHeight: 0, background: "#f7f8fa", padding: sel ? "16px 20px" : 0 }}>
        {!sel ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)", fontSize: 13 }}>
            Elige un ticket para ver su historia.
          </div>
        ) : (
          <>
            <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Chip {...(() => { const t = tipoDe(sel); return { bg: t.bg, color: t.color }; })()}>
                  {tipoDe(sel).t}
                </Chip>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{sel.codigo || "#" + sel.case_id}</span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--texto-suave)" }}>
                  {fechaHora(sel.fecha_caso)}
                </span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>
                {motivoLegible(sel.motivo_id, sel.motivo_label)}
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.9, color: "var(--texto)" }}>
                <div><span style={{ color: "var(--texto-suave)" }}>Estado:</span> {sel.estado_id}{sel.sub_estado_id ? ` · ${sel.sub_estado_id}` : ""}</div>
                {sel.estacion_origen && <div><span style={{ color: "var(--texto-suave)" }}>SC:</span> {sel.estacion_origen}</div>}
                {sel.route_code && <div><span style={{ color: "var(--texto-suave)" }}>Ruta:</span> {sel.route_code}</div>}
                {sel.conductor_nombre && <div><span style={{ color: "var(--texto-suave)" }}>Conductor:</span> {sel.conductor_nombre}{sel.conductor_telefono ? ` · ${sel.conductor_telefono}` : ""}</div>}
                {sel.shipment_id && <div><span style={{ color: "var(--texto-suave)" }}>Paquete:</span> {sel.shipment_id}</div>}
                {sel.analista_actual && <div><span style={{ color: "var(--texto-suave)" }}>Analista:</span> {nombres[sel.analista_actual] || "—"}</div>}
                {sel.anidado_en_case_id && (
                  <div style={{ color: "#1a3a6b", fontWeight: 600 }}>↩ Anidado en la incidencia #{sel.anidado_en_case_id}</div>
                )}
                {sel.etiquetas && sel.etiquetas.length > 0 && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                    {sel.etiquetas.map((e) => <Chip key={e} bg="#f1f5f9" color="#475569">{e}</Chip>)}
                  </div>
                )}
                {sel.comentarios && (
                  <div style={{ marginTop: 8, padding: "8px 10px", background: "#fafbfc", borderRadius: 7, whiteSpace: "pre-wrap", fontSize: 12 }}>
                    {sel.comentarios}
                  </div>
                )}
              </div>
            </div>

            {anidadas.length > 0 && (
              <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Consultas anidadas en este ticket</div>
                {anidadas.map((a) => (
                  <div key={a.case_id} style={{ fontSize: 12, color: "var(--texto)", padding: "3px 0" }}>
                    ↩ {a.codigo || "#" + a.case_id}{a.conductor_nombre ? ` · ${a.conductor_nombre}` : ""}
                    <span style={{ color: "var(--texto-tenue)" }}> · {fechaHora(a.fecha_caso)}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
                Conversación de WhatsApp <span style={{ fontWeight: 400, color: "var(--texto-suave)" }}>({mensajes.length})</span>
              </div>
              {mensajes.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--texto-tenue)" }}>Sin mensajes en este ticket.</div>
              ) : mensajes.map((m) => {
                const entrante = m.direccion === "entrante";
                return (
                  <div key={m.id} style={{ display: "flex", justifyContent: entrante ? "flex-start" : "flex-end", marginBottom: 6 }}>
                    <div style={{ maxWidth: "78%", padding: "7px 11px", borderRadius: 9, fontSize: 12.5,
                      background: entrante ? "#f1f5f9" : "var(--navy)", color: entrante ? "var(--texto)" : "#fff",
                      whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>
                        {entrante ? "Conductor" : (m.emisor === "ia" ? "IA" : "Analista")} · {fechaHora(m.creado_en)}
                      </div>
                      {m.texto || `[${m.tipo_contenido}]`}
                    </div>
                  </div>
                );
              })}
            </div>

            {correos.length > 0 && (
              <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, padding: "12px 16px" }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
                  Correos <span style={{ fontWeight: 400, color: "var(--texto-suave)" }}>({correos.length})</span>
                </div>
                {correos.map((c) => (
                  <div key={c.id} style={{ borderTop: "1px solid #f1f2f4", padding: "8px 0" }}>
                    <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
                      {c.direccion === "entrante" ? `↙ de ${c.remitente}` : `↗ a ${c.destinatario}`} · {fechaHora(c.creado_en)}
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{c.asunto}</div>
                    <div style={{ fontSize: 12, color: "var(--texto)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 130, overflow: "hidden" }}>
                      {c.cuerpo}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
