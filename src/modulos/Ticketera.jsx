import { useEffect, useState, useCallback } from "react";
import { sb } from "../shared/supabase.js";
import { useAuth } from "../shared/auth.jsx";
import { esAbierto } from "../shared/constantes.js";
import ColaTickets from "../componentes/ColaTickets.jsx";
import HiloTicket from "../componentes/HiloTicket.jsx";
import PanelContexto from "../componentes/PanelContexto.jsx";

export default function Ticketera() {
  const { analista } = useAuth();
  const [casos, setCasos] = useState([]);
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
    setCasos(data || []);
    setSeleccionado((prev) => prev || (data && data[0]) || null);
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // refresco automatico cada 30s
  useEffect(() => {
    const t = setInterval(cargar, 30000);
    return () => clearInterval(t);
  }, [cargar]);

  const abiertos = casos.filter((c) => esAbierto(c.estado_id));

  async function tomar(caso) {
    const { error } = await sb.rpc("fn_tomar_ticket", { p_caso_id: caso.id });
    if (!error) cargar();
  }

  async function resolver(caso) {
    const { error } = await sb.rpc("fn_resolver_ticket", { p_caso_id: caso.id, p_estado: "CLOSED" });
    if (!error) { cargar(); }
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

  if (!abiertos.length && !cargando) {
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
        casos={abiertos}
        seleccionado={seleccionado}
        onSeleccionar={setSeleccionado}
        analistaId={analista?.id}
      />
      <HiloTicket
        caso={seleccionado}
        onTomar={tomar}
        onResolver={resolver}
        analistaId={analista?.id}
      />
      <PanelContexto caso={seleccionado} />
    </div>
  );
}

const pantallaCentro = {
  height: "100%", display: "flex", alignItems: "center",
  justifyContent: "center", color: "var(--texto-suave)",
};
