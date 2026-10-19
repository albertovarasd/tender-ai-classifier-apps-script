/**
 * Muestra una alerta si hay una interfaz de usuario disponible (ej. corriste
 * la función a mano desde el menú). Si no hay pantalla (ej. corrió sola por
 * un activador automático), lo escribe en el registro en su lugar.
 */
function mostrarAlerta(mensaje) {
  try {
    SpreadsheetApp.getUi().alert(mensaje);
  } catch (e) {
    Logger.log('[Alerta] ' + mensaje);
  }
}

/**
 * Devuelve la hoja configurada en CONFIG.HOJA. Si no existe, avisa y devuelve null.
 * Se usa siempre la hoja por nombre (no la "activa"): así el resultado no
 * depende de qué pestaña tenga abierta quien ejecuta, ni de los activadores.
 */
function obtenerHoja_() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.HOJA);
  if (!hoja) {
    mostrarAlerta(`No se encontró la hoja "${CONFIG.HOJA}".`);
  }
  return hoja;
}

/**
 * Una fila está "activa" si no está vencida (días de cierre >= 0) y su estado
 * no es uno de los que se descartan siempre. Evita gastar tokens en
 * licitaciones que ya no importan. Un valor de días vacío cuenta como 0.
 */
function esFilaActiva_(dias, estado) {
  const diasNum = Number(dias);
  return !isNaN(diasNum) && diasNum >= 0 &&
    CONFIG.ESTADOS.OCULTAR_SIEMPRE.indexOf(estado) === -1;
}

function recortar_(texto, maxCaracteres) {
  const s = String(texto);
  return s.length > maxCaracteres ? s.slice(0, maxCaracteres) : s;
}

/** Quita las cercas de código ```json que algunos modelos agregan a pesar de pedirles solo JSON. */
function limpiarJson_(texto) {
  return String(texto).replace(/```json/g, '').replace(/```/g, '').trim();
}

/**
 * Indexa los resultados de la IA por su campo "n" (número del elemento en el
 * lote). Se usa "n" y no la posición del arreglo porque, si el modelo omite un
 * elemento, la posición se corre y el resultado terminaría en la fila equivocada.
 */
function indexarPorN_(resultados) {
  const porN = {};
  (Array.isArray(resultados) ? resultados : []).forEach(r => {
    if (r && r.n !== undefined && r.n !== null) porN[r.n] = r;
  });
  return porN;
}
