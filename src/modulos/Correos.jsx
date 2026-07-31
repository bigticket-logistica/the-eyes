import { useState, useEffect, useCallback, useRef } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { hace, fechaHora } from "../shared/fechas.js";
import { enviarCorreoCliente } from "../shared/mensajes.js";

// ═══════════════════════════════════════════════════════════════════════════
// CORREOS · Bandeja de la torre dentro de The Eyes
// Lee y responde sin salir de la aplicación. Los entrantes llegan por el
// webhook /correo-webhook (inbound parsing de Brevo) y aparecen en vivo por
// realtime; los salientes se envían por la Edge Function correo-cliente.
// Agrupado por hilo: preferencia al ticket (case_id), si no al correo.
// ═══════════════════════════════════════════════════════════════════════════

function Burbuja({ c }) {
  const entrante = c.direccion === "entrante";
  return (
    <div style={{ display: "flex", justifyContent: entrante ? "flex-start" : "flex-end", marginBottom: 10 }}>
      <div style={{
        maxWidth: "82%", padding: "10px 13px", borderRadius: 10, fontSize: 13, lineHeight: 1.55,
        background: entrante ? "#fff" : "var(--navy)", color: entrante ? "var(--texto)" : "#fff",
        border: entrante ? "1px solid var(--borde)" : "none", whiteSpace: "pre-wrap",
      }}>
        <div style={{ fontSize: 10.5, opacity: 0.75, marginBottom: 4 }}>
          {entrante ? (c.nombre_de || c.remitente) : "Torre de soporte"} · {fechaHora(c.creado_en)}
        </div>
        {c.asunto && <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.asunto}</div>}
        {c.cuerpo || "(sin contenido)"}
        {c.adjuntos && c.adjuntos.length > 0 && (
          <div style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>
            📎 {c.adjuntos.length} {c.adjuntos.length === 1 ? "adjunto" : "adjuntos"}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Correos() {
  const { analista } = useAuth();
  const [hilos, setHilos] = useState([]);
  const [sel, setSel] = useState(null);
  const [correos, setCorreos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [soloNoLeidos, setSoloNoLeidos] = useState(false);

  // redacción / respuesta
  const [nuevo, setNuevo] = useState(false);
  const [destinatario, setDestinatario] = useState("");
  const [asunto, setAsunto] = useState("");
  const [cuerpo, setCuerpo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState("");
  const finRef = useRef(null);
  const selRef = useRef(null);
  selRef.current = sel;

  const cargarHilos = useCallback(async () => {
    const { data, error } = await sb.from("vw_correos_hilos")
      .select("*").order("ultimo_en", { ascending: false }).limit(100);
    if (error) { setError("No pudimos cargar la bandeja."); setCargando(false); return; }
    setHilos(data || []);
    setCargando(false);
  }, []);

  const abrirHilo = useCallback(async (h) => {
    setSel(h); setNuevo(false); setAviso("");
    const { data } = await sb.from("crm_inc_correos")
      .select("*").eq("hilo_key", h.hilo_key).order("creado_en", { ascending: true });
    const lista = data || [];
    setCorreos(lista);
    // preparar respuesta
    const ultEntrante = [...lista].reverse().find((c) => c.direccion === "entrante");
    const base = ultEntrante || lista[lista.length - 1];
    setDestinatario(ultEntrante ? (ultEntrante.remitente || "") : (base?.destinatario || ""));
    const asuntoBase = base?.asunto || "";
    setAsunto(/^re:/i.test(asuntoBase) ? asuntoBase : `Re: ${asuntoBase}`);
    setCuerpo("");
    // marcar leídos los entrantes del hilo
    const pendientes = lista.filter((c) => c.direccion === "entrante" && !c.leido).map((c) => c.id);
    if (pendientes.length) {
      await sb.from("crm_inc_correos").update({ leido: true }).in("id", pendientes);
      cargarHilos();
    }
    setTimeout(() => finRef.current?.scrollIntoView({ behavior: "smooth" }), 60);
  }, [cargarHilos]);

  useEffect(() => { cargarHilos(); }, [cargarHilos]);

  // Realtime: un correo nuevo refresca la bandeja y el hilo abierto
  useEffect(() => {
    const canal = sb.channel("correos-bandeja")
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_inc_correos" }, (payload) => {
        cargarHilos();
        const c = payload.new;
        if (c && selRef.current && c.hilo_key === selRef.current.hilo_key) abrirHilo(selRef.current);
      })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargarHilos, abrirHilo]);

  async function enviar() {
    const dest = destinatario.trim();
    if (!dest || !cuerpo.trim() || enviando) return;
    setEnviando(true); setAviso("");
    try {
      await enviarCorreoCliente({
        caseId: sel?.case_id || null, casoId: null,
        destinatario: dest, asunto: asunto.trim() || "(sin asunto)", cuerpo,
        plantilla: nuevo ? "bandeja_nuevo" : "bandeja_respuesta",
      });
      setCuerpo(""); setAviso("Correo enviado ✓");
      await cargarHilos();
      if (sel) await abrirHilo(sel);
      else { setNuevo(false); }
    } catch (e) {
      setAviso(e.message || "No se pudo enviar");
    } finally { setEnviando(false); }
  }

  function nuevoCorreo() {
    setSel(null); setCorreos([]); setNuevo(true); setAviso("");
    setDestinatario(""); setAsunto(""); setCuerpo("");
  }

  const visibles = soloNoLeidos ? hilos.filter((h) => h.no_leidos > 0) : hilos;
  const totalNoLeidos = hilos.reduce((a, h) => a + Number(h.no_leidos || 0), 0);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 0.8fr) 1.6fr", height: "100%" }}>
      {/* ─── LISTA DE HILOS ─── */}
      <div style={{ borderRight: "1px solid var(--borde)", overflowY: "auto", background: "#fff" }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--borde)", position: "sticky", top: 0, background: "#fff", zIndex: 2 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Correos</div>
              <div style={{ fontSize: 11, color: "var(--texto-suave)" }}>
                {hilos.length} {hilos.length === 1 ? "hilo" : "hilos"}
                {totalNoLeidos > 0 ? ` · ${totalNoLeidos} sin leer` : ""}
              </div>
            </div>
            <button onClick={nuevoCorreo}
              style={{ fontSize: 12, padding: "6px 12px", background: "var(--navy)", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer" }}>
              ✉️ Nuevo
            </button>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, cursor: "pointer", color: "var(--texto-suave)" }}>
            <input type="checkbox" checked={soloNoLeidos} onChange={(e) => setSoloNoLeidos(e.target.checked)} />
            Solo sin leer
          </label>
        </div>

        {error && <div style={{ padding: 14, fontSize: 12, color: "#791F1F" }}>{error}</div>}
        {cargando ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>Cargando…</div>
        ) : visibles.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--texto-suave)", fontSize: 12.5, lineHeight: 1.6 }}>
            {soloNoLeidos ? "Nada sin leer. 👌" : "Sin correos todavía. Los que envíes desde una incidencia y las respuestas de los clientes aparecerán acá."}
          </div>
        ) : visibles.map((h) => {
          const activo = sel?.hilo_key === h.hilo_key;
          return (
            <div key={h.hilo_key} onClick={() => abrirHilo(h)}
              style={{ padding: "10px 14px", borderBottom: "1px solid #f1f2f4", cursor: "pointer",
                background: activo ? "var(--naranja-suave)" : (h.no_leidos > 0 ? "#f8fbff" : "#fff"),
                borderLeft: `3px solid ${activo ? "var(--naranja)" : "transparent"}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: h.no_leidos > 0 ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.contraparte || "—"}
                </span>
                {h.no_leidos > 0 && (
                  <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, background: "var(--naranja)", color: "#fff", borderRadius: 10, padding: "1px 7px" }}>
                    {h.no_leidos}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--texto)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.ultima_direccion === "saliente" ? "↗ " : "↙ "}{h.ultimo_asunto || "(sin asunto)"}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--texto-tenue)", marginTop: 2 }}>
                {hace(h.ultimo_en)}{h.case_id ? ` · ticket #${h.case_id}` : ""}
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── HILO / REDACCIÓN ─── */}
      <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#f7f8fa" }}>
        {!sel && !nuevo ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)", fontSize: 13 }}>
            Elige un hilo o escribe un correo nuevo.
          </div>
        ) : (
          <>
            <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--borde)", background: "#fff" }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {nuevo ? "Correo nuevo" : (sel.contraparte || "Hilo")}
              </div>
              <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
                {nuevo ? "Sale desde la torre de control" : `${sel.total} ${sel.total === 1 ? "correo" : "correos"}${sel.case_id ? ` · ticket #${sel.case_id}` : ""}`}
              </div>
            </div>

            {!nuevo && (
              <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
                {correos.map((c) => <Burbuja key={c.id} c={c} />)}
                <div ref={finRef} />
              </div>
            )}

            <div style={{ borderTop: "1px solid var(--borde)", background: "#fff", padding: "12px 18px", flex: nuevo ? 1 : "none" }}>
              {aviso && (
                <div style={{ fontSize: 12, marginBottom: 8, color: aviso.includes("✓") ? "#166534" : "#791F1F" }}>{aviso}</div>
              )}
              <input value={destinatario} onChange={(e) => setDestinatario(e.target.value)} placeholder="Para: correo@cliente.com"
                style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px", border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 6 }} />
              <input value={asunto} onChange={(e) => setAsunto(e.target.value)} placeholder="Asunto"
                style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px", border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 6 }} />
              <textarea value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} rows={nuevo ? 12 : 5}
                placeholder="Escribe el mensaje…"
                style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: 10, border: "1px solid var(--borde)", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }} />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                {nuevo && <button onClick={() => setNuevo(false)} style={{ fontSize: 13, padding: "7px 14px" }}>Cancelar</button>}
                <button onClick={enviar} disabled={enviando || !destinatario.trim() || !cuerpo.trim()}
                  style={{ fontSize: 13, padding: "7px 18px", background: "var(--navy)", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", opacity: enviando ? 0.6 : 1 }}>
                  {enviando ? "Enviando…" : "Enviar"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
