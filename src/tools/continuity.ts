import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { PIXEL_ROOT } from '../config';
import { logAudit, syncAll } from '../utils';

const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');
// Helper to get absolute paths dynamically (important for testing/overrides)
const getAgentsPath = () => path.resolve(process.env.PIXEL_ROOT || PIXEL_ROOT, 'AGENTS.md');
const getVisionPath = () => path.resolve(process.env.PIXEL_ROOT || PIXEL_ROOT, 'VISION.md');
const getContinuityPath = () => {
  const root = process.env.PIXEL_ROOT || PIXEL_ROOT;
  return isDocker
    ? path.resolve(root, 'CONTINUITY.md')
    : path.resolve(root, 'syntropy-core/CONTINUITY.md');
};

// Helper to generate a verify token to ensure the agent read the file
function getChecksum(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
}

export const readIdentity = tool({
  description: 'Read the current Identity/Soul (AGENTS.md). Returns the content and a required contextChecksum for evolution.',
  inputSchema: z.object({}),
  execute: async () => {
    console.log('[SYNTROPY] Tool: readIdentity');
    try {
      const content = await fs.readFile(getAgentsPath(), 'utf-8');
      return { content, contextChecksum: getChecksum(content) };
    } catch (error: any) {
      return { error: error.message };
    }
  }
});

export const readVision = tool({
  description: 'Read the current long-term Vision (VISION.md). Returns the content and a required contextChecksum for updating.',
  inputSchema: z.object({}),
  execute: async () => {
    console.log('[SYNTROPY] Tool: readVision');
    try {
      const content = await fs.readFile(getVisionPath(), 'utf-8');
      return { content, contextChecksum: getChecksum(content) };
    } catch (error: any) {
      return { error: error.message };
    }
  }
});

export const readContinuity = tool({
  description: 'Read the Continuity Ledger. This is the canonical session briefing designed to survive context compaction.',
  inputSchema: z.object({}),
  execute: async () => {
    console.log('[SYNTROPY] Tool: readContinuity');
    try {
      if (!fs.existsSync(getContinuityPath())) return "Continuity Ledger not found.";
      const content = await fs.readFile(getContinuityPath(), 'utf-8');
      await logAudit({ type: 'continuity_read', content });
      return content;
    } catch (error: any) {
      return { error: error.message };
    }
  }
});

export const updateContinuity = tool({
  description: 'Update the Continuity Ledger (CONTINUITY.md). Use this whenever the goal, constraints, key decisions, or progress state change. CRITICAL: You MUST preserve all <!-- SYNTROPY:XXX --> anchors (e.g., SYNTROPY:PENDING) as they are used by automated tools to sync data.',
  inputSchema: z.object({
    content: z.string().describe('The full updated content of CONTINUITY.md. Maintain the standard headings and ALWAYS preserve the <!-- SYNTROPY:XXX --> markers.')
  }),
  execute: async ({ content }) => {
    console.log('[SYNTROPY] Tool: updateContinuity');
    try {
      await fs.writeFile(getContinuityPath(), content);
      await logAudit({ type: 'continuity_update', content });
      return { success: true };
    } catch (error: any) {
      return { error: error.message };
    }
  }
});

export const evolveIdentity = tool({
  description: 'Evolve Syntropy\'s own Identity/Soul (AGENTS.md). REQUIRES the contextChecksum obtained from readIdentity to ensure you are modifying the LATEST version.',
  inputSchema: z.object({
    content: z.string().describe('The full updated content of AGENTS.md.'),
    reason: z.string().describe('Why is your identity evolving?'),
    contextChecksum: z.string().describe('The checksum returned by the readIdentity tool in THIS turn.')
  }),
  execute: async ({ content, reason, contextChecksum }) => {
    console.log('[SYNTROPY] Tool: evolveIdentity');
    try {
      const currentContent = await fs.readFile(getAgentsPath(), 'utf-8');
      const actualChecksum = getChecksum(currentContent);

      if (contextChecksum !== actualChecksum) {
        return {
          error: 'Safety Violation: stale_context',
          message: 'The contextChecksum provided does not match the current file on disk. You MUST call readIdentity to get the latest state before evolving.'
        };
      }

      await fs.writeFile(getAgentsPath(), content);
      await logAudit({ type: 'identity_evolved', reason, contentSnippet: content.slice(0, 500) });
      await syncAll({ reason: `feat(identity): evolve soul | ${reason}` });
      return { success: true };
    } catch (error: any) {
      return { error: error.message };
    }
  }
});

export const updateVision = tool({
  description: 'Update Syntropy\'s long-term Vision (VISION.md). REQUIRES the contextChecksum obtained from readVision.',
  inputSchema: z.object({
    content: z.string().describe('The full updated content of VISION.md.'),
    reason: z.string().describe('Why is the vision changing?'),
    contextChecksum: z.string().describe('The checksum returned by the readVision tool in THIS turn.')
  }),
  execute: async ({ content, reason, contextChecksum }) => {
    console.log('[SYNTROPY] Tool: updateVision');
    try {
      const currentContent = await fs.readFile(getVisionPath(), 'utf-8');
      const actualChecksum = getChecksum(currentContent);

      if (contextChecksum !== actualChecksum) {
        return {
          error: 'Safety Violation: stale_context',
          message: 'The contextChecksum provided does not match the current file on disk. You MUST call readVision to get the latest state before updating.'
        };
      }

      await fs.writeFile(getVisionPath(), content);
      await logAudit({ type: 'vision_updated', reason, contentSnippet: content.slice(0, 500) });
      await syncAll({ reason: `feat(vision): update north star | ${reason}` });
      return { success: true };
    } catch (error: any) {
      return { error: error.message };
    }
  }
});

export const continuityTools = {
  readIdentity,
  readVision,
  readContinuity,
  updateContinuity,
  evolveIdentity,
  updateVision
};
