/**
 * Oculta las filas vencidas (días de cierre negativos) y las de estado
 * "Descartado" / "No asignado". Las filas con estado "Participando",
 * "Cotizado" o "Asignado" NUNCA se ocultan (se vuelven a mostrar si lo estaban).
 */
function ocultarFilasConFechaVencida() {
  const hoja = obtenerHoja_();
  if (!hoja) return;

  const columnaDias = CONFIG.COLUMNAS.DIAS_CIERRE;
  const columnaEstado = CONFIG.COLUMNAS.ESTADO;
  const valores = hoja.getDataRange().getValues();

  for (let i = 1; i < valores.length; i++) {
    const fila = i + 1;
    const dias = Number(valores[i][columnaDias - 1]);
    const estado = valores[i][columnaEstado - 1];

    // 1. Estados que nunca se ocultan (prioridad más alta).
    if (CONFIG.ESTADOS.NUNCA_OCULTAR.indexOf(estado) !== -1) {
      hoja.showRows(fila);
      continue;
    }

    // 2. Estados que se ocultan siempre, sin importar la fecha.
    if (CONFIG.ESTADOS.OCULTAR_SIEMPRE.indexOf(estado) !== -1) {
      hoja.hideRows(fila);
      continue;
    }

    // 3. Días de cierre negativo = licitación vencida → ocultar.
    if (!isNaN(dias) && dias < 0) {
      hoja.hideRows(fila);
      continue;
    }

    // Si no calzó en ningún caso anterior, se asegura de que esté visible.
    hoja.showRows(fila);
  }

  mostrarAlerta('Proceso de ocultación de filas completado.');
}

/**
 * Alterna: oculta las filas vencidas (días de cierre negativo) cuyo estado es
 * "Asignado", "Cotizado" o "Participando"; si ya estaban ocultas por esta
 * misma función, las vuelve a mostrar.
 */
function alternarFilasVencidasProtegidas() {
  const hoja = obtenerHoja_();
  if (!hoja) return;

  const lastRow = hoja.getLastRow();
  if (lastRow < 2) return;

  const numFilas = lastRow - 1;
  const dias = hoja.getRange(2, CONFIG.COLUMNAS.DIAS_CIERRE, numFilas, 1).getValues();
  const estados = hoja.getRange(2, CONFIG.COLUMNAS.ESTADO, numFilas, 1).getValues();

  const filasVencidasProtegidas = [];
  for (let i = 0; i < numFilas; i++) {
    const diasNum = Number(dias[i][0]);
    if (!isNaN(diasNum) && diasNum < 0 &&
        CONFIG.ESTADOS.NUNCA_OCULTAR.indexOf(estados[i][0]) !== -1) {
      filasVencidasProtegidas.push(i + 2);
    }
  }

  if (filasVencidasProtegidas.length === 0) {
    mostrarAlerta('No hay filas vencidas con estado Asignado/Cotizado/Participando.');
    return;
  }

  const yaOcultas = hoja.isRowHiddenByUser(filasVencidasProtegidas[0]);

  filasVencidasProtegidas.forEach(fila => {
    if (yaOcultas) {
      hoja.showRows(fila);
    } else {
      hoja.hideRows(fila);
    }
  });

  const accion = yaOcultas ? 'mostraron' : 'ocultaron';
  mostrarAlerta(`Se ${accion} ${filasVencidasProtegidas.length} fila(s) vencidas con estado protegido.`);
}
