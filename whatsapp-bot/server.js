require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Historial de conversaciones en memoria ───────────────────────────────────
const conversaciones = {};

// ─── Horario Argentina ────────────────────────────────────────────────────────
function obtenerHoraArgentina() {
  return new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: 'numeric',
    hour12: false
  });
}

function obtenerResponsable() {
  const hora = parseInt(obtenerHoraArgentina());
  if (hora >= 6 && hora < 10) return 'german';
  if (hora >= 10 && hora < 22) return 'guillermo';
  return 'fuera_horario';
}

// ─── Enviar mensaje por WhatsApp ──────────────────────────────────────────────
async function enviarMensaje(numero, texto) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: numero,
      type: 'text',
      text: { body: texto }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// ─── Generar respuesta con Claude ─────────────────────────────────────────────
async function generarRespuesta(numero, mensajeUsuario) {
  if (!conversaciones[numero]) conversaciones[numero] = [];

  conversaciones[numero].push({ role: 'user', content: mensajeUsuario });

  // Mantener máximo 10 mensajes de historial
  if (conversaciones[numero].length > 20) {
    conversaciones[numero] = conversaciones[numero].slice(-20);
  }

  const respuesta = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: `Sos el asistente de ventas de MAG Suplementos, representantes oficiales de suplementos nutricionales en Buenos Aires y Mar del Plata, Argentina.

Tu objetivo es ayudar a los clientes con consultas sobre productos, precios, disponibilidad y asesoría nutricional. Respondés de forma amable, breve y profesional. Usás un tono cercano pero serio.

Productos que vendemos: proteínas, creatinas, pre-entrenos, quemadores, vitaminas, aminoácidos y más.
Sitio web: https://mag-rep-oficial.com.ar
Instagram: @mag.rep.oficial

Si el cliente quiere hacer un pedido, necesita asesoría personalizada detallada, o tiene una queja, indicale que en breve lo va a contactar un asesor humano.

Respondé siempre en español rioplatense (vos, che, etc.). Sé conciso, máximo 3 líneas.`,
    messages: conversaciones[numero]
  });

  const textoRespuesta = respuesta.content[0].text;
  conversaciones[numero].push({ role: 'assistant', content: textoRespuesta });

  return textoRespuesta;
}

// ─── Notificar al asesor humano ───────────────────────────────────────────────
async function notificarAsesor(numeroCliente, mensajeCliente, responsable) {
  const mensajes = {
    german: `🔔 *MAG Bot* - Consulta para vos (turno mañana)\n\nCliente: wa.me/${numeroCliente}\nMensaje: "${mensajeCliente}"\n\nRespondele cuando puedas 👍`,
    guillermo: `🔔 *MAG Bot* - Consulta para vos\n\nCliente: wa.me/${numeroCliente}\nMensaje: "${mensajeCliente}"\n\nRespondele cuando puedas 👍`
  };

  const numeroAsesor = responsable === 'german'
    ? process.env.GERMAN_NUMBER
    : process.env.GUILLERMO_NUMBER;

  if (numeroAsesor && mensajes[responsable]) {
    try {
      await enviarMensaje(numeroAsesor, mensajes[responsable]);
    } catch (e) {
      console.log('No se pudo notificar al asesor:', e.message);
    }
  }
}

// ─── Webhook verificación (GET) ───────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Webhook recepción de mensajes (POST) ─────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const entry = req.body.entry?.[0];
    const cambios = entry?.changes?.[0]?.value;
    const mensaje = cambios?.messages?.[0];

    if (!mensaje || mensaje.type !== 'text') return;

    const numeroCliente = mensaje.from;
    const textoCliente = mensaje.text.body;

    console.log(`📩 Mensaje de ${numeroCliente}: ${textoCliente}`);

    const responsable = obtenerResponsable();

    if (responsable === 'fuera_horario') {
      // Fuera de horario: respuesta automática
      await enviarMensaje(
        numeroCliente,
        '¡Hola! 👋 Gracias por escribirnos a *MAG Suplementos*.\n\nNuestro horario de atención es de 6:00 a 22:00 hs (Argentina). En cuanto abramos te respondemos! 💪\n\nWhile you wait, podés ver todos nuestros productos en: https://mag-rep-oficial.com.ar'
      );
      return;
    }

    // Generar respuesta con IA
    const respuestaIA = await generarRespuesta(numeroCliente, textoCliente);
    await enviarMensaje(numeroCliente, respuestaIA);

    // Notificar al asesor humano para que tenga contexto
    await notificarAsesor(numeroCliente, textoCliente, responsable);

  } catch (error) {
    console.error('❌ Error procesando mensaje:', error.message);
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('MAG WhatsApp Bot funcionando ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
