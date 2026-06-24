import { useAuth } from "../shared/auth.jsx";
import { NavLink } from "react-router-dom";
import { useAlertas } from "../shared/alertas.jsx";

function iniciales(nombre) {
  if (!nombre) return "··";
  return nombre.split(" ").slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

function Tab({ to, children, badge }) {
  return (
    <NavLink to={to} end style={({ isActive }) => ({
      color: isActive ? "#fff" : "#bcd0ec",
      fontSize: 13, fontWeight: isActive ? 600 : 400,
      padding: "5px 12px", borderRadius: 7,
      background: isActive ? "var(--navy-suave)" : "transparent",
      textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6,
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
  const { noLeidos, sonidoActivo, setSonidoActivo } = useAlertas();

  return (
    <header style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 18px", background: "var(--navy)", flexShrink: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, background: "var(--naranja)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontWeight: 700, fontSize: 15,
        }}>◉</div>
        <span style={{ color: "#fff", fontWeight: 600, fontSize: 16 }}>The Eyes</span>
        <span style={{ color: "#bcd0ec", fontSize: 12, paddingLeft: 12, borderLeft: "1px solid var(--navy-suave)" }}>
          Torre de soporte · {analista?.pais || "MX"}
        </span>
        <nav style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 10 }}>
          <Tab to="/">Tickets hoy</Tab>
          <Tab to="/consultas" badge={noLeidos}>Consultas en ruta</Tab>
          <Tab to="/historico">Histórico</Tab>
        </nav>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button onClick={() => setSonidoActivo(!sonidoActivo)}
          title={sonidoActivo ? "Sonido activado" : "Sonido silenciado"}
          style={{ background: "transparent", border: "none", color: "#bcd0ec", cursor: "pointer", fontSize: 16, padding: 2 }}>
          {sonidoActivo ? "🔔" : "🔕"}
        </button>
        <span style={{ color: "#bcd0ec", fontSize: 13 }}>{analista?.nombre}</span>
        <div style={{
          width: 28, height: 28, borderRadius: "50%", background: "var(--naranja)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontWeight: 500, fontSize: 12,
        }}>{iniciales(analista?.nombre)}</div>
        <button onClick={salir} style={{
          background: "transparent", border: "1px solid var(--navy-suave)",
          color: "#bcd0ec", fontSize: 12, padding: "5px 12px",
        }}>Salir</button>
      </div>
    </header>
  );
}
