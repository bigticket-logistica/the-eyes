import { useState } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// BOTÓN DE LLAMADA · placeholder
//
// La integración de voz existe del lado del servidor (the-eyes-voz.cjs, Twilio),
// pero está esperando el número mexicano y su trámite regulatorio. Este botón
// muestra dónde va a estar y qué va a hacer, sin fingir que funciona: al
// apretarlo dice explícitamente que está pendiente.
//
// Se prefiere esto a un botón oculto porque en una demo importa mostrar el
// recorrido completo, y a un botón que aparente funcionar porque eso genera
// una expectativa falsa.
// ═══════════════════════════════════════════════════════════════════════════

export default function BotonLlamar({ telefono, nombre, disabled }) {
  const [aviso, setAviso] = useState(false);
  if (!telefono) return null;

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setAviso(!aviso)} disabled={disabled}
        title={`Llamar a ${nombre || telefono}`}
        style={{ padding: "9px 11px", fontSize: 15, lineHeight: 1 }}>
        📞
      </button>

      {aviso && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 50,
          background: "#fff", border: "1px solid var(--borde)", borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,.14)", padding: "12px 14px", width: 260,
          fontSize: 12, lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 5 }}>Llamada de voz</div>
          <div style={{ color: "var(--texto-suave)" }}>
            Llamar a <b>{nombre || telefono}</b> desde el navegador, con grabación y
            registro en el ticket.
          </div>
          <div style={{
            marginTop: 8, padding: "6px 8px", background: "#fffbeb",
            border: "1px solid #fde68a", borderRadius: 7, color: "#92400e", fontSize: 11,
          }}>
            Pendiente del número mexicano y su trámite regulatorio.
          </div>
          <button onClick={() => setAviso(false)}
            style={{ fontSize: 11, padding: "4px 10px", marginTop: 8 }}>Entendido</button>
        </div>
      )}
    </div>
  );
}
