function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Tareas Personalizadas')
    .addItem('1. Llenar Clasificación y Sub-Clasificación', 'fillBothClassifications')
    .addSeparator()
    .addItem('2. Ocultar Filas Descartado - Vencida', 'ocultarFilasConFechaVencida')
    .addItem('3. Ocultar/Mostrar Filas Vencidas Protegidas', 'alternarFilasVencidasProtegidas')
    .addSeparator()
    .addItem('4. Analizar Documentos (Fabricante/Usuario Final)', 'analizarTodosLosDocumentos')
    .addItem('5. Resumir Texto Largo', 'fillResumen')
    .addToUi();
}
