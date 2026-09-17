import { useState, useEffect, useCallback } from "react";
import { sb } from "../shared/supabase.js";

// ═══════════════════════════════════════════════════════════════════════════
// AVISOS FALLIDOS · el aviso que Meta no pudo entregar
//
// POR QUÉ EXISTE
//   Un aviso que falla no se ve en ninguna parte: el analista aprieta
//   Notificar, el chip se pone verde porque el mensaje se encoló, y el chofer
//   nunca recibe nada. Se descubrió por un caso que mandó 1226 mensajes al
//   mismo número muerto sin que nadie se enterara.
//
//   Acá el fallo se muestra con su motivo, y el analista puede escribir otro
//   número y reenviar sin salir de la ficha.
//
// QUÉ SE MUESTRA Y QUÉ NO
//   Solo el ÚLTIMO intento por destinatario. Un número malo puede tener cientos
//   de fallos del mismo tipo y listarlos no agrega nada: lo que el analista
//   necesita saber es "a este número no le llega, ¿a cuál mando?".
//
//   Y no se muestra si después hubo un envío bueno a ese mismo destinatario:
//   el problema ya se resolvió, solo o porque alguien corrigió el directorio.
//
// LOS CÓDIGOS DE META
//   Vienen en raw.wa_error.code. El webhook los fusiona con el raw en vez de
//   reemplazarlo — reemplazarlo borraba la marca del aviso y causaba el ciclo
//   infinito. raw.wa_intentos lleva la cuenta.
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  ladrillo: "#9e3b1b", ladrilloTenue: "#faece6",
  naranja: "#F47B20", naranjaTenue: "#fdf1e6",
  gris: "#8a94a6",
};

// Qué significa cada código, en palabras que le sirvan al analista para decidir
// qué hacer. Lo que Meta devuelve es "Message undeliverable", que no dice nada.
const MOTIVOS = {
  131026: {
    corto: "Ese número no recibe WhatsApp",
    largo: "El número no tiene cuenta de WhatsApp, o la tiene pero no puede recibir mensajes de empresas. Reintentar no sirve: hay que conseguir otro número.",
  },
  131047: {
    corto: "Pasaron más de 24 horas sin respuesta",
    largo: "La ventana de conversación se cerró. Solo se puede mandar una plantilla aprobada, no texto libre.",
  },
  131051: {
    corto: "Tipo de mensaje no soportado",
    largo: "Meta rechazó el formato del mensaje.",
  },
  132000: {
    corto: "Faltan datos en la plantilla",
    largo: "Alguna variable de la plantilla llegó vacía. Es un problema del caso, no del número: revisa que tenga producto, ruta y monto cargados.",
  },
  132001: {
    corto: "La plantilla no existe",
    largo: "El nombre o el idioma de la plantilla no coinciden con ninguna aprobada en esta cuenta de WhatsApp.",
  },
  131049: {
    corto: "Meta limitó la entrega",
    largo: "Meta decidió no entregar este mensaje para cuidar la experiencia del usuario. Suele pasar con envíos repetidos al mismo número.",
  },
  470: {
    corto: "Pasaron más de 24 horas sin respuesta",
    largo: "La ventana de conversación se cerró y el mensaje necesitaba una plantilla.",
  },
};

function motivoDe(codigo) {
  return MOTIVOS[codigo] || {
    corto: `Meta rechazó el envío (código ${codigo || "?"})`,
    largo: "No tenemos una explicación para este código. Si se repite, conviene revisarlo con el detalle del error.",
  };
}

function horaMX(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-MX", {
    timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export default function AvisosFallidos({ caseId, onNotificar }) {
  const [fallos, setFallos] = useState([]);
  const [abierto, setAbierto] = useState(null);
  const [nuevoTel, setNuevoTel] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);

  const cargar = useCallback(async () => {
    if (!caseId) return;
    // Los salientes del caso, del más nuevo al más viejo. Con 200 alcanza:
    // solo se necesita el último por destinatario y si hubo uno bueno después.
    const { data, error } = await sb.from("pnr_mensajes_mx")
      .select("id, telefono, conversacion_id, estado_entrega, creado_en, raw")
      .eq("case_id", caseId).eq("direccion", "saliente")
      .order("creado_en", { ascending: false })
      .limit(200);
    if (error || !data) { setFallos([]); return; }

    // Un destinatario es un teléfono. Del más nuevo al más viejo: el primero
    // que aparece manda. Si ese fue bueno, no hay nada que avisar.
    const porTelefono = new Map();
    for (const m of data) {
      const k = String(m.telefono || "");
      if (!k || porTelefono.has(k)) continue;
      porTelefono.set(k, m);
    }

    const malos = [];
    for (const [tel, m] of porTelefono) {
      if (m.estado_entrega !== "fallido") continue;
      const raw = m.raw && typeof m.raw === "object" ? m.raw : {};
      const err = raw.wa_error || {};
      malos.push({
        telefono: tel,
        id: m.id,
        cuando: m.creado_en,
        codigo: err.code || null,
        intentos: Number(raw.wa_intentos || 0),
        // Con qué tipo de aviso falló: así el reenvío manda el mismo, no uno
        // distinto que confundiría al que lo reciba.
        tipo: raw.aviso || "cambio",
        // Los parámetros traen el nombre en la primera posición.
        quien: Array.isArray(raw.parametros) ? raw.parametros[0] : null,
        plantilla: raw.plantilla || null,
      });
    }
    setFallos(malos);
  }, [caseId]);

  useEffect(() => { cargar(); }, [cargar]);

  async function reenviar(f) {
    const tel = nuevoTel.replace(/\D/g, "");
    if (tel.length < 10) {
      setResultado({ ok: false, texto: "El número necesita al menos 10 dígitos." });
      return;
    }
    setEnviando(true);
    setResultado(null);
    try {
      // Mismo tipo de aviso que falló, y el número escrito a mano. fn_pnr_avisar
      // ya acepta p_telefono, y además deja ese número como el último usado del
      // caso: los avisos automáticos que vengan después lo van a respetar.
      const r = onNotificar ? await onNotificar(caseId, f.tipo, null, tel) : null;
      const bien = r && (r.ok || r.conductor?.ok || r.supervisor?.ok);
      setResultado(bien
        ? { ok: true, texto: "Encolado. En un minuto se ve si Meta lo entregó." }
        : { ok: false, texto: (r && (r.error || r.conductor?.error || r.supervisor?.error)) || "No se pudo encolar." });
      if (bien) {
        setNuevoTel("");
        setTimeout(() => { cargar(); setAbierto(null); }, 4000);
      }
    } catch (e) {
      setResultado({ ok: false, texto: String(e.message || e) });
    }
    setEnviando(false);
  }

  if (!fallos.length) return null;

  return (
    <div style={{ border: `1px solid ${C.ladrillo}44`, borderRadius: 10,
      background: C.ladrilloTenue, padding: "9px 11px", marginBottom: 8 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: C.ladrillo, marginBottom: 6 }}>
        {fallos.length === 1 ? "Un aviso no llegó" : `${fallos.length} avisos no llegaron`}
      </div>

      {fallos.map((f) => {
        const m = motivoDe(f.codigo);
        const esteAbierto = abierto === f.telefono;
        return (
          <div key={f.telefono} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 11.5, color: "var(--texto)", lineHeight: 1.5 }}>
              <strong>{f.quien || "destinatario"}</strong>
              <span style={{ color: C.gris }}> · {f.telefono}</span>
              <br />
              {m.corto}.
              {f.intentos > 1 && (
                <span style={{ color: C.gris }}> Se intentó {f.intentos} veces.</span>
              )}
              <span style={{ color: C.gris }}> Último: {horaMX(f.cuando)}.</span>
            </div>

            <div style={{ fontSize: 11, color: C.gris, lineHeight: 1.45, marginTop: 2 }}>
              {m.largo}
            </div>

            {!esteAbierto ? (
              <button onClick={() => { setAbierto(f.telefono); setResultado(null); }}
                style={{ marginTop: 5, fontSize: 11, padding: "4px 9px", borderRadius: 7,
                  cursor: "pointer", border: `1px solid ${C.naranja}`,
                  background: C.naranjaTenue, color: C.naranja, fontWeight: 600 }}>
                Enviar a otro número
              </button>
            ) : (
              <div style={{ marginTop: 6, display: "flex", gap: 5, alignItems: "center",
                flexWrap: "wrap" }}>
                <input value={nuevoTel} onChange={(e) => setNuevoTel(e.target.value)}
                  placeholder="55 1234 5678" inputMode="numeric"
                  style={{ flex: "1 1 140px", minWidth: 120, fontSize: 11.5,
                    padding: "5px 8px", borderRadius: 7, border: "1px solid var(--borde)" }} />
                <button onClick={() => reenviar(f)} disabled={enviando}
                  style={{ fontSize: 11, padding: "5px 10px", borderRadius: 7,
                    cursor: "pointer", border: "none", background: C.naranja,
                    color: "#fff", fontWeight: 600 }}>
                  {enviando ? "…" : "Enviar"}
                </button>
                <button onClick={() => { setAbierto(null); setResultado(null); }}
                  style={{ fontSize: 11, padding: "5px 9px", borderRadius: 7,
                    cursor: "pointer", border: "1px solid var(--borde)",
                    background: "#fff", color: "var(--texto-suave)" }}>
                  Cancelar
                </button>
              </div>
            )}

            {esteAbierto && resultado && (
              <div style={{ fontSize: 11, marginTop: 4,
                color: resultado.ok ? "#1f7a5c" : C.ladrillo }}>
                {resultado.texto}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
