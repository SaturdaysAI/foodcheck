/* ============================================================================
 * Cloudflare Worker - DOBLE RUTA
 * 1. POST /      -> Maneja la IA de Visión (Llava)
 * 2. GET /api/nutrition -> Maneja la búsqueda en OpenFoodFacts (OFF)
 * ========================================================================== */

// --- Funciones Helper (Comunes) ---
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function extractJson(text) {
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) return null;
  const jsonEnd = text.lastIndexOf('}');
  if (jsonEnd === -1 || jsonEnd < jsonStart) return null;
  let jsonString = text.substring(jsonStart, jsonEnd + 1);
  const cleanedJsonString = jsonString.replace(/\\_/g, '_');
  try {
    return JSON.parse(cleanedJsonString);
  } catch (e) {
    return null;
  }
}

// --- RUTA 1: IA de Visión ---
async function handleVisionRequest(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: "JSON inválido" }), {
      status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
  const { imageBase64 } = payload;
  if (!imageBase64) {
    return new Response(JSON.stringify({ error: "Falta imageBase64" }), {
      status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }

  const parts = imageBase64.split(",");
  if (parts.length !== 2 || !parts[0].startsWith("data:image/")) {
    return new Response(JSON.stringify({ error: "Formato de imagen Data URL inválido" }), {
      status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
  const base64Data = parts[1];
  let imageBytes;
  try {
    imageBytes = base64ToBytes(base64Data);
  } catch (e) {
    return new Response(JSON.stringify({ error: "Error al decodificar Base64" }), {
      status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
  
  const systemInstructions = `
    Eres un asistente experto en vision que identifica todos los alimentos visibles en una fotografia.
    Devuelve UNICAMENTE un objeto JSON valido que siga exactamente el esquema proporcionado (sin comentarios ni texto extra).
    El JSON debe tener una clave raiz "detections", que es un array de objetos.
    Para cada alimento:
    - Usa "name" con un nombre especifico y descriptivo en espanol en minusculas (por ejemplo "platano entero", "manzana roja", "yogur natural").
    - "bbox" debe contener las coordenadas del rectangulo que delimita el alimento, normalizadas entre 0 y 1 con hasta cuatro decimales (x,y = esquina superior izquierda; width,height = anchura y altura). width y height deben ser > 0.01.
    - "confidence" debe ser un numero entre 0 y 1 con hasta cuatro decimales.
    - "portion_estimate_grams" debe ser tu mejor estimacion de la cantidad aproximada en gramos (usa numeros enteros).
    - "alternatives" es un array con nombres alternativos posibles en espanol (o vacio si no hay).
    - "cooking" debe ser uno de los valores: "crudo", "hervido", "plancha", "frito", "horneado", "guiso".
    - "notes" es un array de frases cortas en espanol que expliquen pistas visuales o dudas (o vacio).
    EJEMPLO: {"detections": [{"name": "huevo frito", "bbox": [0.2, 0.3, 0.5, 0.5], "confidence": 0.9, "portion_estimate_grams": 60, "alternatives": ["huevo estrellado"], "cooking": "frito", "notes": ["yema visible"]}]}
    `.trim();

  try {
    const inputs = {
      image: Array.from(imageBytes),
      prompt: systemInstructions,
      max_tokens: 1024,
    };
    const result = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', inputs);

    if (!result || typeof result.description !== 'string') {
      const errorDetails = JSON.stringify(result, null, 2);
      throw new Error("Respuesta inesperada del modelo. No se encontró 'description' string. Contenido: " + errorDetails);
    }
    const modelResponseText = result.description; 
    
    const extractedJson = extractJson(modelResponseText);
    let finalJsonResponse;

    if (!extractedJson || !extractedJson.detections) {
      finalJsonResponse = JSON.stringify({ detections: [] });
    } else {
      finalJsonResponse = JSON.stringify(extractedJson);
    }
    
    return new Response(finalJsonResponse, {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Error en el modelo de IA", details: err.message }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
}

// --- RUTA 2: Búsqueda de Nutrición (OFF) ---
async function handleNutritionRequest(request, env) {
  const url = new URL(request.url);
  // Recreamos los parámetros de búsqueda, pero pasándolos desde nuestra URL
  const params = url.searchParams;

  try {
    const offUrl = `https://world.openfoodfacts.org/cgi/search.pl?${params.toString()}`;
    
    // El worker llama a OFF (de servidor a servidor, sin CORS)
    const response = await fetch(offUrl, {
      headers: {
        'User-Agent': 'FoodCheckApp-Proxy/1.0' // Es buena práctica identificarse
      }
    });

    if (!response.ok) {
      throw new Error(`OpenFoodFacts falló con ${response.status}`);
    }

    const data = await response.json();
    
    // Devolvemos la respuesta de OFF al navegador
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  
  } catch (err) {
    return new Response(JSON.stringify({ error: "Error al contactar OpenFoodFacts", details: err.message }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
}

// --- Router Principal ---
export default {
  async fetch(request, env, ctx) {
    
    // --- Manejar OPTIONS (CORS) ---
    // Global para todas las rutas
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // --- RUTA 1: POST / (IA Vision) ---
    if (request.method === "POST" && url.pathname === "/") {
      return await handleVisionRequest(request, env);
    }

    // --- RUTA 2: GET /api/nutrition (Nuevo Endpoint) ---
    if (request.method === "GET" && url.pathname === "/api/nutrition") {
      return await handleNutritionRequest(request, env);
    }

    // --- Fallback (Ruta no encontrada) ---
    return new Response(JSON.stringify({ error: "Ruta no encontrada" }), {
      status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
};
