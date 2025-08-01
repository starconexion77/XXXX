const OpenAI = require('openai');
const logger = require('../config/logger');
const axios = require('axios');
const FormData = require('form-data');

// Configuración de OpenAI con manejo de errores
const openai = new OpenAI({
  apiKey: 'sk-v1sLERgwDDBja_qN5wHyFM1JVpWncWRLc2IBvyJWXST3BlbkFJhERoWyvZTcPM9r8IYyVZKQz98LOTjJi33vzsMMluYA'
});

const getChatCompletion = async (prompt, userMessage, conversationHistory = []) => {
  try {
    logger.info('Iniciando getChatCompletion', {
      promptLength: prompt?.length,
      messageLength: userMessage?.length
    });

    if (!prompt || !userMessage) {
      logger.error('Prompt o mensaje de usuario faltante');
      return 'Lo siento, hubo un error en el procesamiento del mensaje.';
    }

    const messages = [
      { role: "system", content: prompt },
      ...conversationHistory.slice(-5),
      { role: "user", content: userMessage }
    ];

    logger.info('Enviando solicitud a OpenAI');
    
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // Cambiado a gpt-3.5-turbo que es más estable
      messages: messages,
      max_tokens: 200,
      temperature: 0.7
    });

    logger.info('Respuesta recibida de OpenAI');

    if (!response.choices || !response.choices[0]?.message?.content) {
      logger.error('Respuesta inválida de OpenAI:', response);
      return 'Lo siento, no pude generar una respuesta apropiada.';
    }

    return response.choices[0].message.content.trim();

  } catch (error) {
    logger.error('Error en getChatCompletion:', {
      error: error.message,
      stack: error.stack,
      response: error.response?.data
    });

    // Retornamos un mensaje de error en lugar de lanzar una excepción
    return 'Lo siento, hubo un problema al procesar tu mensaje. Por favor, intenta de nuevo.';
  }
};

const convertAudioToText = async (audioBuffer) => {
  try {
    logger.info('Iniciando convertAudioToText');

    if (!audioBuffer || audioBuffer.length === 0) {
      logger.error('Buffer de audio inválido');
      return null;
    }

    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: 'audio.ogg',
      contentType: 'audio/ogg; codecs=opus'
    });
    formData.append('model', 'whisper-1');
    formData.append('language', 'es');

    logger.info('Enviando solicitud de transcripción a OpenAI');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${openai.apiKey}`,
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity
      }
    );

    logger.info('Respuesta de transcripción recibida');

    if (!response.data || !response.data.text) {
      logger.error('Respuesta inválida de transcripción:', response.data);
      return null;
    }

    return response.data.text;

  } catch (error) {
    logger.error('Error en convertAudioToText:', {
      error: error.message,
      stack: error.stack,
      response: error.response?.data
    });
    return null;
  }
};

module.exports = {
  getChatCompletion,
  convertAudioToText
};