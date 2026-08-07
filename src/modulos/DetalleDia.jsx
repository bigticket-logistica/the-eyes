import { Fragment, useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../shared/supabase.js";
import { hace } from "../shared/fechas.js";
import { useAuth } from "../shared/auth.jsx";
import { enviarMensaje, conversacionPorTelefono, ventanaAbierta, crearCasoConsulta } from "../shared/mensajes.js";

// ═══════════════════════════════════════════════════════════════════════════
// DETALLE DÍA v2 · Avance de rutas por SC + chat con el chofer
// Fuente: vw_rutas_mx_ultimo (una fila por ruta, última captura de HOY,
// escrita cada 5 min por the-eyes-mx). El teléfono del conductor se resuelve
// cruzando driver_id contra el Directorio (padrón MELI + overrides de la torre).
// ═══════════════════════════════════════════════════════════════════════════

const STATUS_RUTA = {
  planned:           { label: "Planificada",  bg: "#e0f2fe", color: "#075985" },
  active:            { label: "En ruta",      bg: "#fef3c7", color: "#92400e" },
  close:             { label: "Cerrada",      bg: "#dcfce7", color: "#166534" },
  return_to_station: { label: "Volviendo",    bg: "#f3e8ff", color: "#6b21a8" },
};
const estiloStatus = (s) => STATUS_RUTA[s] || { label: s || "—", bg: "#f1f5f9", color: "#475569" };

const ALERTAS = [
  { campo: "alerta_inactividad_vehiculo", label: "Sin actividad" },
  { campo: "alerta_ruta_demorada",        label: "Demorada" },
  { campo: "atraso_inicial",              label: "Atraso inicial" },
  { campo: "alerta_despacho_demorado",    label: "Despacho demorado" },
  { campo: "alerta_stemout_demorado",     label: "Stemout demorado" },
  { campo: "alerta_saca_pendiente",       label: "Saca pendiente" },
  { campo: "alerta_parada_comercial",     label: "Parada comercial" },
];
const alertasDe = (r) => ALERTAS.filter((a) => r[a.campo] === true);
const pct = (parte, total) => (total > 0 ? Math.round((100 * parte) / total) : 0);
const avanceRuta = (r) => pct(r.pkg_delivered || 0, r.pkg_total || 0);

// ── Teléfonos desde el padrón: driver_id → phone (último snapshot gana) ─────
// El teléfono se resuelve en la base (fn_telefonos_de_rutas), no acá.
//
// Antes se cruzaba el Directorio por driver_id, pero las 499 personas cargadas
// desde el Excel entraron con driver_id NEGATIVO —no teníamos sus identificadores
// reales de MELI— y los de MELI son positivos: el cruce no encontraba a nadie y
// el botón de mensaje quedaba deshabilitado en todas las rutas.
//
// La función resuelve por driver_id cuando existe y por nombre normalizado
// cuando no, y devuelve null si el nombre es ambiguo: mandarle el mensaje a la
// persona equivocada es peor que no mandarlo.
async function resolverTelefonos() {
  const { data, error } = await sb.rpc("fn_telefonos_de_rutas", { p_fecha: null });
  if (error) throw error;
  const mapa = {};
  for (const f of data || []) {
    if (f.driver_id) mapa[f.driver_id] = f.telefono || null;
    // también por id de ruta, para las rutas sin driver_id en el monitor
    if (f.id_ruta) mapa[`r${f.id_ruta}`] = f.telefono || null;
  }
  return mapa;
}

function Kpi({ titulo, valor, sub, color }) {
  return (
    <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, padding: "12px 16px", minWidth: 130 }}>
      <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 4 }}>{titulo}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || "var(--texto)" }}>{valor}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--texto-tenue)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function BarraAvance({ porcentaje }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: "#eef1f5", borderRadius: 5, overflow: "hidden", minWidth: 60 }}>
        <div style={{ width: `${Math.min(100, porcentaje)}%`, height: "100%", background: porcentaje >= 100 ? "#16a34a" : "var(--navy)", borderRadius: 5 }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, minWidth: 36, textAlign: "right" }}>{porcentaje}%</span>
    </div>
  );
}

function BadgesAlertas({ ruta }) {
  const lista = alertasDe(ruta);
  if (!lista.length) return <span style={{ color: "var(--texto-tenue)" }}>—</span>;
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {lista.map((a) => (
        <span key={a.campo} className="pill" style={{
          background: a.campo === "alerta_inactividad_vehiculo" ? "#FCEBEB" : "#FAEEDA",
          color: a.campo === "alerta_inactividad_vehiculo" ? "#791F1F" : "#633806",
        }}>{a.label}</span>
      ))}
    </div>
  );
}

// Fila de UNA ruta (se usa dentro del SC desplegado y en la tabla de problemas)
function FilaRuta({ r, telefono, onChat, conSC }) {
  const st = estiloStatus(r.status);
  const sinTel = !telefono;
  return (
    <tr style={{ borderTop: "1px solid var(--borde)" }}>
      <td style={{ padding: "8px 14px", fontWeight: 600 }}>
        {r.id_ruta}
        {r.cycle_name ? <span style={{ fontWeight: 400, color: "var(--texto-tenue)" }}> · {r.cycle_name}</span> : null}
        {r.is_line_haul === true && <span className="pill" style={{ marginLeft: 6, background: "#f1f5f9", color: "#475569" }}>line-haul</span>}
      </td>
      {conSC && <td style={{ padding: "8px 10px", fontWeight: 600 }}>{r.service_center_id || "—"}</td>}
      <td style={{ padding: "8px 10px" }}>{r.driver_name || "—"}</td>
      <td style={{ padding: "8px 10px" }}>{r.vehicle_license || "—"}</td>
      <td style={{ padding: "8px 10px" }}><span className="pill" style={{ background: st.bg, color: st.color }}>{st.label}</span></td>
      <td style={{ padding: "8px 10px", width: "18%" }}><BarraAvance porcentaje={avanceRuta(r)} /></td>
      <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
        {(r.pkg_delivered ?? "—")} / {(r.pkg_total ?? "—")}
        {r.pkg_not_delivered > 0 && <span style={{ color: "#b45309" }}> · {r.pkg_not_delivered} fallidos</span>}
      </td>
      <td style={{ padding: "8px 10px" }}><BadgesAlertas ruta={r} /></td>
      <td style={{ padding: "8px 14px", textAlign: "right" }}>
        {/* Antes era un 💬 solo, y con el teléfono ausente quedaba gris sin
            explicar por qué. Ahora dice qué hace, y si no hay teléfono igual se
            puede abrir para escribir uno a mano. */}
        <button
          onClick={() => onChat(r, telefono)}
          title={sinTel
            ? "Sin teléfono en el padrón: se puede escribir uno a mano"
            : `Escribir a ${r.driver_name} · ${telefono}`}
          style={{
            fontSize: 11.5, padding: "5px 11px", whiteSpace: "nowrap",
            border: `1px solid ${sinTel ? "var(--borde)" : "var(--navy)"}`,
            background: sinTel ? "#fff" : "#eef2f7",
            color: sinTel ? "var(--texto-suave)" : "var(--navy)",
            borderRadius: 7, cursor: "pointer",
          }}>
          💬 {sinTel ? "Sin tel." : "Escribir"}
        </button>
      </td>
    </tr>
  );
}

function EncabezadoRutas({ conSC }) {
  return (
    <tr style={{ color: "var(--texto-suave)", fontSize: 11, textAlign: "left" }}>
      <th style={{ padding: "8px 14px", fontWeight: 500 }}>Ruta</th>
      {conSC && <th style={{ padding: "8px 10px", fontWeight: 500 }}>SC</th>}
      <th style={{ padding: "8px 10px", fontWeight: 500 }}>Conductor</th>
      <th style={{ padding: "8px 10px", fontWeight: 500 }}>Patente</th>
      <th style={{ padding: "8px 10px", fontWeight: 500 }}>Estado</th>
      <th style={{ padding: "8px 10px", fontWeight: 500 }}>Avance</th>
      <th style={{ padding: "8px 10px", fontWeight: 500 }}>Paquetes</th>
      <th style={{ padding: "8px 10px", fontWeight: 500 }}>Alertas</th>
      <th style={{ padding: "8px 14px" }} />
    </tr>
  );
}

// ── Panel de chat (overlay) ─────────────────────────────────────────────────
// Ventana de Meta abierta (el chofer escribió hace <24h) → texto libre.
// Ventana cerrada → plantilla aprobada de Meta: el analista solo edita el
// motivo (variable {{3}}); nombre y ruta se completan solos.
const PLANTILLA_CONTACTO = { nombre: "contacto_ruta_torre", idioma: "es_MX" };

// Motivos listos, redactados para el conductor. Cubren las alertas que muestra
// el panel, así la analista no tiene que redactar lo mismo veinte veces al día.
const MOTIVOS = [
  { clave: "demora",   etiqueta: "Demora en la ruta",
    texto: "Vemos tu ruta con demora y sin avance en el último tramo. ¿Tienes algún problema para continuar?" },
  { clave: "detenido", etiqueta: "Vehículo detenido",
    texto: "Vemos el vehículo detenido hace algunos minutos. ¿Todo bien por allá?" },
  { clave: "despacho", etiqueta: "Despacho demorado",
    texto: "Vemos que la ruta todavía no sale del centro de distribución. ¿Hay algún problema con el despacho?" },
  { clave: "saca",     etiqueta: "Saca pendiente",
    texto: "Vemos una saca pendiente de entrega en tu ruta. ¿Nos confirmas en qué estado va?" },
  { clave: "avance",   etiqueta: "Consultar avance",
    texto: "Queremos saber cómo vas con el reparto. ¿Nos cuentas cómo va la ruta?" },
  { clave: "coordinar", etiqueta: "Coordinar",
    texto: "Queremos coordinar contigo un tema de tu ruta." },
];

function motivoSugerido(ruta) {
  if (ruta.alerta_inactividad_vehiculo === true) return MOTIVOS[1].texto;
  if (ruta.alerta_despacho_demorado === true)    return MOTIVOS[2].texto;
  if (ruta.alerta_saca_pendiente === true)       return MOTIVOS[3].texto;
  if (ruta.alerta_ruta_demorada === true || ruta.atraso_inicial === true) return MOTIVOS[0].texto;
  return MOTIVOS[5].texto;
}

// Estilos del selector de teléfono. En objetos aparte para que las tres
// variantes del campo se vean idénticas y no se desalineen entre sí.
const opcionTel = {
  fontSize: 12.5, display: "flex", alignItems: "center", gap: 8,
  cursor: "pointer", width: "100%", justifyContent: "flex-start",
};
const campoTel = {
  fontSize: 12.5, padding: "8px 11px", border: "1px solid var(--borde)",
  borderRadius: 7, fontVariantNumeric: "tabular-nums",
};

function PanelChat({ chat, onCerrar, onEnviado, analistaId }) {
  const primerNombre = chat.ruta.driver_name?.split(" ")[0] || "conductor";
  const [texto, setTexto] = useState(
    `Hola ${primerNombre}, te contactamos de la torre Bigticket por tu ruta ${chat.ruta.id_ruta}. `
  );
  const [motivo, setMotivo] = useState(motivoSugerido(chat.ruta));
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");
  const [ventana, setVentana] = useState(null); // null = averiguando

  // El teléfono se puede elegir. Opciones reales:
  //   · Directorio  → lo que resolvió fn_telefonos_de_rutas
  //   · MELI        → driver_phone de la ruta. En la práctica viene VACÍO en
  //                   todas las filas del monitor porque MELI no lo manda en
  //                   get-routes-list; la opción aparece solo si hay dato.
  //   · A mano      → para cuando el padrón está incompleto y la analista tiene
  //                   el número por otra vía.
  // Las plantillas se leen de crm_plantillas_wa: solo las que Meta aprobó.
  // Antes había una sola en duro en el código, así que agregar otra obligaba a
  // desplegar y no había forma de saber cuáles estaban aprobadas.
  const [plantillas, setPlantillas] = useState([]);
  const [plantillaSel, setPlantillaSel] = useState(null);

  useEffect(() => {
    sb.from("crm_plantillas_wa")
      .select("nombre, idioma, etiqueta, descripcion, cuerpo, variables, botones")
      .eq("activa", true).order("orden")
      .then(({ data }) => {
        const l = data || [];
        setPlantillas(l);
        // La de demora es la que corresponde cuando la ruta viene con atraso.
        const demora = l.find((x) => x.nombre === "consulta_demora_ruta");
        const hayDemora = chat.ruta.alerta_ruta_demorada === true
          || chat.ruta.atraso_inicial === true
          || chat.ruta.alerta_despacho_demorado === true
          || chat.ruta.alerta_stemout_demorado === true;
        setPlantillaSel((hayDemora && demora) ? demora : (l[0] || null));
      });
  }, [chat.ruta]);

  const telMeli = (chat.ruta.driver_phone || "").replace(/\D/g, "") || null;
  const telDir  = (chat.telefono || "").replace(/\D/g, "") || null;
  const [fuenteTel, setFuenteTel] = useState(telDir ? "directorio" : (telMeli ? "meli" : "manual"));
  const [telManual, setTelManual] = useState("");

  const telefono = fuenteTel === "directorio" ? telDir
                 : fuenteTel === "meli"       ? telMeli
                 : telManual.replace(/\D/g, "");
  const telValido = telefono && telefono.length >= 10;

  useEffect(() => {
    if (!telValido) { setVentana(null); return; }
    let activo = true;
    conversacionPorTelefono(telefono)
      .then((c) => { if (activo) setVentana(ventanaAbierta(c)); })
      .catch(() => { if (activo) setVentana(false); });
    return () => { activo = false; };
  }, [telefono, telValido]);

  const modoPlantilla = ventana === false;

  // Las variables en orden. Las dos plantillas activas comparten la forma
  // (nombre, ruta, texto libre), así que el tercer campo es siempre el editable.
  const variables = [primerNombre, String(chat.ruta.id_ruta), motivo.trim()];
  const vistaPrevia = plantillaSel
    ? plantillaSel.cuerpo.replace(/\{\{(\d+)\}\}/g, (_, n) => variables[Number(n) - 1] ?? "")
    : `Hola ${primerNombre}, te contactamos de la torre de soporte Bigticket por tu ruta ${chat.ruta.id_ruta}. ${motivo.trim()} Por favor respóndenos por aquí para poder ayudarte.`;

  async function enviar() {
    if (enviando || ventana === null || !telValido) return;
    const cuerpo = modoPlantilla ? vistaPrevia : texto.trim();
    if (!cuerpo || (modoPlantilla && !motivo.trim())) return;
    setEnviando(true);
    setError("");
    try {
      const resp = await enviarMensaje({
        telefono,
        texto: cuerpo,
        caseId: null,
        emisorId: analistaId,
        plantilla: modoPlantilla
          ? (plantillaSel
              ? { nombre: plantillaSel.nombre, idioma: plantillaSel.idioma, variables }
              : { ...PLANTILLA_CONTACTO, variables })
          : null,
      });
      // ticket propio en Consultas en ruta
      let caseId = null;
      if (resp?.conversacion_id) {
        try { caseId = await crearCasoConsulta(resp.conversacion_id, analistaId); }
        catch (e) { /* el mensaje ya salió; el ticket se puede crear desde Consultas */ }
      }
      onEnviado(caseId);
    } catch (e) {
      setError(e.message || "No se pudo enviar el mensaje.");
      setEnviando(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }} onClick={onCerrar}>
      <div style={{ background: "#fff", borderRadius: 12, width: 460, maxWidth: "100%", padding: 18 }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>💬 {chat.ruta.driver_name}</div>
          <button onClick={onCerrar} style={{ fontSize: 12, padding: "2px 10px" }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--texto-suave)", marginBottom: 10 }}>
          Ruta {chat.ruta.id_ruta} · {chat.ruta.service_center_id}
        </div>

        {/* ── A qué número se manda ──
            Con opciones reales se muestran radios. SIN opciones no se muestra
            ninguno: un botón de opción con una sola alternativa no significa
            nada y descuadraba el recuadro. En ese caso va directo el campo. */}
        {(telDir || telMeli) ? (
          <div style={{
            border: "1px solid var(--borde)", borderRadius: 9,
            padding: "10px 12px", marginBottom: 12, textAlign: "left",
          }}>
            <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 8 }}>
              Enviar a
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {telDir && (
                <label style={opcionTel}>
                  <input type="radio" name="fuenteTel" checked={fuenteTel === "directorio"}
                    onChange={() => setFuenteTel("directorio")} style={{ margin: 0, flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{telDir}</span>
                  <span style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>del Directorio</span>
                </label>
              )}
              {telMeli && telMeli !== telDir && (
                <label style={opcionTel}>
                  <input type="radio" name="fuenteTel" checked={fuenteTel === "meli"}
                    onChange={() => setFuenteTel("meli")} style={{ margin: 0, flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{telMeli}</span>
                  <span style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>de MELI</span>
                </label>
              )}
              <label style={opcionTel}>
                <input type="radio" name="fuenteTel" checked={fuenteTel === "manual"}
                  onChange={() => setFuenteTel("manual")} style={{ margin: 0, flexShrink: 0 }} />
                <span>Otro número</span>
              </label>
              {fuenteTel === "manual" && (
                <input value={telManual} onChange={(e) => setTelManual(e.target.value)}
                  placeholder="Ej. 5215512345678" autoFocus
                  style={{ ...campoTel, marginLeft: 23,
                    borderColor: telManual && !telValido ? "#fca5a5" : "var(--borde)" }} />
              )}
            </div>
          </div>
        ) : (
          <div style={{
            border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 9,
            padding: "11px 13px", marginBottom: 12, textAlign: "left",
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#92400e", marginBottom: 3 }}>
              Sin teléfono en el padrón
            </div>
            <div style={{ fontSize: 11.5, color: "#92400e", marginBottom: 8, lineHeight: 1.45 }}>
              Escribe el número para contactar a {chat.ruta.driver_name || "este conductor"}.
            </div>
            <input value={telManual} onChange={(e) => setTelManual(e.target.value)}
              placeholder="Ej. 5215512345678" autoFocus
              style={{ ...campoTel, width: "100%", boxSizing: "border-box",
                borderColor: telManual && !telValido ? "#fca5a5" : "var(--borde)" }} />
            <div style={{ fontSize: 10.5, color: "#92400e", marginTop: 5 }}>
              Solo dígitos, con código de país. México 52 · Chile 56
            </div>
          </div>
        )}

        {!telValido && (telDir || telMeli) && (
          <div style={{ padding: "12px 0", textAlign: "center", color: "var(--texto-suave)", fontSize: 12.5 }}>
            Escribe el número para continuar.
          </div>
        )}

        {telValido && ventana === null && (
          <div style={{ padding: "14px 0", textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>Verificando ventana de contacto…</div>
        )}

        {telValido && ventana === true && (
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            rows={4}
            autoFocus
            style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: 10, border: "1px solid var(--borde)", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }}
          />
        )}

        {telValido && modoPlantilla && (
          <div>
            <div style={{ background: "#e0f2fe", color: "#075985", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginBottom: 10 }}>
              El conductor no ha escrito en las últimas 24h → se envía una <b>plantilla aprobada</b>.
            </div>

            {plantillas.length > 1 && (
              <div style={{ marginBottom: 9 }}>
                <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 4 }}>Plantilla</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {plantillas.map((pl) => (
                    <button key={pl.nombre} onClick={() => setPlantillaSel(pl)}
                      title={pl.descripcion || pl.nombre}
                      style={{
                        fontSize: 11, padding: "4px 10px", borderRadius: 20, whiteSpace: "nowrap",
                        border: `1px solid ${plantillaSel?.nombre === pl.nombre ? "var(--navy)" : "var(--borde)"}`,
                        background: plantillaSel?.nombre === pl.nombre ? "#eef2f7" : "#fff",
                        fontWeight: plantillaSel?.nombre === pl.nombre ? 600 : 400,
                      }}>
                      {pl.etiqueta}
                      {pl.botones?.length ? " · con botones" : ""}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Motivos listos para no redactar lo mismo veinte veces al día.
                El sugerido viene de la alerta que tiene la ruta. */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
              {MOTIVOS.map((m) => (
                <button key={m.clave} onClick={() => setMotivo(m.texto)}
                  title={m.texto}
                  style={{
                    fontSize: 11, padding: "4px 9px", borderRadius: 20, whiteSpace: "nowrap",
                    border: `1px solid ${motivo === m.texto ? "var(--navy)" : "var(--borde)"}`,
                    background: motivo === m.texto ? "#eef2f7" : "#fff",
                    fontWeight: motivo === m.texto ? 600 : 400,
                  }}>
                  {m.etiqueta}
                </button>
              ))}
            </div>
            <textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={2}
              style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", border: "1px solid var(--borde)", borderRadius: 8, marginBottom: 10, fontFamily: "inherit", resize: "vertical" }}
            />
            <div style={{ background: "#fafbfc", border: "1px dashed var(--borde)", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "var(--texto)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {vistaPrevia}
              {/* Los botones de respuesta rápida: el conductor contesta de un
                  toque mientras maneja, y con eso se abre la ventana de 24 h. */}
              {plantillaSel?.botones?.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  {plantillaSel.botones.map((b) => (
                    <span key={b} style={{
                      fontSize: 11.5, padding: "5px 12px", borderRadius: 7,
                      border: "1px solid #a7c4e8", color: "#1a5fb4", background: "#fff",
                    }}>{b}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {error && <div style={{ color: "#791F1F", fontSize: 12, marginTop: 8 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onCerrar} style={{ fontSize: 13, padding: "7px 14px" }}>Cancelar</button>
          <button onClick={enviar}
            disabled={enviando || ventana === null || (modoPlantilla ? !motivo.trim() : !texto.trim())}
            style={{ fontSize: 13, padding: "7px 16px", background: "var(--navy)", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", opacity: enviando || ventana === null ? 0.6 : 1 }}>
            {enviando ? "Enviando…" : modoPlantilla ? "Enviar plantilla" : "Enviar WhatsApp"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DetalleDia() {
  const { analista } = useAuth();
  const navigate = useNavigate();
  const [rutas, setRutas] = useState([]);
  const [telefonos, setTelefonos] = useState({});
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [abiertos, setAbiertos] = useState({});   // { SC: true }
  const [chat, setChat] = useState(null);          // { ruta, telefono }
  // Las line-haul no se ocultan porque sobren: 29 con despacho demorado es una
  // señal real. Se separan porque la ACCIÓN es distinta — a una transferencia
  // atascada no se le escribe a un conductor, se escala al centro de
  // distribución. La torre trabaja el reparto minuto a minuto, así que ese es
  // el estado inicial.
  const [verLineHaul, setVerLineHaul] = useState(false);
  const [enviadoOk, setEnviadoOk] = useState("");

  const cargar = useCallback(async () => {
    setError("");
    const { data, error } = await sb.from("vw_rutas_mx_ultimo").select("*");
    if (error) { setError("No pudimos cargar el avance de rutas. Reintenta en unos segundos."); setCargando(false); return; }
    const lista = data || [];
    setRutas(lista);
    setCargando(false);
    try {
      const mapa = await resolverTelefonos();
      setTelefonos(mapa);
    } catch (e) { /* sin teléfonos los botones quedan deshabilitados; no es fatal */ }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => {
    const t = setInterval(cargar, 30000);
    return () => clearInterval(t);
  }, [cargar]);

  function abrirChat(ruta, telefono) { setEnviadoOk(""); setChat({ ruta, telefono }); }
  function chatEnviado(caseId) {
    const nombre = chat?.ruta?.driver_name || "el conductor";
    setChat(null);
    setEnviadoOk(caseId
      ? `Mensaje enviado a ${nombre} y ticket #${caseId} creado en "Consultas en ruta".`
      : `Mensaje enviado a ${nombre}. La conversación sigue en "Consultas en ruta".`);
  }

  if (cargando) {
    return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)" }}>Cargando…</div>;
  }

  // ── Agregados ─────────────────────────────────────────────────────────────
  // Avance/cierres: acumulado del DÍA (rutas fuera del feed siguen sumando).
  // Alertas/en-ruta: solo rutas VIGENTES (presentes en el feed de MELI ahora).
  const reparto = rutas.filter((r) => r.is_line_haul === false);
  const entregados = reparto.reduce((a, r) => a + (r.pkg_delivered || 0), 0);
  const cargados   = reparto.reduce((a, r) => a + (r.pkg_total || 0), 0);
  const fallidos   = reparto.reduce((a, r) => a + (r.pkg_not_delivered || 0), 0);
  const vigentes   = rutas.filter((r) => r.vigente !== false);
  const activas    = vigentes.filter((r) => r.status === "active").length;
  const cerradas   = rutas.filter((r) => r.status === "close").length;

  // Las tarjetas de alerta se calculan sobre el MISMO universo que la tabla de
  // abajo: rutas de reparto vigentes y no cerradas. Antes no cuadraban entre sí:
  // las tarjetas contaban solo dos alertas (inactividad y ruta demorada, ambas
  // en cero hoy), la tabla contaba CUALQUIER alerta, y una consulta directa a la
  // base contaba también las line-haul. Tres números para tres universos.
  const repartoVivo = vigentes.filter((r) =>
    (verLineHaul || r.is_line_haul !== true) && r.status !== "close");
  const lineHaulConAlerta = vigentes.filter((r) =>
    r.is_line_haul === true && r.status !== "close" && (r.alertas_activas || 0) > 0).length;
  const detenidas  = repartoVivo.filter((r) => r.alerta_inactividad_vehiculo === true).length;
  // "Demorada" agrupa todas las formas de atraso que reporta MELI: la ruta en sí,
  // el despacho que no sale del centro, el stem-out y el atraso inicial.
  const demoradas  = repartoVivo.filter((r) =>
    r.alerta_ruta_demorada === true || r.atraso_inicial === true ||
    r.alerta_despacho_demorado === true || r.alerta_stemout_demorado === true).length;
  const conAlerta  = repartoVivo.filter((r) => (r.alertas_activas || 0) > 0).length;
  const capturaMax = rutas.reduce((m, r) => (r.capturado_at > m ? r.capturado_at : m), "");

  const porSC = {};
  for (const r of rutas) {
    const sc = r.service_center_id || "—";
    if (!porSC[sc]) porSC[sc] = { sc, filas: [], activas: 0, cerradas: 0, entregados: 0, total: 0, conAlerta: 0 };
    const g = porSC[sc];
    // el desplegable muestra lo vivo en el feed; las line-haul según el interruptor
    if (r.vigente !== false && (verLineHaul || r.is_line_haul !== true)) g.filas.push(r);
    if (r.status === "active" && r.vigente !== false) g.activas++;
    if (r.status === "close") g.cerradas++;      // cierres del día completos
    if (r.is_line_haul === false) { g.entregados += r.pkg_delivered || 0; g.total += r.pkg_total || 0; }
    if ((r.alertas_activas || 0) > 0 && r.status !== "close" && r.vigente !== false) g.conAlerta++;
  }
  const listaSC = Object.values(porSC).sort((a, b) => a.sc.localeCompare(b.sc));
  for (const g of listaSC) {
    g.filas.sort((a, b) =>
      (b.alertas_activas || 0) - (a.alertas_activas || 0) ||
      avanceRuta(a) - avanceRuta(b));
  }

  // Las line-haul quedan fuera de las listas. Son transferencias entre bodegas:
  // MELI no les asigna conductor (driver_name viene "-" y driver_id null), así
  // que ocupaban la tabla con filas sin nombre, sin patente y sin nadie a quien
  // escribir. Siguen contando en los KPI de rutas del feed.
  const problema = repartoVivo
    .filter((r) => (r.alertas_activas || 0) > 0)
    .sort((a, b) => (b.alertas_activas || 0) - (a.alertas_activas || 0));

  const sinDatos = rutas.length === 0;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Detalle del día</div>
          <div style={{ fontSize: 12, color: "var(--texto-suave)" }}>
            {sinDatos ? "Sin capturas todavía" : `Última captura ${hace(capturaMax)} · se actualiza cada 5 min`}
          </div>
        </div>
        <button onClick={cargar} style={{ fontSize: 12, padding: "6px 14px" }}>Actualizar</button>
      </div>

      {error && <div style={{ background: "#FCEBEB", color: "#791F1F", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>{error}</div>}

      {enviadoOk && (
        <div style={{ background: "#dcfce7", color: "#166534", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span>{enviadoOk}</span>
          <button onClick={() => navigate("/consultas")} style={{ fontSize: 12, padding: "4px 12px", flexShrink: 0 }}>Ir a Consultas</button>
        </div>
      )}

      {sinDatos && !error && (
        <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, padding: 28, textAlign: "center", color: "var(--texto-suave)" }}>
          Aún no hay rutas capturadas hoy. El monitor corre de 6:00 a 21:59 CDMX; la primera captura del día aparece minutos después del primer despacho.
        </div>
      )}

      {!sinDatos && (
        <Fragment>
          {/* KPIs */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
            <Kpi titulo="Avance de reparto" valor={`${pct(entregados, cargados)}%`} sub={`${entregados.toLocaleString("es-MX")} / ${cargados.toLocaleString("es-MX")} paquetes`} color="var(--navy)" />
            <Kpi titulo="Rutas en feed" valor={vigentes.length} sub={`${activas} en ruta · ${cerradas} cerradas hoy`} />
            <Kpi titulo="Detenidas" valor={detenidas} sub="vehículo sin actividad" color={detenidas ? "#b91c1c" : "#16a34a"} />
            <Kpi titulo="Demoradas" valor={demoradas} sub="ruta, despacho o stem-out" color={demoradas ? "#b45309" : "#16a34a"} />
            <Kpi titulo="No entregados" valor={fallidos.toLocaleString("es-MX")} sub="reparto de hoy" color={fallidos ? "#b45309" : undefined} />
          </div>

          {/* Rutas en problema */}
          <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
            <div style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--borde)" }}>
              <span style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span>
                  Rutas con alerta
                  <span style={{ fontWeight: 400, color: "var(--texto-suave)", fontSize: 12 }}> ({problema.length})</span>
                </span>
                <button onClick={() => setVerLineHaul(!verLineHaul)}
                  title="Las transferencias entre bodegas no tienen conductor: se escalan al centro de distribución"
                  style={{
                    fontSize: 11, fontWeight: 400, padding: "3px 10px", borderRadius: 20,
                    border: `1px solid ${verLineHaul ? "var(--navy)" : "var(--borde)"}`,
                    background: verLineHaul ? "#eef2f7" : "#fff", whiteSpace: "nowrap",
                  }}>
                  {verLineHaul
                    ? "Solo reparto"
                    : `Incluir line-haul${lineHaulConAlerta ? ` (${lineHaulConAlerta})` : ""}`}
                </button>
              </span>
              <div style={{ fontWeight: 400, fontSize: 11, color: "var(--texto-tenue)", marginTop: 3 }}>
                {detenidas > 0 && `${detenidas} detenidas · `}
                {demoradas > 0 && `${demoradas} con demora · `}
                cualquier alerta de MELI
                {!verLineHaul && lineHaulConAlerta > 0 &&
                  ` · ${lineHaulConAlerta} line-haul con alerta no listadas`}
              </div>
            </div>
            {problema.length === 0 ? (
              <div style={{ padding: 22, textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>
                Ninguna ruta con alertas activas ahora mismo. 👌
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><EncabezadoRutas conSC /></thead>
                <tbody>
                  {problema.map((r) => (
                    <FilaRuta key={r.id_ruta} r={r} telefono={telefonos[r.driver_id] || telefonos[`r${r.id_ruta}`]} onChat={abrirChat} conSC />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Avance por SC, desplegable */}
          <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--borde)" }}>
              Avance por Service Center <span style={{ fontWeight: 400, color: "var(--texto-suave)", fontSize: 12 }}>(clic en un SC para ver sus rutas)</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--texto-suave)", fontSize: 11, textAlign: "left" }}>
                  <th style={{ padding: "8px 14px", fontWeight: 500 }}>SC</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Rutas</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>En ruta</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Cerradas</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500 }}>Entregados / Total</th>
                  <th style={{ padding: "8px 10px", fontWeight: 500, width: "24%" }}>Avance</th>
                  <th style={{ padding: "8px 14px", fontWeight: 500 }}>Con alerta</th>
                </tr>
              </thead>
              <tbody>
                {listaSC.map((g) => (
                  <Fragment key={g.sc}>
                    <tr onClick={() => setAbiertos((p) => ({ ...p, [g.sc]: !p[g.sc] }))}
                      style={{ borderTop: "1px solid var(--borde)", cursor: "pointer", background: abiertos[g.sc] ? "var(--naranja-suave)" : "transparent" }}>
                      <td style={{ padding: "9px 14px", fontWeight: 600 }}>
                        <span style={{ display: "inline-block", width: 14, color: "var(--texto-suave)" }}>{abiertos[g.sc] ? "▾" : "▸"}</span>
                        {g.sc}
                      </td>
                      <td style={{ padding: "9px 10px" }}>{g.filas.length}</td>
                      <td style={{ padding: "9px 10px" }}>{g.activas}</td>
                      <td style={{ padding: "9px 10px" }}>{g.cerradas}</td>
                      <td style={{ padding: "9px 10px" }}>{g.entregados.toLocaleString("es-MX")} / {g.total.toLocaleString("es-MX")}</td>
                      <td style={{ padding: "9px 10px" }}><BarraAvance porcentaje={pct(g.entregados, g.total)} /></td>
                      <td style={{ padding: "9px 14px" }}>
                        {g.conAlerta > 0
                          ? <span className="pill" style={{ background: "#FCEBEB", color: "#791F1F" }}>{g.conAlerta}</span>
                          : <span style={{ color: "var(--texto-tenue)" }}>—</span>}
                      </td>
                    </tr>
                    {abiertos[g.sc] && (
                      <tr>
                        <td colSpan={7} style={{ padding: 0, background: "#fafbfc" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                            <thead><EncabezadoRutas /></thead>
                            <tbody>
                              {g.filas.map((r) => (
                                <FilaRuta key={r.id_ruta} r={r} telefono={telefonos[r.driver_id] || telefonos[`r${r.id_ruta}`]} onChat={abrirChat} />
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Fragment>
      )}

      {chat && (
        <PanelChat chat={chat} analistaId={analista?.id}
          onCerrar={() => setChat(null)} onEnviado={chatEnviado} />
      )}
    </div>
  );
}
