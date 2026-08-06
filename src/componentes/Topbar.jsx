import { useAuth } from "../shared/auth.jsx";
import { NavLink } from "react-router-dom";
import { useAlertas } from "../shared/alertas.jsx";
import { useChatNoLeidos } from "../modulos/Mensajes.jsx";

function iniciales(nombre) {
  if (!nombre) return "··";
  return nombre.split(" ").slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

function Tab({ to, children, badge }) {
  return (
    <NavLink to={to} end style={({ isActive }) => ({
      color: isActive ? "#fff" : "#bcd0ec",
      fontSize: 12.5, fontWeight: isActive ? 600 : 400,
      padding: "5px 9px", borderRadius: 7,
      background: isActive ? "var(--navy-suave)" : "transparent",
      textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5,
      whiteSpace: "nowrap", flexShrink: 0,
    })}>
      {children}
      {badge > 0 && (
        <span style={{ fontSize: 10, fontWeight: 700, background: "var(--naranja)", color: "#fff",
          borderRadius: 10, padding: "1px 7px", minWidth: 18, textAlign: "center" }}>{badge}</span>
      )}
    </NavLink>
  );
}

export default function Topbar() {
  const { analista, salir } = useAuth();
  const { noLeidos, correosNoLeidos, sonidoActivo, setSonidoActivo } = useAlertas();
  const chatNoLeidos = useChatNoLeidos();

  return (
    <header style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "9px 16px", background: "var(--navy)", flexShrink: 0, gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        {/* Logo de Bigticket en blanco sobre el navy. Alto fijo y ancho automático
            para que no se deforme, y flexShrink 0 para que no lo aplaste el nav
            cuando hay muchas pestañas. */}
        <img src="/bigticket-blanco.png" alt="Bigticket"
          style={{ height: 22, width: "auto", flexShrink: 0, display: "block" }} />

        {/* Título y país agrupados en una columna: ocupan menos ancho horizontal
            que en línea, lo que deja más espacio para las pestañas. */}
        <div style={{
          paddingLeft: 12, borderLeft: "1px solid var(--navy-suave)",
          display: "flex", flexDirection: "column", justifyContent: "center",
          lineHeight: 1.15, flexShrink: 0,
        }}>
          <span style={{ color: "#fff", fontWeight: 600, fontSize: 14, whiteSpace: "nowrap" }}>
            Torre de Control
          </span>
          <span style={{ color: "#bcd0ec", fontSize: 10.5, letterSpacing: 0.4, whiteSpace: "nowrap" }}
            title={`Operación ${analista?.pais || "MX"}`}>
            {analista?.pais || "MX"}
          </span>
        </div>

        <nav style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: 2, overflowX: "auto" }}>
          <Tab to="/">Incidencias</Tab>
          <Tab to="/detalle-dia">Detalle</Tab>
          <Tab to="/consultas" badge={noLeidos}>Consultas</Tab>
          <Tab to="/correos" badge={correosNoLeidos}>Correos</Tab>
          <Tab to="/mensajes" badge={chatNoLeidos}>Mensajes</Tab>
          <Tab to="/bitacora">Bitácora</Tab>
          <Tab to="/directorio">Directorio</Tab>
          <Tab to="/anomalias">Anomalías</Tab>
          <Tab to="/historico">Histórico</Tab>
        </nav>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <button onClick={() => setSonidoActivo(!sonidoActivo)}
          title={sonidoActivo ? "Sonido activado" : "Sonido silenciado"}
          style={{ background: "transparent", border: "none", color: "#bcd0ec", cursor: "pointer", fontSize: 16, padding: 2 }}>
          {sonidoActivo ? "🔔" : "🔕"}
        </button>
        <span style={{ color: "#bcd0ec", fontSize: 12.5, whiteSpace: "nowrap", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis" }} title={analista?.nombre}>{analista?.nombre}</span>
        <div style={{
          width: 28, height: 28, borderRadius: "50%", background: "var(--naranja)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontWeight: 500, fontSize: 12,
        }}>{iniciales(analista?.nombre)}</div>
        <button onClick={salir} style={{
          background: "transparent", border: "1px solid var(--navy-suave)",
          color: "#bcd0ec", fontSize: 12, padding: "5px 11px", whiteSpace: "nowrap",
        }}>Salir</button>
      </div>
    </header>
  );
}
