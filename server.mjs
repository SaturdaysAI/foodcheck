import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 8787;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const VISION_ENDPOINT = "/api/vision-detect";
const LEGACY_VISION_ENDPOINTS = ["/api/glm45v"];
const MODEL_PRIORITY = [
  {
    id: "qwen/qwen2.5-vl-72b-instruct:free",
    supportsSchema: false,
    supportsVision: true,
    notes: "Variante gratuita de mayor tamaño (OpenRouter).",
  },
  {
    id: "qwen/qwen2.5-vl-32b-instruct:free",
    supportsSchema: false,
    supportsVision: true,
    notes: "Modelo multimodal gratuito recomendado (OpenRouter).",
  },
  {
    id: "qwen/qwen3-vl-8b-instruct",
    supportsSchema: false,
    supportsVision: true,
    notes: "Alternativa económica multimodal (OpenRouter).",
  },
  {
    id: "meta-llama/llama-3.2-11b-vision-instruct",
    supportsSchema: true,
    supportsVision: true,
    notes: "Fallback con coste (OpenRouter).",
  },
  {
    id: "google/gemini-flash-1.5",
    supportsSchema: true,
    supportsVision: true,
    notes: "Fallback (puede requerir plan).",
  },
];

if (!OPENROUTER_API_KEY) {
  throw new Error("No se detecto OPENROUTER_API_KEY. Define la variable de entorno en tu .env o shell.");
}

const MODEL_INSTRUCTIONS = `
Eres un asistente experto en vision que identifica todos los alimentos visibles en una fotografia.
Devuelve UNICAMENTE un objeto JSON valido que siga exactamente el esquema proporcionado (sin comentarios ni texto extra).
Para cada alimento:
- Usa "name" con un nombre especifico y descriptivo en espanol en minusculas (por ejemplo "platano entero", "manzana roja", "yogur natural").
- "bbox" debe contener las coordenadas del rectangulo que delimita el alimento, normalizadas entre 0 y 1 con hasta cuatro decimales (x,y = esquina superior izquierda; width,height = anchura y altura). width y height deben ser > 0.01.
- "confidence" debe ser un numero entre 0 y 1 con hasta cuatro decimales. Usa valores >= 0.05 incluso si la deteccion es incierta.
- Observa cuidadosamente color, forma y contexto para nombrar el alimento real (ejemplos: fruta amarilla curva -> "platano", fruta roja pequeña con semillas -> "fresa", fruta redonda roja con tallo -> "manzana roja").
- No repitas nombres genéricos ni supongas que es una manzana salvo que se vea claramente una manzana.
- Identifica correctamente bolleria y postres (por ejemplo: "donut de chocolate", "rosquilla glaseada", "croissant"), nunca los nombres como fruta.
- Asegurate de que el bounding box cubra la mayor parte del alimento (>= 0.2 de ancho y alto) y que la porcion estimada sea coherente con el tamaño del alimento.
- "portion_estimate_grams" debe ser tu mejor estimacion de la cantidad aproximada en gramos (usa numeros enteros).
- "alternatives" es un array con nombres alternativos posibles en espanol (o vacio si no hay).
- "cooking" debe ser uno de los valores: "crudo", "hervido", "plancha", "frito", "horneado", "guiso".
- "notes" es un array de frases cortas en espanol que expliquen pistas visuales o dudas (o vacio).
Debes devolver al menos una deteccion cuando haya alimentos visibles. Solo devuelve una lista vacia si no hay comida en la imagen.
`.trim();

const RESPONSE_SCHEMA = {
  name: "food_detections",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      detections: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 2 },
            confidence: { type: "number", minimum: 0.05, maximum: 1 },
            bbox: {
              type: "object",
              additionalProperties: false,
              properties: {
                x: { type: "number", minimum: 0, maximum: 1 },
                y: { type: "number", minimum: 0, maximum: 1 },
                width: { type: "number", minimum: 0.01, maximum: 1 },
                height: { type: "number", minimum: 0.01, maximum: 1 },
              },
              required: ["x", "y", "width", "height"],
            },
            alternatives: {
              type: "array",
              items: { type: "string" },
            },
            cooking: {
              type: "string",
              enum: ["crudo", "hervido", "plancha", "frito", "horneado", "guiso"],
            },
            portion_estimate_grams: { type: "number", minimum: 10 },
            notes: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["name", "confidence", "bbox", "portion_estimate_grams", "alternatives", "cooking", "notes"],
        },
      },
    },
    required: ["detections"],
  },
};

function extractBase64Image(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("La imagen estÃ¡ vacÃ­a.");
  }

  // Divide en prefijo y datos base64
  const parts = dataUrl.split(",");
  if (parts.length !== 2) {
    throw new Error("Formato de imagen invÃ¡lido.");
  }

  const mimeMatch = parts[0].match(/^data:(image\/[a-zA-Z0-9.+-]+);base64$/);
  if (!mimeMatch) {
    throw new Error("La imagen debe ser base64 con prefijo data:image/...");
  }

  const base64Data = parts[1].trim();
  if (!base64Data.length) {
    throw new Error("La imagen en base64 estÃ¡ vacÃ­a.");
  }

  const sizeInBytes = Buffer.byteLength(base64Data, "base64");
  const maxBytes = 10 * 1024 * 1024; // 10 MB
  if (sizeInBytes > maxBytes) {
    throw new Error(`La imagen supera el lÃ­mite de ${maxBytes / (1024 * 1024)} MB.`);
  }

  return { base64Data, mimeType: mimeMatch[1], sizeInBytes };
}


const corsOptions = {
  origin(origin, callback) {
    if (!origin || origin === "null") {
      return callback(null, true);
    }
    return callback(null, true);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
const allVisionEndpoints = [VISION_ENDPOINT, ...LEGACY_VISION_ENDPOINTS];
allVisionEndpoints.forEach((path) => app.options(path, cors(corsOptions)));
app.use(express.json({ limit: "15mb" }));

const handleVisionDetect = async (req, res) => {
  try {
    const { imageBase64, prompt = "Identifica los alimentos principales del plato y delimÃ­talos." } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: "Falta imageBase64" });
    }

    const { base64Data, mimeType, sizeInBytes } = extractBase64Image(imageBase64);
    try {
      fs.writeFileSync("last-image.txt", base64Data);
    } catch (writeError) {
      console.warn("No se pudo guardar last-image.txt:", writeError.message);
    }

    console.log(`Imagen recibida: tipo=${mimeType}, tamaÃ±o=${(sizeInBytes / 1024).toFixed(1)} KB`);
    console.log(`Fragmento base64: ${base64Data.slice(0, 64)}...`);

    let finalData = null;
    let lastFailure = null;

    for (const modelInfo of MODEL_PRIORITY) {
      if (modelInfo.supportsVision === false) {
        console.log(`Omitiendo modelo sin soporte de visión: ${modelInfo.id}`);
        continue;
      }
      try {
        console.log(`Intentando modelo ${modelInfo.id}`);
        const completionPayload = {
          model: modelInfo.id,
          messages: [
            { role: "system", content: MODEL_INSTRUCTIONS.trim() },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `${prompt}\n\nResponde exclusivamente con el JSON especificado usando valores decimales con hasta cuatro cifras.`,
                },
                { type: "input_image", image_base64: base64Data },
              ],
            },
          ],
          max_tokens: 1024,
          temperature: 0,
        };
        if (modelInfo.supportsSchema) {
          completionPayload.response_format = {
            type: "json_schema",
            json_schema: RESPONSE_SCHEMA,
          };
        }

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": "http://localhost:8787",
            "X-Title": "FoodCheck Proxy",
          },
          body: JSON.stringify(completionPayload),
        });

        const raw = await response.text();
        console.log(`OpenRouter status (${modelInfo.id}):`, response.status, "| headers:", Object.fromEntries(response.headers.entries()));
        try {
          fs.writeFileSync("last-response.json", raw);
        } catch (logError) {
          console.warn("No se pudo guardar last-response.json:", logError.message);
        }

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (parseError) {
          parsed = { parseError: parseError.message, raw };
        }

        if (!response.ok) {
          const message = parsed?.error?.message ?? raw;
          console.warn(`Modelo ${modelInfo.id} devolvió error:`, message);
          lastFailure = { status: response.status, error: parsed };

          const isMissingEndpoint =
            response.status === 404 && typeof message === "string" && message.includes("No endpoints found");
          const isProviderFault =
            response.status === 400 &&
            typeof message === "string" &&
            /provider\s+returned\s+error/i.test(message);
          const isRateLimitOrServer = response.status === 429 || response.status >= 500;

          if (isMissingEndpoint || isProviderFault || isRateLimitOrServer) {
            console.log(`Continuando con el siguiente modelo tras error de ${modelInfo.id}.`);
            continue;
          }

          if (response.status === 401 || response.status === 403) {
            return res.status(response.status).json({
              error: "Autenticación fallida con OpenRouter",
              details: parsed,
            });
          }

          return res.status(response.status).json(parsed);
        }

        finalData = parsed;
        break;
      } catch (requestError) {
        console.error(`Error llamando a ${modelInfo.id}:`, requestError);
        lastFailure = { error: requestError.message ?? String(requestError) };
      }
    }

    if (!finalData) {
      return res.status(502).json({
        error: "No se pudo obtener detecciones de los modelos configurados.",
        details: lastFailure,
      });
    }

    res.json(finalData);
  } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).json({ error: "Error en el proxy", details: error.message });
  }
};

app.post(VISION_ENDPOINT, handleVisionDetect);
LEGACY_VISION_ENDPOINTS.forEach((path) => app.post(path, handleVisionDetect));

app.listen(PORT, () => {
  console.log(`Proxy escuchando en http://localhost:${PORT}`);
});




