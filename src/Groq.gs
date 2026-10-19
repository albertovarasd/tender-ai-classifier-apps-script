/**
 * Cliente mínimo de Groq (API compatible con OpenAI) con reintentos.
 *
 * - Si Groq responde "rate_limit_exceeded", espera exactamente lo que indica
 *   ("try again in 15.5s") más un margen y reintenta.
 * - Si la respuesta viene vacía, cortada o con JSON inválido, reintenta tras una pausa.
 */

function obtenerApiKey_() {
  const clave = PropertiesService.getScriptProperties().getProperty(CONFIG.GROQ.PROPIEDAD_API_KEY);
  if (!clave) {
    throw new Error(
      `Falta la propiedad de secuencia de comandos "${CONFIG.GROQ.PROPIEDAD_API_KEY}". ` +
      'Agrégala en Configuración del proyecto > Propiedades de la secuencia de comandos.'
    );
  }
  return clave;
}

/**
 * @param {string} modelo     Modelo de Groq.
 * @param {Array}  mensajes   Mensajes en formato chat [{role, content}].
 * @param {number} maxTokens  Tope de tokens de la respuesta.
 * @param {boolean} comoJson  Si es true, parsea la respuesta como JSON (dentro del
 *                            ciclo de reintentos, para que un JSON cortado se reintente).
 * @return {string|Object|Array} Texto de la respuesta, o el JSON ya parseado.
 * @throws Si se agotan los reintentos.
 */
function llamarGroq(modelo, mensajes, maxTokens, comoJson) {
  const opciones = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + obtenerApiKey_() },
    payload: JSON.stringify({
      model: modelo,
      messages: mensajes,
      temperature: 0,
      max_tokens: maxTokens
    }),
    muteHttpExceptions: true
  };

  let ultimoError = new Error('No se obtuvo respuesta de Groq.');

  for (let intento = 1; intento <= CONFIG.GROQ.MAX_REINTENTOS; intento++) {
    let pausaMs = 3000;
    try {
      const respuesta = UrlFetchApp.fetch(CONFIG.GROQ.URL, opciones);
      const codigoHttp = respuesta.getResponseCode();
      const textoCrudo = respuesta.getContentText();

      if (!textoCrudo || textoCrudo.trim().length === 0) {
        throw new Error(`Respuesta vacía del servidor (código HTTP: ${codigoHttp})`);
      }

      const data = JSON.parse(textoCrudo);

      if (data && data.error) {
        if (data.error.code === 'rate_limit_exceeded') {
          const coincidencia = String(data.error.message).match(/try again in ([\d.]+)s/);
          const segundos = coincidencia ? parseFloat(coincidencia[1]) : 20;
          Logger.log(`Límite de tokens alcanzado, esperando ${segundos}s (intento ${intento})...`);
          ultimoError = new Error('Se agotaron los reintentos por límite de tokens.');
          Utilities.sleep(Math.ceil((segundos + 1) * 1000));
          continue;
        }
        throw new Error('Error de la API: ' + (data.error.message || JSON.stringify(data.error)));
      }

      if (data && data.choices && data.choices.length > 0) {
        const contenido = String(data.choices[0].message.content || '').trim();
        return comoJson ? JSON.parse(limpiarJson_(contenido)) : contenido;
      }

      throw new Error('Respuesta inesperada de la API: ' + textoCrudo.slice(0, 300));
    } catch (e) {
      ultimoError = e;
      Logger.log(`Error al llamar a Groq (intento ${intento}): ${e.message}`);
      // Una respuesta vacía o cortada suele ser un límite de tasa "encubierto":
      // conviene esperar más antes de reintentar.
      const mensaje = String(e.message);
      if (mensaje.indexOf('vacía') !== -1 || mensaje.indexOf('Unexpected end') !== -1) {
        pausaMs = 15000;
      }
      if (intento < CONFIG.GROQ.MAX_REINTENTOS) Utilities.sleep(pausaMs);
    }
  }

  throw ultimoError;
}
