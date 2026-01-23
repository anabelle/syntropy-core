import * as path from 'path';
import * as fs from 'fs-extra';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Detect if running in Docker (PIXEL_ROOT would be /app in container)
const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');

// Path configuration - use env vars or sensible defaults
// Path configuration - use env vars or sensible defaults
export const PIXEL_ROOT = process.env.PIXEL_ROOT || (isDocker ? '/app' : path.resolve(__dirname, '../..'));
export const PIXEL_AGENT_DIR = process.env.PIXEL_AGENT_DIR || path.resolve(PIXEL_ROOT, 'pixel-agent');

// Model Selection: Primary intelligence for orchestration
// Use OpenRouter for free/cheaper models, or direct OpenAI
export const MODEL_PROVIDER = process.env.MODEL_PROVIDER || 'openrouter'; // 'openai' or 'openrouter'
export const MODEL_NAME = process.env.SYNTROPY_MODEL || 'xiaomi/mimo-v2-flash:free';

export const AGENT_SRC_DIR = path.resolve(PIXEL_AGENT_DIR, 'src');
export const CHARACTER_DIR = path.resolve(AGENT_SRC_DIR, 'character');

// Database and log paths
export const DB_PATH = process.env.DB_PATH || path.resolve(PIXEL_ROOT, isDocker ? 'pixels.db' : 'data/pixels.db');
export const LOG_PATH = process.env.LOG_PATH || (isDocker ? '/app/logs/agent.log' : '/home/pixel/.pm2/logs/pixel-agent-out-2.log');
export const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.resolve(isDocker ? '/app/audit' : PIXEL_ROOT, isDocker ? 'audit.json' : 'pixel-landing/public/audit.json');
export const OPENCODE_LIVE_LOG = path.resolve(PIXEL_ROOT, 'logs/opencode_live.log');

// Ensure audit directory exists
const auditDir = path.dirname(AUDIT_LOG_PATH);
if (!fs.existsSync(auditDir)) {
  fs.mkdirSync(auditDir, { recursive: true });
}

// Ensure API Key presence for OpenRouter/OpenAI
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Opencode Model - passed to worker containers via environment variable
// Syntropy does NOT run Opencode directly; workers handle all Opencode execution
export const OPENCODE_MODEL = process.env.OPENCODE_MODEL || 'opencode/glm-4.7';

