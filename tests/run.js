/**
 * Pruebas locales: ejecutan el código real de src/*.gs dentro de un contexto de
 * Node con versiones simuladas de los servicios de Google (SpreadsheetApp,
 * UrlFetchApp, ScriptApp, DriveApp...). No llaman a Google ni a Groq.
 *
 * Uso:  node tests/run.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const CODIGO = fs
  .readdirSync(SRC)
  .filter(f => f.endsWith('.gs'))
  .sort()
  .map(f => fs.readFileSync(path.join(SRC, f), 'utf8'))
  .join('\n');

const N_COLUMNAS = 18;

function fila(campos) {
  const f = new Array(N_COLUMNAS).fill('');
  const C = { texto: 6, estado: 8, carpeta: 10, clas: 12, sub: 13, dias: 14, fab: 16, usu: 17, resumen: 18 };
  Object.keys(campos).forEach(k => { f[C[k] - 1] = campos[k]; });
  return f;
}

class HojaFalsa {
  constructor(nombre, filas) {
    this.nombre = nombre;
    this.datos = [new Array(N_COLUMNAS).fill('encabezado'), ...filas];
    this.ocultas = new Set();
  }
  getLastRow() { return this.datos.length; }
  getDataRange() { return { getValues: () => this.datos.map(f => f.slice()) }; }
  getRange(fila0, col0, nFilas, nCols) {
    const self = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < nFilas; r++) out.push(self.datos[fila0 - 1 + r].slice(col0 - 1, col0 - 1 + nCols));
        return out;
      },
      setValues(vals) {
        vals.forEach((fv, r) => fv.forEach((v, c) => { self.datos[fila0 - 1 + r][col0 - 1 + c] = v; }));
      }
    };
  }
  hideRows(f) { this.ocultas.add(f); }
  showRows(f) { this.ocultas.delete(f); }
  isRowHiddenByUser(f) { return this.ocultas.has(f); }
  celda(fila1, col1) { return this.datos[fila1 - 1][col1 - 1]; }
}

function respuestaGroq(contenido) {
  return { code: 200, text: JSON.stringify({ choices: [{ message: { content: contenido } }] }) };
}

/** Crea un contexto limpio con el código cargado y los servicios de Google simulados. */
function entorno({ filas = [], apiKey = 'clave-de-prueba', carpetas = {} } = {}) {
  const hoja = new HojaFalsa('SAP ARIBA', filas);
  const estado = {
    reloj: 1000000,
    pausas: [],
    alertas: [],
    logs: [],
    llamadasGroq: [],
    respuestas: [],         // cola de respuestas de Groq (objeto, función o Error)
    props: apiKey ? { GROQ_API_KEY: apiKey } : {},
    triggers: [],
    nextTriggerId: 1,
    papelera: [],
    ocr: {}                 // nombre de archivo -> texto devuelto por el OCR
  };

  const ctx = {
    console,
    Logger: { log: m => estado.logs.push(String(m)) },
    Date: { now: () => estado.reloj },
    Utilities: { sleep: ms => { estado.pausas.push(ms); estado.reloj += ms; } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in estado.props ? estado.props[k] : null),
        setProperty: (k, v) => { estado.props[k] = v; }
      })
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: n => (n === hoja.nombre ? hoja : null) }),
      getUi: () => ({ alert: m => estado.alertas.push(m) })
    },
    ScriptApp: {
      EventType: { CLOCK: 'CLOCK' },
      getProjectTriggers: () => estado.triggers.slice(),
      deleteTrigger: t => { estado.triggers = estado.triggers.filter(x => x !== t); },
      getOAuthToken: () => 'token',
      newTrigger: nombre => {
        const t = {
          fn: nombre,
          id: 't' + estado.nextTriggerId++,
          getHandlerFunction() { return this.fn; },
          getEventType() { return 'CLOCK'; },
          getUniqueId() { return this.id; }
        };
        const builder = {
          timeBased: () => builder,
          after: ms => { t.despuesDe = ms; return builder; },
          create: () => { estado.triggers.push(t); return t; }
        };
        return builder;
      }
    },
    UrlFetchApp: {
      fetch: (url, opciones) => {
        const cuerpo = JSON.parse(opciones.payload);
        estado.llamadasGroq.push({ url, cuerpo, headers: opciones.headers });
        let r = estado.respuestas.shift();
        if (r === undefined) throw new Error('Sin respuesta simulada en la cola');
        if (typeof r === 'function') r = r(cuerpo);
        if (r instanceof Error) throw r;
        return { getResponseCode: () => r.code, getContentText: () => r.text };
      }
    },
    MimeType: { PDF: 'application/pdf' },
    DriveApp: {
      getFolderById: id => {
        if (!(id in carpetas)) throw new Error('Carpeta no encontrada: ' + id);
        const archivos = carpetas[id];
        let i = 0;
        return { getFiles: () => ({ hasNext: () => i < archivos.length, next: () => archivos[i++] }) };
      },
      getFileById: id => ({ setTrashed: () => estado.papelera.push(id) })
    },
    Drive: {
      Files: {
        insert: (recurso, blob) => ({ id: 'doc-' + blob.nombre, nombre: blob.nombre }),
        get: () => ({ thumbnailLink: null })
      }
    },
    DocumentApp: {
      openById: id => ({ getBody: () => ({ getText: () => estado.ocr[id.replace('doc-', '')] || '' }) })
    }
  };

  vm.createContext(ctx);
  vm.runInContext(CODIGO, ctx, { filename: 'src/*.gs' });
  const ejecutar = codigo => vm.runInContext(codigo, ctx);
  return { hoja, estado, ctx, ejecutar };
}

function archivoPdf(nombre, mime = 'application/pdf') {
  return {
    getMimeType: () => mime,
    getName: () => nombre,
    getId: () => 'id-' + nombre,
    getBlob: () => ({ nombre, getContentType: () => mime })
  };
}

// ---------------------------------------------------------------------------
const pruebas = [];
const prueba = (nombre, fn) => pruebas.push({ nombre, fn });

// Respuesta de clasificación que devuelve una entrada por cada elemento numerado del prompt.
const clasificarTodo = cuerpo => {
  const prompt = cuerpo.messages[0].content;
  const n = (prompt.match(/^\d+\. "/gm) || []).length;
  const arr = [];
  for (let i = 1; i <= n; i++) arr.push({ n: i, classification: '2. Mecánico o estructural', subclassification: 'Repuesto comercial' });
  return respuestaGroq('```json\n' + JSON.stringify(arr) + '\n```');
};

prueba('clasificación: solo procesa filas activas, sin clasificar y con texto', () => {
  const { hoja, estado, ejecutar } = entorno({
    filas: [
      fila({ texto: 'bomba', estado: 'Pendiente revisión', dias: 5 }),                         // fila 2: sí
      fila({ texto: 'vencida', estado: 'Pendiente revisión', dias: -1 }),                       // fila 3: no (vencida)
      fila({ texto: 'descartada', estado: 'Descartado', dias: 5 }),                             // fila 4: no
      fila({ texto: 'ya hecha', estado: 'Pendiente revisión', dias: 5, clas: 'X', sub: 'Y' }),  // fila 5: no
      fila({ texto: '', estado: 'Pendiente revisión', dias: 5 }),                               // fila 6: no (sin texto)
      fila({ texto: 'motor', estado: 'Participando', dias: 0 })                                 // fila 7: sí (días = 0)
    ]
  });
  estado.respuestas.push(clasificarTodo);
  ejecutar('fillBothClassifications()');

  assert.strictEqual(estado.llamadasGroq.length, 1, 'un solo lote');
  assert.strictEqual(hoja.celda(2, 12), '2. Mecánico o estructural');
  assert.strictEqual(hoja.celda(2, 13), 'Repuesto comercial');
  assert.strictEqual(hoja.celda(7, 12), '2. Mecánico o estructural');
  assert.strictEqual(hoja.celda(3, 12), '');
  assert.strictEqual(hoja.celda(4, 12), '');
  assert.strictEqual(hoja.celda(5, 12), 'X');
  assert.strictEqual(hoja.celda(6, 12), '');
  assert.ok(estado.alertas[0].includes('2 fila(s)'), estado.alertas[0]);
  assert.strictEqual(estado.llamadasGroq[0].headers.Authorization, 'Bearer clave-de-prueba');
});

prueba('clasificación: agrupa en lotes de 3 y pausa entre lotes', () => {
  const filas = [];
  for (let i = 0; i < 7; i++) filas.push(fila({ texto: 'item ' + i, estado: 'Pendiente revisión', dias: 3 }));
  const { estado, hoja, ejecutar } = entorno({ filas });
  estado.respuestas.push(clasificarTodo, clasificarTodo, clasificarTodo);
  ejecutar('fillBothClassifications()');
  assert.strictEqual(estado.llamadasGroq.length, 3);           // 3 + 3 + 1
  assert.deepStrictEqual(estado.pausas, [4000, 4000]);         // entre lotes, no después del último
  assert.strictEqual(hoja.celda(8, 13), 'Repuesto comercial'); // la última fila (7ª)
});

prueba('clasificación: si el modelo omite un elemento, el resto NO se corre de fila', () => {
  const { hoja, estado, ejecutar } = entorno({
    filas: [
      fila({ texto: 'A', estado: 'Pendiente revisión', dias: 3 }),
      fila({ texto: 'B', estado: 'Pendiente revisión', dias: 3 }),
      fila({ texto: 'C', estado: 'Pendiente revisión', dias: 3 })
    ]
  });
  // El modelo devuelve solo los elementos 1 y 3.
  estado.respuestas.push(respuestaGroq(JSON.stringify([
    { n: 1, classification: 'C1', subclassification: 'S1' },
    { n: 3, classification: 'C3', subclassification: 'S3' }
  ])));
  ejecutar('fillBothClassifications()');
  assert.strictEqual(hoja.celda(2, 12), 'C1');
  assert.strictEqual(hoja.celda(3, 12), '', 'la fila B no debe recibir el resultado de C');
  assert.strictEqual(hoja.celda(4, 12), 'C3');
});

prueba('groq: ante rate_limit espera lo indicado (+1s) y reintenta el mismo lote', () => {
  const { hoja, estado, ejecutar } = entorno({ filas: [fila({ texto: 'A', estado: 'Pendiente revisión', dias: 3 })] });
  estado.respuestas.push(
    { code: 429, text: JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Rate limit. Please try again in 2.5s.' } }) },
    clasificarTodo
  );
  ejecutar('fillBothClassifications()');
  assert.strictEqual(estado.llamadasGroq.length, 2);
  assert.strictEqual(estado.pausas[0], 3500, 'ceil((2.5 + 1) * 1000)');
  assert.strictEqual(hoja.celda(2, 12), '2. Mecánico o estructural');
});

prueba('groq: JSON cortado se reintenta y luego funciona', () => {
  const { hoja, estado, ejecutar } = entorno({ filas: [fila({ texto: 'A', estado: 'Pendiente revisión', dias: 3 })] });
  estado.respuestas.push(respuestaGroq('[{"n":1,"classification":"2. Meca'), clasificarTodo);
  ejecutar('fillBothClassifications()');
  assert.strictEqual(estado.llamadasGroq.length, 2);
  assert.strictEqual(hoja.celda(2, 13), 'Repuesto comercial');
});

prueba('groq: tras agotar reintentos el lote falla sin romper la corrida ni escribir basura', () => {
  const { hoja, estado, ejecutar } = entorno({ filas: [fila({ texto: 'A', estado: 'Pendiente revisión', dias: 3 })] });
  for (let i = 0; i < 6; i++) estado.respuestas.push(new Error('sin red'));
  ejecutar('fillBothClassifications()');
  assert.strictEqual(estado.llamadasGroq.length, 4, 'MAX_REINTENTOS = 4');
  assert.strictEqual(hoja.celda(2, 12), '');
  assert.ok(estado.alertas[0].includes('0 fila(s)'));
});

prueba('sin GROQ_API_KEY: falla de inmediato con un mensaje claro y sin llamar a la API', () => {
  const { estado, ejecutar } = entorno({ apiKey: null, filas: [fila({ texto: 'A', estado: 'Pendiente revisión', dias: 3 })] });
  assert.throws(() => ejecutar('fillBothClassifications()'), /GROQ_API_KEY/);
  assert.strictEqual(estado.llamadasGroq.length, 0);
});

prueba('límite de tiempo: guarda lo hecho y programa continuación; la siguiente la reemplaza', () => {
  const filas = [];
  for (let i = 0; i < 12; i++) filas.push(fila({ texto: 'item ' + i, estado: 'Pendiente revisión', dias: 3 }));
  const { hoja, estado, ejecutar } = entorno({ filas });
  ejecutar('CONFIG.TIEMPO_LIMITE_MS = 5000');
  estado.respuestas.push(clasificarTodo, clasificarTodo, clasificarTodo, clasificarTodo);

  ejecutar('fillBothClassifications()');
  assert.strictEqual(estado.triggers.length, 1, 'quedó una continuación programada');
  assert.strictEqual(estado.triggers[0].fn, 'fillBothClassifications');
  assert.strictEqual(estado.triggers[0].despuesDe, 10000);
  const hechas = hoja.datos.slice(1).filter(f => f[11]).length;
  assert.ok(hechas > 0 && hechas < 12, 'progreso parcial guardado: ' + hechas);
  assert.strictEqual(estado.props.IDS_CONTINUACION, 't1');

  // La continuación arranca: borra el activador viejo (que ya se disparó) y termina el trabajo.
  ejecutar('CONFIG.TIEMPO_LIMITE_MS = 5 * 60 * 1000');
  estado.respuestas.push(clasificarTodo, clasificarTodo, clasificarTodo, clasificarTodo);
  ejecutar('fillBothClassifications()');
  assert.strictEqual(estado.triggers.length, 0, 'no quedan continuaciones');
  assert.strictEqual(hoja.datos.slice(1).filter(f => f[11]).length, 12);
});

prueba('activadores diarios del usuario NO se borran al limpiar continuaciones', () => {
  const { estado, ejecutar } = entorno({ filas: [fila({ texto: 'A', estado: 'Pendiente revisión', dias: 3 })] });
  // Activador diario creado a mano por el usuario (no está en IDS_CONTINUACION).
  estado.triggers.push({ fn: 'fillBothClassifications', id: 'diario', getHandlerFunction() { return this.fn; }, getEventType: () => 'CLOCK', getUniqueId() { return this.id; } });
  estado.respuestas.push(clasificarTodo);
  ejecutar('fillBothClassifications()');
  assert.strictEqual(estado.triggers.length, 1);
  assert.strictEqual(estado.triggers[0].id, 'diario');
});

prueba('resumen: usa el campo n, guarda en la columna R y recorta el texto a 600 caracteres', () => {
  const largo = 'x'.repeat(1000);
  const { hoja, estado, ejecutar } = entorno({
    filas: [
      fila({ texto: 'CILINDRO; PLANO: 1', estado: 'Pendiente revisión', dias: 2 }),
      fila({ texto: largo, estado: 'Pendiente revisión', dias: 2 })
    ]
  });
  estado.respuestas.push(respuestaGroq(JSON.stringify([
    { n: 2, resumen: 'Largo | x' },
    { n: 1, resumen: 'Cilindro | Plano 1' }
  ])));
  ejecutar('fillResumen()');
  assert.strictEqual(hoja.celda(2, 18), 'Cilindro | Plano 1');
  assert.strictEqual(hoja.celda(3, 18), 'Largo | x');
  const prompt = estado.llamadasGroq[0].cuerpo.messages[0].content;
  assert.ok(prompt.includes('2. "' + 'x'.repeat(600) + '"'));
  assert.ok(!prompt.includes('x'.repeat(601)));
});

prueba('resumen: si el lote falla, reintenta fila por fila y rescata las que se puedan', () => {
  const { hoja, estado, ejecutar } = entorno({
    filas: [
      fila({ texto: 'A', estado: 'Pendiente revisión', dias: 2 }),
      fila({ texto: 'B', estado: 'Pendiente revisión', dias: 2 })
    ]
  });
  // Lote completo: 4 intentos fallidos. Luego fila A: ok. Fila B: 4 intentos fallidos.
  for (let i = 0; i < 4; i++) estado.respuestas.push(new Error('boom'));
  estado.respuestas.push(respuestaGroq(JSON.stringify([{ n: 1, resumen: 'Resumen de A' }])));
  for (let i = 0; i < 4; i++) estado.respuestas.push(new Error('boom'));
  ejecutar('fillResumen()');
  assert.strictEqual(hoja.celda(2, 18), 'Resumen de A');
  assert.strictEqual(hoja.celda(3, 18), '');
});

prueba('documentos: OCR + IA llena fabricante y usuario final; maneja carpetas sin archivos y sin texto', () => {
  const { hoja, estado, ejecutar } = entorno({
    filas: [
      fila({ estado: 'Pendiente revisión', dias: 4, carpeta: 'https://drive.google.com/drive/folders/AAA111' }),   // con texto
      fila({ estado: 'Pendiente revisión', dias: 4, carpeta: 'https://drive.google.com/drive/folders/BBB222' }),   // sin archivos
      fila({ estado: 'Pendiente revisión', dias: 4, carpeta: 'https://drive.google.com/drive/folders/CCC333' }),   // OCR vacío
      fila({ estado: 'Descartado', dias: 4, carpeta: 'https://drive.google.com/drive/folders/DDD444' }),            // descartada: se omite
      fila({ estado: 'Pendiente revisión', dias: -3, carpeta: 'https://drive.google.com/drive/folders/EEE555' }),  // vencida: se omite
      fila({ estado: 'Pendiente revisión', dias: 4, carpeta: 'sin enlace valido' })                                // enlace inválido: se omite
    ],
    carpetas: {
      AAA111: [archivoPdf('planilla.xlsx', 'application/vnd.ms-excel'), archivoPdf('ficha.pdf')],
      BBB222: [archivoPdf('solo.xlsx', 'application/vnd.ms-excel')],
      CCC333: [archivoPdf('escaneo.pdf')]
    }
  });
  estado.ocr['ficha.pdf'] = 'FICHA TECNICA. Fabricante: ACME Corp. Usuario final: Planta Demo. ' + 'z'.repeat(8000);
  estado.ocr['escaneo.pdf'] = '   ';
  estado.respuestas.push(respuestaGroq('{"fabricante":"ACME Corp","usuarioFinal":"Planta Demo"}'));

  ejecutar('analizarTodosLosDocumentos()');

  assert.strictEqual(estado.llamadasGroq.length, 1, 'solo la carpeta con texto llama a la IA');
  assert.strictEqual(hoja.celda(2, 16), 'ACME Corp');
  assert.strictEqual(hoja.celda(2, 17), 'Planta Demo');
  assert.strictEqual(hoja.celda(3, 16), 'Sin archivo analizable en carpeta');
  assert.strictEqual(hoja.celda(4, 16), 'Sin texto legible');
  assert.strictEqual(hoja.celda(5, 16), '', 'descartada: no se analiza');
  assert.strictEqual(hoja.celda(6, 16), '', 'vencida: no se analiza');
  assert.strictEqual(hoja.celda(7, 16), '', 'enlace inválido: no se analiza');
  assert.deepStrictEqual(estado.papelera.sort(), ['doc-escaneo.pdf', 'doc-ficha.pdf'], 'los Docs temporales de OCR van a la papelera');
  const msgUsuario = estado.llamadasGroq[0].cuerpo.messages[1].content;
  assert.ok(msgUsuario.length < 6100, 'el texto se recorta a 6000 caracteres');
});

prueba('documentos: error de la IA deja "Error en el análisis" y no detiene el resto', () => {
  const { hoja, estado, ejecutar } = entorno({
    filas: [fila({ estado: 'Pendiente revisión', dias: 4, carpeta: 'https://drive.google.com/drive/folders/AAA111' })],
    carpetas: { AAA111: [archivoPdf('ficha.pdf')] }
  });
  estado.ocr['ficha.pdf'] = 'texto suficientemente largo para el OCR';
  for (let i = 0; i < 4; i++) estado.respuestas.push(new Error('caída'));
  ejecutar('analizarTodosLosDocumentos()');
  assert.strictEqual(hoja.celda(2, 16), 'Error en el análisis');
});

prueba('visibilidad: oculta vencidas y descartadas; nunca oculta las protegidas', () => {
  const { hoja, ejecutar } = entorno({
    filas: [
      fila({ estado: 'Pendiente revisión', dias: 3 }),   // fila 2: visible
      fila({ estado: 'Pendiente revisión', dias: -2 }),  // fila 3: oculta (vencida)
      fila({ estado: 'Descartado', dias: 10 }),          // fila 4: oculta
      fila({ estado: 'No asignado', dias: 10 }),         // fila 5: oculta
      fila({ estado: 'Participando', dias: -10 })        // fila 6: visible aunque esté vencida
    ]
  });
  hoja.hideRows(6); // estaba oculta: debe volver a mostrarse
  ejecutar('ocultarFilasConFechaVencida()');
  assert.deepStrictEqual([...hoja.ocultas].sort(), [3, 4, 5]);
});

prueba('visibilidad: alternar oculta y vuelve a mostrar las vencidas protegidas', () => {
  const { hoja, estado, ejecutar } = entorno({
    filas: [
      fila({ estado: 'Cotizado', dias: -5 }),
      fila({ estado: 'Asignado', dias: -1 }),
      fila({ estado: 'Pendiente revisión', dias: -1 })
    ]
  });
  ejecutar('alternarFilasVencidasProtegidas()');
  assert.deepStrictEqual([...hoja.ocultas].sort(), [2, 3]);
  ejecutar('alternarFilasVencidasProtegidas()');
  assert.deepStrictEqual([...hoja.ocultas], []);
  assert.ok(estado.alertas[0].includes('ocultaron') && estado.alertas[1].includes('mostraron'));
});

prueba('hoja inexistente: avisa en vez de fallar', () => {
  const { estado, ejecutar } = entorno({ filas: [] });
  ejecutar('CONFIG.HOJA = "Otra"');
  ejecutar('fillResumen()');
  assert.ok(estado.alertas[0].includes('No se encontró la hoja "Otra"'));
});

// ---------------------------------------------------------------------------
let fallidas = 0;
pruebas.forEach(({ nombre, fn }) => {
  try {
    fn();
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallidas++;
    console.log('  FALLA ' + nombre + '\n         ' + (e.message || e).split('\n').join('\n         '));
  }
});
console.log(`\n${pruebas.length - fallidas}/${pruebas.length} pruebas pasaron`);
process.exit(fallidas ? 1 : 0);
