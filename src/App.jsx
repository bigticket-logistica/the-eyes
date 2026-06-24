import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./shared/auth.jsx";
import Login from "./modulos/Login.jsx";
import Ticketera from "./modulos/Ticketera.jsx";
import Historico from "./modulos/Historico.jsx";
import Topbar from "./componentes/Topbar.jsx";

function Cargando() {
  return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--texto-suave)" }}>
      Cargando…
    </div>
  );
}

export default function App() {
  const { sesion, analista, cargando } = useAuth();

  if (cargando) return <Cargando />;

  // Sin sesión: solo login
  if (!sesion) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Con sesión pero sin perfil de analista: aviso
  if (!analista) {
    return (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Tu cuenta aún no está habilitada como analista</div>
        <div style={{ color: "var(--texto-suave)", maxWidth: 420 }}>
          Pídele a un administrador que registre tu usuario en la tabla de analistas para acceder a la torre.
        </div>
      </div>
    );
  }

  // Sesión + analista: app completa
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <Topbar />
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Routes>
          <Route path="/" element={<Ticketera />} />
          <Route path="/historico" element={<Historico />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
