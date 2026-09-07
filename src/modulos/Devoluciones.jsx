import { useState, useEffect, useCallback, useMemo } from "react";
import { sb } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// DEVOLUCIONES MX · panel del analista
//
// La unidad es PAQUETE POR DÍA, no el paquete: un envío que sale tres días son
// tres filas. Por eso todo se filtra por dev_paquetes_mx.dia y no por la fecha
// del envío.
//
// LO QUE SE VE Y POR QUÉ
//   Arriba, el cierre del día: cinco cifras. Abajo, una fila por ruta que se
//   despliega y muestra sus paquetes agrupados por `requiere`.
//
//   Las rutas con SleepOver van en su propio bloque. Están en un camino
//   distinto: esa noche no se les pide nada y sus devoluciones se definen al
//   día siguiente. Mezcladas con las normales, el analista no entiende por qué
//   unas tienen aviso y otras no.
//
// EL CONTADOR DE MELI NO SIRVE PARA ESTO
//   En la ruta 153820564 el contador decía 10 no entregados y a devolver era 1:
//   6 transferred (de otra ruta), 9 stopped (se los queda para mañana) y 1
//   bad_address. Por eso la columna que manda es `requiere` y el
//   pkg_not_delivered se muestra al lado solo como referencia.
//
// SIN FK, DOS CONSULTAS
//   dev_paquetes_mx no tiene FK a dev_rutas_mx a propósito (regla de mundos
//   separados), así que PostgREST no puede anidarlas. Se piden por separado y
//   se cruzan acá por id_ruta.
//
// LO QUE FALTA
//   Las marcas de foto y geo viven en dev_pruebas_mx y todavía no están
//   conectadas: hace falta ver sus columnas para no inventarlas. Las tres
//   marcas que sí se pintan salen de dev_paquetes_mx.
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

// El panel es el cierre del día anterior: el día en curso tiene rutas abiertas y
// sus devoluciones todavía no están definidas.
function ayerMX() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

const num = (n) => (n == null ? "—" : Number(n).toLocaleString("es-MX"));

// Hora en 24 h. El am/pm se corta en las celdas angostas y 20:02 se lee como
// 08:02 — ya pasó en la pantalla de Posventa.
function hora(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("es-MX", {
    timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function fechaHora(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// ── Los seis valores de `requiere` ─────────────────────────────────────────
// El orden no es alfabético: primero lo que hay que gestionar, después lo que
// solo explica el resto de la ruta.
const REQUIERE = [
  { clave: "devolver",     etiqueta: "A devolver",   color: C.ladrillo, tinte: C.ladrilloTenue },
  { clave: "pendiente",    etiqueta: "Pendiente",    color: C.naranja,  tinte: C.naranjaTenue },
  { clave: "reprogramado", etiqueta: "Reprogramado", color: C.naranja,  tinte: C.naranjaTenue },
  { clave: "transferido",  etiqueta: "Transferido",  color: C.gris,     tinte: C.grisTenue },
  { clave: "entregado",    etiqueta: "Entregado",    color: C.verde,    tinte: C.verdeTenue },
  { clave: "otro",         etiqueta: "Otro",         color: C.gris,     tinte: C.grisTenue },
];

const META_REQUIERE = REQUIERE.reduce((a, r) => ({ ...a, [r.clave]: r }), {});

// Cuántos folios a devolver en una ruta empiezan a ser raros. NO es una regla de
// negocio — el umbral real todavía no está decidido y cuando lo esté va en
// dev_config. Acá solo sirve para que el analista mire esa ruta primero: nueve
// de diez rutas traen entre 1 y 3, y una de 31 es una ruta abortada o un
// problema de clasificación, no un día malo.
const OJO_DEVOLUCIONES = 6;

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
      {nota && <div style={{ fontSize: 10, color: C.gris, marginTop: 1 }}>{nota}</div>}
    </div>
  );
}

// ── Envoltorio de bloque ───────────────────────────────────────────────────

function Bloque({ titulo, subtitulo, children }) {
  return (
    <div style={{ border: "1px solid var(--borde)", borderRadius: 14,
      background: "#fff", marginBottom: 16, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9,
        padding: "11px 16px", background: C.navyTenue,
        borderBottom: "1px solid var(--borde)" }}>
        <span style={{ fontSize: 14.5, fontWeight: 700, color: C.navy }}>{titulo}</span>
        {subtitulo && <span style={{ fontSize: 11.5, color: C.gris }}>{subtitulo}</span>}
      </div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

// ── Una marca de un folio ──────────────────────────────────────────────────
// Tres estados y no dos: cumplida, pendiente, y no aplica. Un guion gris cuando
// no aplica evita que se lea como incumplimiento — el mismo problema de los
// cumplido% de Posventa, donde no distinguir la suerte del proceso escondía el
// dato importante.

function Marca({ sigla, estado, titulo }) {
  const paleta = {
    ok:       { fondo: C.verdeTenue,    borde: C.verde,    texto: C.verde },
    pendiente:{ fondo: "#fff",          borde: C.gris,     texto: C.gris },
    aviso:    { fondo: C.naranjaTenue,  borde: C.naranja,  texto: C.naranja },
  }[estado] || { fondo: "#fff", borde: C.gris, texto: C.gris };

  return (
    <span title={titulo} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 20, height: 18, borderRadius: 5, fontSize: 9, fontWeight: 700,
      background: paleta.fondo, border: `1px solid ${paleta.borde}55`,
      color: paleta.texto, cursor: "help", flexShrink: 0,
    }}>{sigla}</span>
  );
}

function Etiqueta({ children, color, tinte }) {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
      textTransform: "uppercase", color, background: tinte,
      border: `1px solid ${color}33`, borderRadius: 6, padding: "1px 6px",
      whiteSpace: "nowrap" }}>{children}</span>
  );
}

// ── Los paquetes de una ruta, agrupados por requiere ───────────────────────

function PaquetesDeRuta({ paquetes }) {
  const grupos = useMemo(() => {
    const m = new Map();
    for (const p of paquetes) {
      const k = p.requiere || "otro";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return REQUIERE
      .filter((r) => m.has(r.clave))
      .map((r) => ({ meta: r, filas: m.get(r.clave) }));
  }, [paquetes]);

  if (!paquetes.length) {
    return <div style={{ fontSize: 12, color: C.gris, padding: "6px 2px" }}>
      Esta ruta no tiene paquetes capturados.
    </div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {grupos.map(({ meta, filas }) => (
        <div key={meta.clave}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
            <Etiqueta color={meta.color} tinte={meta.tinte}>{meta.etiqueta}</Etiqueta>
            <span style={{ fontSize: 11, color: C.gris }}>{filas.length}</span>
          </div>

          {/* Solo los `devolver` se listan folio por folio con sus marcas: son
              los únicos que se le piden al conductor. Los demás se resumen por
              substatus — sirven para entender la ruta, no para gestionar. */}
          {meta.clave === "devolver" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {filas.map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8,
                  padding: "5px 8px", borderRadius: 7, background: C.grisTenue,
                  fontSize: 11.5, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums",
                    minWidth: 96 }}>{p.folio_guia}</span>

                  <span style={{ color: C.gris, fontSize: 10.5, minWidth: 120 }}>
                    {p.substatus || "—"}
                  </span>

                  <span style={{ display: "inline-flex", gap: 3 }}>
                    <Marca sigla="A1"
                      estado={p.aviso1_en ? "ok" : "pendiente"}
                      titulo={p.aviso1_en
                        ? `Aviso 1 enviado ${fechaHora(p.aviso1_en)}`
                        : "Aviso 1 sin enviar"} />
                    <Marca sigla="A2"
                      estado={p.aviso2_en ? "ok" : "pendiente"}
                      titulo={p.aviso2_en
                        ? `Solicitud de fotos enviada ${fechaHora(p.aviso2_en)}`
                        : "Solicitud de fotos sin enviar"} />
                    <Marca sigla="ML"
                      estado={p.meli_retorno_en ? "ok" : "pendiente"}
                      titulo={p.meli_retorno_en
                        ? `Retorno visto en MELI ${fechaHora(p.meli_retorno_en)}`
                        : "Sin retorno confirmado en MELI"} />
                  </span>

                  {p.postergado_en && (
                    <Etiqueta color={C.naranja} tinte={C.naranjaTenue}>
                      postergado {hora(p.postergado_en)}
                    </Etiqueta>
                  )}

                  {p.resultado
                    ? <Etiqueta color={p.resultado === "no_resuelto" ? C.ladrillo : C.verde}
                        tinte={p.resultado === "no_resuelto" ? C.ladrilloTenue : C.verdeTenue}>
                        {p.resultado.replace("_", " ")}
                      </Etiqueta>
                    : <Etiqueta color={C.gris} tinte={C.grisTenue}>en curso</Etiqueta>}

                  {p.incidente && (
                    <span title={p.incidente} style={{ color: C.gris, fontSize: 10.5,
                      maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap", cursor: "help" }}>
                      {p.incidente}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {Object.entries(
                filas.reduce((a, p) => {
                  const k = p.substatus || "sin substatus";
                  a[k] = (a[k] || 0) + 1;
                  return a;
                }, {})
              ).sort((a, b) => b[1] - a[1]).map(([sub, n]) => (
                <span key={sub} style={{ fontSize: 10.5, color: C.gris,
                  background: C.grisTenue, borderRadius: 6, padding: "2px 7px",
                  whiteSpace: "nowrap" }}>
                  {sub} · <strong style={{ color: "var(--texto)" }}>{n}</strong>
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Una fila de ruta, desplegable ──────────────────────────────────────────

function FilaRuta({ ruta, paquetes, abierta, alternar, contactable }) {
  const aDevolver = paquetes.filter((p) => p.requiere === "devolver");
  const resueltos = aDevolver.filter((p) => p.resultado).length;
  const ojo = aDevolver.length >= OJO_DEVOLUCIONES;

  return (
    <div style={{ border: "1px solid var(--borde)", borderRadius: 10,
      marginBottom: 6, overflow: "hidden", background: "#fff" }}>
      <button onClick={alternar} style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "8px 11px", background: abierta ? C.navyTenue : "#fff",
        border: "none", borderRadius: 0, textAlign: "left", flexWrap: "wrap",
      }}>
        <span style={{ color: C.gris, fontSize: 10, width: 10, flexShrink: 0 }}>
          {abierta ? "▼" : "▶"}
        </span>

        <span style={{ fontWeight: 700, fontSize: 12.5, fontVariantNumeric: "tabular-nums",
          minWidth: 92 }}>{ruta.id_ruta}</span>

        <span style={{ fontSize: 11.5, color: C.navy, fontWeight: 600, minWidth: 54 }}>
          {ruta.service_center_id || "—"}
        </span>

        <span style={{ fontSize: 11.5, minWidth: 150, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ruta.driver_name}>
          {ruta.driver_name || "sin conductor"}
        </span>

        {ruta.driver_nivel && (
          <span style={{ fontSize: 10, color: C.gris }}>{ruta.driver_nivel}</span>
        )}

        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center",
          gap: 7, flexWrap: "wrap" }}>
          {/* Sin wa_id en el directorio no hay a quién avisarle. Se muestra
              acá porque hoy es el bloqueante real del módulo: la ruta puede
              estar perfectamente clasificada y el aviso igual no sale. */}
          {!contactable && (
            <Etiqueta color={C.ladrillo} tinte={C.ladrilloTenue}>sin teléfono</Etiqueta>
          )}

          {ruta.sleep_over_en && (
            <Etiqueta color={C.naranja} tinte={C.naranjaTenue}>
              sleepover {hora(ruta.sleep_over_en)}
            </Etiqueta>
          )}

          {ruta.retorno_en && (
            <Etiqueta color={C.verde} tinte={C.verdeTenue}>
              retornó {hora(ruta.retorno_en)}
            </Etiqueta>
          )}

          <span style={{ fontSize: 11, color: C.gris, whiteSpace: "nowrap" }}>
            {num(paquetes.length)} paq · MELI dice {num(ruta.pkg_not_delivered)}
          </span>

          <span style={{ fontSize: 12, fontWeight: 800,
            color: ojo ? C.ladrillo : C.navy, whiteSpace: "nowrap" }}
            title={ojo
              ? "Muchos folios para una sola ruta: conviene mirarla antes de avisar"
              : "Folios a devolver / resueltos"}>
            {ojo && "⚠ "}{num(aDevolver.length)} a devolver
            <span style={{ color: C.gris, fontWeight: 400, fontSize: 10.5 }}>
              {" "}({resueltos} resueltos)
            </span>
          </span>
        </span>
      </button>

      {abierta && (
        <div style={{ padding: "10px 12px 12px 31px",
          borderTop: "1px solid var(--borde)" }}>
          <PaquetesDeRuta paquetes={paquetes} />
        </div>
      )}
    </div>
  );
}

// ── Módulo ─────────────────────────────────────────────────────────────────

export default function Devoluciones() {
  const [dia, setDia] = useState(() => ayerMX());
  const [rutas, setRutas] = useState([]);
  const [paquetes, setPaquetes] = useState([]);
  const [contactables, setContactables] = useState(new Set());
  const [soloConDevolucion, setSoloConDevolucion] = useState(true);
  const [abiertas, setAbiertas] = useState(() => new Set());
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    const [r, p, d] = await Promise.all([
      sb.from("dev_rutas_mx").select("*").eq("fecha_operativa", dia),
      sb.from("dev_paquetes_mx").select("*").eq("dia", dia),
      // Vigentes y no inválidos: un chip que cambió de dueño no sirve para
      // avisarle al conductor de hoy.
      sb.from("directorio_mx").select("driver_user_id,wa_id,estado")
        .is("hasta", null).not("wa_id", "is", null),
    ]);
    const malo = r.error || p.error || d.error;
    if (malo) {
      setError(malo.message);
    } else {
      setRutas(r.data || []);
      setPaquetes(p.data || []);
      setContactables(new Set(
        (d.data || [])
          .filter((f) => f.estado !== "invalido" && f.driver_user_id != null)
          .map((f) => String(f.driver_user_id))
      ));
    }
    setCargando(false);
  }, [dia]);

  useEffect(() => { cargar(); }, [cargar]);

  // Paquetes por ruta, una sola pasada.
  const porRuta = useMemo(() => {
    const m = new Map();
    for (const p of paquetes) {
      const k = String(p.id_ruta);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return m;
  }, [paquetes]);

  const cifras = useMemo(() => {
    const aDevolver = paquetes.filter((p) => p.requiere === "devolver");
    const rutasConDev = new Set(aDevolver.map((p) => String(p.id_ruta)));
    return {
      rutas: rutas.length,
      conDevolucion: rutasConDev.size,
      aDevolver: aDevolver.length,
      retornados: aDevolver.filter((p) => p.meli_retorno_en).length,
      pendientes: aDevolver.filter((p) => !p.resultado).length,
      conSleepOver: rutas.filter((r) => r.sleep_over_en).length,
    };
  }, [rutas, paquetes]);

  // Dos listas: las postergadas por SleepOver van aparte porque siguen otro
  // camino y otro plazo.
  const { normales, conSleepOver } = useMemo(() => {
    const visibles = rutas.filter((r) => {
      if (!soloConDevolucion) return true;
      const ps = porRuta.get(String(r.id_ruta)) || [];
      return ps.some((p) => p.requiere === "devolver");
    });
    // Más folios a devolver primero: es lo que el analista tiene que mirar.
    const peso = (r) =>
      (porRuta.get(String(r.id_ruta)) || []).filter((p) => p.requiere === "devolver").length;
    const orden = (a, b) => peso(b) - peso(a) || Number(a.id_ruta) - Number(b.id_ruta);
    return {
      normales: visibles.filter((r) => !r.sleep_over_en).sort(orden),
      conSleepOver: visibles.filter((r) => r.sleep_over_en).sort(orden),
    };
  }, [rutas, porRuta, soloConDevolucion]);

  function alternar(idRuta) {
    setAbiertas((prev) => {
      const s = new Set(prev);
      const k = String(idRuta);
      if (s.has(k)) s.delete(k); else s.add(k);
      return s;
    });
  }

  function pintarLista(lista) {
    if (!lista.length) {
      return <div style={{ fontSize: 12, color: C.gris, padding: 8 }}>
        Sin rutas en este grupo.
      </div>;
    }
    return lista.map((r) => (
      <FilaRuta key={r.id_ruta}
        ruta={r}
        paquetes={porRuta.get(String(r.id_ruta)) || []}
        abierta={abiertas.has(String(r.id_ruta))}
        alternar={() => alternar(r.id_ruta)}
        contactable={contactables.has(String(r.driver_id))} />
    ));
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 16,
      background: "var(--fondo)" }}>

      {/* ── Barra de día ────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12,
        marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
            textTransform: "uppercase", color: C.gris, marginBottom: 3 }}>
            Día operativo
          </div>
          <input type="date" value={dia} max={hoyMX()}
            onChange={(e) => setDia(e.target.value)}
            style={{ width: 160, fontSize: 13, padding: "7px 9px" }} />
        </div>

        <button onClick={() => setDia(ayerMX())} style={{ fontSize: 12, padding: "7px 12px" }}>
          Ayer
        </button>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 12, color: "var(--texto-suave)", cursor: "pointer" }}>
          <input type="checkbox" checked={soloConDevolucion}
            onChange={(e) => setSoloConDevolucion(e.target.checked)} />
          Solo rutas con devolución
        </label>

        <button onClick={cargar} disabled={cargando}
          style={{ marginLeft: "auto", fontSize: 12, padding: "7px 12px" }}>
          {cargando ? "Cargando…" : "Actualizar"}
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 14, padding: "10px 13px", borderRadius: 10,
          background: C.ladrilloTenue, border: `1px solid ${C.ladrillo}33`,
          color: C.ladrillo, fontSize: 12.5 }}>
          {error}
        </div>
      )}

      {/* ── Cierre del día ──────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <Cifra etiqueta="Rutas del día" valor={num(cifras.rutas)}
          nota={cifras.conSleepOver ? `${cifras.conSleepOver} con SleepOver` : null} />
        <Cifra etiqueta="Con devolución" valor={num(cifras.conDevolucion)} />
        <Cifra etiqueta="Paquetes a devolver" valor={num(cifras.aDevolver)}
          color={C.ladrillo} tinte={C.ladrilloTenue} />
        <Cifra etiqueta="Retornados en MELI" valor={num(cifras.retornados)}
          color={C.verde} tinte={C.verdeTenue} />
        <Cifra etiqueta="Pendientes" valor={num(cifras.pendientes)}
          color={C.naranja} tinte={C.naranjaTenue}
          nota="sin resultado todavía" />
      </div>

      {cargando ? (
        <div style={{ fontSize: 12.5, color: C.gris, padding: 8 }}>Cargando el día…</div>
      ) : (
        <>
          <Bloque titulo="Rutas cerradas"
            subtitulo="retorno el mismo día · plazo del bloqueo de las 23:00">
            {pintarLista(normales)}
          </Bloque>

          <Bloque titulo="Postergadas por SleepOver"
            subtitulo="MELI habilitó el reintento · se resuelven al día siguiente">
            {/* No es un bloque de error: es el camino largo. Acá no se le pide
                nada al conductor esa noche, y las devoluciones se definen
                recién cuando se sabe qué entregó y qué retornó. */}
            {pintarLista(conSleepOver)}
          </Bloque>

          <div style={{ fontSize: 10.5, color: C.gris, lineHeight: 1.5,
            padding: "0 2px 8px" }}>
            <strong>A1</strong> aviso inicial · <strong>A2</strong> solicitud de
            fotos · <strong>ML</strong> retorno confirmado en MELI. Las marcas de
            foto y geolocalización todavía no están conectadas.
          </div>
        </>
      )}
    </div>
  );
}
