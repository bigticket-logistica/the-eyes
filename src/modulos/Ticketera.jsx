import { useEffect, useState, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { esAbierto } from "../shared/constantes.js";
import { esDeHoyMX } from "../shared/fechas.js";
import ColaTickets from "../componentes/ColaTickets.jsx";
import HiloTicket from "../componentes/HiloTicket.jsx";
import PanelContexto from "../componentes/PanelContexto.jsx";

export default function Ticketera() {
  const { analista } = useAuth();
  const [casos, setCasos] = useState([]);
  const [nombres, setNombres] = useState({});
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
    setSeleccionado((prev) => prev || elegibles[0] || null);
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // nombres de analistas (para "tomado por X")
  useEffect(() => {
    sb.from("crm_analistas").select("id, nombre").then(({ data }) => {
      setNombres(Object.fromEntries((data || []).map((a) => [a.id, a.nombre])));
    });
  }, []);

  // Realtime: cualquier cambio en los casos refresca la cola al instante
  useEffect(() => {
    const canal = sb.channel("ticketera-casos")
      .on("postgres_changes", { event: "*", schema: "public", table: "crm_inc_casos" }, () => cargar())
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
    // sobre un ticket ajeno, el clic es un traspaso declarado
    const forzar = !!(caso.analista_actual && caso.analista_actual !== analista?.id);
    if (forzar) {
      const dueno = nombres[caso.analista_actual] || "otro analista";
      if (!window.confirm(`Este ticket lo tiene ${dueno}. ¿Traspasártelo?`)) return;
    }
    const { error } = await sb.rpc("fn_tomar_ticket", { p_caso_id: caso.id, p_forzar: forzar });
    if (error) {
      // perdió el empate: alguien lo tomó un instante antes
      alert(error.message.includes("ya tomado") ? error.message : "No se pudo tomar el ticket: " + error.message);
      cargar();
      return;
    }
    cargar();
  }

  async function traspasar(caso, destino) {
    const nombre = nombres[destino] || "ese analista";
    if (!window.confirm(`¿Traspasar el ticket a ${nombre}?`)) return;
    const { error } = await sb.rpc("fn_traspasar_ticket", { p_caso_id: caso.id, p_destino: destino });
    if (error) { alert("No se pudo traspasar: " + error.message); return; }
    cargar();
  }

  async function resolver(caso) {
    const { error } = await sb.rpc("fn_resolver_ticket", { p_caso_id: caso.id, p_estado: "CLOSED" });
    if (error) { alert("No se pudo resolver: " + error.message); return; }
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
    <div style={{
      display: "grid",
      gridTemplateColumns: "260px minmax(0, 1fr) 280px",
      height: "100%",
    }}>
      <ColaTickets
        casosHoy={abiertosHoy}
        cerradosHoy={cerradosHoy}
        seleccionado={seleccionado}
        onSeleccionar={setSeleccionado}
        analistaId={analista?.id} nombres={nombres} onTraspasar={traspasar}
      />
      <HiloTicket
        caso={seleccionado}
        onTomar={tomar}
        onResolver={resolver}
        analistaId={analista?.id} nombres={nombres} onTraspasar={traspasar}
      />
      <PanelContexto caso={seleccionado} />
    </div>
  );
}

const pantallaCentro = {
  height: "100%", display: "flex", alignItems: "center",
  justifyContent: "center", color: "var(--texto-suave)",
};
