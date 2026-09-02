import { useState, useEffect, useCallback, useMemo } from "react";
import { sb } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// TABLERO DE CONTROL · PNR
//
// Tres bloques, en el orden en que se leen:
//
//   1  PNR y montos. Cuántos hay, cuántos se ganaron, cuántos se cobran, y la
//      plata asociada. General y por centro.
//   2  Tareas por supervisor. Los dos SLA que le corresponden, las reaperturas
//      y los dos tiempos de respuesta.
//   3  Evidencia. Con prueba cargada contra respondido sin prueba, y qué pasó
//      con cada grupo ante MELI.
//
// LOS NÚMEROS NO SE CALCULAN ACÁ
//   Vienen de fn_pnr_bloque1, 2 y 3. Si el front sumara, el CSV diría otra cosa
//   y nadie sabría cuál de los dos creer. Y los porcentajes son el caso peor:
//   el promedio de porcentajes no es el porcentaje del total, así que un total
//   sumado en el cliente sale mal por definición.
//
// EL CSV Y NO XLSX
//   El analista lo abre, lo modifica y lo manda. Un xlsx formateado se ve mejor
//   la primera vez y estorba a partir de la segunda.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  navy: "#1a3a6b", navyTenue: "#eef2f8",
  naranja: "#F47B20", naranjaTenue: "#fdf1e6",
  ladrillo: "#9e3b1b", ladrilloTenue: "#faece6",
  verde: "#1f7a5c", verdeTenue: "#eaf5f1",
  gris: "#8a94a6", grisTenue: "#f4f6f9",
};

function hoyMX() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

function haceDiasMX(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

const dinero = (n) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("es-MX", { maximumFractionDigits: 0 });

const num = (n) => (n == null ? "—" : Number(n).toLocaleString("es-MX"));

// Porcentaje con su sentido: verde si cumple, ladrillo si no. El umbral no es
// una opinión de diseño — es el 80% que gerencia pide.
const META_PCT = 80;

function Pct({ v, invertir }) {
  if (v == null) {
    return <span style={{ color: C.gris, fontSize: 11 }}>sin datos</span>;
  }
  const bien = invertir ? Number(v) <= 100 - META_PCT : Number(v) >= META_PCT;
  return (
    <span style={{ fontWeight: 700, color: bien ? C.verde : C.ladrillo }}>
      {Number(v).toFixed(1)}%
    </span>
  );
}

// El plazo del supervisor. Está acá y también en pnr_sla_config: el front lo usa
// para pintar, la base para calcular. Si gerencia lo mueve hay que cambiarlo en
// los dos lados.
const SLA_SUPERVISOR = 40;

// Horas promedio con su tope a la vista.
//
// Antes se mostraba el número solo — "34,1" — y no decía contra qué se compara.
// Con el tope al lado se lee de una: 34 de 40 va apretado, 45 de 40 se pasó.
//
// El paréntesis es el denominador. Un promedio de tres casos y uno de doce se
// veían idénticos, y el de tres se mueve entero con un caso raro.
function Horas({ v, n }) {
  if (v == null) return <span style={{ color: C.gris }}>—</span>;
  const pasado = Number(v) > SLA_SUPERVISOR;
  return (
    <span title={pasado
        ? `Se pasa del plazo de ${SLA_SUPERVISOR} h por ${(Number(v) - SLA_SUPERVISOR).toFixed(1)} h en promedio`
        : `Dentro del plazo de ${SLA_SUPERVISOR} h`}>
      <span style={{ fontWeight: pasado ? 700 : 500, color: pasado ? C.ladrillo : "inherit" }}>
        {v}
      </span>
      <span style={{ color: C.gris, fontSize: 10 }}> /{SLA_SUPERVISOR}</span>
      <span style={{ color: C.gris, fontSize: 10 }}> ({n})</span>
    </span>
  );
}

// ── Una cifra grande ───────────────────────────────────────────────────────

function Cifra({ etiqueta, valor, nota, color = C.navy, tinte = "#fff" }) {
  return (
    <div style={{ flex: "1 1 140px", minWidth: 130, padding: "10px 13px",
      borderRadius: 10, background: tinte, border: `1px solid ${color}22` }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
        textTransform: "uppercase", color: C.gris }}>
        {etiqueta}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1.15,
        fontVariantNumeric: "tabular-nums" }}>
        {valor}
      </div>
      {nota && (
        <div style={{ fontSize: 10, color: C.gris, marginTop: 1 }}>{nota}</div>
      )}
    </div>
  );
}

// ── Envoltorio de bloque ───────────────────────────────────────────────────

function Bloque({ n, titulo, subtitulo, children }) {
  return (
    <div style={{ border: "1px solid var(--borde)", borderRadius: 14,
      background: "#fff", marginBottom: 16, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9,
        padding: "11px 16px", background: C.navyTenue,
        borderBottom: "1px solid var(--borde)" }}>
        <span style={{ display: "inline-flex", alignItems: "center",
          justifyContent: "center", width: 22, height: 22, borderRadius: "50%",
          background: C.navy, color: "#fff", fontSize: 12, fontWeight: 700 }}>
          {n}
        </span>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: C.navy }}>{titulo}</span>
        {subtitulo && (
          <span style={{ fontSize: 11.5, color: C.gris }}>{subtitulo}</span>
        )}
      </div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

// ── Tabla ──────────────────────────────────────────────────────────────────
// La fila TOTAL viene de la base, no sumada acá, y se pinta distinto para que no
// se confunda con un centro más.
//
// ORDENAR POR COLUMNA
//   Se ordena en el cliente y sobre el valor CRUDO de la fila, nunca sobre el
//   texto pintado: "$1,809" comparado como texto deja $9,988 arriba de $19,733.
//
//   La fila TOTAL queda fija arriba, fuera del orden. Es el resumen del rango,
//   no un centro más; si entrara al sort saldría siempre primera o última y se
//   leería como un centro gigante.
//
//   Primer clic en una columna de números: de mayor a menor. Cuando alguien
//   ordena por plata quiere ver quién pierde más, no quién pierde menos. En las
//   columnas de texto el primer clic es alfabético. El segundo clic invierte.
//
//   Los nulos van al final en las dos direcciones: un centro sin dato no es ni
//   el mejor ni el peor, y arriba desplazaría a los que sí tienen número.
//
//   Ordenar no vuelve a pedir datos: los montos ya están en la fila, así que el
//   sort es local y no gasta una llamada a la base.

function Tabla({ columnas, filas, claveFila, ordenInicial = null }) {
  // { clave, asc } o null para respetar el orden que devuelve la base.
  const [orden, setOrden] = useState(ordenInicial);

  function alOrdenar(col) {
    if (col.ordenable === false) return;
    setOrden((prev) =>
      prev && prev.clave === col.clave
        ? { clave: col.clave, asc: !prev.asc }
        // Números arrancan descendente, texto ascendente.
        : { clave: col.clave, asc: !col.derecha });
  }

  const ordenadas = useMemo(() => {
    const totales = filas.filter((f) => f.es_total);
    const resto = filas.filter((f) => !f.es_total);
    if (!orden) return [...totales, ...resto];

    const col = columnas.find((c) => c.clave === orden.clave);
    // Las columnas alineadas a la derecha son las numéricas. Se comparan como
    // número aunque la base las mande como string.
    const numerica = !!col?.derecha;
    const signo = orden.asc ? 1 : -1;

    const valor = (f) => {
      const v = f[orden.clave];
      if (v == null || v === "") return null;
      if (!numerica) return String(v);
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const ordenado = [...resto].sort((a, b) => {
      const va = valor(a);
      const vb = valor(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return signo * (numerica ? va - vb : va.localeCompare(vb, "es"));
    });

    return [...totales, ...ordenado];
  }, [filas, columnas, orden]);

  if (!filas.length) {
    return <div style={{ fontSize: 12, color: C.gris, padding: 8 }}>Sin datos en el rango.</div>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {columnas.map((col) => {
              const activa = orden?.clave === col.clave;
              const sePuedeOrdenar = col.ordenable !== false;
              return (
              <th key={col.clave}
                onClick={() => alOrdenar(col)}
                aria-sort={activa ? (orden.asc ? "ascending" : "descending") : "none"}
                style={{
                  textAlign: col.derecha ? "right" : "left",
                  padding: "6px 8px", borderBottom: `1px solid ${C.navy}33`,
                  fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
                  textTransform: "uppercase",
                  color: activa ? C.navy : C.gris, whiteSpace: "nowrap",
                  cursor: sePuedeOrdenar ? "pointer" : "default",
                  userSelect: "none",
                }}>
                {col.titulo}
                {/* La flecha del orden va pegada al título. En la columna activa
                    es sólida y navy; en las demás queda un ↕ apenas visible que
                    avisa que la columna se puede ordenar sin ensuciar la
                    cabecera. */}
                {sePuedeOrdenar && (
                  <span style={{ marginLeft: 3, fontSize: 8.5,
                    color: activa ? C.navy : `${C.gris}55` }}>
                    {activa ? (orden.asc ? "▲" : "▼") : "↕"}
                  </span>
                )}
                {/* La (i) va en la CABECERA y no en un pie de tabla: la duda
                    aparece mirando la columna, y un texto al final obliga a
                    bajar, leer y volver a subir para saber qué se estaba
                    mirando. Es title nativo y no un tooltip propio porque no
                    hay que descubrirlo: el cursor de ayuda ya lo anuncia.
                    El clic en la (i) no ordena: se va a leer, no a reordenar. */}
                {col.ayuda && (
                  <span title={col.ayuda}
                    onClick={(e) => e.stopPropagation()}
                    style={{ display: "inline-block", marginLeft: 4, width: 12, height: 12,
                      borderRadius: "50%", border: `1px solid ${C.gris}`, color: C.gris,
                      fontSize: 8.5, lineHeight: "11px", textAlign: "center",
                      cursor: "help", fontWeight: 700, verticalAlign: "middle" }}>
                    i
                  </span>
                )}
              </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordenadas.map((f, i) => {
            const total = !!f.es_total;
            return (
              <tr key={claveFila(f, i)} style={{
                background: total ? C.navyTenue : i % 2 ? C.grisTenue : "#fff",
                fontWeight: total ? 700 : 400,
              }}>
                {columnas.map((col) => (
                  <td key={col.clave} style={{
                    padding: "6px 8px", borderBottom: "1px solid var(--borde)",
                    textAlign: col.derecha ? "right" : "left",
                    fontVariantNumeric: col.derecha ? "tabular-nums" : "normal",
                    whiteSpace: "nowrap",
                  }}>
                    {col.pinta ? col.pinta(f) : f[col.clave]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Módulo ─────────────────────────────────────────────────────────────────

export default function TableroControl() {
  // Últimos 30 días por defecto. No el periodo de MELI: ese sirve para cuadrar
  // contra el portal, y este tablero es de gestión — un rango móvil deja ver si
  // la semana viene mejor o peor que la anterior, cosa que un periodo cerrado
  // no muestra hasta que termina.
  const [desde, setDesde] = useState(() => haceDiasMX(30));
  const [hasta, setHasta] = useState(() => hoyMX());

  const [b1, setB1] = useState([]);
  const [b2, setB2] = useState([]);
  const [b3, setB3] = useState([]);
  const [alertas, setAlertas] = useState([]);
  const [verCierre, setVerCierre] = useState(false);
  const [cerrando, setCerrando] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [bajando, setBajando] = useState(false);

  // Quincenas disponibles para el informe con formato del portal. Vienen de la
  // base, no se calculan: solo se puede emitir el informe de una quincena que
  // realmente tengamos capturada.
  const [periodos, setPeriodos] = useState([]);
  // cargando · listo · error. Sin esto, cuando la RPC falla el selector se
  // queda diciendo "cargando…" para siempre y parece que el front está colgado.
  const [periodosEstado, setPeriodosEstado] = useState("cargando");
  const [periodoSel, setPeriodoSel] = useState("");
  const [bajandoReporte, setBajandoReporte] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    const args = { p_desde: desde, p_hasta: hasta };
    const [r1, r2, r3, ra] = await Promise.all([
      sb.rpc("fn_pnr_bloque1", args),
      sb.rpc("fn_pnr_bloque2", args),
      sb.rpc("fn_pnr_bloque3", args),
      sb.from("vw_pnr_sla_alertas").select("*"),
    ]);
    const malo = r1.error || r2.error || r3.error;
    if (malo) setError(malo.message);
    setB1(r1.data || []);
    setB2(r2.data || []);
    setB3(r3.data || []);
    setAlertas(ra.error ? [] : (ra.data || []));
    setCargando(false);
  }, [desde, hasta]);

  useEffect(() => { cargar(); }, [cargar]);

  // ── Las quincenas disponibles ────────────────────────────────────────────
  // Se piden una sola vez. La quincena en curso llega marcada y no se puede
  // descargar: mientras está abierta MELI sigue moviendo casos dentro y fuera,
  // así que un informe emitido hoy no es el mismo que mañana. Se emite cerrada.
  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data, error: e } = await sb.rpc("fn_pnr_periodos");
      if (!vivo) return;
      if (e) {
        // El error se muestra. Un selector vacío sin explicación manda a alguien
        // a revisar el navegador cuando el problema está en la base.
        setPeriodosEstado("error");
        setError(`No se pudieron cargar las quincenas: ${e.message}`);
        return;
      }
      const lista = data || [];
      setPeriodos(lista);
      setPeriodosEstado("listo");
      const cerrada = lista.find((p) => !p.es_vigente);
      if (cerrada) setPeriodoSel(cerrada.periodo);
    })();
    return () => { vivo = false; };
  }, []);

  // ── Calcular el cierre de un mes ─────────────────────────────────────────
  // fn_pnr_cerrar_mes escribe: reconstruye las tareas del mes y actualiza su
  // estado. Un mes ya definitivo lo protege la propia función y no se toca.
  async function cerrarMes(mes) {
    setCerrando(mes);
    setError(null);
    try {
      const { data, error: e } = await sb.rpc("fn_pnr_cerrar_mes", { p_mes: mes });
      if (e) throw new Error(e.message);
      const r = data || {};
      // El resultado se dice en la barra de mensajes: sin esto el botón parece
      // no haber hecho nada, porque el cambio queda dentro de la fila plegada.
      setError(`Cierre de ${mes}: ${r.estado || "?"}`
        + (r.tareas != null ? ` · ${r.tareas} tarea(s)` : "")
        + (r.pct != null ? ` · ${r.pct}% cumplido` : ""));
      await cargar();
    } catch (e) {
      setError(`No se pudo calcular ${mes}: ${e.message}`);
    } finally {
      setCerrando(null);
    }
  }

  // ── Bajar un archivo ─────────────────────────────────────────────────────
  // Las dos descargas de la pantalla comparten esto. Estaba duplicado y el CSV
  // del rango y el del informe habían quedado con reglas distintas de escape.
  //
  // Punto y coma como separador y BOM al inicio: Excel en español lee la coma
  // como decimal, así que con comas de separador mete todo en una columna, y
  // sin el BOM los acentos salen rotos.
  function bajarBlob(contenido, tipo, nombre) {
    const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
    const a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(url);
  }

  function filasACsv(filas, cols) {
    // Los números salen con coma decimal. Excel en español lee el punto como
    // separador de miles, así que 725.00 le queda como 72500 y el analista suma
    // una columna que está mal sin ninguna señal de que lo esté.
    const escapa = (v) => {
      if (v == null) return "";
      if (typeof v === "number") return String(v).replace(".", ",");
      const s = String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return "\uFEFF"
      + cols.join(";") + "\n"
      + filas.map((f) => cols.map((c) => escapa(f[c])).join(";")).join("\n");
  }

  // ── El informe del periodo MELI ──────────────────────────────────────────
  // Una fila por caso, con los nombres de columna del portal, para poder cruzar
  // el archivo contra MELI sin renombrar nada.
  //
  // Las columnas salen en el orden en que las devuelve la función, no en un
  // orden escrito acá: si MELI agrega un campo se agrega en la función y el
  // front no se toca.
  async function bajarReporte() {
    if (!periodoSel) return;
    setBajandoReporte(true);
    setError(null);
    try {
      const { data, error: e } = await sb.rpc("fn_pnr_reporte_meli",
        { p_periodo: periodoSel });
      if (e) throw new Error(e.message);
      if (!data || !data.length) throw new Error(`No hay casos guardados en ${periodoSel}.`);

      const cols = Object.keys(data[0]);
      bajarBlob(filasACsv(data, cols), "text/csv;charset=utf-8",
        `PNR_${periodoSel}.csv`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBajandoReporte(false);
    }
  }

  // ── El CSV del rango ─────────────────────────────────────────────────────
  // Baja el DETALLE, un caso por fila, no los totales. El analista agrupa como
  // necesite en su planilla; con los totales ya sumados solo puede leerlos.
  async function bajarCsv() {
    setBajando(true);
    setError(null);
    try {
      const { data, error: e } = await sb.from("vw_pnr_tablero_detalle")
        .select("*")
        .gte("dia", desde)
        .lte("dia", hasta)
        .order("dia", { ascending: false });
      if (e) throw new Error(e.message);
      if (!data || !data.length) throw new Error("No hay casos en ese rango.");

      const cols = Object.keys(data[0]);
      bajarBlob(filasACsv(data, cols), "text/csv;charset=utf-8",
        desde === hasta ? `pnr_${desde}.csv` : `pnr_${desde}_a_${hasta}.csv`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBajando(false);
    }
  }

  // Solo las cerradas llegan al selector. La vigente no se ofrece siquiera:
  // ofrecerla deshabilitada invita a preguntar por qué está ahí.
  const cerradas = periodos.filter((p) => !p.es_vigente);
  const periodoElegido = periodos.find((p) => p.periodo === periodoSel);

  const total = b1.find((f) => f.es_total) || {};
  const t3 = b3.find((f) => f.es_total) || {};

  return (
    <div>
      {/* ── Controles ──────────────────────────────────────────────────────
          Dos tarjetas porque son dos preguntas distintas, no dos filtros del
          mismo dato:

          IZQUIERDA · el rango manda sobre los tres bloques de la pantalla y
          sobre el CSV de detalle. Sirve para un día suelto, una semana o un mes.
          No sirve para pedir una quincena de MELI, porque una quincena incluye
          casos nacidos semanas antes: 100 de los 290 casos de 202608Q1 nacieron
          en junio y julio.

          DERECHA · la quincena manda solo sobre el informe que se descarga. Es
          la pregunta "dame el periodo tal como lo ve MELI".

          Ponerlas juntas en una sola barra hacía que pareciera que el rango
          filtraba el informe. Separadas, cada una se explica sola. */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16,
        alignItems: "stretch" }}>

        {/* ── Tarjeta del rango ──────────────────────────────────────── */}
        <div style={{ flex: "1 1 330px", border: "1px solid var(--borde)",
          borderRadius: 14, background: "#fff", padding: "13px 15px" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy }}>
            Rango de fechas
          </div>
          <div style={{ fontSize: 11, color: C.gris, marginTop: 2, marginBottom: 10,
            lineHeight: 1.4 }}>
            Manda sobre los tres bloques de abajo. Para un día específico, pon la
            misma fecha en los dos campos.
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8,
            flexWrap: "wrap" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 7,
              border: "1px solid var(--borde)", borderRadius: 9, padding: "5px 9px" }}>
              <input type="date" value={desde} max={hasta}
                onChange={(e) => setDesde(e.target.value)}
                style={{ fontSize: 12.5, border: "none", outline: "none", padding: 0,
                  background: "transparent", width: 118 }} />
              <span style={{ fontSize: 11, color: C.gris }}>→</span>
              <input type="date" value={hasta} min={desde} max={hoyMX()}
                onChange={(e) => setHasta(e.target.value)}
                style={{ fontSize: 12.5, border: "none", outline: "none", padding: 0,
                  background: "transparent", width: 118 }} />
            </div>

            <button onClick={bajarCsv} disabled={bajando} className="btn-navy"
              title="Detalle del rango, un caso por fila"
              style={{ fontSize: 12, fontWeight: 600, padding: "7px 13px",
                borderRadius: 8 }}>
              {bajando ? "Generando…" : "↓ Descargar CSV"}
            </button>

            <button onClick={cargar} disabled={cargando}
              title="Vuelve a pedir los números del rango"
              style={{ fontSize: 11.5, padding: "6px 10px", borderRadius: 7 }}>
              {cargando ? "…" : "Actualizar"}
            </button>
          </div>
        </div>

        {/* ── Tarjeta del informe MELI ───────────────────────────────── */}
        <div style={{ flex: "1 1 330px", border: "1px solid var(--borde)",
          borderRadius: 14, background: "#fff", padding: "13px 15px" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.navy }}>
            Informe del periodo MELI
          </div>
          <div style={{ fontSize: 11, color: C.gris, marginTop: 2, marginBottom: 10,
            lineHeight: 1.4 }}>
            CSV con una fila por caso y las columnas del portal. Solo quincenas
            cerradas: mientras una está en curso MELI mueve casos dentro y fuera.
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8,
            flexWrap: "wrap" }}>
            <select value={periodoSel} onChange={(e) => setPeriodoSel(e.target.value)}
              style={{ fontSize: 12.5, padding: "7px 9px", borderRadius: 8,
                border: "1px solid var(--borde)", background: "#fff",
                fontVariantNumeric: "tabular-nums" }}>
              {!cerradas.length && (
                <option value="">
                  {periodosEstado === "cargando" ? "cargando…"
                    : periodosEstado === "error" ? "error al cargar"
                    : "sin quincenas cerradas"}
                </option>
              )}
              {cerradas.map((p) => (
                <option key={p.periodo} value={p.periodo}>
                  {p.periodo} · {p.casos} casos{p.listo ? "" : " · incompleto"}
                </option>
              ))}
            </select>

            <button onClick={bajarReporte}
              disabled={bajandoReporte || !periodoSel} className="btn-navy"
              style={{ fontSize: 12, fontWeight: 600, padding: "7px 13px",
                borderRadius: 8 }}>
              {bajandoReporte ? "Generando…" : "↓ Descargar CSV"}
            </button>
          </div>

          {/* SEMÁFORO DE LA QUINCENA
              El archivo sale igual esté lista o no, pero con distinto contenido:
              sin detalle capturado quedan vacías productos, fecha de entrega y
              los comentarios. Antes eso solo se notaba al abrir el CSV, cuando
              ya se había mandado. Acá se dice antes de descargar.

              El botón NO se bloquea: puede que el analista quiera los montos y
              los estados, que están correctos igual. Se informa, no se decide
              por él. */}
          {periodoElegido && (
            periodoElegido.listo ? (
              <div style={{ fontSize: 11.5, marginTop: 9, fontWeight: 600,
                color: C.verde, display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontSize: 13 }}>✓</span>
                Informe listo para descargar · {periodoElegido.casos} casos
              </div>
            ) : (
              <div style={{ fontSize: 11, marginTop: 9, color: C.ladrillo,
                lineHeight: 1.45 }}>
                <div style={{ fontWeight: 600 }}>Informe incompleto</div>
                {periodoElegido.abiertos > 0 && (
                  <div>
                    {periodoElegido.abiertos} caso(s) siguen sin cerrar en nuestra
                    base: falta la pasada de cierre de la quincena.
                  </div>
                )}
                {periodoElegido.con_detalle < periodoElegido.casos && (
                  <div>
                    Detalle capturado en {periodoElegido.con_detalle} de{" "}
                    {periodoElegido.casos} casos: van a salir vacías productos,
                    fecha de entrega y los comentarios.
                  </div>
                )}
              </div>
            )
          )}
        </div>
      </div>

      {error && (
        <div style={{ background: C.ladrilloTenue, border: `1px solid ${C.ladrillo}`,
          color: C.ladrillo, borderRadius: 10, padding: "10px 14px", fontSize: 12.5,
          marginBottom: 14 }}>
          {error}
        </div>
      )}

      {/* ── El cierre del SLA de supervisores ─────────────────────────────
          Antes esto eran cuatro barras naranjas arriba de todo, una por mes sin
          calcular. Ocupaban media pantalla con algo que no es del informe de
          MELI ni del tablero: es la medición del SLA de los supervisores para
          su incentivo, y solo importa cuando alguien la va a usar.

          Ahora es UNA línea plegada. Los meses sin calcular no se anuncian
          -no calcularlos es una decisión, no una falla-, y el mes preliminar sí
          se menciona porque ahí el número puede cambiar y de él salen
          incentivos. */}
      {alertas.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <button onClick={() => setVerCierre((v) => !v)}
            style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 7,
              color: C.gris }}>
            {verCierre ? "▾" : "▸"} Cierre del SLA de supervisores
            {alertas.some((a) => a.estado === "preliminar")
              && " · un mes preliminar"}
          </button>

          {verCierre && (
            <div style={{ marginTop: 8 }}>
              {alertas.map((a) => (
                <div key={a.mes} style={{ display: "flex", alignItems: "center",
                  gap: 10, flexWrap: "wrap", borderBottom: "1px solid var(--borde)",
                  padding: "7px 2px", fontSize: 12 }}>
                  <strong style={{ minWidth: 96, fontVariantNumeric: "tabular-nums" }}>
                    {a.mes}
                  </strong>
                  <span style={{ color: a.estado === "preliminar" ? C.ladrillo : C.gris,
                    minWidth: 74 }}>
                    {a.estado}
                  </span>
                  <span style={{ color: C.gris, flex: 1, minWidth: 200 }}>
                    {a.estado === "sin_cerrar"
                      ? "sin calcular"
                      : `${a.casos_sin_tarea || 0} caso(s) sin tarea`}
                  </span>
                  {/* Recalcular un mes preliminar solo lo vuelve a medir; un
                      definitivo la función lo protege sola y no lo toca. */}
                  <button onClick={() => cerrarMes(a.mes)}
                    disabled={cerrando === a.mes}
                    style={{ fontSize: 11, padding: "4px 9px", borderRadius: 6 }}>
                    {cerrando === a.mes ? "…"
                      : a.estado === "sin_cerrar" ? "Calcular" : "Recalcular"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── BLOQUE 1 ─────────────────────────────────────────────────── */}
      <Bloque n={1} titulo="PNR y montos" subtitulo="general y por centro">
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 13 }}>
          <Cifra etiqueta="PNR en el rango" valor={num(total.pnr_total)}
            nota={`${num(total.resueltos)} con desenlace`} />
          <Cifra etiqueta="Anulados" valor={num(total.anulados)}
            nota="se ganaron" color={C.verde} tinte={C.verdeTenue} />
          <Cifra etiqueta="Facturados" valor={num(total.facturados)}
            nota="se cobran" color={C.ladrillo} tinte={C.ladrilloTenue} />
          <Cifra etiqueta="Monto perdido" valor={dinero(total.monto_facturado)}
            color={C.ladrillo} tinte={C.ladrilloTenue} />
          <Cifra etiqueta="Monto en riesgo" valor={dinero(total.monto_en_riesgo)}
            nota="abiertos y en revisión" color={C.naranja} tinte={C.naranjaTenue} />
          <Cifra etiqueta="% anulado" valor={total.pct_anulado != null
              ? `${Number(total.pct_anulado).toFixed(1)}%` : "—"}
            nota="sobre los resueltos"
            color={Number(total.pct_anulado) >= META_PCT ? C.verde : C.naranja}
            tinte={Number(total.pct_anulado) >= META_PCT ? C.verdeTenue : C.naranjaTenue} />
        </div>

        {/* Abre ordenado por plata perdida, de mayor a menor: el centro que más
            cuesta va arriba sin que nadie tenga que buscarlo. Para volver al
            orden por volumen de PNR basta un clic en esa columna, o cambiar
            ordenInicial a { clave: "pnr_total", asc: false }. */}
        <Tabla claveFila={(f) => f.sc}
          filas={b1}
          ordenInicial={{ clave: "monto_facturado", asc: false }}
          columnas={[
            { clave: "sc", titulo: "Centro",
              ayuda: "Centro de servicio donde ocurrió la entrega reclamada." },
            { clave: "pnr_total", titulo: "PNR",
              ayuda: "Reclamos que MELI abrió en el rango de fechas. Se cuenta por la fecha en que nació el caso, no por la de la ruta.", derecha: true, pinta: (f) => num(f.pnr_total) },
            { clave: "anulados", titulo: "Anulados",
              ayuda: "MELI cerró el caso a favor: no se cobra nada. Es el resultado que se busca.", derecha: true,
              pinta: (f) => <span style={{ color: C.verde }}>{num(f.anulados)}</span> },
            { clave: "facturados", titulo: "Facturados",
              ayuda: "MELI cobró el valor del producto. El caso se perdió.", derecha: true,
              pinta: (f) => <span style={{ color: C.ladrillo }}>{num(f.facturados)}</span> },
            { clave: "esperando", titulo: "Esperando",
              ayuda: "Ya se hizo lo nuestro y decide MELI: comprobante cargado, en revisión o asignado.", derecha: true, pinta: (f) => num(f.esperando) },
            { clave: "abiertos", titulo: "Abiertos",
              ayuda: "Todavía dependen de nosotros: esperando comprobante o sin comprobante cargado.", derecha: true, pinta: (f) => num(f.abiertos) },
            { clave: "monto_total", titulo: "Monto total",
              ayuda: "Suma del valor de los productos de todos los PNR del rango.", derecha: true, pinta: (f) => dinero(f.monto_total) },
            { clave: "monto_facturado", titulo: "Perdido",
              ayuda: "Plata que MELI ya cobró. Es pérdida cerrada, no recuperable.", derecha: true,
              pinta: (f) => <span style={{ color: C.ladrillo }}>{dinero(f.monto_facturado)}</span> },
            { clave: "monto_en_riesgo", titulo: "En riesgo",
              ayuda: "Valor de los casos abiertos y en revisión. Todavía se puede evitar perderlo.", derecha: true,
              pinta: (f) => <span style={{ color: C.naranja }}>{dinero(f.monto_en_riesgo)}</span> },
            { clave: "pct_anulado", titulo: "% anulado",
              ayuda: "Anulados sobre los casos RESUELTOS (anulados + facturados). Los abiertos no entran al divisor: mientras un caso está abierto no se ganó ni se perdió.", derecha: true,
              pinta: (f) => <Pct v={f.pct_anulado} /> },
          ]} />
      </Bloque>

      {/* ── BLOQUE 2 ─────────────────────────────────────────────────── */}
      <Bloque n={2} titulo="Tareas por supervisor"
        subtitulo="los dos SLA que le corresponden, reaperturas y tiempos">
        {/* Los dos SLA se explican acá y no en un tooltip: son distintos y la
            diferencia entre ellos es justamente lo que hay que mirar. */}
        <div style={{ fontSize: 11.5, color: C.gris, marginBottom: 11, lineHeight: 1.45 }}>
          <strong style={{ color: C.navy }}>SLA fotos</strong>: subir la evidencia a la
          tarea que le crea The Eyes.{" "}
          <strong style={{ color: C.navy }}>SLA comprobante</strong>: cargarlo en Mercado
          Libre, que es lo que decide el caso. Un supervisor puede cumplir el primero y
          perder igual si no hace el segundo. Los dos se miden desde que nació el PNR, con
          plazo de 40 h.
        </div>

        <Tabla claveFila={(f) => `${f.supervisor}|${f.sc}`}
          filas={b2}
          columnas={[
            { clave: "supervisor", titulo: "Supervisor",
              ayuda: "Supervisor del centro donde ocurrió el reclamo." },
            { clave: "sc", titulo: "SC",
              ayuda: "Centro de servicio." },
            { clave: "pnr_total", titulo: "PNR", derecha: true, pinta: (f) => num(f.pnr_total) },
            { clave: "tareas", titulo: "Tareas",
              ayuda: "Veces que un analista apretó Notificar y se creó la tarea de pedir fotos. Cero tareas con muchos PNR significa que nadie notificó: no es culpa del supervisor.", derecha: true, pinta: (f) => num(f.tareas) },
            { clave: "fotos_enviadas", titulo: "Con fotos",
              ayuda: "Tareas que el supervisor cerró subiendo la evidencia.", derecha: true,
              pinta: (f) => <span style={{ color: C.verde }}>{num(f.fotos_enviadas)}</span> },
            { clave: "tareas_vencidas", titulo: "Vencidas",
              ayuda: "Tareas que pasaron el plazo de 40 h sin cerrarse. Quedan bloqueadas en la bitácora como no cumplidas.", derecha: true,
              pinta: (f) => f.tareas_vencidas > 0
                ? <span style={{ color: C.ladrillo, fontWeight: 700 }}>{num(f.tareas_vencidas)}</span>
                : <span style={{ color: C.gris }}>0</span> },
            { clave: "reaperturas", titulo: "Reaperturas",
              ayuda: "Veces que la torre rechazó la evidencia y pidió otra. Cada reapertura es trabajo que se repite.", derecha: true,
              pinta: (f) => num(f.reaperturas) },
            { clave: "pct_sla_fotos", titulo: "% SLA fotos",
              ayuda: "Tareas con fotos subidas dentro de las 40 h, sobre las que ya se definieron. \"Sin datos\" significa que no hay tareas: sin Notificar no hay nada que cumplir. Declarar que el conductor no tiene pruebas cuenta como cumplido.", derecha: true,
              pinta: (f) => <Pct v={f.pct_sla_fotos} /> },
            { clave: "pct_sla_comprobante", titulo: "% SLA compr.",
              ayuda: "Casos con el comprobante cargado en MELI dentro de las 40 h. Es el SLA que de verdad decide el caso, y el que tiene volumen suficiente para leerse.", derecha: true,
              pinta: (f) => <Pct v={f.pct_sla_comprobante} /> },
            // El promedio va con su denominador entre paréntesis. Un promedio de
            // una sola tarea no es una medición, y quien lee tiene que poder ver
            // de cuántas sale antes de sacar conclusiones.
            { clave: "horas_prom_fotos", titulo: "h a fotos", derecha: true,
              ayuda: `Horas promedio desde que nació el PNR hasta que el supervisor `
                + `subió las fotos. El plazo son ${SLA_SUPERVISOR} h. Entre paréntesis, `
                + `sobre cuántos casos se calcula el promedio.`,
              pinta: (f) => <Horas v={f.horas_prom_fotos} n={f.n_horas_fotos} /> },
            { clave: "horas_prom_comprobante", titulo: "h a compr.", derecha: true,
              ayuda: `Horas promedio desde que nació el PNR hasta que el comprobante `
                + `quedó cargado en Mercado Libre. El plazo son ${SLA_SUPERVISOR} h. `
                + `Entre paréntesis, sobre cuántos casos se calcula.`,
              pinta: (f) => <Horas v={f.horas_prom_comprobante} n={f.n_horas_comprobante} /> },
            { clave: "monto_en_riesgo", titulo: "En riesgo", derecha: true,
              ayuda: "Valor de los casos abiertos y en revisión de este supervisor. Todavía se puede evitar perderlo.",
              pinta: (f) => dinero(f.monto_en_riesgo) },
          ]} />
      </Bloque>

      {/* ── BLOQUE 3 ─────────────────────────────────────────────────── */}
      <Bloque n={3} titulo="Evidencia" subtitulo="con prueba cargada vs. respondido sin prueba">
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 13 }}>
          <Cifra etiqueta="Con prueba" valor={num(t3.con_prueba)}
            nota={`${num(t3.con_prueba_anulado)} anulados`} color={C.verde} tinte={C.verdeTenue} />
          <Cifra etiqueta="Sin prueba" valor={num(t3.sin_prueba)}
            nota="respondidos sin comprobante" color={C.ladrillo} tinte={C.ladrilloTenue} />
          <Cifra etiqueta="Pendientes" valor={num(t3.pendiente)} nota="todavía se espera" />
          <Cifra etiqueta="Monto sin prueba" valor={dinero(t3.monto_sin_prueba)}
            color={C.ladrillo} tinte={C.ladrilloTenue} />
          <Cifra etiqueta="Perdido sin prueba" valor={dinero(t3.monto_perdido_sin_prueba)}
            nota="el costo de no cargar" color={C.ladrillo} tinte={C.ladrilloTenue} />
        </div>

        {/* La comparación de los dos porcentajes de éxito es el número más útil
            del tablero: dice cuánto sirve de verdad cargar la evidencia. Si
            fueran parecidos, el esfuerzo estaría mal dirigido. */}
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 13 }}>
          <Cifra etiqueta="% éxito con prueba"
            valor={t3.pct_exito_con_prueba != null
              ? `${Number(t3.pct_exito_con_prueba).toFixed(1)}%` : "—"}
            nota="anulados sobre resueltos" color={C.verde} tinte={C.verdeTenue} />
          <Cifra etiqueta="% éxito sin prueba"
            valor={t3.pct_exito_sin_prueba != null
              ? `${Number(t3.pct_exito_sin_prueba).toFixed(1)}%` : "—"}
            nota="anulados sobre resueltos" color={C.ladrillo} tinte={C.ladrilloTenue} />
        </div>

        <Tabla claveFila={(f) => f.sc}
          filas={b3}
          columnas={[
            { clave: "sc", titulo: "Centro" },
            { clave: "con_prueba", titulo: "Con prueba",
              ayuda: "Casos donde el comprobante quedó cargado en MELI.", derecha: true,
              pinta: (f) => <span style={{ color: C.verde }}>{num(f.con_prueba)}</span> },
            { clave: "sin_prueba", titulo: "Sin prueba",
              ayuda: "Casos respondidos a MELI SIN comprobante cargado. Se contestó sin respaldo.", derecha: true,
              pinta: (f) => f.sin_prueba > 0
                ? <span style={{ color: C.ladrillo, fontWeight: 700 }}>{num(f.sin_prueba)}</span>
                : <span style={{ color: C.gris }}>0</span> },
            { clave: "pendiente", titulo: "Pendientes",
              ayuda: "Todavía se espera el comprobante: el caso sigue abierto.", derecha: true, pinta: (f) => num(f.pendiente) },
            { clave: "con_prueba_anulado", titulo: "CP anulados",
              ayuda: "De los que tenían prueba, cuántos se ganaron.", derecha: true,
              pinta: (f) => num(f.con_prueba_anulado) },
            { clave: "con_prueba_facturado", titulo: "CP facturados",
              ayuda: "De los que tenían prueba, cuántos se perdieron igual.", derecha: true,
              pinta: (f) => num(f.con_prueba_facturado) },
            { clave: "sin_prueba_facturado", titulo: "SP facturados",
              ayuda: "De los respondidos sin prueba, cuántos se perdieron. Es el costo directo de no cargar la evidencia.", derecha: true,
              pinta: (f) => f.sin_prueba_facturado > 0
                ? <span style={{ color: C.ladrillo, fontWeight: 700 }}>{num(f.sin_prueba_facturado)}</span>
                : <span style={{ color: C.gris }}>0</span> },
            { clave: "monto_sin_prueba", titulo: "Monto SP",
              ayuda: "Valor de los casos respondidos sin comprobante.", derecha: true,
              pinta: (f) => dinero(f.monto_sin_prueba) },
            { clave: "pct_exito_con_prueba", titulo: "% éxito CP",
              ayuda: "Anulados sobre resueltos, entre los que SÍ tenían prueba cargada.", derecha: true,
              pinta: (f) => <Pct v={f.pct_exito_con_prueba} /> },
            { clave: "pct_exito_sin_prueba", titulo: "% éxito SP",
              ayuda: "Anulados sobre resueltos, entre los que NO tenían prueba. Comparado con el anterior dice cuánto sirve de verdad cargar la evidencia.", derecha: true,
              pinta: (f) => <Pct v={f.pct_exito_sin_prueba} /> },
          ]} />
      </Bloque>
    </div>
  );
}
