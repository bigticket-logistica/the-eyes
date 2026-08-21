import { Fragment, useState, useEffect, useMemo } from "react";
import { sb } from "../shared/supabase.js";

// ── Posventa ───────────────────────────────────────────────────────────────
// Hoy solo PNR; las devoluciones entran después como una segunda vista del
// mismo módulo. Lee vw_pnr_tablero completa (154 filas hoy, unos pocos miles
// en el peor caso) y agrega en el cliente: una consulta por carga en vez de
// tres RPC de totales que después habría que mantener sincronizadas a mano
// con la misma regla de clasificación.

const VISTAS = [
  { clave: "pnr",          etiqueta: "PNR",          activa: true  },
  { clave: "devoluciones", etiqueta: "Devoluciones", activa: false },
];

// Regla de clasificación del dinero. Está acá arriba, en un solo lugar, porque
// es la definición del negocio y no un detalle de pintura: si mañana cambia
// qué sub_estado cuenta como salvado, se cambia acá y las tarjetas, los
// filtros y el orden quedan consistentes solos.
//   riesgo  → todavía se puede pelear, y MELI espera pruebas
//   gestion → pruebas ya entregadas, esperando resolución de MELI
//   salvado → no nos lo cobraron
//   perdido → nos lo cobraron
function clasificar(c) {
  if (c.sub_estado === "NOT_BILLED") return "salvado";
  if (c.sub_estado === "BILLED") return "perdido";
  if (c.necesita_pruebas) return "riesgo";
  return "gestion";
}

const ESTADOS = { NEW: "Nuevo", IN_PROGRESS: "En curso", CLOSED: "Cerrado" };

const SUBESTADOS = {
  WITHOUT_RECEIPT:  { texto: "Sin comprobante",       color: "#c0392b" },
  WAITING_RECEIPT:  { texto: "Esperando comprobante", color: "var(--naranja)" },
  UPLOADED_RECEIPT: { texto: "Comprobante subido",    color: "#2f6fb5" },
  ON_REVIEW:        { texto: "En revisión",           color: "#2f6fb5" },
  ASSIGNED:         { texto: "Asignado",              color: "#2f6fb5" },
  TO_BILL:          { texto: "Por cobrar",            color: "var(--naranja)" },
  BILLED:           { texto: "Cobrado",               color: "#c0392b" },
  NOT_BILLED:       { texto: "No cobrado",            color: "#2f9e6b" },
};

const FILTROS = [
  { clave: "riesgo",   etiqueta: "Necesitan pruebas" },
  { clave: "gestion",  etiqueta: "En gestión" },
  { clave: "cerrados", etiqueta: "Cerrados" },
  { clave: "todos",    etiqueta: "Todos" },
];

function dinero(n) {
  if (n === null || n === undefined) return "—";
  return "$" + Number(n).toLocaleString("es-MX", { maximumFractionDigits: 0 });
}

function horaCorta(iso) {
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
  if (horas === null || horas === undefined) return { texto: "—", color: "var(--texto-tenue)" };
  if (horas <= 0) return { texto: `Vencido ${Math.abs(Math.round(horas))} h`, color: "#c0392b" };
  if (horas < 6)  return { texto: `${horas.toFixed(1)} h`, color: "#c0392b" };
  if (horas < 24) return { texto: `${Math.floor(horas)} h`, color: "var(--naranja)" };
  return { texto: `${Math.floor(horas)} h`, color: "#2f9e6b" };
}

function TarjetaDinero({ etiqueta, monto, casos, color, nota }) {
  return (
    <div style={{
      flex: 1, minWidth: 190, background: "#fff", border: "1px solid var(--borde)",
      borderRadius: 12, borderTop: `3px solid ${color}`, padding: "12px 14px",
    }}>
      <div style={{ fontSize: 11, color: "var(--texto-suave)", letterSpacing: 0.3, textTransform: "uppercase" }}>
        {etiqueta}
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, color: "var(--texto)", lineHeight: 1.3 }}>
        {dinero(monto)}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--texto-tenue)" }}>
        {casos} {casos === 1 ? "caso" : "casos"} · {nota}
      </div>
    </div>
  );
}

function Chip({ texto, color }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, color, border: `1px solid ${color}`,
      borderRadius: 20, padding: "1px 8px", whiteSpace: "nowrap",
    }}>{texto}</span>
  );
}

function Dato({ etiqueta, valor }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 10, color: "var(--texto-tenue)", textTransform: "uppercase", letterSpacing: 0.3 }}>
        {etiqueta}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--texto)" }}>{valor || "—"}</div>
    </div>
  );
}

function Detalle({ c, onCopiar }) {
  const sinRuta = !c.conductor_ruta && !c.patente && !c.fecha_ruta;
  return (
    <div style={{ padding: "12px 16px 14px 44px", background: "#fafbfd", borderTop: "1px solid var(--borde)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 12 }}>
        <Dato etiqueta="Caso" valor={c.case_id} />
        <Dato etiqueta="Guía" valor={c.shipment_id} />
        <Dato etiqueta="Ruta" valor={`${c.route_code || "—"} · ${c.route_id || "—"}`} />
        <Dato etiqueta="Centro" valor={c.service_center} />
        <Dato etiqueta="Nace" valor={c.cuando_mx} />
        <Dato etiqueta="Transcurrido" valor={c.horas_transcurridas != null ? `${Math.round(c.horas_transcurridas)} h` : null} />
        <Dato etiqueta="Estado MELI" valor={`${ESTADOS[c.estado] || c.estado} · ${(SUBESTADOS[c.sub_estado] || {}).texto || c.sub_estado}`} />
        <Dato etiqueta="Periodo" valor={c.periodo} />
      </div>

      {/* Contexto de la ruta. Viene del cruce por route_id con
          rutas_monitoreo_mx dentro de la vista; si no cruzó se dice, no se
          esconde: un caso sin ruta es justamente el que hay que ir a buscar
          a mano. */}
      <div style={{ fontSize: 11, color: "var(--texto-suave)", fontWeight: 600, marginBottom: 6 }}>
        Contexto de la ruta
      </div>
      {sinRuta ? (
        <div style={{ fontSize: 12, color: "var(--texto-tenue)", marginBottom: 12 }}>
          Sin cruce con rutas_monitoreo_mx para el route_id {c.route_id || "—"}.
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

      {/* Avisos. Solo lectura hasta que estén cerradas las tres decisiones del
          escalonamiento: espera inicial, plantilla y saltos 24 h / 40 h. */}
      <div style={{ fontSize: 11, color: "var(--texto-suave)", fontWeight: 600, marginBottom: 6 }}>
        Avisos
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 12 }}>
        <Dato etiqueta="Conductor" valor={horaCorta(c.avisado_inicial_en) || "Sin avisar"} />
        <Dato etiqueta="Supervisor (24 h)" valor={horaCorta(c.avisado_24h_en) || "Sin avisar"} />
        <Dato etiqueta="Dueño (40 h)" valor={horaCorta(c.avisado_final_en) || "Sin avisar"} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => onCopiar(c.shipment_id, "Guía copiada")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar guía</button>
        <button onClick={() => onCopiar(String(c.case_id), "Caso copiado")}
          style={{ fontSize: 11.5, padding: "5px 11px" }}>Copiar caso</button>
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
  const sub = SUBESTADOS[c.sub_estado] || { texto: c.sub_estado, color: "var(--texto-tenue)" };
  return (
    <Fragment>
      <div onClick={onAbrir} style={{
        display: "flex", alignItems: "center", gap: 12, padding: "9px 16px",
        borderTop: "1px solid var(--borde)", cursor: "pointer",
        background: abierta ? "#fafbfd" : "#fff",
      }}>
        <span style={{ width: 14, color: "var(--texto-tenue)", fontSize: 10 }}>{abierta ? "▾" : "▸"}</span>
        <span style={{ width: 92, fontSize: 12, fontWeight: 600, color: r.color, whiteSpace: "nowrap" }}>
          {r.texto}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: "var(--texto)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.conductor || "Sin conductor"}
        </span>
        <span style={{ width: 150, fontSize: 12, color: "var(--texto-suave)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {c.route_code} · {c.service_center}
        </span>
        <span style={{ width: 96, fontSize: 12, color: "var(--texto-tenue)", whiteSpace: "nowrap" }}>
          {c.cuando_mx}
        </span>
        <span style={{ width: 150, textAlign: "right" }}><Chip texto={sub.texto} color={sub.color} /></span>
        <span style={{ width: 78, textAlign: "right", fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>
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
  const [filtro, setFiltro] = useState("riesgo");
  const [periodo, setPeriodo] = useState("");
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
    const t = {
      riesgo:  { monto: 0, n: 0 },
      gestion: { monto: 0, n: 0 },
      salvado: { monto: 0, n: 0 },
      perdido: { monto: 0, n: 0 },
    };
    for (const c of delPeriodo) {
      const k = clasificar(c);
      t[k].monto += Number(c.monto || 0);
      t[k].n += 1;
    }
    return t;
  }, [delPeriodo]);

  // Orden: primero lo que todavía tiene reloj, del que vence antes al que
  // vence después. Los vencidos van abajo ordenados por monto, porque una vez
  // que el SLA pasó el reloj ya no distingue nada y lo que decide a cuál ir
  // primero es cuánta plata hay adentro.
  const lista = useMemo(() => {
    const filtrada = delPeriodo.filter((c) => {
      if (filtro === "todos") return true;
      if (filtro === "cerrados") return c.cerrado;
      return clasificar(c) === filtro && !c.cerrado;
    });
    return filtrada.slice().sort((a, b) => {
      const va = (a.horas_restantes ?? -9999) > 0;
      const vb = (b.horas_restantes ?? -9999) > 0;
      if (va !== vb) return va ? -1 : 1;
      if (va) return (a.horas_restantes ?? 0) - (b.horas_restantes ?? 0);
      return Number(b.monto || 0) - Number(a.monto || 0);
    });
  }, [delPeriodo, filtro]);

  function copiar(texto, mensaje) {
    navigator.clipboard.writeText(texto || "");
    setAviso(mensaje);
    setTimeout(() => setAviso(""), 1600);
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "16px 20px", background: "var(--fondo, #f4f6f9)" }}>
      {/* Encabezado */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: "var(--navy)" }}>Posventa</h2>
        <div style={{ display: "flex", gap: 4 }}>
          {VISTAS.map((v) => (
            <button key={v.clave} onClick={() => v.activa && setVista(v.clave)} disabled={!v.activa}
              title={v.activa ? "" : "Todavía no disponible"}
              style={{
                fontSize: 12.5, padding: "5px 12px", borderRadius: 7,
                cursor: v.activa ? "pointer" : "default",
                border: "1px solid " + (vista === v.clave ? "var(--navy)" : "var(--borde)"),
                background: vista === v.clave ? "var(--navy)" : "#fff",
                color: vista === v.clave ? "#fff" : v.activa ? "var(--texto)" : "var(--texto-tenue)",
              }}>
              {v.etiqueta}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {aviso && <span style={{ fontSize: 11.5, color: "#2f9e6b" }}>{aviso}</span>}
          <select value={periodo} onChange={(e) => setPeriodo(e.target.value)}
            style={{ fontSize: 12.5, padding: "4px 8px", borderRadius: 7, border: "1px solid var(--borde)" }}>
            {periodos.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={cargar} style={{ fontSize: 11.5, padding: "5px 11px" }}>Actualizar</button>
        </div>
      </div>

      {error && (
        <div style={{ background: "#fdeaea", border: "1px solid #f3b9b9", color: "#8c2b2b",
          borderRadius: 10, padding: "10px 14px", fontSize: 12.5, marginBottom: 14 }}>
          No se pudo leer vw_pnr_tablero: {error}
        </div>
      )}

      {/* Las tres tarjetas de dinero, en el orden del recorrido de un caso:
          lo que todavía se puede pelear, lo que ya se ganó, lo que se fue. */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <TarjetaDinero etiqueta="En riesgo" monto={totales.riesgo.monto} casos={totales.riesgo.n}
          color="var(--naranja)" nota="MELI espera pruebas" />
        <TarjetaDinero etiqueta="Salvado" monto={totales.salvado.monto} casos={totales.salvado.n}
          color="#2f9e6b" nota="no nos lo cobraron" />
        <TarjetaDinero etiqueta="Perdido" monto={totales.perdido.monto} casos={totales.perdido.n}
          color="#c0392b" nota="cobrado por MELI" />
      </div>
      <div style={{ fontSize: 11.5, color: "var(--texto-tenue)", marginBottom: 16 }}>
        Además {totales.gestion.n} casos en gestión por {dinero(totales.gestion.monto)}: pruebas
        entregadas, esperando resolución de MELI.
      </div>

      {/* Lista */}
      <div style={{ background: "#fff", border: "1px solid var(--borde)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--texto)" }}>Casos</span>
          <div style={{ display: "flex", gap: 4 }}>
            {FILTROS.map((f) => (
              <button key={f.clave} onClick={() => { setFiltro(f.clave); setAbierta(null); }}
                style={{
                  fontSize: 11.5, padding: "4px 10px", borderRadius: 20,
                  border: "1px solid " + (filtro === f.clave ? "var(--naranja)" : "var(--borde)"),
                  background: filtro === f.clave ? "var(--naranja-suave)" : "#fff",
                  color: filtro === f.clave ? "var(--naranja)" : "var(--texto-suave)",
                  fontWeight: filtro === f.clave ? 600 : 400, cursor: "pointer",
                }}>
                {f.etiqueta}
              </button>
            ))}
          </div>
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--texto-tenue)" }}>
            {lista.length} en pantalla · por vencer primero, después por monto
          </span>
        </div>

        {cargando ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--texto-suave)", fontSize: 13, borderTop: "1px solid var(--borde)" }}>
            Cargando casos…
          </div>
        ) : lista.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--texto-suave)", fontSize: 13, borderTop: "1px solid var(--borde)" }}>
            Nada acá. Probá con otro filtro o con otro periodo.
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
  );
}
