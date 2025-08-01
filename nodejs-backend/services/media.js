const axios = require('axios');
const FormData = require('form-data');
const logger = require('../config/logger');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs').promises;
const path = require('path');

/**
 * Descarga un mensaje de audio de WhatsApp
 * @param {Object} message - Mensaje de audio de WhatsApp
 * @returns {Object} Objeto con buffer y ruta del archivo temporal
 */
const downloadAudioMessage = async (message) => {
    try {
        logger.info('Iniciando descarga de mensaje de audio:', {
            mimetype: message.mimetype,
            seconds: message.seconds,
            ptt: message.ptt
        });
        
        const stream = await downloadContentFromMessage(message, 'audio');
        let buffer = Buffer.from([]);
        
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        
        // Guardar el audio temporalmente
        const tempPath = path.join('/tmp', `audio_${Date.now()}.ogg`);
        await fs.writeFile(tempPath, buffer);
        
        logger.info('Audio descargado exitosamente:', {
            bufferSize: buffer.length,
            tempPath: tempPath
        });
        
        return { 
            buffer, 
            path: tempPath,
            mimetype: message.mimetype || 'audio/ogg'
        };
    } catch (error) {
        logger.error('Error en downloadAudioMessage:', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
};

/**
 * Convierte un archivo de audio a texto usando la API de OpenAI
 * @param {Object} audioData - Datos del audio (buffer y ruta)
 * @param {String} apiKey - API key de OpenAI
 * @returns {String} Texto transcrito del audio
 */
const convertAudioToText = async (audioData, apiKey) => {
    try {
        if (!apiKey) {
            logger.error('API key no proporcionada para transcripción');
            throw new Error('API_KEY_NOT_CONFIGURED');
        }

        logger.info('Iniciando conversión de audio a texto', {
            bufferSize: audioData.buffer.length,
            path: audioData.path
        });
        
        // Verificar que el archivo exista
        try {
            await fs.access(audioData.path);
        } catch (error) {
            logger.error('El archivo de audio no existe:', audioData.path);
            throw new Error('AUDIO_FILE_NOT_FOUND');
        }
        
        // Crear FormData con el archivo de audio
        const formData = new FormData();
        
        // Usar el archivo temporal
        formData.append('file', await fs.readFile(audioData.path), {
            filename: 'audio.ogg',
            contentType: 'audio/ogg; codecs=opus'
        });
        
        formData.append('model', 'whisper-1');
        formData.append('language', 'es');
        formData.append('response_format', 'json');
        
        logger.info('Enviando solicitud a OpenAI');
        
        const response = await axios({
            method: 'post',
            url: 'https://api.openai.com/v1/audio/transcriptions',
            data: formData,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 30000 // 30 segundos de timeout
        });
        
        logger.info('Respuesta recibida de OpenAI:', {
            status: response.status,
            hasText: !!response.data?.text
        });
        
        // Limpiar archivo temporal
        try {
            await fs.unlink(audioData.path);
            logger.info('Archivo temporal eliminado:', audioData.path);
        } catch (e) {
            logger.warn('Error eliminando archivo temporal:', e.message);
        }
        
        if (!response.data || !response.data.text) {
            throw new Error('TRANSCRIPTION_EMPTY');
        }
        
        return response.data.text.trim();
    } catch (error) {
        logger.error('Error en convertAudioToText:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
        });
        
        // Intentar limpiar archivo temporal en caso de error
        if (audioData.path) {
            try {
                await fs.unlink(audioData.path);
                logger.info('Archivo temporal eliminado en manejo de error:', audioData.path);
            } catch (e) {
                logger.warn('Error eliminando archivo temporal:', e.message);
            }
        }
        
        // Reclasificar errores de la API para mejor manejo
        if (error.response) {
            const status = error.response.status;
            const data = error.response.data;
            
            if (status === 401) {
                throw new Error('API_KEY_INVALID');
            } else if (status === 429) {
                throw new Error('RATE_LIMIT_EXCEEDED');
            } else if (data && data.error && data.error.message) {
                if (data.error.message.includes('audio file is too large')) {
                    throw new Error('AUDIO_FILE_TOO_LARGE');
                }
                logger.error('Error específico de OpenAI:', data.error.message);
            }
        }
        
        throw error;
    }
};

module.exports = {
    downloadAudioMessage,
    convertAudioToText
};