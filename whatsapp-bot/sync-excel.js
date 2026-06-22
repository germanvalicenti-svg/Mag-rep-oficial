/**
 * sync-excel.js — Sincroniza stock.json desde MAG_Control_Stock_2026.xlsx
 *
 * USO:
 *   node sync-excel.js [--dry-run] [--path="/ruta/al/excel.xlsx"]
 *
 * Por defecto busca el Excel en:
 *   ../PLAN DE MARKETING Y STOCK/MAG_Control_Stock_2026.xlsx
 *
 * Instalar dependencia si no está:
 *   npm install exceljs
 */

const fs   = require('fs');
const path = require('path');

// Verificar si exceljs está instalado
let ExcelJS;
try {
  ExcelJS = require('exceljs');
} catch {
  console.error('❌ Falta exceljs. Instalalo con: npm install exceljs');
  process.exit(1);
}

// ─── ARGUMENTOS ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pathArg = args.find(a => a.startsWith('--path='));
const EXCEL_PATH = pathArg
  ? pathArg.replace('--path=', '')
  : path.join(__dirname, '..', 'PLAN DE MARKETING Y STOCK', 'MAG_Control_Stock_2026.xlsx');

const STOCK_PATH = path.join(__dirname, 'stock.json');

// ─── LEER STOCK ACTUAL (para preservar precios y alertas) ────────────────────
function leerStockActual() {
  try { return JSON.parse(fs.readFileSync(STOCK_PATH, 'utf8')); }
  catch { return {}; }
}

// ─── PARSEAR SHEET DE INVENTARIO ─────────────────────────────────────────────
async function parsearInventario(workbook) {
  // Buscar la sheet de Inventario (puede tener emoji en el nombre)
  let sheet = null;
  workbook.worksheets.forEach(ws => {
    const nombre = ws.name.toLowerCase().replace(/[^a-záéíóúñ\s]/g, '').trim();
    if (nombre.includes('inventario')) sheet = ws;
  });

  if (!sheet) {
    console.error('❌ No se encontró la sheet de Inventario en el Excel.');
    console.log('   Sheets disponibles:', workbook.worksheets.map(w => w.name));
    return null;
  }

  console.log(`📋 Leyendo sheet: "${sheet.name}"`);

  const filas = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // Saltar encabezado
    const valores = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      valores.push(cell.value !== null && cell.value !== undefined ? String(cell.value).trim() : '');
    });
    if (valores.length > 0 && valores[0]) {
      filas.push(valores);
    }
  });

  return filas;
}

// ─── MAPEAR FILAS A STOCK ─────────────────────────────────────────────────────
function mapearFilasAStock(filas, stockActual) {
  const nuevoStock = {};

  for (const fila of filas) {
    // Columnas esperadas: PRODUCTO | SABOR/VARIANTE | STOCK | MÍNIMO | PRECIO WEB | ...
    // Ajustar según la estructura real del Excel
    const [col0 = '', col1 = '', col2 = '', col3 = '', col4 = ''] = fila;

    const productoBase = col0.trim();
    const sabor = col1.trim();
    const stockNum = parseInt(col2) || 0;
    const minimo = parseInt(col3) || 2;
    const precioWeb = parseInt(String(col4).replace(/[^\d]/g, '')) || 0;

    if (!productoBase) continue;

    // Construir clave: "Producto · Sabor" si hay sabor, o solo "Producto"
    const clave = sabor && sabor !== '-' && sabor !== ''
      ? `${productoBase} · ${sabor}`
      : productoBase;

    // Preservar precio del stock actual si el Excel no tiene precio
    const precioFinal = precioWeb > 0 ? precioWeb : (stockActual[clave]?.precio || 0);

    nuevoStock[clave] = {
      nombre: clave,
      stock: stockNum,
      alerta: minimo,
      precio: precioFinal,
    };
  }

  return nuevoStock;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔄 Sincronizando stock desde Excel...');
  console.log(`📂 Archivo: ${EXCEL_PATH}`);

  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`❌ No se encontró el archivo: ${EXCEL_PATH}`);
    console.log('   Verificá la ruta o usá --path="/ruta/completa/al/excel.xlsx"');
    process.exit(1);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(EXCEL_PATH);

  const filas = await parsearInventario(workbook);
  if (!filas) process.exit(1);

  console.log(`✅ ${filas.length} filas leídas del Excel`);

  const stockActual = leerStockActual();
  const nuevoStock = mapearFilasAStock(filas, stockActual);

  // Mostrar cambios
  let cambios = 0;
  for (const [clave, datos] of Object.entries(nuevoStock)) {
    const anterior = stockActual[clave];
    if (!anterior) {
      console.log(`  ➕ NUEVO: ${clave} → stock: ${datos.stock}`);
      cambios++;
    } else if (anterior.stock !== datos.stock) {
      const diff = datos.stock - anterior.stock;
      const signo = diff > 0 ? '+' : '';
      console.log(`  📦 ${clave}: ${anterior.stock} → ${datos.stock} (${signo}${diff})`);
      cambios++;
    }
  }

  // Productos que ya no están en el Excel (los mantenemos con el stock que tenían)
  for (const clave of Object.keys(stockActual)) {
    if (!nuevoStock[clave]) {
      console.log(`  ⚠️ No encontrado en Excel, manteniendo: ${clave} (stock: ${stockActual[clave].stock})`);
      nuevoStock[clave] = stockActual[clave];
    }
  }

  if (cambios === 0) {
    console.log('✅ Sin cambios de stock detectados.');
  } else {
    console.log(`\n📊 ${cambios} cambio(s) detectado(s).`);
  }

  if (dryRun) {
    console.log('\n🔍 DRY RUN — No se guardaron cambios.');
    console.log('   Corré sin --dry-run para aplicar los cambios.');
    return;
  }

  // Hacer backup del stock anterior
  const backupPath = STOCK_PATH + '.bak';
  fs.copyFileSync(STOCK_PATH, backupPath);
  console.log(`💾 Backup guardado en: ${backupPath}`);

  // Guardar nuevo stock
  fs.writeFileSync(STOCK_PATH, JSON.stringify(nuevoStock, null, 2), 'utf8');
  console.log(`✅ stock.json actualizado con ${Object.keys(nuevoStock).length} SKUs.`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
