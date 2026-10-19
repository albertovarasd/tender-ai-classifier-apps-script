/**
 * Resume el texto largo de cada licitación activa en UNA línea: nombre del
 * producto + 2 o 3 especificaciones que lo identifiquen. Procesa en lotes y,
 * si se acaba el tiempo, programa su propia continuación.
 */
function fillResumen() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Ya hay otra ejecución de fillResumen en curso — se omite esta para no duplicar trabajo.');
    return;
  }

  try {
    obtenerApiKey_();
    const horaInicio = Date.now();
    borrarTriggersDeContinuacion_('fillResumen');

    const hoja = obtenerHoja_();
    if (!hoja) return;

    const lastRow = hoja.getLastRow();
    if (lastRow < 2) {
      mostrarAlerta('No hay datos para resumir.');
      return;
    }

    const C = CONFIG.COLUMNAS;
    const numFilas = lastRow - 1;
    const textos = hoja.getRange(2, C.TEXTO_LARGO, numFilas, 1).getValues();
    const resumenes = hoja.getRange(2, C.RESUMEN, numFilas, 1).getValues();
    const dias = hoja.getRange(2, C.DIAS_CIERRE, numFilas, 1).getValues();
    const estados = hoja.getRange(2, C.ESTADO, numFilas, 1).getValues();

    // Filtro "activa" rápido: usa los datos que ya están en memoria.
    const pendientes = [];
    for (let i = 0; i < numFilas; i++) {
      const item = textos[i][0];
      if (item && !resumenes[i][0] && esFilaActiva_(dias[i][0], estados[i][0])) {
        pendientes.push({ indice: i, texto: item });
      }
    }

    if (pendientes.length === 0) {
      mostrarAlerta('No hay filas activas nuevas para resumir.');
      return;
    }

    const tamanoLote = CONFIG.TAMANO_LOTE.RESUMEN;
    let procesadas = 0;
    let guardadasHastaAhora = 0;
    let seAgotoElTiempo = false;

    const guardar = () => hoja.getRange(2, C.RESUMEN, numFilas, 1).setValues(resumenes);

    try {
      for (let inicio = 0; inicio < pendientes.length; inicio += tamanoLote) {
        if (Date.now() - horaInicio > CONFIG.TIEMPO_LIMITE_MS) {
          seAgotoElTiempo = true;
          break;
        }

        const lote = pendientes.slice(inicio, inicio + tamanoLote);
        const porN = indexarPorN_(resumirLote(lote));

        let algunoExitoso = false;
        for (let j = 0; j < lote.length; j++) {
          const resultado = porN[j + 1];
          if (resultado && resultado.resumen) {
            resumenes[lote[j].indice][0] = resultado.resumen;
            procesadas++;
            algunoExitoso = true;
          }
        }

        if (!algunoExitoso) {
          Logger.log(`⚠️ Lote completo falló (0 de ${lote.length} filas), se sigue con el siguiente lote.`);
        }

        // Guardar progreso cada ~15 resúmenes por si el proceso se corta.
        if (procesadas - guardadasHastaAhora >= 15) {
          guardar();
          guardadasHastaAhora = procesadas;
        }

        if (inicio + tamanoLote < pendientes.length) {
          Utilities.sleep(CONFIG.PAUSA_ENTRE_LOTES_MS);
        }
      }
    } finally {
      guardar();
    }

    if (seAgotoElTiempo) {
      programarContinuacion_('fillResumen');
      Logger.log(`Se resumieron ${procesadas} de ${pendientes.length} pendientes activas. Continuará automáticamente.`);
    } else {
      mostrarAlerta(`Resumen completado: ${procesadas} fila(s) activas procesadas. ¡Todo listo!`);
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Prompt de resumen. Los ejemplos son ficticios: reemplázalos por casos de tu
 * rubro para que el modelo imite el formato que tú quieres.
 */
function construirPromptResumen_(listaTextos) {
  return `Para cada uno de los siguientes textos técnicos de licitaciones, extrae UN resumen de una sola línea con el NOMBRE del producto seguido de sus especificaciones más importantes (número de plano, material, dimensiones, modelo, uso designado, marca/fabricante — incluye 2 o 3 de las que más identifiquen la pieza, no solo una).

REGLAS:
- Si el texto menciona una MARCA o fabricante, inclúyela como "Marca: [nombre]".
- Si NO menciona marca, NO escribas "Marca: No especifica" ni nada parecido — simplemente omite esa parte por completo, no dejes hueco.
- Separa cada dato con " | ".
- No inventes datos que no estén en el texto.

Ejemplos:
Input: "HERRAMIENTA LARGA; NUMERO PLANO: PL-0001; USO DESIGNADO: F"
Output: "Herramienta larga | Plano PL-0001"

Input: "CILINDRO; NOMBRE FABRICANTE: ACME; NUMERO DE PARTE: 100200; MODELO DEL EQUIPO: M-10"
Output: "Cilindro | Marca: Acme | N° parte 100200 | Modelo M-10"

Input: "RIEL; MODIFICADOR: FIJACION; NUMERO PLANO: 00123; CARACTERISTICAS ADICIONALES: ACERO INOXIDABLE 316L, LARGO 1500mm"
Output: "Riel de fijación | Plano 00123 | Acero inoxidable 316L | Largo 1500mm"

Input: "TERMOVENTILADOR, POTENCIA: 2000 W, TENSION NOMINAL: 220 V.C.A.; REFERENCIA: ACME HX500"
Output: "Termoventilador | Marca: Acme HX500 | 2000W | 220V"

Elementos:
${listaTextos}

Responde ÚNICAMENTE con un array JSON válido, sin texto antes ni después, con este formato exacto:
[{"n":1,"resumen":"..."},{"n":2,"resumen":"..."}]`;
}

/**
 * Resume un lote con UNA llamada a la IA. Si el lote falla tras los reintentos
 * y tiene más de una fila, prueba de a UNA: así un texto problemático no
 * arrastra a los demás. Devuelve [] si no se pudo resumir nada.
 */
function resumirLote(lote) {
  const listaTextos = lote.map((item, idx) =>
    `${idx + 1}. "${recortar_(item.texto, CONFIG.MAX_CARACTERES.RESUMEN)}"`
  ).join('\n');

  try {
    const resultados = llamarGroq(
      CONFIG.GROQ.MODELO_RESUMEN,
      [{ role: 'user', content: construirPromptResumen_(listaTextos) }],
      3000,
      true
    );
    return Array.isArray(resultados) ? resultados : [];
  } catch (e) {
    Logger.log('Error al resumir el lote: ' + e.message);

    if (lote.length > 1) {
      Logger.log(`Reintentando las ${lote.length} filas del lote una por una...`);
      const individuales = [];
      for (let k = 0; k < lote.length; k++) {
        const unResultado = resumirLote([lote[k]]);
        if (unResultado.length > 0 && unResultado[0] && unResultado[0].resumen) {
          individuales.push({ n: k + 1, resumen: unResultado[0].resumen });
        }
        Utilities.sleep(3000);
      }
      return individuales;
    }
    return [];
  }
}
