import { Fragment, useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../shared/supabase.js";
import { hace } from "../shared/fechas.js";
import { useAuth } from "../shared/auth.jsx";
import { enviarMensaje, conversacionPorTelefono, ventanaAbierta } from "../shared/mensajes.js";

// ═══════════════════════════════════════════════════════════════════════════
// DETALLE DÍA v2 · Avance de rutas por SC + chat con el chofer
// Fuente: vw_rutas_mx_ultimo (una fila por ruta, última captura de HOY,
// escrita cada 5 min por the-eyes-mx). El teléfono del conductor se resuelve
// cruzando driver_id contra el padrón (meli_drivers_master, último snapshot).
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
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// ── Teléfonos desde el padrón: driver_id → phone (último snapshot gana) ─────
async function resolverTelefonos(driverIds) {
  const ids = [...new Set(driverIds.filter(Boolean))];
  const mapa = {};
  for (const lote of chunk(ids, 100)) {
    const { data, error } = await sb
      .from("meli_drivers_master")
      .select("driver_id, phone, fecha_snapshot")
      .in("driver_id", lote)
      .order("fecha_snapshot", { ascending: false });
    if (error) throw error;
    for (const d of data || []) {
      if (mapa[d.driver_id] === undefined) mapa[d.driver_id] = d.phone || null;
    }
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
function FilaRuta({ r, telefono, onChat }) {
  const st = estiloStatus(r.status);
  const sinTel = !telefono;
  return (
    <tr style={{ borderTop: "1px solid var(--borde)" }}>
      <td style={{ padding: "8px 14px", fontWeight: 600 }}>
        {r.id_ruta}
        {r.cycle_name ? <span style={{ fontWeight: 400, color: "var(--texto-tenue)" }}> · {r.cycle_name}</span> : null}
        {r.is_line_haul === true && <span className="pill" style={{ marginLeft: 6, background: "#f1f5f9", color: "#475569" }}>line-haul</span>}
      </td>
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
        <button
          onClick={() => onChat(r, telefono)}
          disabled={sinTel}
          title={sinTel ? "Sin teléfono en el padrón para este conductor" : `Escribir a ${r.driver_name}`}
          style={{ fontSize: 12, padding: "4px 10px", opacity: sinTel ? 0.4 : 1, cursor: sinTel ? "not-allowed" : "pointer" }}>
          💬
        </button>
      </td>
    </tr>
  );
}

function EncabezadoRutas() {
  return (
    <tr style={{ color: "var(--texto-suave)", fontSize: 11, textAlign: "left" }}>
      <th style={{ padding: "8px 14px", fontWeight: 500 }}>Ruta</th>
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
function PanelChat({ chat, onCerrar, onEnviado, analistaId }) {
  const [texto, setTexto] = useState(
    `Hola ${chat.ruta.driver_name?.split(" ")[0] || ""}, te contactamos de la torre Bigticket por tu ruta ${chat.ruta.id_ruta}. `
  );
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState("");
  const [ventana, setVentana] = useState(null); // null = averiguando

  useEffect(() => {
    let activo = true;
    conversacionPorTelefono(chat.telefono)
      .then((c) => { if (activo) setVentana(ventanaAbierta(c)); })
      .catch(() => { if (activo) setVentana(false); });
    return () => { activo = false; };
  }, [chat.telefono]);

  async function enviar() {
    const t = texto.trim();
    if (!t || enviando) return;
    setEnviando(true);
    setError("");
    try {
      await enviarMensaje({ telefono: chat.telefono, texto: t, caseId: null, emisorId: analistaId });
      onEnviado();
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
      <div style={{ background: "#fff", borderRadius: 12, width: 440, maxWidth: "100%", padding: 18 }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>💬 {chat.ruta.driver_name}</div>
          <button onClick={onCerrar} style={{ fontSize: 12, padding: "2px 10px" }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--texto-suave)", marginBottom: 10 }}>
          Ruta {chat.ruta.id_ruta} · {chat.ruta.service_center_id} · {chat.telefono}
        </div>

        {ventana === false && (
          <div style={{ background: "#FAEEDA", color: "#633806", borderRadius: 8, padding: "8px 12px", fontSize: 12, marginBottom: 10 }}>
            El conductor no ha escrito en las últimas 24h: Meta puede rechazar el texto libre.
            Si no llega, pídele por otro canal que escriba "Hola" al número de Soporte.
          </div>
        )}

        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={4}
          autoFocus
          style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: 10, border: "1px solid var(--borde)", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }}
        />

        {error && <div style={{ color: "#791F1F", fontSize: 12, marginTop: 8 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onCerrar} style={{ fontSize: 13, padding: "7px 14px" }}>Cancelar</button>
          <button onClick={enviar} disabled={enviando || !texto.trim()}
            style={{ fontSize: 13, padding: "7px 16px", background: "var(--navy)", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", opacity: enviando ? 0.6 : 1 }}>
            {enviando ? "Enviando…" : "Enviar WhatsApp"}
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
  const [enviadoOk, setEnviadoOk] = useState("");

  const cargar = useCallback(async () => {
    setError("");
    const { data, error } = await sb.from("vw_rutas_mx_ultimo").select("*");
    if (error) { setError("No pudimos cargar el avance de rutas. Reintenta en unos segundos."); setCargando(false); return; }
    const lista = data || [];
    setRutas(lista);
    setCargando(false);
    try {
      const mapa = await resolverTelefonos(lista.map((r) => r.driver_id));
      setTelefonos(mapa);
    } catch (e) { /* sin teléfonos los botones quedan deshabilitados; no es fatal */ }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => {
    const t = setInterval(cargar, 30000);
    return () => clearInterval(t);
  }, [cargar]);

  function abrirChat(ruta, telefono) { setEnviadoOk(""); setChat({ ruta, telefono }); }
  function chatEnviado() {
    const nombre = chat?.ruta?.driver_name || "el conductor";
    setChat(null);
    setEnviadoOk(`Mensaje enviado a ${nombre}. La conversación sigue en "Consultas en ruta".`);
  }

  if (cargando) {
    return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)" }}>Cargando…</div>;
  }

  // ── Agregados ─────────────────────────────────────────────────────────────
  const reparto = rutas.filter((r) => r.is_line_haul === false);
  const entregados = reparto.reduce((a, r) => a + (r.pkg_delivered || 0), 0);
  const cargados   = reparto.reduce((a, r) => a + (r.pkg_total || 0), 0);
  const fallidos   = reparto.reduce((a, r) => a + (r.pkg_not_delivered || 0), 0);
  const activas    = rutas.filter((r) => r.status === "active").length;
  const cerradas   = rutas.filter((r) => r.status === "close").length;
  const detenidas  = rutas.filter((r) => r.alerta_inactividad_vehiculo === true && r.status !== "close").length;
  const demoradas  = rutas.filter((r) => (r.alerta_ruta_demorada === true || r.atraso_inicial === true) && r.status !== "close").length;
  const capturaMax = rutas.reduce((m, r) => (r.capturado_at > m ? r.capturado_at : m), "");

  const porSC = {};
  for (const r of rutas) {
    const sc = r.service_center_id || "—";
    if (!porSC[sc]) porSC[sc] = { sc, filas: [], activas: 0, cerradas: 0, entregados: 0, total: 0, conAlerta: 0 };
    const g = porSC[sc];
    g.filas.push(r);
    if (r.status === "active") g.activas++;
    if (r.status === "close") g.cerradas++;
    if (r.is_line_haul === false) { g.entregados += r.pkg_delivered || 0; g.total += r.pkg_total || 0; }
    if ((r.alertas_activas || 0) > 0 && r.status !== "close") g.conAlerta++;
  }
  const listaSC = Object.values(porSC).sort((a, b) => a.sc.localeCompare(b.sc));
  for (const g of listaSC) {
    g.filas.sort((a, b) => (b.alertas_activas || 0) - (a.alertas_activas || 0) || avanceRuta(a) - avanceRuta(b));
  }

  const problema = rutas
    .filter((r) => (r.alertas_activas || 0) > 0 && r.status !== "close")
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
            <Kpi titulo="Rutas" valor={rutas.length} sub={`${activas} en ruta · ${cerradas} cerradas`} />
            <Kpi titulo="Detenidas" valor={detenidas} sub="sin actividad del vehículo" color={detenidas ? "#b91c1c" : "#16a34a"} />
            <Kpi titulo="Demoradas" valor={demoradas} sub="demora o atraso inicial" color={demoradas ? "#b45309" : "#16a34a"} />
            <Kpi titulo="No entregados" valor={fallidos.toLocaleString("es-MX")} sub="reparto de hoy" color={fallidos ? "#b45309" : undefined} />
          </div>

          {/* Rutas en problema */}
          <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
            <div style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--borde)" }}>
              Rutas detenidas o con demora <span style={{ fontWeight: 400, color: "var(--texto-suave)", fontSize: 12 }}>({problema.length})</span>
            </div>
            {problema.length === 0 ? (
              <div style={{ padding: 22, textAlign: "center", color: "var(--texto-suave)", fontSize: 13 }}>
                Ninguna ruta con alertas activas ahora mismo. 👌
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><EncabezadoRutas /></thead>
                <tbody>
                  {problema.map((r) => (
                    <FilaRuta key={r.id_ruta} r={r} telefono={telefonos[r.driver_id]} onChat={abrirChat} />
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
                                <FilaRuta key={r.id_ruta} r={r} telefono={telefonos[r.driver_id]} onChat={abrirChat} />
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
