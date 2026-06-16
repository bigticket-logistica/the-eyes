import { useAuth } from "../shared/auth.jsx";

function iniciales(nombre) {
  if (!nombre) return "··";
  return nombre.split(" ").slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

export default function Topbar() {
  const { analista, salir } = useAuth();

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
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
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
