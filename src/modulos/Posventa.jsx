import { Fragment, useState, useEffect, useMemo } from "react";
import { sb } from "../shared/supabase.js";

// ── Posventa ───────────────────────────────────────────────────────────────
// Hoy solo PNR; las devoluciones entran después como una segunda vista del
// mismo módulo. Lee vw_pnr_tablero completa (155 filas hoy, unos pocos miles
// en el peor caso) y agrega en el cliente: una consulta por carga en vez de
// tres RPC de totales que después habría que mantener sincronizadas a mano
// con la misma regla de clasificación.

const VISTAS = [
  { clave: "pnr",          etiqueta: "PNR",          activa: true  },
  { clave: "devoluciones", etiqueta: "Devoluciones", activa: false },
];

// Paleta. Navy y naranja son los institucionales; los otros tres se derivan
// de ellos en vez de traer una familia nueva. El ladrillo es el naranja
// oscurecido y desaturado, así la pérdida se lee como "esto se apagó" y no
// como una alerta de sistema. El verde queda reservado para una sola cosa:
// el cumplimiento de un hito. Si el verde apareciera también en montos o
// bordes, el tilde dejaría de saltar a la vista, que es lo único que tiene
// que hacer.
const C = {
  navy:         "#1a3a6b",
  navyTenue:    "#eef2f8",
  naranja:      "#F47B20",
  naranjaTenue: "#fdf1e6",
  ladrillo:     "#9e3b1b",
  ladrilloTenue:"#faece6",
  verde:        "#1f7a5c",
  gris:         "#8a94a6",
  grisTenue:    "#f4f6f9",
};

// Regla de clasificación del dinero. Está acá arriba, en un solo lugar, porque
// es la definición del negocio y no un detalle de pintura: si mañana cambia
// qué sub_estado cuenta como salvado, se cambia acá y las tarjetas, el filtro
// y los totales quedan consistentes solos.
function clasificar(c) {
  if (c.sub_estado === "NOT_BILLED") return "salvado";
  if (c.sub_estado === "BILLED") return "perdido";
  if (c.necesita_pruebas) return "riesgo";
  return "gestion";
}

const GRUPOS = [
  { clave: "riesgo",  etiqueta: "En riesgo", nota: "MELI espera pruebas",   color: C.naranja,  tinte: C.naranjaTenue },
  { clave: "gestion", etiqueta: "En gestión", nota: "esperando a MELI",     color: C.navy,     tinte: C.navyTenue },
  { clave: "salvado", etiqueta: "Salvado",   nota: "no nos lo cobraron",    color: C.verde,    tinte: "#e9f3ef" },
  { clave: "perdido", etiqueta: "Perdido",   nota: "cobrado por MELI",      color: C.ladrillo, tinte: C.ladrilloTenue },
];

const ESTADOS = { NEW: "Nuevo", IN_PROGRESS: "En curso", CLOSED: "Cerrado" };

// Etiquetas cortas: la columna es angosta y "Esperando comprobante" completo
// empujaba el resto de la fila. El texto largo queda en el detalle.
const SUBESTADOS = {
  WITHOUT_RECEIPT:  { corto: "Sin comprob.", largo: "Sin comprobante",       color: C.ladrillo },
  WAITING_RECEIPT:  { corto: "Esperando",    largo: "Esperando comprobante", color: C.naranja },
  UPLOADED_RECEIPT: { corto: "Subido",       largo: "Comprobante subido",    color: C.navy },
  ON_REVIEW:        { corto: "En revisión",  largo: "En revisión",           color: C.navy },
  ASSIGNED:         { corto: "Asignado",     largo: "Asignado",              color: C.navy },
  TO_BILL:          { corto: "Por cobrar",   largo: "Por cobrar",            color: C.naranja },
  BILLED:           { corto: "Cobrado",      largo: "Cobrado",               color: C.ladrillo },
  NOT_BILLED:       { corto: "No cobrado",   largo: "No cobrado",            color: C.verde },
};

// Línea de cumplimiento del caso, en el orden en que debería ocurrir. Las dos
// últimas llegan de la vista actualizada; si todavía no corriste el SQL vienen
// undefined y se pintan como pendientes, sin romper nada.
const HITOS = [
  { clave: "avisado_inicial_en",   etiqueta: "Aviso 1", titulo: "Primer aviso al conductor" },
  { clave: "avisado_24h_en",       etiqueta: "Aviso 2", titulo: "Escalamiento al supervisor (24 h)" },
  { clave: "avisado_final_en",     etiqueta: "Aviso 3", titulo: "Escalamiento al dueño (40 h)" },
  { clave: "pruebas_recibidas_en", etiqueta: "Pruebas", titulo: "El conductor entregó las pruebas" },
  { clave: "comprobante_en",       etiqueta: "Cargado", titulo: "Comprobante cargado en MELI" },
];

// Una sola plantilla de columnas para la cabecera y para las filas: así no
// hay forma de que se desalineen cuando cambie un ancho.
const GRID = "14px 84px 84px minmax(130px,1fr) 128px 104px 296px 78px";

function dinero(n) {
  if (n === null || n === undefined) return "—";
  return "$" + Number(n).toLocaleString("es-MX", { maximumFractionDigits: 0 });
}

function fechaHito(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("es-MX", {
    timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// El reloj sale de horas_restantes, que ya calcula la vista sobre las 48 h
// contadas desde fecha_caso. No se recalcula acá para que la pantalla y la
// base nunca digan cosas distintas.
function reloj(horas) {
  if (horas === null || horas === undefined) return { texto: "—", color: C.gris };
  if (horas <= 0) return { texto: `Vencido ${Math.abs(Math.round(horas))} h`, color: C.ladrillo };
  if (horas < 6)  return { texto: `${horas.toFixed(1)} h`, color: C.ladrillo };
  if (horas < 24) return { texto: `${Math.floor(horas)} h`, color: C.naranja };
  return { texto: `${Math.floor(horas)} h`, color: C.navy };
}

function Tarjeta({ grupo, monto, casos, activa, onClick }) {
  return (
    <button onClick={onClick} title={`Ver solo ${grupo.etiqueta.toLowerCase()}`}
      style={{
        flex: 1, minWidth: 178, textAlign: "left", cursor: "pointer",
        background: activa ? grupo.tinte : "#fff",
        border: `1px solid ${activa ? grupo.color : "var(--borde)"}`,
        borderTop: `3px solid ${grupo.color}`,
        borderRadius: 12, padding: "11px 14px",
        boxShadow: activa ? `inset 0 0 0 1px ${grupo.color}` : "none",
      }}>
      <div style={{ fontSize: 10.5, color: activa ? grupo.color : "var(--texto-suave)",
        letterSpacing: 0.3, textTransform: "uppercase", fontWeight: activa ? 700 : 500 }}>
        {grupo.etiqueta}
      </div>
      <div style={{ fontSize: 23, fontWeight: 600, color: "var(--texto)", lineHeight: 1.3 }}>
        {dinero(monto)}
      </div>
      <div style={{ fontSize: 11, color: "var(--texto-tenue)" }}>
        {casos} {casos === 1 ? "caso" : "casos"} · {grupo.nota}
      </div>
    </button>
  );
}

function Hito({ valor, titulo }) {
  const f = fechaHito(valor);
  return (
    <div title={titulo} style={{ textAlign: "center", lineHeight: 1.15, overflow: "hidden" }}>
      {f ? (
        <Fragment>
          <span style={{ color: C.verde, fontSize: 12, fontWeight: 700 }}>✓</span>
          <div style={{ fontSize: 8.5, color: "var(--texto-tenue)", whiteSpace: "nowrap" }}>{f}</div>
        </Fragment>
      ) : (
        <span style={{ color: "#cbd2dd", fontSize: 11 }}>○</span>
      )}
    </div>
  );
}

function Dato({ etiqueta, valor }) {
  return (
    <div style={{ minWidth: 118 }}>
      <div style={{ fontSize: 10, color: "var(--texto-tenue)", textTransform: "uppercase", letterSpacing: 0.3 }}>
        {etiqueta}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--texto)" }}>{valor || "—"}</div>
    </div>
  );
}

function Detalle({ c, onCopiar }) {
  const sinRuta = !c.conductor_ruta && !c.patente && !c.fecha_ruta;
  const sub = SUBESTADOS[c.sub_estado] || { largo: c.sub_estado };
  return (
    <div style={{ padding: "12px 16px 14px 44px", background: C.grisTenue, borderTop: "1px solid var(--borde)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 12 }}>
        <Dato etiqueta="Caso PNR" valor={c.case_id} />
        <Dato etiqueta="Guía" valor={c.shipment_id} />
        <Dato etiqueta="Ruta" valor={`${c.route_code || "—"} · ${c.route_id || "—"}`} />
        <Dato etiqueta="Centro" valor={c.service_center} />
        <Dato etiqueta="Nace" valor={c.cuando_mx} />
        <Dato etiqueta="Transcurrido" valor={c.horas_transcurridas != null ? `${Math.round(c.horas_transcurridas)} h` : null} />
        <Dato etiqueta="Estado MELI" valor={`${ESTADOS[c.estado] || c.estado} · ${sub.largo}`} />
        <Dato etiqueta="Periodo" valor={c.periodo} />
      </div>

      {/* Contexto de la ruta. Viene del cruce por route_id con la última
          captura histórica de rutas_monitoreo_mx; si no cruzó se dice, no se
          esconde: un caso sin ruta es justamente el que hay que ir a buscar
          a mano a Logistic. */}
      <div style={{ fontSize: 11, color: "var(--texto-suave)", fontWeight: 600, marginBottom: 6 }}>
        Contexto de la ruta
      </div>
      {sinRuta ? (
        <div style={{ fontSize: 12, color: "var(--texto-tenue)", marginBottom: 12 }}>
          Sin captura de la ruta {c.route_id || "—"} en el monitor. Hay que buscarla en Logistic.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 12 }}>
          <Dato etiqueta="Conductor de ruta" valor={c.conductor_ruta} />
          <Dato etiqueta="Placa" valor={c.patente} />
          <Dato etiqueta="Fecha de ruta" valor={c.fecha_ruta} />
          <Dato etiqueta="Estado" valor={c.estado_ruta} />
          <Dato etiqueta="Paquetes" valor={c.pkg_total != null ? `${c.pkg_delivered ?? 0} de ${c.pkg_total} · ${c.pkg_not_delivered ?? 0} no entregados` : null} />
        </div>
      )}

      {/* Los mismos hitos de la fila, acá con el nombre largo. */}
      <div style={{ fontSize: 11, color: "var(--texto-suave)", fontWeight: 600, marginBottom: 6 }}>
        Cumplimiento
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 12 }}>
        {HITOS.map((h) => (
          <Dato key={h.clave} etiqueta={h.titulo} valor={fechaHito(c[h.clave]) || "Pendiente"} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => onCopiar(String(c.case_id), "Caso copiado")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar caso</button>
        <button onClick={() => onCopiar(c.shipment_id, "Guía copiada")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar guía</button>
        <button onClick={() => onCopiar(c.route_code || "", "Ruta copiada")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar ruta</button>
        <button disabled title="Falta definir plantilla y tiempos de escalonamiento"
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Avisar al conductor</button>
      </div>
    </div>
  );
}

function Fila({ c, abierta, onAbrir, onCopiar }) {
  const r = reloj(c.horas_restantes);
  const sub = SUBESTADOS[c.sub_estado] || { corto: c.sub_estado, color: C.gris };
  return (
    <Fragment>
      <div onClick={onAbrir} style={{
        display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 10,
        padding: "8px 16px", borderTop: "1px solid var(--borde)", cursor: "pointer",
        background: abierta ? C.grisTenue : "#fff",
      }}>
        <span style={{ color: "var(--texto-tenue)", fontSize: 10 }}>{abierta ? "▾" : "▸"}</span>
        <span style={{ fontSize: 11.5, color: "var(--texto-suave)", fontVariantNumeric: "tabular-nums" }}>
          {c.case_id}
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: r.color, whiteSpace: "nowrap" }}>
          {r.texto}
        </span>
        <span style={{ minWidth: 0, fontSize: 13, color: "var(--texto)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.conductor || "Sin conductor"}
        </span>
        <span style={{ fontSize: 12, color: "var(--texto-suave)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {c.route_code} · {c.service_center}
        </span>
        <span style={{
          fontSize: 10.5, fontWeight: 600, color: sub.color, border: `1px solid ${sub.color}`,
          borderRadius: 20, padding: "1px 7px", textAlign: "center", whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>{sub.corto}</span>
        <span style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 2 }}>
          {HITOS.map((h) => <Hito key={h.clave} valor={c[h.clave]} titulo={h.titulo} />)}
        </span>
        <span style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
          {dinero(c.monto)}
        </span>
      </div>
      {abierta && <Detalle c={c} onCopiar={onCopiar} />}
    </Fragment>
  );
}

export default function Posventa() {
  const [vista, setVista] = useState("pnr");
  const [casos, setCasos] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [grupo, setGrupo] = useState("riesgo");
  const [periodo, setPeriodo] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [abierta, setAbierta] = useState(null);
  const [aviso, setAviso] = useState("");

  async function cargar() {
    setError(null);
    const { data, error: err } = await sb
      .from("vw_pnr_tablero")
      .select("*")
      .limit(5000);
    if (err) setError(err.message);
    else setCasos(data || []);
    setCargando(false);
  }

  useEffect(() => {
    cargar();
    // pnr-mx.cjs corre cada 5 min; refrescar cada 3 alcanza para no mirar
    // datos viejos sin castigar la base.
    const t = setInterval(cargar, 180000);
    return () => clearInterval(t);
  }, []);

  const periodos = useMemo(() => {
    const s = [...new Set(casos.map((c) => c.periodo).filter(Boolean))];
    return s.sort().reverse();
  }, [casos]);

  // Si todavía no se eligió periodo, se toma el más nuevo apenas llegan datos.
  useEffect(() => {
    if (!periodo && periodos.length) setPeriodo(periodos[0]);
  }, [periodos, periodo]);

  const delPeriodo = useMemo(
    () => casos.filter((c) => !periodo || c.periodo === periodo),
    [casos, periodo]
  );

  const totales = useMemo(() => {
    const t = { riesgo: { monto: 0, n: 0 }, gestion: { monto: 0, n: 0 },
                salvado: { monto: 0, n: 0 }, perdido: { monto: 0, n: 0 } };
    for (const c of delPeriodo) {
      const k = clasificar(c);
      t[k].monto += Number(c.monto || 0);
      t[k].n += 1;
    }
    return t;
  }, [delPeriodo]);

  const buscando = busqueda.trim().length > 0;

  // La búsqueda ignora periodo y tarjeta a propósito: cuando alguien pega un
  // número de caso quiere ese caso, no "ese caso si además está en la
  // quincena y el grupo que tenía abiertos".
  const lista = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const base = buscando
      ? casos.filter((c) =>
          [c.case_id, c.shipment_id, c.route_code, c.route_id, c.conductor, c.service_center, c.patente]
            .some((v) => String(v || "").toLowerCase().includes(q)))
      : delPeriodo.filter((c) => grupo === "todos" || clasificar(c) === grupo);

    // Orden: primero lo que todavía tiene reloj, del que vence antes al que
    // vence después. Los vencidos van abajo por monto, porque una vez que el
    // SLA pasó el reloj ya no distingue nada y lo que decide a cuál ir primero
    // es cuánta plata hay adentro.
    return base.slice().sort((a, b) => {
      const va = (a.horas_restantes ?? -9999) > 0;
      const vb = (b.horas_restantes ?? -9999) > 0;
      if (va !== vb) return va ? -1 : 1;
      if (va) return (a.horas_restantes ?? 0) - (b.horas_restantes ?? 0);
      return Number(b.monto || 0) - Number(a.monto || 0);
    });
  }, [casos, delPeriodo, grupo, busqueda, buscando]);

  function copiar(texto, mensaje) {
    navigator.clipboard.writeText(texto || "");
    setAviso(mensaje);
    setTimeout(() => setAviso(""), 1600);
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "16px 20px", background: "var(--fondo, #f4f6f9)" }}>
      {/* Encabezado */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.navy }}>Posventa</h2>
        <div style={{ display: "flex", gap: 4 }}>
          {VISTAS.map((v) => (
            <button key={v.clave} onClick={() => v.activa && setVista(v.clave)} disabled={!v.activa}
              title={v.activa ? "" : "Todavía no disponible"}
              style={{
                fontSize: 12.5, padding: "5px 12px", borderRadius: 7,
                cursor: v.activa ? "pointer" : "default",
                border: "1px solid " + (vista === v.clave ? C.navy : "var(--borde)"),
                background: vista === v.clave ? C.navy : "#fff",
                color: vista === v.clave ? "#fff" : v.activa ? "var(--texto)" : "var(--texto-tenue)",
              }}>
              {v.etiqueta}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {aviso && <span style={{ fontSize: 11.5, color: C.verde }}>{aviso}</span>}
          <input value={busqueda} onChange={(e) => { setBusqueda(e.target.value); setAbierta(null); }}
            placeholder="Buscar caso, guía, ruta o conductor"
            style={{ fontSize: 12.5, padding: "5px 10px", borderRadius: 7,
              border: "1px solid var(--borde)", width: 250 }} />
          {buscando && (
            <button onClick={() => setBusqueda("")} style={{ fontSize: 11.5, padding: "5px 9px" }}>Limpiar</button>
          )}
          <select value={periodo} onChange={(e) => setPeriodo(e.target.value)} disabled={buscando}
            title={buscando ? "La búsqueda recorre todos los periodos" : ""}
            style={{ fontSize: 12.5, padding: "4px 8px", borderRadius: 7, border: "1px solid var(--borde)" }}>
            {periodos.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={cargar} style={{ fontSize: 11.5, padding: "5px 11px" }}>Actualizar</button>
        </div>
      </div>

      {error && (
        <div style={{ background: C.ladrilloTenue, border: `1px solid ${C.ladrillo}`, color: C.ladrillo,
          borderRadius: 10, padding: "10px 14px", fontSize: 12.5, marginBottom: 14 }}>
          No se pudo leer vw_pnr_tablero: {error}
        </div>
      )}

      {/* Las tarjetas son el filtro. Un tablero de plata donde el número y el
          botón que lo abre son la misma cosa: se toca el monto que interesa y
          la lista de abajo queda con esos casos. */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        {GRUPOS.map((g) => (
          <Tarjeta key={g.clave} grupo={g} monto={totales[g.clave].monto} casos={totales[g.clave].n}
            activa={!buscando && grupo === g.clave}
            onClick={() => { setBusqueda(""); setGrupo(g.clave); setAbierta(null); }} />
        ))}
      </div>

      {/* Lista */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12, overflow: "hidden", marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
            {buscando ? "Resultados" : (GRUPOS.find((g) => g.clave === grupo) || {}).etiqueta || "Todos"}
          </span>
          <button onClick={() => { setBusqueda(""); setGrupo("todos"); setAbierta(null); }}
            style={{
              fontSize: 11.5, padding: "4px 10px", borderRadius: 20, cursor: "pointer",
              border: "1px solid " + (!buscando && grupo === "todos" ? C.navy : "var(--borde)"),
              background: !buscando && grupo === "todos" ? C.navyTenue : "#fff",
              color: !buscando && grupo === "todos" ? C.navy : "var(--texto-suave)",
              fontWeight: !buscando && grupo === "todos" ? 600 : 400,
            }}>
            Todos
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--texto-tenue)" }}>
            {lista.length} en pantalla · {buscando ? "todos los periodos" : "por vencer primero, después por monto"}
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 1060 }}>
            {/* Cabecera de columnas: sin esto los cinco tildes no se sabe qué
                marcan. Usa la misma plantilla de grid que las filas. */}
            <div style={{
              display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "6px 16px",
              borderTop: "1px solid var(--borde)", background: C.grisTenue,
              fontSize: 9.5, letterSpacing: 0.3, textTransform: "uppercase",
              color: "var(--texto-tenue)", fontWeight: 600,
            }}>
              <span />
              <span>Caso</span>
              <span>SLA 48 h</span>
              <span>Conductor</span>
              <span>Ruta · centro</span>
              <span style={{ textAlign: "center" }}>Estado</span>
              <span style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 2 }}>
                {HITOS.map((h) => (
                  <span key={h.clave} title={h.titulo} style={{ textAlign: "center" }}>{h.etiqueta}</span>
                ))}
              </span>
              <span style={{ textAlign: "right" }}>Monto</span>
            </div>

            {cargando ? (
              <div style={{ padding: 28, textAlign: "center", color: "var(--texto-suave)", fontSize: 13, borderTop: "1px solid var(--borde)" }}>
                Cargando casos…
              </div>
            ) : lista.length === 0 ? (
              <div style={{ padding: 28, textAlign: "center", color: "var(--texto-suave)", fontSize: 13, borderTop: "1px solid var(--borde)" }}>
                {buscando ? `Ningún caso coincide con "${busqueda.trim()}".` : "Nada acá. Probá con otra tarjeta o con otro periodo."}
              </div>
            ) : (
              lista.map((c) => (
                <Fila key={c.case_id} c={c} abierta={abierta === c.case_id}
                  onAbrir={() => setAbierta(abierta === c.case_id ? null : c.case_id)}
                  onCopiar={copiar} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
