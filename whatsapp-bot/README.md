# MAG WhatsApp Bot

Bot de WhatsApp con IA (Claude) para MAG Suplementos.

## Cómo funciona

- **6:00 - 10:00 ARG** → IA responde + notifica a Germán
- **10:00 - 22:00 ARG** → IA responde + notifica a Guillermo  
- **22:00 - 6:00 ARG** → Mensaje automático de fuera de horario

## Setup

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar variables de entorno
```bash
cp .env.example .env
# Editar .env con los valores reales
```

### 3. Variables necesarias en .env
- `VERIFY_TOKEN` → cualquier texto secreto (ej: mag_secreto_2024)
- `WHATSAPP_ACCESS_TOKEN` → token de Meta Developers
- `PHONE_NUMBER_ID` → ID del número en Meta Developers
- `ANTHROPIC_API_KEY` → key de console.anthropic.com
- `GERMAN_NUMBER` → 5492235408752
- `GUILLERMO_NUMBER` → 5492236974558

### 4. Correr localmente
```bash
npm start
```

### 5. Deploy en Railway
1. Subir este proyecto a GitHub
2. Conectar repo en railway.app
3. Agregar las variables de entorno
4. Railway genera una URL pública automáticamente

### 6. Configurar webhook en Meta Developers
- URL: `https://tu-url-railway.app/webhook`
- Token: el mismo que pusiste en VERIFY_TOKEN
