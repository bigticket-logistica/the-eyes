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

// Estados de MELI -> etiqueta y color del pill
export const ESTADOS = {
  NEW:       { label: "Nuevo",                bg: "#dbeafe", color: "#1e40af" },
  OPEN:      { label: "Abierto",              bg: "#fef3c7", color: "#92400e" },
  ON_HOLD:   { label: "Esperando respuesta",  bg: "#f3e8ff", color: "#6b21a8" },
  CLOSED:    { label: "Cerrado",              bg: "#dcfce7", color: "#166534" },
  CANCELLED: { label: "Cancelado",            bg: "#f1f5f9", color: "#475569" },
};

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

// Estados considerados "abiertos" (cola activa)
export const ESTADOS_ABIERTOS = ["NEW", "OPEN", "ON_HOLD"];
export const esAbierto = (estado) => ESTADOS_ABIERTOS.includes(estado);

export const estiloEstado    = (e) => ESTADOS[e]      || { label: e || "—", bg: "#f1f5f9", color: "#475569" };
export const estiloPrioridad = (p) => PRIORIDADES[p]  || { label: p || "—", bg: "#f1f5f9", color: "#475569", peso: 0 };
export const estiloGrupo     = (g) => GRUPOS[g]       || { label: g || "—", bg: "#f1f5f9", color: "#475569" };
