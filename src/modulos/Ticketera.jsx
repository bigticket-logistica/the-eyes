import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { sb } from "../shared/supabase.js";
import { puedeActuar } from "../shared/permisos.js";
import { useAuth } from "../shared/auth.jsx";
import { esAbierto, motivoLegible } from "../shared/constantes.js";
import { esDeHoyMX } from "../shared/fechas.js";
import ColaTickets from "../componentes/ColaTickets.jsx";
import HiloTicket from "../componentes/HiloTicket.jsx";
import PanelContexto from "../componentes/PanelContexto.jsx";
import { conversacionPorTelefono, ventanaAbierta, enviarMensaje } from "../shared/mensajes.js";


// ── Al tomar una incidencia: elegir el número y contactar al conductor ──────
// Candidatos: el que da Logistic (MELI) + los del Directorio de la torre
// (cruzados por patente y por nombre). Si no hay conversación abierta en las
// últimas 24h, el primer mensaje va por PLANTILLA aprobada de Meta —
// siempre se envía, para asegurar el contacto.
const PLANTILLA = { nombre: "contacto_ruta_torre", idioma: "es_MX" };
const suf10 = (t) => String(t || "").replace(/\D/g, "").slice(-10);

function PanelTomar({ caso, onCerrar, onListo, analistaId }) {
  const [candidatos, setCandidatos] = useState([]);
  const [elegido, setElegido] = useState(suf10(caso.conductor_telefono) ? String(caso.conductor_telefono).replace(/\D/g, "") : "");
  const [motivo, setMotivo] = useState(`Tenemos una incidencia en tu ruta: ${motivoLegible(caso.motivo_id, caso.motivo_label)}.`);
  const [ventana, setVentana] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");

  // armar candidatos: MELI + Directorio (patente / nombre), sin duplicar
  useEffect(() => {
    let vivo = true;
    (async () => {
      const lista = [];
      const vistos = new Set();
      const push = (tel, fuente, nombre) => {
        const s = suf10(tel);
        if (!s || vistos.has(s)) return;
        vistos.add(s);
        lista.push({ tel: String(tel).replace(/\D/g, ""), fuente, nombre });
      };
      push(caso.conductor_telefono, "Logistic (MELI)", caso.conductor_nombre);
      try {
        const filtros = [];
        if (caso.patente) filtros.push(`patente.eq.${caso.patente}`);
        if (caso.conductor_nombre) filtros.push(`nombre.ilike.%${caso.conductor_nombre}%`);
        if (filtros.length) {
          const { data } = await sb.from("vw_directorio_conductores")
            .select("nombre, telefono, patente").or(filtros.join(",")).limit(10);
          for (const d of (data || [])) {
            push(d.telefono, `Directorio${d.patente ? " · " + d.patente : ""}`, d.nombre);
          }
        }
      } catch (e) { /* el Directorio es complemento, no bloquea */ }
      if (!vivo) return;
      setCandidatos(lista);
      if (!elegido && lista[0]) setElegido(lista[0].tel);
    })();
    return () => { vivo = false; };
  }, [caso.case_id]);

  // ¿hay ventana de 24h abierta con el número elegido?
  useEffect(() => {
    if (!elegido) { setVentana(null); return; }
    let vivo = true;
    setVentana(null);
    conversacionPorTelefono(elegido)
      .then((c) => { if (vivo) setVentana(ventanaAbierta(c)); })
      .catch(() => { if (vivo) setVentana(false); });
    return () => { vivo = false; };
  }, [elegido]);

  const primerNombre = (caso.conductor_nombre || "").split(" ")[0] || "conductor";
  const rutaTxt = caso.route_code || String(caso.case_id);
  const conPlantilla = ventana === false;
  const vistaPrevia = `Hola ${primerNombre}, te contactamos de la torre de soporte Bigticket por tu ruta ${rutaTxt}. ${motivo.trim()} Por favor respóndenos por aquí para poder ayudarte.`;

  async function ejecutar(contactar) {
    if (ocupado) return;
    setOcupado(true); setError("");
    try {
      const { error: e1 } = await sb.rpc("fn_tomar_ticket", { p_caso_id: caso.id, p_forzar: false });
      if (e1) throw new Error(e1.message);

      if (contactar) {
        if (!elegido) throw new Error("Elige un número para contactar");
        if (suf10(elegido) !== suf10(caso.conductor_telefono)) {
          const { error: e2 } = await sb.rpc("fn_fijar_telefono_contacto", { p_caso_id: caso.id, p_telefono: elegido });
          if (e2) throw new Error(e2.message);
        }
        await enviarMensaje({
          telefono: elegido, texto: vistaPrevia, caseId: caso.case_id, emisorId: analistaId,
          plantilla: conPlantilla ? { ...PLANTILLA, variables: [primerNombre, rutaTxt, motivo.trim()] } : null,
        });
      }
      onListo();
    } catch (e) {
      setError(e.message || "No se pudo completar");
      setOcupado(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", zIndex: 60,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={onCerrar}>
      <div style={{ background: "#fff", borderRadius: 12, width: 480, maxWidth: "100%", padding: 18 }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Tomar {caso.codigo || "#" + caso.case_id}</div>
          <button onClick={onCerrar} style={{ fontSize: 12, padding: "2px 10px" }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--texto-suave)", marginBottom: 12 }}>
          {motivoLegible(caso.motivo_id, caso.motivo_label)} · {caso.conductor_nombre || "sin conductor"}
          {caso.patente ? " · " + caso.patente : ""}
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>¿A qué número contactamos?</div>
        {candidatos.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--texto-tenue)", marginBottom: 10 }}>
            Sin teléfono en MELI ni en el Directorio. Puedes tomar el ticket y agregar el número en Directorio.
          </div>
        ) : (
          <div style={{ marginBottom: 10 }}>
            {candidatos.map((c) => (
              <label key={c.tel} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                borderRadius: 7, cursor: "pointer", fontSize: 13,
                background: elegido === c.tel ? "var(--naranja-suave)" : "transparent" }}>
                <input type="radio" name="tel" checked={elegido === c.tel} onChange={() => setElegido(c.tel)} />
                <b>{c.tel}</b>
                <span style={{ fontSize: 11, color: "var(--texto-suave)" }}>
                  {c.fuente}{c.nombre ? " · " + c.nombre : ""}
                </span>
              </label>
            ))}
          </div>
        )}

        {elegido && (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Motivo del contacto</div>
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px",
                border: "1px solid var(--borde)", borderRadius: 7, marginBottom: 8 }} />
            <div style={{ background: "#fafbfc", border: "1px dashed var(--borde)", borderRadius: 8,
              padding: "9px 12px", fontSize: 12.5, lineHeight: 1.5, marginBottom: 8 }}>{vistaPrevia}</div>
            <div style={{ fontSize: 11, color: "var(--texto-suave)", marginBottom: 10 }}>
              {ventana === null ? "Verificando conversación previa…"
                : ventana ? "✓ Conversación abierta: se envía como mensaje normal."
                : "Sin conversación en 24h: se envía por plantilla aprobada de Meta."}
            </div>
          </>
        )}

        {error && <div style={{ color: "#791F1F", fontSize: 12, marginBottom: 8 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={() => ejecutar(false)} disabled={ocupado} style={{ fontSize: 12, padding: "7px 12px" }}>
            Solo tomar
          </button>
          <button onClick={() => ejecutar(true)} disabled={ocupado || !elegido || ventana === null}
            style={{ fontSize: 13, padding: "7px 16px", background: "var(--navy)", color: "#fff",
              border: "none", borderRadius: 7, cursor: "pointer", opacity: ocupado ? 0.6 : 1 }}>
            {ocupado ? "Enviando…" : conPlantilla ? "Tomar y enviar plantilla" : "Tomar y contactar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Ticketera() {
  const { analista } = useAuth();
  const [params, setParams] = useSearchParams();
  const casoParam = params.get("caso");
  const yaSalte = useRef(false);
  const [casos, setCasos] = useState([]);
  const [nombres, setNombres] = useState({});
  const [consultasLibres, setConsultasLibres] = useState([]);
  const [porTomar, setPorTomar] = useState(null);
  const [seleccionado, setSeleccionado] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true);
    setError("");
    const { data, error } = await sb
      .from("crm_inc_casos")
      .select("*")
      .order("fecha_caso", { ascending: false })
      .limit(200);
    if (error) {
      setError("No pudimos cargar los tickets. Reintenta en unos segundos.");
      setCargando(false);
      return;
    }
    const lista = data || [];
    setCasos(lista);
    // la selección por defecto respeta el mismo filtro de la cola
    const elegibles = lista.filter((c) => esDeHoyMX(c.fecha_caso) && (c.origen || "meli") === "meli" && Number(c.case_id) < 900000000);
    // si hay un ticket abierto en el panel, actualizarlo con los datos frescos
    // (dueño, estado): así el candado aparece/desaparece sin refrescar la página
    setSeleccionado((prev) => prev ? (lista.find((c) => c.id === prev.id) || prev) : (elegibles[0] || null));
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Enlace profundo desde el chat interno: /?caso=123456 abre ese ticket.
  // Se hace una sola vez y se limpia el parámetro, para no re-seleccionar
  // en cada recarga de la cola.
  useEffect(() => {
    if (!casoParam || yaSalte.current || !casos.length) return;
    const c = casos.find((x) => String(x.case_id) === String(casoParam));
    if (c) { setSeleccionado(c); yaSalte.current = true; setParams({}, { replace: true }); }
  }, [casoParam, casos, setParams]);

  // consultas abiertas y NO anidadas: candidatas a anidarse en una incidencia
  const cargarConsultas = useCallback(async () => {
    const { data } = await sb.from("crm_inc_casos")
      .select("id, case_id, codigo, conductor_nombre, conductor_telefono, fecha_caso")
      .eq("origen", "consulta")
      .in("estado_id", ["NEW", "OPEN", "ON_HOLD", "CHECKING"])
      .is("anidado_en_case_id", null)
      .order("fecha_caso", { ascending: false })
      .limit(50);
    setConsultasLibres(data || []);
  }, []);
  useEffect(() => { cargarConsultas(); }, [cargarConsultas]);

  async function anidarConsulta(incidencia, consultaCaseId) {
    const c = consultasLibres.find((x) => String(x.case_id) === String(consultaCaseId));
    const etiqueta = c ? `${c.codigo || "#" + c.case_id}${c.conductor_nombre ? " · " + c.conductor_nombre : ""}` : "esa consulta";
    if (!window.confirm(`¿Anidar ${etiqueta} en la incidencia ${incidencia.codigo || "#" + incidencia.case_id}?\n\nEl hilo de WhatsApp pasa a esta incidencia y la consulta se cierra.`)) return;
    const { error } = await sb.rpc("fn_anidar_consulta", {
      p_incidencia_id: incidencia.id, p_consulta_case_id: Number(consultaCaseId),
    });
    if (error) { alert("No se pudo anidar: " + error.message); return; }
    await Promise.all([cargar(), cargarConsultas()]);
  }

  // nombres de analistas (para "tomado por X")
  useEffect(() => {
    sb.from("crm_analistas").select("id, nombre").then(({ data }) => {
      setNombres(Object.fromEntries((data || []).map((a) => [a.id, a.nombre])));
    });
  }, []);

  // Realtime: cualquier cambio en los casos refresca la cola al instante
  useEffect(() => {
    const canal = sb.channel("ticketera-casos")
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_inc_casos" }, () => { cargar(); cargarConsultas(); })
      .subscribe();
    return () => { sb.removeChannel(canal); };
  }, [cargar]);

  // refresco automatico cada 30s
  useEffect(() => {
    const t = setInterval(cargar, 30000);
    return () => clearInterval(t);
  }, [cargar]);

  // Solo casos de HOY (el pasado vive en el historico, no en la cola).
  const casosHoy = casos.filter((c) => esDeHoyMX(c.fecha_caso) && (c.origen || "meli") === "meli" && Number(c.case_id) < 900000000);
  const abiertosHoy = casosHoy.filter((c) => esAbierto(c.estado_id, c.sub_estado_id));
  const cerradosHoy = casosHoy.filter((c) => !esAbierto(c.estado_id, c.sub_estado_id));
  // para la condicion de "vacio" y seleccion inicial
  const abiertos = abiertosHoy;

  async function tomar(caso) {
    // La base lo rechazaría igual; se avisa antes para no mostrar un error crudo.
    if (!puedeActuar(analista)) { alert("Tu usuario es de solo lectura."); return; }
    // ticket ajeno: traspaso declarado (sin panel de contacto)
    if (caso.analista_actual && caso.analista_actual !== analista?.id) {
      const dueno = nombres[caso.analista_actual] || "otro analista";
      if (!window.confirm(`Este ticket lo tiene ${dueno}. ¿Traspasártelo?`)) return;
      const { error } = await sb.rpc("fn_tomar_ticket", { p_caso_id: caso.id, p_forzar: true });
      if (error) { alert("No se pudo tomar el ticket: " + error.message); return; }
      cargar();
      return;
    }
    // ticket libre: abrir panel para elegir número y disparar el contacto
    setPorTomar(caso);
  }

  async function traspasar(caso, destino) {
    const nombre = nombres[destino] || "ese analista";
    if (!window.confirm(`¿Traspasar el ticket a ${nombre}?`)) return;
    const { error } = await sb.rpc("fn_traspasar_ticket", { p_caso_id: caso.id, p_destino: destino });
    if (error) { alert("No se pudo traspasar: " + error.message); return; }
    cargar();
  }

  // El cierre lleva un motivo del catálogo de MELI. Se guarda como decisión de
  // la torre (cierre_local) además de reflejarse en el estado: si MELI cierra
  // después con otro motivo, el monitor sobrescribe el estado pero la decisión
  // de la torre queda registrada y la divergencia se puede ver.
  async function resolver(caso, cierre, nota) {
    if (!puedeActuar(analista)) { alert("Tu usuario es de solo lectura."); return; }
    const { error } = await sb.rpc("fn_cerrar_ticket", {
      p_caso_id: caso.id,
      p_cierre: cierre || "CLOSED/FINISHED",
      p_nota: nota || null,
    });
    if (error) { alert("No se pudo cerrar: " + error.message); return; }
    cargar();
  }

  if (cargando && !casos.length) {
    return <div style={pantallaCentro}>Cargando tickets…</div>;
  }

  if (error && !casos.length) {
    return (
      <div style={pantallaCentro}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Algo falló al cargar</div>
          <div style={{ color: "var(--texto-suave)", marginBottom: 14 }}>{error}</div>
          <button className="btn-navy" onClick={cargar} style={{ padding: "8px 18px" }}>Reintentar</button>
        </div>
      </div>
    );
  }

  if (!casosHoy.length && !cargando) {
    return (
      <div style={pantallaCentro}>
        <div style={{ textAlign: "center", maxWidth: 360 }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Sin incidencias abiertas</div>
          <div style={{ color: "var(--texto-suave)" }}>
            Cuando entren casos nuevos desde MELI aparecerán aquí. La cola se refresca sola.
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div style={{
      display: "grid",
      gridTemplateColumns: "260px minmax(0, 1fr) 280px",
      height: "100%",
    }}>
      <ColaTickets
        casosHoy={abiertosHoy}
        cerradosHoy={cerradosHoy}
        seleccionado={seleccionado}
        onSeleccionar={setSeleccionado} consultasLibres={consultasLibres} onAnidar={anidarConsulta} totalHoy={casos.filter((c) => esDeHoyMX(c.fecha_caso) && (c.origen || "meli") === "meli" && Number(c.case_id) < 900000000).length}
        analistaId={analista?.id} nombres={nombres} onTraspasar={traspasar}
      />
      <HiloTicket
        caso={seleccionado}
        onTomar={tomar}
        onResolver={resolver}
        analistaId={analista?.id} nombres={nombres} onTraspasar={traspasar}
      />
      <PanelContexto caso={seleccionado} analistaId={analista?.id} />
    </div>
      {porTomar && (
        <PanelTomar caso={porTomar} analistaId={analista?.id}
          onCerrar={() => setPorTomar(null)}
          onListo={() => { setPorTomar(null); cargar(); }} />
      )}
    </>
  );
}

const pantallaCentro = {
  height: "100%", display: "flex", alignItems: "center",
  justifyContent: "center", color: "var(--texto-suave)",
};
