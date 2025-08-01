// Guarda este archivo como setup-openai.js en la raíz de tu proyecto

const redis = require('redis');
const { promisify } = require('util');

async function setupOpenAIConfig() {
  // Crear cliente Redis
  const client = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || '',
  });

  // Promisify para usar async/await
  const setAsync = promisify(client.set).bind(client);
  const getAsync = promisify(client.get).bind(client);

  try {
    console.log('Configurando API key de OpenAI en Redis...');

    // Configuración de OpenAI
    const apiConfig = {
      api_key: "sk-v1sLERgwDDBja_qN5wHyFM1JVpWncWRLc2IBvyJWXST3BlbkFJhERoWyvZTcPM9r8IYyVZKQz98LOTjJi33vzsMMluYA",
      model: "gpt-3.5-turbo"
    };

    // Guardar en Redis
    await setAsync('openai_config', JSON.stringify(apiConfig));
    console.log('Configuración de OpenAI guardada correctamente en Redis');
    
    // Verificar que se guardó correctamente
    const savedConfig = await getAsync('openai_config');
    if (savedConfig) {
      console.log('Configuración recuperada correctamente:');
      const parsedConfig = JSON.parse(savedConfig);
      console.log('- API Key: ' + parsedConfig.api_key.substring(0, 10) + '...');
      console.log('- Model: ' + parsedConfig.model);
    } else {
      console.error('Error: No se pudo recuperar la configuración');
    }
  } catch (error) {
    console.error('Error al configurar OpenAI:', error);
  } finally {
    // Cerrar la conexión a Redis
    client.quit();
    console.log('Conexión a Redis cerrada');
  }
}

// Ejecutar la función
setupOpenAIConfig();