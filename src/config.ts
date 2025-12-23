import * as path from 'path';
import * as fs from 'fs-extra';
import dotenv from 'dotenv';

// Load environment variables from pixel-agent
export const PIXEL_ROOT = path.resolve('..');
export const PIXEL_AGENT_DIR = path.resolve(PIXEL_ROOT, 'pixel-agent');
const agentEnvPath = path.resolve(PIXEL_AGENT_DIR, '.env');

if (fs.existsSync(agentEnvPath)) {
  dotenv.config({ path: agentEnvPath });
} else {
  dotenv.config();
}

// Model Selection: Primary intelligence for orchestration (Use stable model for tool loops)
export const MODEL_NAME = process.env.SYNTROPY_MODEL || 'gpt-4o-mini';

export const AGENT_SRC_DIR = path.resolve(PIXEL_AGENT_DIR, 'src');
export const CHARACTER_DIR = path.resolve(AGENT_SRC_DIR, 'character');
export const DB_PATH = path.resolve(PIXEL_ROOT, 'lnpixels/api/pixels.db');
export const LOG_PATH = '/home/pixel/.pm2/logs/pixel-agent-out-2.log';
export const AUDIT_LOG_PATH = path.resolve(PIXEL_ROOT, 'pixel-landing/public/audit.json');

// Ensure API Key presence for OpenRouter/OpenAI
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
