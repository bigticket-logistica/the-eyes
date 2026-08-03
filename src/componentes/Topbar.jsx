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
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, background: "var(--naranja)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontWeight: 700, fontSize: 15,
        }}>◉</div>
        <span style={{ color: "#fff", fontWeight: 600, fontSize: 15, whiteSpace: "nowrap" }}>The Eyes</span>
        <span style={{ color: "#bcd0ec", fontSize: 11.5, paddingLeft: 10, borderLeft: "1px solid var(--navy-suave)", whiteSpace: "nowrap" }}
          title={`Torre de soporte · ${analista?.pais || "MX"}`}>
          {analista?.pais || "MX"}
        </span>
        <nav style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: 6, overflowX: "auto" }}>
          <Tab to="/">Incidencias</Tab>
          <Tab to="/detalle-dia">Detalle</Tab>
          <Tab to="/consultas" badge={noLeidos}>Consultas</Tab>
          <Tab to="/correos" badge={correosNoLeidos}>Correos</Tab>
          <Tab to="/mensajes" badge={chatNoLeidos}>Mensajes</Tab>
          <Tab to="/bitacora">Bitácora</Tab>
          <Tab to="/directorio">Directorio</Tab>
          <Tab to="/historico">Histórico</Tab>
          <Tab to="/meli">MELI</Tab>
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
