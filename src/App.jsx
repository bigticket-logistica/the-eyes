import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./shared/auth.jsx";
import Login from "./modulos/Login.jsx";
import Ticketera from "./modulos/Ticketera.jsx";
import Historico from "./modulos/Historico.jsx";
import Consultas from "./modulos/Consultas.jsx";
import DetalleDia from "./modulos/DetalleDia.jsx";
import Directorio from "./modulos/Directorio.jsx";
import Bitacora from "./modulos/Bitacora.jsx";
import Correos from "./modulos/Correos.jsx";
import Mensajes from "./modulos/Mensajes.jsx";
import Anomalias from "./modulos/Anomalias.jsx";
import Posventa from "./modulos/Posventa.jsx";
import Salud from "./modulos/Salud.jsx";
import Topbar from "./componentes/Topbar.jsx";
import { AlertasProvider, ContenedorToasts } from "./shared/alertas.jsx";

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
    <AlertasProvider>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <Topbar />
        <div style={{ flex: 1, overflow: "hidden" }}>
          <Routes>
            <Route path="/" element={<Ticketera />} />
            <Route path="/detalle-dia" element={<DetalleDia />} />
            <Route path="/correos" element={<Correos />} />
            <Route path="/bitacora" element={<Bitacora />} />
            <Route path="/directorio" element={<Directorio />} />
            <Route path="/historico" element={<Historico />} />
            <Route path="/consultas" element={<Consultas />} />
            <Route path="/mensajes" element={<Mensajes />} />
            <Route path="/anomalias" element={<Anomalias />} />
            {/* Posventa nace con PNR. Las devoluciones entran después como una
                segunda vista dentro del mismo módulo, por eso la ruta es
                /posventa y no /pnr: la pestaña no tiene que cambiar de nombre
                cuando llegue lo que sigue. */}
            <Route path="/posventa" element={<Posventa />} />
            <Route path="/salud" element={<Salud />} />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
      <ContenedorToasts />
    </AlertasProvider>
  );
}
