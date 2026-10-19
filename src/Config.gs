/**
 * Configuración central. Todo lo que depende de TU planilla o de tu criterio
 * vive aquí: nombre de la hoja, columnas, estados, modelos y límites.
 *
 * La clave de Groq NO va aquí: se guarda en
 * Configuración del proyecto > Propiedades de la secuencia de comandos
 * con el nombre GROQ_API_KEY.
 */
const CONFIG = {
  // Nombre de la hoja con las licitaciones (la que llena el scraper).
  HOJA: 'SAP ARIBA',

  // Números de columna (A = 1). Ajusta si tu planilla tiene otro orden.
  COLUMNAS: {
    TEXTO_LARGO: 6,        // F: descripción técnica de la licitación
    ESTADO: 8,             // H: "Pendiente revisión", "Descartado", etc.
    CARPETA_DRIVE: 10,     // J: enlace a la carpeta de Drive con los adjuntos
    CLASIFICACION: 12,     // L
    SUBCLASIFICACION: 13,  // M
    DIAS_CIERRE: 14,       // N: días que faltan para el cierre (negativo = vencida)
    FABRICANTE: 16,        // P
    USUARIO_FINAL: 17,     // Q
    RESUMEN: 18            // R
  },

  // Estados que cambian el comportamiento. Deben coincidir con tu planilla.
  ESTADOS: {
    // Nunca se procesan y siempre se ocultan.
    OCULTAR_SIEMPRE: ['Descartado', 'No asignado'],
    // Nunca se ocultan, aunque estén vencidas.
    NUNCA_OCULTAR: ['Participando', 'Cotizado', 'Asignado']
  },

  GROQ: {
    URL: 'https://api.groq.com/openai/v1/chat/completions',
    PROPIEDAD_API_KEY: 'GROQ_API_KEY',
    MODELO_CLASIFICACION: 'openai/gpt-oss-20b',
    MODELO_RESUMEN: 'openai/gpt-oss-20b',
    MODELO_DOCUMENTOS: 'openai/gpt-oss-120b',
    MAX_REINTENTOS: 4
  },

  // Cuántas filas se mandan juntas en una sola llamada a la IA.
  TAMANO_LOTE: { CLASIFICACION: 3, RESUMEN: 3 },

  // Se recorta el texto antes de enviarlo: reduce el consumo de tokens.
  MAX_CARACTERES: { CLASIFICACION: 400, RESUMEN: 600, DOCUMENTO: 6000 },

  // Apps Script corta cada ejecución a los 6 minutos: se frena a los 5 y se
  // programa una continuación automática.
  TIEMPO_LIMITE_MS: 5 * 60 * 1000,
  CONTINUACION_MS: 10 * 1000,

  PAUSA_ENTRE_LOTES_MS: 4000,
  PAUSA_ENTRE_DOCUMENTOS_MS: 4000,

  // Idioma de los documentos para el OCR de Drive.
  IDIOMA_OCR: 'es'
};
