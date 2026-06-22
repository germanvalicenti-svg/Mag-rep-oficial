require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { PRODUCTOS, generarCatalogoParaIA } = require('./products');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── PATHS DE DATOS ───────────────────────────────────────────────────────────
const STOCK_PATH    = path.join(__dirname, 'stock.json');
const WAITLIST_PATH = path.join(__dirname, 'waitlist.json');
const CONV_PATH     = path.join(__dirname, 'conversations.json');
const PEDIDOS_PATH  = path.join(__dirname, 'pedidos.json');

// ─── LECTURA / ESCRITURA ──────────────────────────────────────────────────────
function leerJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return {}; }
}
function escribirJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

// ─── HORARIO ARGENTINA ────────────────────────────────────────────────────────
function horaArgentina() {
  return parseInt(new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false
  }));
}
function obtenerResponsable() {
  const h = horaArgentina();
  if (h >= 6  && h < 10) return 'german';
  if (h >= 10 && h < 22) return 'guillermo';
  return 'fuera_horario';
}

// ─── STOCK ────────────────────────────────────────────────────────────────────
// El stock usa claves de string por nombre completo (ej: "Protein W80 · Chocolate")
function getStock() { return leerJSON(STOCK_PATH); }
function setStock(data) { escribirJSON(STOCK_PATH, data); }

// Busca una entrada de stock por clave exacta o por nombre parcial
function buscarEnStock(nombreParcial) {
  const stock = getStock();
  const t = nombreParcial.toLowerCase();
  return Object.entries(stock).filter(([key]) => key.toLowerCase().includes(t));
}

// Retorna la entrada de stock exacta por clave
function stockInfo(clave) {
  return getStock()[clave] || null;
}

// Descuenta 1 unidad de stock y lanza alerta si queda poco
function descontarStock(clave) {
  const stock = getStock();
  if (stock[clave] && stock[clave].stock > 0) {
    stock[clave].stock -= 1;
    setStock(stock);
    if (stock[clave].stock <= stock[clave].alerta) {
      notificarStockBajo(clave, stock[clave].stock);
    }
    return true;
  }
  return false;
}

// ─── WAITLIST ─────────────────────────────────────────────────────────────────
function getWaitlist() { return leerJSON(WAITLIST_PATH); }
function setWaitlist(data) { escribirJSON(WAITLIST_PATH, data); }

function agregarAWaitlist(clave, nombre, numeroCliente) {
  const wl = getWaitlist();
  if (!wl[clave]) wl[clave] = [];
  if (wl[clave].some(e => e.numero === numeroCliente)) return false;
  wl[clave].push({ nombre, numero: numeroCliente, fecha: new Date().toISOString() });
  setWaitlist(wl);
  return true;
}

function posicionEnWaitlist(clave, numeroCliente) {
  const wl = getWaitlist();
  const lista = wl[clave] || [];
  const idx = lista.findIndex(e => e.numero === numeroCliente);
  return idx === -1 ? null : idx + 1;
}

// ─── PEDIDOS ──────────────────────────────────────────────────────────────────
function getPedidos() { return leerJSON(PEDIDOS_PATH); }

function registrarPedido(numero, nombre, productos, textoOriginal) {
  const pedidos = getPedidos();
  if (!Array.isArray(pedidos)) {
    // Si por error no es array, reinicializar
    escribirJSON(PEDIDOS_PATH, []);
  }
  const lista = Array.isArray(pedidos) ? pedidos : [];
  const nuevoPedido = {
    id: lista.length + 1,
    fecha: new Date().toISOString(),
    cliente: nombre || 'Sin nombre',
    whatsapp: numero,
    productosDescripcion: productos,
    mensajeOriginal: textoOriginal,
    estado: 'PENDIENTE',
    metodoPago: null,
    entrega: null,
  };
  lista.push(nuevoPedido);
  escribirJSON(PEDIDOS_PATH, lista);
  return nuevoPedido;
}

// ─── CONVERSACIONES (persistentes) ───────────────────────────────────────────
function getConversaciones() { return leerJSON(CONV_PATH); }
function guardarConversaciones(data) { escribirJSON(CONV_PATH, data); }

function obtenerHistorial(numero) {
  return getConversaciones()[numero] || [];
}

function agregarMensaje(numero, role, content) {
  const convs = getConversaciones();
  if (!convs[numero]) convs[numero] = [];
  convs[numero].push({ role, content });
  if (convs[numero].length > 20) convs[numero] = convs[numero].slice(-20);
  guardarConversaciones(convs);
}

// ─── ENVIAR WHATSAPP ──────────────────────────────────────────────────────────
async function enviarMensaje(numero, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: numero, type: 'text', text: { body: texto } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('❌ Error enviando a', numero, e.response?.data || e.message);
  }
}

// ─── NOTIFICACIONES INTERNAS ──────────────────────────────────────────────────
async function notificarStockBajo(nombreProducto, cantidadRestante) {
  const resp = obtenerResponsable();
  const numero = resp === 'german' ? process.env.GERMAN_NUMBER : process.env.GUILLERMO_NUMBER;
  if (!numero) return;
  await enviarMensaje(numero,
    `⚠️ *MAG Bot — ALERTA DE STOCK*\n\n` +
    `📦 *${nombreProducto}*\nQuedan *${cantidadRestante} unidades*.\n\n` +
    `Avisale al proveedor para reponer antes de quedarse sin stock.`
  );
}

async function notificarAsesor(numeroCliente, mensajeCliente, razon, datosPedido = null) {
  const resp = obtenerResponsable();
  const numero = resp === 'german' ? process.env.GERMAN_NUMBER : process.env.GUILLERMO_NUMBER;
  if (!numero) return;

  let texto = `🔔 *MAG Bot — Atención requerida*\n\n` +
    `👤 Cliente: wa.me/${numeroCliente}\n` +
    `📌 Motivo: ${razon}\n` +
    `💬 Mensaje: _"${mensajeCliente}"_`;

  if (datosPedido) {
    texto += `\n\n📦 *Detalle del pedido:*\n${datosPedido}`;
  }

  texto += `\n\n→ Respondele cuando puedas 👍`;
  await enviarMensaje(numero, texto);
}

// ─── NOTIFICAR WAITLIST CUANDO VUELVE EL STOCK ───────────────────────────────
async function notificarWaitlist(clave) {
  const wl = getWaitlist();
  const lista = wl[clave] || [];
  if (lista.length === 0) return;

  const stock = getStock();
  const producto = stock[clave];
  if (!producto) return;

  console.log(`📢 Notificando ${lista.length} cliente(s) en espera de ${clave}`);

  for (let i = 0; i < lista.length; i++) {
    const cliente = lista[i];
    await enviarMensaje(cliente.numero,
      `🎉 *¡Buenas noticias, ${cliente.nombre}!*\n\n` +
      `*${producto.nombre}* volvió a tener stock en MAG Suplementos.\n\n` +
      `📋 Sos el/la *#${i + 1}* en la lista de espera.\n` +
      `💰 Precio: $${producto.precio.toLocaleString('es-AR')}\n\n` +
      `Respondé *"quiero comprar"* para reservarlo antes de que se agote. ¡No te lo pierdas! 💪`
    );
    await new Promise(r => setTimeout(r, 1200));
  }
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const catalogo = generarCatalogoParaIA();
  const stock = getStock();

  // Agrupar por estado
  const sinStock = [];
  const pocoStock = [];
  const disponible = [];

  for (const [clave, s] of Object.entries(stock)) {
    if (s.stock === 0) {
      sinStock.push(`❌ ${clave}`);
    } else if (s.stock <= s.alerta) {
      pocoStock.push(`⚠️ ${clave}: ${s.stock} ud. (POCO STOCK)`);
    } else {
      disponible.push(`✅ ${clave}: ${s.stock} ud.`);
    }
  }

  const estadoStock =
    (sinStock.length   ? `\n🚫 SIN STOCK:\n${sinStock.join('\n')}`   : '') +
    (pocoStock.length  ? `\n⚠️ POCO STOCK:\n${pocoStock.join('\n')}` : '') +
    (disponible.length ? `\n✅ DISPONIBLE:\n${disponible.join('\n')}` : '');

  return `Sos el asistente virtual de *MAG Suplementos*, representantes oficiales de suplementos nutricionales en Mar del Plata y Buenos Aires, Argentina. Todos los productos son certificados RNPA, fabricados por farmacéutica habilitada.

## TU ROL
Sos un asesor experto en nutrición deportiva y salud. Tu trabajo es ayudar al cliente a elegir el producto correcto, resolver sus dudas con precisión y hacer que se sienta muy bien atendido. Hablás en español rioplatense (vos, te, che). Sos cálido, directo y profesional.

## CÓMO RESPONDER
- Información REAL del catálogo. Nunca inventés datos ni precios.
- Si te preguntan por un producto: precio, descripción, cómo tomarlo, para quién es y sabores disponibles.
- Si el cliente describe su objetivo (bajar grasa, ganar músculo, mejorar rendimiento, dormir mejor), recomendá 2-3 productos específicos con precios. Explicá por qué cada uno.
- Sé concreto y útil. Máximo 5-6 líneas por respuesta. Sin frases genéricas ni paja.
- Al saludar usá siempre "¡Hola!" o "¡Hola, buen día!" — nunca "Ey", "Qué onda" ni expresiones demasiado informales.
- NO decís "te comunico con un asesor" para preguntas de productos, precios, usos o ingredientes.
- Solo escalás a asesor humano si el cliente quiere CERRAR UN PEDIDO (pagar, coordinar envío) o tiene una queja seria.

## PRECIOS
Todos los precios listados son precios WEB (precio al público). Si el cliente consulta por precios mayoristas o de revendedor, avisale que esos precios los maneja el equipo directamente.

## STOCK — MUY IMPORTANTE
El estado de stock actual está abajo. Cuando te consulten por disponibilidad:
- Si hay stock (✅): confirmá que está disponible.
- Si hay POCO STOCK (⚠️): avisá que quedan pocas unidades y que conviene no demorarlo.
- Si NO hay stock (❌): avisá que está agotado y ofrecé la lista de espera: "¿Querés que te anotemos? Te avisamos cuando vuelva y te respetamos el precio actual."
- Para Protein W80 y productos con sabores: siempre detallá qué sabores tienen stock y cuáles no.

## PEDIDOS
Cuando el cliente quiera comprar, recolectá:
1. Qué producto/s quiere y en qué cantidad
2. Si retira en Mar del Plata / Buenos Aires o necesita envío
3. Su nombre para el pedido

Luego decile que en breve lo contacta un asesor para coordinar pago y entrega.

## CATÁLOGO COMPLETO
${catalogo}

## ESTADO DE STOCK ACTUAL (actualizado en tiempo real)
${estadoStock}

## DATOS DEL NEGOCIO
- Web: https://mag-rep-oficial.com.ar
- Instagram: @mag.rep.oficial
- Medios de pago: MercadoPago y efectivo.
- Envíos a todo el país.
- Consultas de lunes a sábado de 6:00 a 22:00 hs (hora Argentina).`;
}

// ─── GENERAR RESPUESTA CON IA ─────────────────────────────────────────────────
async function generarRespuesta(numero, mensajeUsuario) {
  agregarMensaje(numero, 'user', mensajeUsuario);
  const historial = obtenerHistorial(numero);

  const respuesta = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    system: buildSystemPrompt(),
    messages: historial,
  });

  const texto = respuesta.content[0].text;
  agregarMensaje(numero, 'assistant', texto);
  return texto;
}

// ─── ESTADOS POR CLIENTE ──────────────────────────────────────────────────────
// Esperando nombre para waitlist → { numero: claveStock }
const esperandoNombreWaitlist = {};
// Esperando nombre para pedido → { numero: { productos, texto } }
const esperandoDatosPedido = {};

// ─── DETECTAR PRODUCTOS SIN STOCK MENCIONADOS ─────────────────────────────────
function detectarProductoSinStock(texto) {
  const stock = getStock();
  const t = texto.toLowerCase();
  for (const [clave, s] of Object.entries(stock)) {
    if (s.stock === 0) {
      // Buscar palabras clave del nombre en el mensaje
      const palabras = clave.toLowerCase().replace(/[·\-]/g, '').split(/\s+/).filter(w => w.length > 3);
      if (palabras.some(p => t.includes(p))) {
        return { clave, item: s };
      }
    }
  }
  return null;
}

// ─── DETECTAR PRODUCTOS CON POCO STOCK MENCIONADOS ────────────────────────────
function detectarProductoPocoStock(texto) {
  const stock = getStock();
  const t = texto.toLowerCase();
  for (const [clave, s] of Object.entries(stock)) {
    if (s.stock > 0 && s.stock <= s.alerta) {
      const palabras = clave.toLowerCase().replace(/[·\-]/g, '').split(/\s+/).filter(w => w.length > 3);
      if (palabras.some(p => t.includes(p))) {
        return { clave, item: s };
      }
    }
  }
  return null;
}

// ─── DETECTAR SI EL CLIENTE QUIERE COMPRAR ────────────────────────────────────
function quiereComprar(texto) {
  return /quiero comprar|cómo compro|cómo pago|quiero pedir|hacer un pedido|coordinar|envío|cuánto sale el envío|quiero llevar|me lo reservan|cómo me lo mandan|quiero uno|quiero dos|quiero \d/.test(
    texto.toLowerCase()
  );
}

// ─── WEBHOOK VERIFICACIÓN ─────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── WEBHOOK MENSAJES ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido para evitar timeout de Meta

  try {
    const entry   = req.body.entry?.[0];
    const cambios = entry?.changes?.[0]?.value;
    const mensaje = cambios?.messages?.[0];

    if (!mensaje || mensaje.type !== 'text') return;

    const numero = mensaje.from;
    const texto  = mensaje.text.body.trim();

    console.log(`📩 [${numero}] ${texto}`);

    // ── FUERA DE HORARIO ──────────────────────────────────────────────────────
    const hora = horaArgentina();
    if (hora < 6 || hora >= 22) {
      await enviarMensaje(numero,
        `¡Hola! 👋 Gracias por escribirle a *MAG Suplementos*.\n\n` +
        `Nuestro horario de atención es de *6:00 a 22:00 hs* (Argentina).\n` +
        `Te respondemos en cuanto abramos. 💪\n\n` +
        `Mientras tanto, podés ver todos nuestros productos en:\n` +
        `🌐 https://mag-rep-oficial.com.ar`
      );
      return;
    }

    // ── FLUJO WAITLIST: esperando nombre ─────────────────────────────────────
    if (esperandoNombreWaitlist[numero]) {
      const clave = esperandoNombreWaitlist[numero];
      delete esperandoNombreWaitlist[numero];

      const nombreCliente = texto;
      const agregado = agregarAWaitlist(clave, nombreCliente, numero);
      const pos      = posicionEnWaitlist(clave, numero);
      const stock    = getStock();
      const item     = stock[clave];

      if (agregado) {
        await enviarMensaje(numero,
          `✅ ¡Listo, ${nombreCliente}! Te anotamos en la lista de espera de *${item?.nombre || clave}*.\n\n` +
          `📋 Tu posición: *#${pos}*\n` +
          `🔔 Te avisamos en cuanto vuelva y te respetamos el precio actual de *$${item?.precio?.toLocaleString('es-AR') || '—'}*.\n\n` +
          `¿En qué más te puedo ayudar?`
        );
      } else {
        await enviarMensaje(numero,
          `Ya estás anotado/a en la lista de espera de *${item?.nombre || clave}*. Te avisamos cuando vuelva. 👍`
        );
      }
      return;
    }

    // ── FLUJO PEDIDO: esperando nombre del cliente ────────────────────────────
    if (esperandoDatosPedido[numero]) {
      const { productos, textoOriginal } = esperandoDatosPedido[numero];
      delete esperandoDatosPedido[numero];

      const nombreCliente = texto;
      const pedido = registrarPedido(numero, nombreCliente, productos, textoOriginal);

      await enviarMensaje(numero,
        `¡Perfecto, ${nombreCliente}! 🙌\n\n` +
        `Registré tu pedido:\n*${productos}*\n\n` +
        `En breve te contacta un asesor de MAG para coordinar el *pago y la entrega*.\n\n` +
        `¡Gracias por elegir MAG Suplementos! 💪`
      );

      // Notificar al asesor con detalle del pedido
      await notificarAsesor(
        numero, textoOriginal, '🛒 Pedido registrado',
        `Cliente: ${nombreCliente}\nProductos: ${productos}\nPedido N°${pedido.id}`
      );
      return;
    }

    // ── GENERAR RESPUESTA CON IA ──────────────────────────────────────────────
    const respuestaIA = await generarRespuesta(numero, texto);
    await enviarMensaje(numero, respuestaIA);

    // ── POST-PROCESADO: detectar situaciones especiales ───────────────────────
    await new Promise(r => setTimeout(r, 1200)); // Pausa breve

    // 1) Producto sin stock mencionado → ofrecer waitlist
    const sinStockDetectado = detectarProductoSinStock(texto);
    if (sinStockDetectado) {
      const { clave, item } = sinStockDetectado;
      await enviarMensaje(numero,
        `Por cierto, *${item.nombre}* está agotado por ahora.\n` +
        `¿Querés que te anotemos en la lista de espera? Te avisamos cuando vuelva y te respetamos el precio actual de *$${item.precio?.toLocaleString('es-AR')}*. 📋`
      );
      esperandoNombreWaitlist[numero] = clave;
      return;
    }

    // 2) Poco stock → aviso urgente
    const pocoStockDetectado = detectarProductoPocoStock(texto);
    if (pocoStockDetectado) {
      const { item } = pocoStockDetectado;
      await enviarMensaje(numero,
        `⚠️ Te aviso que de *${item.nombre}* quedan *solo ${item.stock} unidades*. Si te interesa, conviene no demorarlo.`
      );
    }

    // 3) Cliente quiere comprar → pedir nombre y escalcar
    if (quiereComprar(texto)) {
      await enviarMensaje(numero,
        `¡Genial! 🎉 Para registrar tu pedido, ¿me decís tu *nombre y apellido*?`
      );
      esperandoDatosPedido[numero] = { productos: texto, textoOriginal: texto };
      await notificarAsesor(numero, texto, '🛒 Cliente quiere hacer un pedido');
    }

  } catch (error) {
    console.error('❌ Error procesando mensaje:', error.message);
  }
});

// ─── ADMIN: RESTOCK + NOTIFICAR WAITLIST ─────────────────────────────────────
app.post('/admin/restock', async (req, res) => {
  const { token, productoNombre, cantidad } = req.body;
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
  if (!productoNombre || cantidad === undefined) return res.status(400).json({ error: 'Falta productoNombre o cantidad' });

  const stock = getStock();
  if (!stock[productoNombre]) return res.status(404).json({ error: 'Producto no encontrado', disponibles: Object.keys(stock) });

  const estabaEnCero = stock[productoNombre].stock === 0;
  stock[productoNombre].stock = cantidad;
  setStock(stock);
  console.log(`📦 Restock: ${productoNombre} → ${cantidad} unidades`);

  if (estabaEnCero && cantidad > 0) {
    await notificarWaitlist(productoNombre);
    const wl = getWaitlist();
    wl[productoNombre] = [];
    setWaitlist(wl);
  }

  res.json({ ok: true, producto: productoNombre, stockActual: cantidad });
});

// ─── ADMIN: VER STOCK ─────────────────────────────────────────────────────────
app.get('/admin/stock', (req, res) => {
  const { token } = req.query;
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

  const stock = getStock();
  const wl = getWaitlist();

  const resumen = Object.entries(stock).map(([clave, s]) => ({
    clave,
    nombre: s.nombre,
    stock: s.stock,
    alerta: s.alerta,
    precio: s.precio,
    estado: s.stock === 0 ? '❌ SIN STOCK' : s.stock <= s.alerta ? '⚠️ POCO STOCK' : '✅ OK',
    enEspera: (wl[clave] || []).length,
  }));

  const sinStock    = resumen.filter(r => r.stock === 0).length;
  const pocoStock   = resumen.filter(r => r.stock > 0 && r.stock <= r.alerta).length;
  const enEsperaTotal = resumen.reduce((acc, r) => acc + r.enEspera, 0);

  res.json({ resumen: { total: resumen.length, sinStock, pocoStock, enEsperaTotal }, productos: resumen });
});

// ─── ADMIN: VER WAITLIST ──────────────────────────────────────────────────────
app.get('/admin/waitlist', (req, res) => {
  const { token } = req.query;
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

  const wl = getWaitlist();
  const stock = getStock();

  const resultado = Object.entries(wl)
    .filter(([, lista]) => lista.length > 0)
    .map(([clave, lista]) => ({
      producto: clave,
      nombre: stock[clave]?.nombre || clave,
      precio: stock[clave]?.precio,
      clientesEnEspera: lista.length,
      lista: lista.map((c, i) => ({
        posicion: i + 1,
        nombre: c.nombre,
        whatsapp: c.numero,
        fecha: c.fecha,
      })),
    }));

  res.json({ total: resultado.reduce((a, r) => a + r.clientesEnEspera, 0), listas: resultado });
});

// ─── ADMIN: VER PEDIDOS ───────────────────────────────────────────────────────
app.get('/admin/pedidos', (req, res) => {
  const { token } = req.query;
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

  const pedidos = getPedidos();
  const lista = Array.isArray(pedidos) ? pedidos : [];

  res.json({
    total: lista.length,
    pendientes: lista.filter(p => p.estado === 'PENDIENTE').length,
    pedidos: lista.reverse(), // Más recientes primero
  });
});

// ─── ADMIN: ACTUALIZAR ESTADO DE PEDIDO ──────────────────────────────────────
app.post('/admin/pedidos/:id/estado', (req, res) => {
  const { token, estado } = req.body;
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

  const pedidos = getPedidos();
  if (!Array.isArray(pedidos)) return res.status(500).json({ error: 'Sin pedidos' });

  const id = parseInt(req.params.id);
  const idx = pedidos.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Pedido no encontrado' });

  pedidos[idx].estado = estado;
  escribirJSON(PEDIDOS_PATH, pedidos);
  res.json({ ok: true, pedido: pedidos[idx] });
});

// ─── ADMIN: DESCONTAR STOCK (venta confirmada) ────────────────────────────────
app.post('/admin/venta', (req, res) => {
  const { token, productoNombre, cantidad = 1 } = req.body;
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

  const stock = getStock();
  if (!stock[productoNombre]) return res.status(404).json({ error: 'Producto no encontrado', disponibles: Object.keys(stock) });
  if (stock[productoNombre].stock < cantidad) return res.status(400).json({ error: 'Stock insuficiente', disponible: stock[productoNombre].stock });

  stock[productoNombre].stock -= cantidad;
  setStock(stock);

  if (stock[productoNombre].stock <= stock[productoNombre].alerta) {
    notificarStockBajo(productoNombre, stock[productoNombre].stock);
  }

  res.json({ ok: true, producto: productoNombre, stockRestante: stock[productoNombre].stock });
});

// ─── ADMIN: ACTUALIZAR PRECIO ─────────────────────────────────────────────────
app.post('/admin/precio', (req, res) => {
  const { token, productoNombre, precio } = req.body;
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });

  const stock = getStock();
  if (!stock[productoNombre]) return res.status(404).json({ error: 'Producto no encontrado' });

  stock[productoNombre].precio = precio;
  setStock(stock);
  res.json({ ok: true, producto: productoNombre, nuevoPrecio: precio });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const stock = getStock();
  const total = Object.keys(stock).length;
  const sinStock = Object.values(stock).filter(s => s.stock === 0).length;
  res.send(`✅ MAG Suplementos Bot v3.0 — ${total} SKUs cargados — ${sinStock} sin stock`);
});

// ─── INICIALIZAR pedidos.json SI NO EXISTE ────────────────────────────────────
if (!fs.existsSync(PEDIDOS_PATH)) {
  escribirJSON(PEDIDOS_PATH, []);
}

// ─── SUSCRIBIR WABA AL WEBHOOK AUTOMÁTICAMENTE ───────────────────────────────
const WABA_ID = '4418796578352662';

async function suscribirWebhookWABA() {
  try {
    const resp = await axios.post(
      `https://graph.facebook.com/v18.0/${WABA_ID}/subscribed_apps`,
      'subscribed_fields=messages',
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      }
    );
    console.log('✅ WABA suscrito al webhook:', JSON.stringify(resp.data));
  } catch (e) {
    console.error('⚠️ Suscripción webhook:', e.response?.data?.error?.message || e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  const stock = getStock();
  console.log(`🚀 MAG Bot v3.0 corriendo en puerto ${PORT}`);
  console.log(`📦 ${Object.keys(stock).length} SKUs cargados`);
  const sinStock = Object.values(stock).filter(s => s.stock === 0).length;
  const pocoStock = Object.values(stock).filter(s => s.stock > 0 && s.stock <= s.alerta).length;
  console.log(`❌ ${sinStock} sin stock | ⚠️ ${pocoStock} con poco stock`);
  await suscribirWebhookWABA();
});
