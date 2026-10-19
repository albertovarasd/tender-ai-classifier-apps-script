/**
 * Clasifica y sub-clasifica en UNA sola pasada, agrupando filas en lotes
 * para minimizar la cantidad de llamadas a la IA (mucho más rápido).
 *
 * Solo procesa filas activas (no vencidas ni descartadas) que aún no tengan
 * ambas columnas llenas. Si se acaba el tiempo, programa su propia continuación.
 */
function fillBothClassifications() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Ya hay otra ejecución de fillBothClassifications en curso — se omite esta.');
    return;
  }

  try {
    obtenerApiKey_(); // falla acá con un mensaje claro si falta la clave
    const horaInicio = Date.now();
    borrarTriggersDeContinuacion_('fillBothClassifications');

    const hoja = obtenerHoja_();
    if (!hoja) return;

    const lastRow = hoja.getLastRow();
    if (lastRow < 2) {
      mostrarAlerta('No hay datos para clasificar.');
      return;
    }

    const C = CONFIG.COLUMNAS;
    const numFilas = lastRow - 1;
    const textos = hoja.getRange(2, C.TEXTO_LARGO, numFilas, 1).getValues();
    const clasificaciones = hoja.getRange(2, C.CLASIFICACION, numFilas, 1).getValues();
    const subClasificaciones = hoja.getRange(2, C.SUBCLASIFICACION, numFilas, 1).getValues();
    const dias = hoja.getRange(2, C.DIAS_CIERRE, numFilas, 1).getValues();
    const estados = hoja.getRange(2, C.ESTADO, numFilas, 1).getValues();

    // Filtro rápido de "activas": usa los datos ya en memoria, sin llamadas
    // lentas a Sheets fila por fila.
    const pendientes = [];
    for (let i = 0; i < numFilas; i++) {
      const item = textos[i][0];
      const yaClasificado = clasificaciones[i][0] && subClasificaciones[i][0];
      if (item && !yaClasificado && esFilaActiva_(dias[i][0], estados[i][0])) {
        pendientes.push({ indice: i, texto: item });
      }
    }

    if (pendientes.length === 0) {
      mostrarAlerta('No hay filas activas nuevas para clasificar.');
      return;
    }

    let procesadas = 0;
    let seAgotoElTiempo = false;
    const tamanoLote = CONFIG.TAMANO_LOTE.CLASIFICACION;

    try {
      for (let inicio = 0; inicio < pendientes.length; inicio += tamanoLote) {
        if (Date.now() - horaInicio > CONFIG.TIEMPO_LIMITE_MS) {
          seAgotoElTiempo = true;
          break;
        }

        const lote = pendientes.slice(inicio, inicio + tamanoLote);
        const porN = indexarPorN_(clasificarLote(lote));

        let algunoExitoso = false;
        for (let j = 0; j < lote.length; j++) {
          const resultado = porN[j + 1];
          if (resultado) {
            const i = lote[j].indice;
            clasificaciones[i][0] = resultado.classification || clasificaciones[i][0];
            subClasificaciones[i][0] = resultado.subclassification || subClasificaciones[i][0];
            procesadas++;
            algunoExitoso = true;
          }
        }

        if (!algunoExitoso) {
          Logger.log(`⚠️ Lote completo falló (0 de ${lote.length} filas), se sigue con el siguiente.`);
        }

        if (inicio + tamanoLote < pendientes.length) {
          Utilities.sleep(CONFIG.PAUSA_ENTRE_LOTES_MS);
        }
      }
    } finally {
      // Se escribe siempre, incluso si algo falló a mitad de camino:
      // así no se pierde lo que ya se clasificó.
      hoja.getRange(2, C.CLASIFICACION, numFilas, 1).setValues(clasificaciones);
      hoja.getRange(2, C.SUBCLASIFICACION, numFilas, 1).setValues(subClasificaciones);
    }

    if (seAgotoElTiempo) {
      programarContinuacion_('fillBothClassifications');
      Logger.log(`Se procesaron ${procesadas} de ${pendientes.length} pendientes activas. Continuará automáticamente.`);
    } else {
      mostrarAlerta(`Clasificación completada: ${procesadas} fila(s) activas procesadas. ¡Todo listo!`);
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Prompt de clasificación. ESTE es el criterio de negocio: edítalo para tus
 * propias categorías. Las opciones deben escribirse EXACTAS, porque el texto
 * de la respuesta se guarda tal cual en la planilla.
 */
function construirPromptClasificacion_(listaTextos) {
  return `Para cada uno de los siguientes elementos numerados, da DOS clasificaciones:

CLASIFICACIÓN PRINCIPAL (classification): una de estas tres opciones exactas:
- "1. Eléctrico o electrónico"
- "2. Mecánico o estructural"
- "3. No aplicable" (si no encaja en ninguna)

SUB-CLASIFICACIÓN (subclassification): una de estas dos opciones exactas, siguiendo ESTA regla:
- "Repuesto con transformación": si el texto menciona un PLANO, número de plano, plano de planificación, dibujo técnico, croquis, o documentación de ingeniería/fabricación (ej: "NUMERO PLANO:", "PLN...", "plano de planificación"). Esto aplica AUNQUE también tenga marca mencionada.
- "Repuesto comercial": SOLO si menciona marca/fabricante establecido y NO menciona plano ni documentación técnica de fabricación.

NOTA IMPORTANTE sobre la relación entre ambas clasificaciones:
- Es POCO COMÚN que un elemento "1. Eléctrico o electrónico" mencione un plano — la mayoría de los repuestos eléctricos son de catálogo (comercial), identificados por marca y número de parte, no por plano de fabricación.
- Por lo tanto, un elemento "1. Eléctrico o electrónico" normalmente debería ser "Repuesto comercial", EXCEPTO en casos como: un tablero/panel de control armado a medida, un cableado o arnés fabricado a medida según plano, o instrumentación que requiere montaje sobre una estructura fabricada a medida. En esos casos excepcionales sí puede ser "con transformación".
- Si de verdad aparece la palabra "plano" o similar en un elemento eléctrico, revisa el contexto: si el plano es solo para el MONTAJE/SOPORTE (mecánico) y el componente eléctrico en sí es de catálogo, evalúa con criterio cuál categoría representa mejor la naturaleza principal del repuesto.

Elementos:
${listaTextos}

Responde ÚNICAMENTE con un array JSON válido, sin texto antes ni después, con este formato exacto:
[{"n":1,"classification":"...","subclassification":"..."},{"n":2,"classification":"...","subclassification":"..."}]`;
}

/**
 * Manda un lote de textos en UNA sola llamada a la IA y pide la clasificación
 * Y sub-clasificación de cada uno, en formato JSON.
 * Devuelve [] si el lote falla tras los reintentos (el llamador sigue con el resto).
 */
function clasificarLote(lote) {
  // Para clasificar basta con el inicio de la descripción (nombre, tipo, plano,
  // marca), no el detalle técnico completo: reduce mucho el consumo de tokens.
  const listaTextos = lote.map((item, idx) =>
    `${idx + 1}. "${recortar_(item.texto, CONFIG.MAX_CARACTERES.CLASIFICACION)}"`
  ).join('\n');

  try {
    const resultados = llamarGroq(
      CONFIG.GROQ.MODELO_CLASIFICACION,
      [{ role: 'user', content: construirPromptClasificacion_(listaTextos) }],
      2048,
      true
    );
    return Array.isArray(resultados) ? resultados : [];
  } catch (e) {
    Logger.log('Error al clasificar el lote: ' + e.message);
    return [];
  }
}
