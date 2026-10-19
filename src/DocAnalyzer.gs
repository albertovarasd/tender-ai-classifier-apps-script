/**
 * Análisis de documentos con IA.
 *
 * Para cada licitación activa que tenga carpeta de Drive y aún no esté
 * analizada: toma el primer archivo legible de la carpeta (PDF o imagen),
 * le extrae el texto con el OCR de Drive y le pide a la IA el fabricante y el
 * usuario final.
 *
 * REQUIERE el servicio avanzado "Drive API" (v2). Ver appsscript.json y el README.
 */
function analizarTodosLosDocumentos() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Ya hay otra ejecución de analizarTodosLosDocumentos en curso — se omite esta.');
    return;
  }

  try {
    obtenerApiKey_();
    const horaInicio = Date.now();
    borrarTriggersDeContinuacion_('analizarTodosLosDocumentos');

    const hoja = obtenerHoja_();
    if (!hoja) return;

    const lastRow = hoja.getLastRow();
    if (lastRow < 2) return;

    const C = CONFIG.COLUMNAS;
    const numFilas = lastRow - 1;
    const links = hoja.getRange(2, C.CARPETA_DRIVE, numFilas, 1).getValues();
    const dias = hoja.getRange(2, C.DIAS_CIERRE, numFilas, 1).getValues();
    const estados = hoja.getRange(2, C.ESTADO, numFilas, 1).getValues();
    const fabricantes = hoja.getRange(2, C.FABRICANTE, numFilas, 1).getValues();
    const usuarios = hoja.getRange(2, C.USUARIO_FINAL, numFilas, 1).getValues();

    const regexIdCarpeta = /\/folders\/([a-zA-Z0-9_-]+)/;

    // Candidatas: activas, con carpeta de Drive y sin analizar aún.
    const pendientes = [];
    for (let i = 0; i < numFilas; i++) {
      const link = links[i][0];
      const yaAnalizado = fabricantes[i][0] && usuarios[i][0];

      if (link && typeof link === 'string' && esFilaActiva_(dias[i][0], estados[i][0]) && !yaAnalizado) {
        const coincidencia = link.match(regexIdCarpeta);
        if (coincidencia && coincidencia[1]) {
          pendientes.push({ indice: i, idCarpeta: coincidencia[1] });
        }
      }
    }

    if (pendientes.length === 0) {
      mostrarAlerta('No hay licitaciones activas pendientes de analizar.');
      return;
    }

    let procesadas = 0;
    let seAgotoElTiempo = false;

    const guardar = () => {
      hoja.getRange(2, C.FABRICANTE, numFilas, 1).setValues(fabricantes);
      hoja.getRange(2, C.USUARIO_FINAL, numFilas, 1).setValues(usuarios);
    };

    try {
      for (let idx = 0; idx < pendientes.length; idx++) {
        if (Date.now() - horaInicio > CONFIG.TIEMPO_LIMITE_MS) {
          seAgotoElTiempo = true;
          break;
        }

        const item = pendientes[idx];
        const resultado = analizarUnaCarpeta(item.idCarpeta);

        fabricantes[item.indice][0] = resultado.fabricante;
        usuarios[item.indice][0] = resultado.usuarioFinal;
        procesadas++;

        // Guardar progreso cada 5 filas, por si el proceso se corta a mitad de camino.
        if (procesadas % 5 === 0) guardar();

        Utilities.sleep(CONFIG.PAUSA_ENTRE_DOCUMENTOS_MS); // los documentos pesan más que los textos
      }
    } finally {
      guardar();
    }

    if (seAgotoElTiempo) {
      programarContinuacion_('analizarTodosLosDocumentos');
      Logger.log(`Se analizaron ${procesadas} de ${pendientes.length} pendientes. Continuará automáticamente.`);
    } else {
      mostrarAlerta(`Análisis completado: ${procesadas} licitación(es) procesada(s).`);
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Busca el primer archivo analizable de la carpeta (PDF o imagen), le extrae
 * el texto por OCR y le pregunta a la IA el fabricante y el usuario final.
 *
 * Limitación conocida: solo se mira UN archivo por carpeta. Si ese archivo no
 * tiene texto legible, no se prueba con el siguiente.
 */
function analizarUnaCarpeta(idCarpeta) {
  try {
    const archivos = DriveApp.getFolderById(idCarpeta).getFiles();

    // Tipos de archivo que el OCR de Drive puede leer: PDF e imágenes.
    const mimesAnalizables = [MimeType.PDF, 'image/tiff', 'image/jpeg', 'image/png'];

    while (archivos.hasNext()) {
      const archivo = archivos.next();
      if (mimesAnalizables.indexOf(archivo.getMimeType()) !== -1) {
        const texto = extraerTextoConOCR(archivo);
        if (!texto || texto.trim().length < 10) {
          return { fabricante: 'Sin texto legible', usuarioFinal: 'Sin texto legible' };
        }
        return identificarConIAGroq(texto);
      }
    }
    return {
      fabricante: 'Sin archivo analizable en carpeta',
      usuarioFinal: 'Sin archivo analizable en carpeta'
    };
  } catch (e) {
    Logger.log('Error analizando carpeta ' + idCarpeta + ': ' + e.message);
    return { fabricante: 'Error de carpeta', usuarioFinal: 'Error de carpeta' };
  }
}

/**
 * Google Drive genera automáticamente una miniatura JPEG para archivos TIFF
 * (la misma que se ve en el visor web). Se usa como respaldo porque el OCR de
 * Drive no acepta TIFF directamente.
 */
function obtenerImagenDesdeMiniatura(archivo) {
  try {
    const meta = Drive.Files.get(archivo.getId());
    let urlMiniatura = meta.thumbnailLink;
    if (!urlMiniatura) return null;

    // Pedir la miniatura en el tamaño más grande posible (por defecto viene chica).
    urlMiniatura = urlMiniatura.replace(/=s\d+/, '=s1600');

    const respuesta = UrlFetchApp.fetch(urlMiniatura, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    if (respuesta.getResponseCode() !== 200) {
      Logger.log('No se pudo obtener la miniatura del TIFF (código ' + respuesta.getResponseCode() + ')');
      return null;
    }

    return respuesta.getBlob().setContentType('image/jpeg').setName(archivo.getName() + '.jpg');
  } catch (e) {
    Logger.log('Error obteniendo miniatura: ' + e.message);
    return null;
  }
}

/**
 * Extrae texto de un PDF o imagen usando el OCR real de Drive: sube el archivo
 * convertido a un Documento de Google temporal, lee el texto y lo manda a la
 * papelera. Reintenta con pausa si choca con el límite propio de Google.
 */
function extraerTextoConOCR(archivo, intento) {
  intento = intento || 1;
  let blob = archivo.getBlob();

  if (blob.getContentType() === 'image/tiff') {
    const blobMiniatura = obtenerImagenDesdeMiniatura(archivo);
    if (!blobMiniatura) {
      Logger.log('TIFF sin miniatura disponible: ' + archivo.getName());
      return '';
    }
    blob = blobMiniatura;
  }

  let docTemporal;
  try {
    docTemporal = Drive.Files.insert(
      { title: archivo.getName() + ' (OCR temporal)' },
      blob,
      { convert: true, ocr: true, ocrLanguage: CONFIG.IDIOMA_OCR }
    );
    return DocumentApp.openById(docTemporal.id).getBody().getText();
  } catch (e) {
    if (String(e.message).toLowerCase().indexOf('rate limit') !== -1 && intento <= 3) {
      const espera = 15000 * intento;
      Logger.log(`Límite de OCR alcanzado, esperando ${espera / 1000}s (intento ${intento})...`);
      Utilities.sleep(espera);
      return extraerTextoConOCR(archivo, intento + 1);
    }
    throw e;
  } finally {
    if (docTemporal && docTemporal.id) {
      DriveApp.getFileById(docTemporal.id).setTrashed(true);
    }
  }
}

/** Le pide a la IA el fabricante y el usuario final a partir del texto del documento. */
function identificarConIAGroq(texto) {
  const errorDeAnalisis = { fabricante: 'Error en el análisis', usuarioFinal: 'Error en el análisis' };

  try {
    const resultado = llamarGroq(
      CONFIG.GROQ.MODELO_DOCUMENTOS,
      [
        {
          role: 'system',
          content: 'Eres un asistente que responde SOLO con un objeto JSON válido, sin texto adicional. Las claves son "fabricante" y "usuarioFinal". Usa "No Identificado" si no encuentras la información.'
        },
        {
          role: 'user',
          content: `Busca el nombre del fabricante y el usuario final en este texto:\n\n${recortar_(texto, CONFIG.MAX_CARACTERES.DOCUMENTO)}`
        }
      ],
      1000,
      true
    );

    if (!resultado || typeof resultado !== 'object') return errorDeAnalisis;
    return {
      fabricante: resultado.fabricante || 'No Identificado',
      usuarioFinal: resultado.usuarioFinal || 'No Identificado'
    };
  } catch (e) {
    Logger.log('Error al identificar fabricante/usuario final: ' + e.message);
    return errorDeAnalisis;
  }
}
