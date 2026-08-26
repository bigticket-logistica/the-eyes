import { useState, useRef, useEffect } from "react";
import { useAuth } from "../shared/auth.jsx";
import { NavLink } from "react-router-dom";
import { useAlertas } from "../shared/alertas.jsx";
import { useChatNoLeidos } from "../modulos/Mensajes.jsx";
import { usePnrSinVer } from "../modulos/Posventa.jsx";

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

// ── Panel de sonido, detrás de la campana ──────────────────────────────────
// Antes la campana era solo encendido/apagado. El volumen tiene que poder
// ajustarse: en una torre con ruido "normal" no alcanza, y en una oficina
// callada "fuerte" molesta. Se prueba al elegir — sin escucharlo no hay forma
// de calibrarlo.
const OPCIONES = [
  { clave: "silencio", etiqueta: "Silencio", pista: "sin ningún aviso" },
  { clave: "suave",    etiqueta: "Suave",    pista: "oficina callada" },
  { clave: "normal",   etiqueta: "Normal",   pista: "recomendado" },
  { clave: "fuerte",   etiqueta: "Fuerte",   pista: "torre con ruido" },
];

function PanelSonido({ nivelSonido, setNivelSonido, sonidoActivo, setSonidoActivo, probarSonido }) {
  const [abierto, setAbierto] = useState(false);
  const caja = useRef(null);

  // Cerrar al hacer clic afuera. Sin esto el panel queda pegado y tapa las
  // pestañas de la derecha.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e) => { if (caja.current && !caja.current.contains(e.target)) setAbierto(false); };
    document.addEventListener("pointerdown", fuera);
    return () => document.removeEventListener("pointerdown", fuera);
  }, [abierto]);

  const actual = sonidoActivo ? nivelSonido : "silencio";

  function elegir(clave) {
    if (clave === "silencio") { setSonidoActivo(false); return; }
    setSonidoActivo(true);
    setNivelSonido(clave);   // suena al elegir, para calibrar
  }

  return (
    <div ref={caja} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setAbierto((v) => !v)}
        title={sonidoActivo ? `Sonido: ${nivelSonido}` : "Sonido silenciado"}
        style={{ background: "transparent", border: "none", color: "#bcd0ec",
          cursor: "pointer", fontSize: 16, padding: 2 }}>
        {sonidoActivo ? "🔔" : "🔕"}
      </button>

      {abierto && (
        <div style={{ position: "absolute", right: 0, top: 30, zIndex: 9998,
          background: "#fff", border: "1px solid var(--borde)", borderRadius: 10,
          boxShadow: "0 6px 22px rgba(0,0,0,.18)", padding: 8, width: 210 }}>
          <div style={{ fontSize: 10.5, color: "var(--texto-suave)", padding: "2px 6px 6px" }}>
            Volumen del aviso
          </div>
          {OPCIONES.map((o) => (
            <button key={o.clave} onClick={() => elegir(o.clave)}
              style={{ display: "flex", width: "100%", alignItems: "baseline", gap: 6,
                textAlign: "left", background: actual === o.clave ? "var(--naranja-suave)" : "transparent",
                border: "none", borderRadius: 7, padding: "6px 8px", cursor: "pointer",
                fontSize: 12.5, color: "var(--texto)" }}>
              <span style={{ fontWeight: actual === o.clave ? 600 : 400 }}>{o.etiqueta}</span>
              <span style={{ fontSize: 10.5, color: "var(--texto-tenue)" }}>{o.pista}</span>
              {actual === o.clave && <span style={{ marginLeft: "auto", color: "var(--naranja)" }}>✓</span>}
            </button>
          ))}
          <div style={{ borderTop: "1px solid var(--borde)", marginTop: 6, paddingTop: 6,
            display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={probarSonido} disabled={!sonidoActivo}
              style={{ fontSize: 11.5, padding: "4px 10px" }}>
              🔊 Probar
            </button>
            <span style={{ fontSize: 9.5, color: "var(--texto-tenue)", lineHeight: 1.3 }}>
              Un conductor suena 3 veces
            </span>
          </div>
          <div style={{ fontSize: 9.5, color: "var(--texto-tenue)", padding: "6px 6px 0", lineHeight: 1.35 }}>
            Si aun en "Fuerte" no se escucha, revisa el volumen del equipo: el
            navegador no puede pasar de ahí.
          </div>
        </div>
      )}
    </div>
  );
}

export default function Topbar() {
  const { analista, salir } = useAuth();
  const { noLeidos, correosNoLeidos, sonidoActivo, setSonidoActivo,
          nivelSonido, setNivelSonido, probarSonido } = useAlertas();
  const chatNoLeidos = useChatNoLeidos();
  const pnrSinVer = usePnrSinVer();

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
          {/* Posventa va después de Anomalías: las dos se miran cuando el día
              operativo ya cerró, a diferencia de las primeras que se usan en
              vivo. El contador de casos por vencer se cablea cuando exista el
              hook; hoy la pestaña entra sin badge para no pedir una consulta
              más en cada carga de la torre. */}
          <Tab to="/posventa" badge={pnrSinVer}>Posventa</Tab>
          {/* Salud es una pantalla de infraestructura, no de operación: se
              muestra solo a quien la mantiene. La lista está acá y no en la base
              porque cambia poco y así no hay una consulta más en cada carga. */}
          {/* Por rol y no por correo en duro: crm_analistas ya tiene rol='admin'.
              La pestaña oculta es solo comodidad; el bloqueo real está en la
              propia página y en fn_metricas_analistas, que rechaza a quien no
              sea admin aunque llame la API directo. */}
          {analista?.rol === "admin" && <Tab to="/salud">Salud</Tab>}
          <Tab to="/historico">Histórico</Tab>
        </nav>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <PanelSonido nivelSonido={nivelSonido} setNivelSonido={setNivelSonido}
          sonidoActivo={sonidoActivo} setSonidoActivo={setSonidoActivo}
          probarSonido={probarSonido} />
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
