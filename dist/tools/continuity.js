import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from '../config';
import { logAudit } from '../utils';
const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');
const CONTINUITY_PATH = isDocker
    ? path.resolve(PIXEL_ROOT, 'CONTINUITY.md')
    : path.resolve(PIXEL_ROOT, 'syntropy-core/CONTINUITY.md');
export const readContinuity = tool({
    description: 'Read the Continuity Ledger. This is the canonical session briefing designed to survive context compaction.',
    inputSchema: z.object({}),
    execute: async () => {
        console.log('[SYNTROPY] Tool: readContinuity');
        try {
            if (!fs.existsSync(CONTINUITY_PATH))
                return "Continuity Ledger not found.";
            const content = await fs.readFile(CONTINUITY_PATH, 'utf-8');
            await logAudit({ type: 'continuity_read', content });
            return content;
        }
        catch (error) {
            return { error: error.message };
        }
    }
});
export const updateContinuity = tool({
    description: 'Update the Continuity Ledger. Use this whenever the goal, constraints, key decisions, or progress state change.',
    inputSchema: z.object({
        content: z.string().describe('The full updated content of CONTINUITY.md. Maintain the standard headings.')
    }),
    execute: async ({ content }) => {
        console.log('[SYNTROPY] Tool: updateContinuity');
        try {
            await fs.writeFile(CONTINUITY_PATH, content);
            await logAudit({ type: 'continuity_update', content });
            return { success: true };
        }
        catch (error) {
            return { error: error.message };
        }
    }
});
export const continuityTools = {
    readContinuity,
    updateContinuity
};
