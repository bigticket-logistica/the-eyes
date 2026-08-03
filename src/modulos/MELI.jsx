import { useState, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// MELI · Portal embebido
//
// El portal no manda X-Frame-Options ni CSP frame-ancestors, así que el
// navegador permite el iframe. Quedan dos cosas que solo se ven en uso real:
//
//   1. COOKIES. El iframe es contexto cross-site. Si las cookies de sesión de
//      MELI son SameSite=Lax, el navegador NO las manda y vas a ver el login
//      dentro del marco por más veces que entres. Si son SameSite=None, todo
//      funciona igual que en una pestaña normal.
//   2. FRAME-BUSTING. Algunas apps detectan window.top !== window.self y se
//      salen del marco por su cuenta. Se nota al instante: el marco queda
//      blanco o te saca a una pestaña nueva.
//
// Para los dos casos existe el botón "Abrir aparte", que abre el portal en
// una ventana dimensionada para quedar al lado de The Eyes. Y si esto
// resultara inestable, la alternativa buena es el panel lateral de Chrome
// sobre la extensión Don B, que ya está instalada en las máquinas.
// ═══════════════════════════════════════════════════════════════════════════

const BASE = "https://envios.adminml.com";

const ATAJOS = [
  { label: "Inicio",   url: `${BASE}/` },
  { label: "Reportes", url: `${BASE}/carriers/reports` },
];

export default function MELI() {
  const [url, setUrl] = useState(ATAJOS[0].url);
  const [campo, setCampo] = useState(ATAJOS[0].url);
  const [recarga, setRecarga] = useState(0);
  const iframeRef = useRef(null);

  function ir(destino) {
    const u = (destino || campo).trim();
    if (!u) return;
    const final = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    setUrl(final);
    setCampo(final);
    setRecarga((n) => n + 1);
  }

  // Ventana al lado: media pantalla a la derecha, para trabajar en paralelo.
  function abrirAparte() {
    const w = Math.floor(window.screen.availWidth / 2);
    const h = window.screen.availHeight;
    window.open(url, "meli_portal",
      `width=${w},height=${h},left=${window.screen.availWidth - w},top=0`);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#fff" }}>
      {/* Barra de navegación */}
      <div style={{
        padding: "8px 12px", borderBottom: "1px solid var(--borde)",
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0,
      }}>
        {ATAJOS.map((a) => (
          <button key={a.url} onClick={() => ir(a.url)}
            style={{
              fontSize: 12, padding: "6px 11px", whiteSpace: "nowrap",
              border: "1px solid var(--borde)", borderRadius: 7,
              background: url === a.url ? "var(--navy)" : "#fff",
              color: url === a.url ? "#fff" : "var(--texto)",
            }}>
            {a.label}
          </button>
        ))}

        <input
          value={campo}
          onChange={(e) => setCampo(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") ir(); }}
          placeholder="URL del portal…"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 220, fontSize: 12, padding: "7px 10px",
            border: "1px solid var(--borde)", borderRadius: 7, fontFamily: "monospace",
          }} />

        <button onClick={() => ir()} style={{ fontSize: 12, padding: "6px 11px" }}>Ir</button>
        <button onClick={() => setRecarga((n) => n + 1)} title="Recargar el marco"
          style={{ fontSize: 12, padding: "6px 11px" }}>↻</button>
        <button className="btn-naranja" onClick={abrirAparte}
          title="Abrir el portal en una ventana al lado, por si el marco no carga"
          style={{ fontSize: 12, padding: "6px 12px", whiteSpace: "nowrap" }}>
          Abrir aparte ↗
        </button>
      </div>

      {/* El portal */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--fondo)" }}>
        <iframe
          key={recarga}
          ref={iframeRef}
          src={url}
          title="Portal MELI"
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          allow="clipboard-read; clipboard-write; geolocation"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>

      {/* Nota de pie: explica el único fallo probable sin alarmar */}
      <div style={{
        padding: "6px 12px", borderTop: "1px solid var(--borde)", flexShrink: 0,
        fontSize: 11, color: "var(--texto-tenue)", background: "#f8fafc",
      }}>
        Si aparece la pantalla de login aunque ya tengas sesión abierta en otra pestaña, el navegador
        está bloqueando las cookies de MELI dentro del marco. Usa <b>Abrir aparte</b>.
      </div>
    </div>
  );
}
