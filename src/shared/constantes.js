export const COLORES = {
  navy: "#1a3a6b",
  navySuave: "#3a5a8a",
  naranja: "#F47B20",
  naranjaSuave: "#FDEEDF",
  fondo: "#f7f8fa",
  borde: "#e4e7ec",
  texto: "#1f2937",
  textoSuave: "#6b7280",
  textoTenue: "#9ca3af",
};

// Estados de MELI -> etiqueta y color del pill (taxonomia real del portal).
// El estado mostrado depende de estado_id + sub_estado_id juntos.
export const ESTADOS = {
  NEW:       { label: "Nuevo",                bg: "#dbeafe", color: "#1e40af" },
  OPEN:      { label: "Abierto",              bg: "#fef3c7", color: "#92400e" },
  ON_HOLD:   { label: "Esperando respuesta",  bg: "#f3e8ff", color: "#6b21a8" },
  CHECKING:  { label: "Comprobando factibilidad", bg: "#e0f2fe", color: "#075985" },
  CLOSED:    { label: "Cerrado",              bg: "#dcfce7", color: "#166534" },
  CANCELLED: { label: "Anulado",              bg: "#f1f5f9", color: "#475569" },
  EXPIRED:   { label: "Anulado",              bg: "#f1f5f9", color: "#475569" },
};

// Diccionario fino por estado_id + sub_estado_id (confirmado con datos reales).
// Da el label exacto que muestra el portal MELI.
export const ESTADOS_DETALLE = {
  "NEW/CREATED":              { label: "Nuevo",                                bg: "#dbeafe", color: "#1e40af", gestion: true },
  "OPEN/ASSIGNED":            { label: "Abierto",                              bg: "#fef3c7", color: "#92400e", gestion: true },
  "ON_HOLD/ANSWER_PENDING":   { label: "Esperando respuesta",                  bg: "#f3e8ff", color: "#6b21a8", gestion: true },
  "ON_HOLD/RESEQUENCING":     { label: "Comprobando factibilidad",             bg: "#e0f2fe", color: "#075985", gestion: true },
  "CLOSED/RESOLVED":          { label: "Cerrado · con reintento",              bg: "#dcfce7", color: "#166534", gestion: false },
  "CLOSED/UNSOLVED":          { label: "Cerrado · sin reintento",              bg: "#dcfce7", color: "#166534", gestion: false },
  "CLOSED/NOT_SUGGESTION":    { label: "Cerrado · sin sugerencia",             bg: "#dcfce7", color: "#166534", gestion: false },
  "CLOSED/FINISHED":          { label: "Cerrado",                              bg: "#dcfce7", color: "#166534", gestion: false },
  "CANCELLED/EXPIRED":        { label: "Anulado",                              bg: "#f1f5f9", color: "#475569", gestion: false },
};

// Resuelve el detalle de estado a partir de estado_id + sub_estado_id.
// Si no encuentra la combinacion exacta, cae al estado base; y si tampoco,
// asume "sin gestion" (lo seguro: no lo deja en la cola de pendientes).
export function detalleEstado(estadoId, subEstadoId) {
  const clave = `${estadoId}/${subEstadoId}`;
  if (ESTADOS_DETALLE[clave]) return ESTADOS_DETALLE[clave];
  const base = ESTADOS[estadoId];
  if (base) return { ...base, gestion: ESTADOS_ABIERTOS.includes(estadoId) };
  return { label: estadoId || "—", bg: "#f1f5f9", color: "#475569", gestion: false };
}

// Prioridad de MELI (se respeta tal cual)
export const PRIORIDADES = {
  VERY_HIGH: { label: "Muy alta", bg: "#FCEBEB", color: "#791F1F", peso: 4 },
  HIGH:      { label: "Alta",     bg: "#FAEEDA", color: "#633806", peso: 3 },
  MEDIUM:    { label: "Media",    bg: "#E6F1FB", color: "#0C447C", peso: 2 },
  LOW:       { label: "Baja",     bg: "#f1f5f9", color: "#475569", peso: 1 },
};

// Grupo del motivo (del catalogo)
export const GRUPOS = {
  critico:    { label: "Crítico",    bg: "#FCEBEB", color: "#791F1F" },
  accionable: { label: "Accionable", bg: "#FAEEDA", color: "#633806" },
  entrega:    { label: "Entrega",    bg: "#E1F5EE", color: "#085041" },
};

// Estados base considerados "abiertos" (requieren gestion)
export const ESTADOS_ABIERTOS = ["NEW", "OPEN", "ON_HOLD", "CHECKING"];
// Un caso requiere gestion segun el diccionario fino (estado + sub_estado)
export const esAbierto = (estadoId, subEstadoId) => detalleEstado(estadoId, subEstadoId).gestion;
export const esCerrado = (estadoId, subEstadoId) => !esAbierto(estadoId, subEstadoId);

// Motivos de MELI -> etiqueta en español legible
export const MOTIVOS = {
  ROBBERY:             "Robo",
  ACCIDENT:            "Tuvo un accidente",
  MECHANICAL_PROBLEM:  "Problema mecánico",
  PERSONAL_PROBLEM:    "No puede seguir conduciendo",
  MISSING_PACKAGE:     "El paquete se perdió",
  BUYER_ABSENT:        "No había nadie en el domicilio",
  BAD_ADDRESS:         "El domicilio es incorrecto",
  INACCESSIBLE_ADDRESS:"Está en una zona inaccesible",
  BUSINESS_CLOSED:     "Negocio cerrado",
  BUYER_MOVED:         "El comprador cambió de domicilio",
  MISSROUTED:          "El paquete no pertenece a mi zona",
  PNR_ON_ROUTE:        "PNR en ruta",
  NOT_RECEIVED:        "El paquete fue rechazado",
  BROKEN_PACKAGE:      "El producto está dañado",
  UNVISITED_ADDRESS:   "Domicilio no visitado",
  LM_COLLECT_PROBLEM:  "Problema con la colecta",
};

export const motivoLegible = (motivoId, fallback) =>
  MOTIVOS[motivoId] || fallback || motivoId || "Incidencia";

export const estiloEstado    = (e) => ESTADOS[e]      || { label: e || "—", bg: "#f1f5f9", color: "#475569" };
export const estiloPrioridad = (p) => PRIORIDADES[p]  || { label: p || "—", bg: "#f1f5f9", color: "#475569", peso: 0 };
export const estiloGrupo     = (g) => GRUPOS[g]       || { label: g || "—", bg: "#f1f5f9", color: "#475569" };
