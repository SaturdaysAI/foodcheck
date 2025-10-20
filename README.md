## FoodCheck

FoodCheck es una herramienta de análisis nutricional mediante fotos de platos. A partir de la fotografía de un plato de comida identifica los alimentos y ofrece información nutricional que proviene de la base de datos abierta OpenFoodFacts.

## Cómo probar el proyecto
1. Clona o descarga el repositorio.
2. Abre `index.html` directamente en tu navegador (doble clic o arrastrando el archivo a una pestaña).
3. Añade la foto de tu plato y comprueba que los alimentos detectados y sus cantidades son correctos. Si faltan alimentos, agrégalos manualmente manualmente con el botón "Añadir alimento".

## Funcionalidades
- Selección de condiciones médicas para adaptar los mensajes.
- Análisis de comida por imagen.
- Búsqueda de alimentos por nombre y marca en OpenFoodFacts. Edición de cantidades.
- Resumen diario de macronutrientes y registro histórico local.
- Asistente dietista virtual que da sugerencias según el análisis del plato.
- Toda la información se guarda en `localStorage`; no es necesario un backend.

## Estado actual del proyecto
- Actualmente, el modelo de detección no detecta correctamente los alimentos, por lo que la funcionalidad de análisis nutricional está en desarrollo.
