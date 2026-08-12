import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import {
  conversacionPorTelefono, ventanaAbierta, enviarMensaje, crearCasoConsulta,
} from "../shared/mensajes.js";

// ═══════════════════════════════════════════════════════════════════════════
// NUEVO MENSAJE · iniciar una conversación desde Consultas
//
// Hasta ahora Consultas solo podía RESPONDER: si el conductor no había escrito,
// no había forma de contactarlo desde acá (había que ir a Detalle del Día, y
// solo si tenía ruta hoy).
//
// LA REGLA DE META QUE MANDA TODO
//   Fuera de la ventana de 24 h desde el último mensaje del conductor, Meta NO
//   acepta texto libre: solo plantilla aprobada. Por eso el panel primero
//   averigua el estado de la ventana y recién entonces decide qué se puede
//   mandar. No es una preferencia nuestra: un texto libre fuera de ventana lo
//   rechaza Meta y el mensaje no llega.
//
// La plantilla contacto_ruta_torre tiene tres variables: nombre, ruta/referencia
// y un texto libre. Ese tercero es el único que el analista redacta, y termina
// pidiendo que el conductor responda — que es lo que abre la ventana para poder
// conversar normal.
// ═══════════════════════════════════════════════════════════════════════════

const PLANTILLA = { nombre: "contacto_ruta_torre", idioma: "es_MX" };

const soloDigitos = (t) => String(t || "").replace(/\D/g, "");

// `inicial` permite abrir este panel YA PRECARGADO desde otra parte de la
// aplicación — hoy lo usa el bloque de incidencias sin consulta. Se reutiliza
// este componente en vez de escribir un segundo selector de plantillas: la
// regla de la ventana de 24 h es delicada y tenerla en dos lugares garantiza
// que uno de los dos se desincronice.
//   inicial = { nombre, telefono, sc, ruta, motivo, alternos: [{numero,...}] }
export default function NuevoMensaje({ analistaId, onAbrirConversacion, onCerrar, inicial }) {
  const [busca, setBusca] = useState("");
  const [resultados, setResultados] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [sel, setSel] = useState(
    inicial?.telefono
      ? { nombre: inicial.nombre || "conductor", telefono: soloDigitos(inicial.telefono),
          sc: inicial.sc || null, origen: inicial.origen || "Incidencia",
          alternos: inicial.alternos || [] }
      : null,
  );

  const [ventana, setVentana] = useState(null);  // null = averiguando
  const [conv, setConv] = useState(null);
  const [ruta, setRuta] = useState(inicial?.ruta || "");
  const [motivo, setMotivo] = useState(inicial?.motivo || "");
  const [libre, setLibre] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");

  // ── Búsqueda: Directorio + conversaciones existentes ──────────────────────
  const buscar = useCallback(async (q) => {
    const t = q.trim();
    if (t.length < 3) { setResultados([]); return; }
    setBuscando(true);
    const dig = soloDigitos(t);
    try {
      const [dir, convs] = await Promise.all([
        sb.from("crm_directorio_conductores")
          .select("nombre, telefono, sc, patente")
          .or(`nombre.ilike.%${t}%${dig.length >= 4 ? `,telefono.ilike.%${dig}%` : ""}`)
          .limit(12),
        sb.from("crm_inc_conversaciones")
          .select("telefono, conductor_nombre, ultimo_entrante_en")
          .or(`conductor_nombre.ilike.%${t}%${dig.length >= 4 ? `,telefono.ilike.%${dig}%` : ""}`)
          .limit(12),
      ]);

      const mapa = new Map();
      for (const r of dir.data || []) {
        const k = soloDigitos(r.telefono).slice(-10);
        if (k) mapa.set(k, { nombre: r.nombre, telefono: soloDigitos(r.telefono), sc: r.sc, origen: "Directorio" });
      }
      for (const c of convs.data || []) {
        const k = soloDigitos(c.telefono).slice(-10);
        if (!k) continue;
        if (mapa.has(k)) mapa.get(k).ya_escribio = c.ultimo_entrante_en;
        else mapa.set(k, {
          nombre: c.conductor_nombre || "(sin nombre en el Directorio)",
          telefono: soloDigitos(c.telefono), sc: null,
          origen: "Conversación previa", ya_escribio: c.ultimo_entrante_en,
        });
      }

      // Un número escrito a mano también sirve, aunque no esté en ninguna parte.
      if (dig.length >= 10 && !mapa.has(dig.slice(-10))) {
        mapa.set(dig.slice(-10), {
          nombre: "(número nuevo)", telefono: dig, sc: null, origen: "Escrito a mano",
        });
      }
      setResultados([...mapa.values()]);
    } catch (e) {
      setError(e.message);
    } finally { setBuscando(false); }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => buscar(busca), 350);
    return () => clearTimeout(t);
  }, [busca, buscar]);

  // ── Al elegir un contacto: averiguar el estado de la ventana ──────────────
  useEffect(() => {
    if (!sel) { setVentana(null); return; }
    let vivo = true;
    setVentana(null); setError("");
    conversacionPorTelefono(sel.telefono)
      .then((c) => {
        if (!vivo) return;
        setConv(c);
        setVentana(ventanaAbierta(c));
      })
      .catch(() => { if (vivo) { setConv(null); setVentana(false); } });
    return () => { vivo = false; };
  }, [sel]);

  const primerNombre = (sel?.nombre || "").split(" ")[0] || "conductor";
  const referencia = ruta.trim() || sel?.sc || "tu operación";
  const vistaPrevia =
    `Hola ${primerNombre}, te contactamos de la torre de soporte Bigticket por ${referencia}. ` +
    `${motivo.trim()} Por favor respóndenos por aquí para poder ayudarte.`;

  async function enviar() {
    if (enviando || !sel || ventana === null) return;
    const conPlantilla = ventana === false;
    if (conPlantilla && !motivo.trim()) { setError("Escribe el motivo del contacto."); return; }
    if (!conPlantilla && !libre.trim()) { setError("Escribe el mensaje."); return; }

    setEnviando(true); setError("");
    try {
      const resp = await enviarMensaje({
        telefono: sel.telefono,
        texto: conPlantilla ? vistaPrevia : libre.trim(),
        caseId: null,
        emisorId: analistaId,
        plantilla: conPlantilla
          ? { ...PLANTILLA, variables: [primerNombre, referencia, motivo.trim()] }
          : null,
      });
      // Ticket propio, para que la conversación quede con dueño y cronómetro.
      const convId = resp?.conversacion_id || conv?.id;
      if (convId) {
        try { await crearCasoConsulta(convId, analistaId); } catch { /* se puede crear después */ }
      }
      onAbrirConversacion?.(convId, sel.telefono);
      onCerrar?.();
    } catch (e) {
      setError(e.message || "No se pudo enviar.");
      setEnviando(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 9998,
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 20px",
    }} onClick={(e) => { if (e.target === e.currentTarget) onCerrar?.(); }}>
      <div style={{
        background: "#fff", borderRadius: 12, width: 520, maxWidth: "94vw",
        boxShadow: "0 16px 48px rgba(0,0,0,.28)", overflow: "hidden",
      }}>
        <div style={{
          padding: "13px 18px", background: "var(--navy)", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Nuevo mensaje a un conductor</span>
          <button onClick={onCerrar}
            style={{ background: "transparent", border: "none", color: "#fff", fontSize: 17, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ padding: 18 }}>
          {/* ── Buscador ── */}
          {!sel ? (
            <>
              <input autoFocus value={busca} onChange={(e) => setBusca(e.target.value)}
                placeholder="Nombre o teléfono del conductor…"
                style={{
                  width: "100%", fontSize: 14, padding: "10px 12px", boxSizing: "border-box",
                  border: "1px solid var(--borde)", borderRadius: 9,
                }} />
              <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginTop: 6 }}>
                Busca en el Directorio y en conversaciones previas. También puedes escribir un número completo.
              </div>

              <div style={{ marginTop: 12, maxHeight: 300, overflowY: "auto" }}>
                {buscando && <div style={{ fontSize: 12, color: "var(--texto-tenue)", padding: 8 }}>Buscando…</div>}
                {!buscando && busca.trim().length >= 3 && resultados.length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--texto-tenue)", padding: 8 }}>
                    Sin resultados. Si tienes el número completo, escríbelo y aparecerá acá.
                  </div>
                )}
                {resultados.map((r) => (
                  <button key={r.telefono} onClick={() => { setSel(r); setRuta(""); setMotivo(""); setLibre(""); }}
                    style={{
                      width: "100%", textAlign: "left", padding: "9px 11px", marginBottom: 5,
                      border: "1px solid var(--borde)", borderRadius: 8, background: "#fff", cursor: "pointer",
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{r.nombre}</div>
                    <div style={{ fontSize: 11.5, color: "var(--texto-suave)", marginTop: 2 }}>
                      {r.telefono}
                      {r.sc ? ` · ${r.sc}` : ""}
                      <span style={{ color: "var(--texto-tenue)" }}> · {r.origen}</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              {/* ── Contacto elegido ── */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "9px 11px", background: "#f8fafc", border: "1px solid var(--borde)",
                borderRadius: 9, marginBottom: 14,
              }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{sel.nombre}</div>
                  <div style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>
                    {sel.telefono}{sel.sc ? ` · ${sel.sc}` : ""}
                  </div>
                </div>
                <button onClick={() => setSel(null)} style={{ fontSize: 11.5, padding: "5px 10px" }}>Cambiar</button>
              </div>

              {/* Números alternativos del Directorio para el mismo conductor.
                  El de MELI es el de la ruta de hoy y va por defecto; estos son
                  el respaldo cuando no contesta. Se muestra el nombre del
                  Directorio porque a veces NO coincide con el de MELI (un mismo
                  número puede tener otra persona registrada) y la analista
                  necesita verlo antes de escribir. */}
              {sel.alternos?.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11.5, color: "var(--texto-suave)", marginBottom: 5 }}>
                    Otros números de este conductor en el Directorio:
                  </div>
                  {sel.alternos.map((a) => {
                    const num = soloDigitos(a.numero);
                    const activo = num.slice(-10) === soloDigitos(sel.telefono).slice(-10);
                    return (
                      <button key={num} disabled={activo}
                        onClick={() => setSel((p) => ({ ...p, telefono: num, sc: a.sc || p.sc }))}
                        style={{
                          display: "block", width: "100%", textAlign: "left", marginBottom: 4,
                          fontSize: 11.5, padding: "6px 9px", borderRadius: 7,
                          border: `1px solid ${activo ? "var(--naranja)" : "var(--borde)"}`,
                          background: activo ? "#fff7ed" : "#fff",
                          cursor: activo ? "default" : "pointer",
                        }}>
                        <b>{num}</b>
                        {activo && <span style={{ color: "var(--naranja)" }}> · en uso</span>}
                        {a.nombre && <span style={{ color: "var(--texto-tenue)" }}> · {a.nombre}</span>}
                        {a.empresa && <span style={{ color: "var(--texto-tenue)" }}> · {a.empresa}</span>}
                      </button>
                    );
                  })}
                </div>
              )}

              {ventana === null ? (
                <div style={{ fontSize: 12.5, color: "var(--texto-suave)", padding: "10px 0" }}>
                  Revisando si la ventana de 24 h está abierta…
                </div>
              ) : ventana ? (
                <>
                  <div style={{
                    fontSize: 12, background: "#ecfdf5", border: "1px solid #a7f3d0",
                    color: "#15803d", borderRadius: 8, padding: "8px 10px", marginBottom: 10,
                  }}>
                    ✓ Ventana abierta — el conductor escribió hace menos de 24 h, así que puedes mandar texto libre.
                  </div>
                  <textarea value={libre} onChange={(e) => setLibre(e.target.value)} rows={4}
                    placeholder="Escribe el mensaje…"
                    style={{
                      width: "100%", boxSizing: "border-box", fontSize: 13, padding: "10px 12px",
                      border: "1px solid var(--borde)", borderRadius: 9, fontFamily: "inherit", resize: "vertical",
                    }} />
                </>
              ) : (
                <>
                  <div style={{
                    fontSize: 12, background: "#fffbeb", border: "1px solid #fde68a",
                    color: "#92400e", borderRadius: 8, padding: "8px 10px", marginBottom: 12,
                  }}>
                    Ventana cerrada — Meta no permite texto libre. Se envía la <b>plantilla aprobada</b>;
                    cuando el conductor responda, la conversación queda abierta para escribir normal.
                  </div>

                  <label style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>Ruta o referencia (opcional)</label>
                  <input value={ruta} onChange={(e) => setRuta(e.target.value)}
                    placeholder="ej. ruta B16_AM2, o el SC"
                    style={{
                      width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 11px",
                      border: "1px solid var(--borde)", borderRadius: 8, marginBottom: 10,
                    }} />

                  <label style={{ fontSize: 11.5, color: "var(--texto-suave)" }}>Motivo del contacto</label>
                  <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2}
                    placeholder="ej. Necesitamos coordinar la entrega de un paquete."
                    style={{
                      width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 11px",
                      border: "1px solid var(--borde)", borderRadius: 8, fontFamily: "inherit", resize: "vertical",
                    }} />

                  <div style={{ fontSize: 11, color: "var(--texto-tenue)", margin: "10px 0 4px" }}>
                    Así lo va a recibir:
                  </div>
                  <div style={{
                    fontSize: 12.5, background: "#f1f5f9", borderRadius: 8, padding: "9px 11px",
                    lineHeight: 1.5, whiteSpace: "pre-wrap",
                  }}>
                    {vistaPrevia}
                  </div>
                </>
              )}

              {error && (
                <div style={{
                  fontSize: 12, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fca5a5",
                  borderRadius: 8, padding: "8px 10px", marginTop: 10,
                }}>{error}</div>
              )}

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button onClick={onCerrar} style={{ padding: "9px 15px", fontSize: 13 }}>Cancelar</button>
                <button className="btn-navy" onClick={enviar} disabled={enviando || ventana === null}
                  style={{ padding: "9px 20px", fontSize: 13 }}>
                  {enviando ? "Enviando…" : ventana === false ? "Enviar plantilla" : "Enviar mensaje"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
