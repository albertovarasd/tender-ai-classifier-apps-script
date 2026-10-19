/**
 * Manejo de activadores de "continuación".
 *
 * Apps Script corta cada ejecución a los 6 minutos. Cuando un proceso largo se
 * queda sin tiempo, programa una continuación que lo vuelve a ejecutar a los
 * pocos segundos. Los IDs de esas continuaciones se guardan para distinguirlas
 * de los activadores diarios que crea el usuario, que NUNCA se borran.
 */
const PROP_IDS_CONTINUACION = 'IDS_CONTINUACION';

function leerIdsContinuacion_() {
  const crudo = PropertiesService.getScriptProperties().getProperty(PROP_IDS_CONTINUACION) || '';
  return crudo.split(',').filter(Boolean);
}

function guardarIdsContinuacion_(ids) {
  PropertiesService.getScriptProperties().setProperty(PROP_IDS_CONTINUACION, ids.join(','));
}

/** Programa una nueva ejecución de `nombreFuncion` y registra su ID. */
function programarContinuacion_(nombreFuncion) {
  const activador = ScriptApp.newTrigger(nombreFuncion)
    .timeBased()
    .after(CONFIG.CONTINUACION_MS)
    .create();

  // Se descartan IDs de activadores que ya no existen para que la lista no crezca sin fin.
  const vigentes = ScriptApp.getProjectTriggers().map(t => t.getUniqueId());
  const ids = leerIdsContinuacion_().filter(id => vigentes.indexOf(id) !== -1);
  ids.push(activador.getUniqueId());
  guardarIdsContinuacion_(ids);
}

/** Borra las continuaciones pendientes de `nombreFuncion` (no toca los activadores diarios). */
function borrarTriggersDeContinuacion_(nombreFuncion) {
  const ids = leerIdsContinuacion_();
  const restantes = ids.slice();

  ScriptApp.getProjectTriggers().forEach(t => {
    const id = t.getUniqueId();
    if (t.getHandlerFunction() === nombreFuncion &&
        t.getEventType() === ScriptApp.EventType.CLOCK &&
        ids.indexOf(id) !== -1) {
      ScriptApp.deleteTrigger(t);
      restantes.splice(restantes.indexOf(id), 1);
    }
  });

  guardarIdsContinuacion_(restantes);
}
