import {genkit} from 'genkit';
import {googleAI} from '@genkit-ai/google-genai';

// Validate required environment variables
const requiredEnvVars = [
  'GOOGLE_GENAI_API_KEY',
  'NEXT_PUBLIC_FIREBASE_API_KEY'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnvVars.join(', ')}. ` +
    'Please check your .env.local file and ensure all required variables are set.'
  );
}

// Validate API key format (Google AI API keys start with "AIza")
if (!process.env.GOOGLE_GENAI_API_KEY?.startsWith('AIza')) {
  throw new Error(
    'Invalid GOOGLE_GENAI_API_KEY format. Google AI API keys should start with "AIza". ' +
    'Please check your API key in the .env.local file.'
  );
}

// Configure Google AI with proper API key management
const googleAIConfig = googleAI({
  apiKey: process.env.GOOGLE_GENAI_API_KEY,
});

// Initialize Genkit with security and monitoring features
export const ai = genkit({
  plugins: [googleAIConfig],
  model: 'googleai/gemini-2.5-flash',
});

// Export configuration for monitoring and testing
export const aiConfig = {
  model: 'googleai/gemini-2.5-flash',
  provider: 'googleAI',
  apiKeyConfigured: !!process.env.GOOGLE_GENAI_API_KEY,
  environment: process.env.NODE_ENV || 'development',
};
