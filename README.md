# Tender AI Classifier (Google Apps Script)

Automatización en **Google Apps Script** que trabaja sobre una planilla de licitaciones: clasifica cada una con IA, la resume en una línea, identifica fabricante y usuario final leyendo sus documentos con OCR, y oculta las que ya no importan. Funciona en conjunto con un scraper que llena la planilla (por ejemplo, un monitor de licitaciones de SAP Ariba), pero sirve con cualquier planilla que tenga la misma estructura.

> Proyecto independiente. Los ejemplos de este repositorio son ficticios.

## El problema

Un equipo de compras puede recibir decenas de licitaciones nuevas por semana. Decidir a cuáles vale la pena responder exige leer descripciones técnicas largas y abrir PDFs uno por uno. Es lento, y lo más repetitivo se puede automatizar.

## Qué hace

| Opción del menú | Qué hace |
|---|---|
| **1. Llenar Clasificación y Sub-Clasificación** | Clasifica cada licitación activa en una categoría y una sub-categoría, mandando las filas a la IA en lotes. |
| **2. Ocultar Filas Descartado - Vencida** | Oculta las filas vencidas o descartadas. Las que están en un estado protegido (Participando, Cotizado, Asignado) nunca se ocultan. |
| **3. Ocultar/Mostrar Filas Vencidas Protegidas** | Alterna la visibilidad de las vencidas que sí tienen un estado protegido. |
| **4. Analizar Documentos** | Lee el primer PDF o imagen de la carpeta de Drive de cada licitación con OCR y extrae fabricante y usuario final. |
| **5. Resumir Texto Largo** | Resume la descripción técnica en una línea: nombre, plano, material, marca. |

Detalles que importan en la práctica:

- **Solo procesa filas activas** (no vencidas ni descartadas) que aún no tengan resultado, para no gastar tokens.
- **Lotes y reintentos:** agrupa filas por llamada. Si Groq responde con límite de tasa, espera exactamente el tiempo que indica y reintenta; si el JSON viene cortado o inválido, reintenta; si un lote de resúmenes falla, prueba fila por fila.
- **Resultados en la fila correcta:** cada resultado se asigna por su número de elemento, no por su posición. Si el modelo omite un elemento, las demás filas no se corren.
- **Tiempo limitado de Apps Script:** cada ejecución se corta a los 6 minutos. El proceso se frena a los 5, guarda lo hecho y programa su propia continuación, sin borrar los activadores diarios que crees tú.
- **Sin ejecuciones superpuestas:** usa un candado, de modo que dos ejecuciones simultáneas no se pisan.
- **Progreso a salvo:** escribe en la planilla incluso si algo falla a mitad de camino.
- **TIFF:** si el adjunto es TIFF, usa la miniatura JPEG que genera Drive, porque el OCR de Drive no acepta TIFF.

## Tecnologías

Google Apps Script (V8) · Google Sheets · Drive API v2 (OCR) · Groq API (modelos `gpt-oss`) · Node.js solo para las pruebas

## Estructura

```
.
├── appsscript.json          # manifiesto: zona horaria, runtime V8, servicio Drive v2
├── src/
│   ├── Config.gs            # hoja, columnas, estados, modelos y límites
│   ├── Menu.gs              # menú "Tareas Personalizadas"
│   ├── Clasificacion.gs     # opción 1 + prompt de clasificación
│   ├── Visibilidad.gs       # opciones 2 y 3
│   ├── DocAnalyzer.gs       # opción 4: OCR + fabricante/usuario final
│   ├── Resumen.gs           # opción 5 + prompt de resumen
│   ├── Groq.gs              # cliente de Groq con reintentos
│   ├── Triggers.gs          # continuaciones automáticas
│   └── Util.gs              # alertas, hoja, filtro de filas activas
└── tests/run.js             # pruebas con servicios de Google simulados
```

## Estructura esperada de la planilla

Una hoja (por defecto llamada `SAP ARIBA`) con una fila de encabezados y una licitación por fila. Los scripts leen y escriben estas columnas; puedes cambiar los números en `Config.gs`.

| Col. | Contenido | Quién la llena |
|---|---|---|
| F | Texto largo (descripción técnica) | scraper |
| H | Estado (`Pendiente revisión`, `Descartado`, `Participando`…) | scraper / tú |
| J | Enlace a la carpeta de Drive con los adjuntos | scraper |
| L | Clasificación | opción 1 |
| M | Sub-clasificación | opción 1 |
| N | Días para el cierre (negativo = vencida) | fórmula de la planilla |
| P | Fabricante | opción 4 |
| Q | Usuario final | opción 4 |
| R | Resumen | opción 5 |

La columna N la calcula tu planilla con una fórmula a partir de la fecha de cierre; los scripts solo la leen.

## Instalación

1. Abre tu planilla y ve a **Extensiones → Apps Script**.
2. Crea un archivo por cada `.gs` de `src/` y pega su contenido. (Alternativa: usa [clasp](https://github.com/google/clasp) para subir la carpeta completa.)
3. En el menú lateral, **Servicios → Agregar un servicio → Drive API → versión v2**, con el identificador `Drive`. Solo hace falta para la opción 4. Si usas clasp, el servicio ya viene declarado en `appsscript.json`.
4. En **Configuración del proyecto → Propiedades de la secuencia de comandos**, agrega `GROQ_API_KEY` con tu clave de [Groq](https://console.groq.com). La clave no se escribe nunca en el código.
5. Revisa `Config.gs`: nombre de la hoja, números de columna y estados.
6. Recarga la planilla. Aparece el menú **Tareas Personalizadas**. La primera vez Google pedirá autorizar los permisos.

### Ejecución automática

En **Activadores → Añadir activador**, elige por ejemplo `fillBothClassifications` con un activador diario. Las continuaciones por límite de tiempo las programa el propio script.

## Personalización

El criterio de negocio vive en dos prompts, pensados para que los cambies:

- `construirPromptClasificacion_` en `Clasificacion.gs`: las categorías y las reglas. El texto de las opciones se guarda tal cual en la planilla.
- `construirPromptResumen_` en `Resumen.gs`: el formato de la línea de resumen y los ejemplos. Reemplázalos por casos de tu rubro.

## Pruebas

```bash
node tests/run.js
```

Ejecutan el código real de `src/` contra versiones simuladas de `SpreadsheetApp`, `UrlFetchApp`, `ScriptApp`, `DriveApp` y Drive. No llaman a Google ni a Groq. Cubren el filtro de filas activas, el reparto en lotes, el límite de tasa, el JSON cortado, la asignación por número de elemento, la continuación por tiempo, el OCR y la visibilidad de filas.

## Privacidad y límites

- **El texto de las licitaciones y el contenido de los documentos se envían a Groq.** Confirma que tienes permiso para procesar esa información con un servicio externo.
- La opción 4 analiza **un solo archivo por carpeta** (el primer PDF o imagen). Si no tiene texto legible, no prueba con el siguiente.
- Los modelos pueden equivocarse: trata la clasificación y el fabricante como una ayuda para priorizar, no como un dato definitivo.
- Los planes gratuitos de Groq tienen límites de tokens por minuto; por eso hay pausas entre lotes.

## Autor

Alberto Varas — Técnico Analista Programador. Automatización y extracción de datos con Python y Google Apps Script.
