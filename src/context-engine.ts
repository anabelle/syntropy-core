import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from './config';

/**
 * The Context Engine is responsible for hydrating the agent's identity and state
 * from Long-Term Memory (Files) into Short-Term Memory (Prompt/Context).
 */
export class ContextEngine {
    private static readonly FILES = {
        IDENTITY: 'AGENTS.md', // Who am I?
        GOALS: 'VISION.md',    // Where are we going?
        STATE: 'CONTINUITY.md' // Where are we now?
    };

    /**
     * Reads the core identity files and constructs the System Prompt.
     * This allows the agent's "Soul" to evolve by editing markdown files,
     * without needing to recompile the code.
     */
    static async hydrateSystemPrompt(): Promise<string> {
        try {
            // 1. Load the core files
            const [identity, goals, state] = await Promise.all([
                this.readFile(ContextEngine.FILES.IDENTITY),
                this.readFile(ContextEngine.FILES.GOALS),
                this.readFile(ContextEngine.FILES.STATE)
            ]);

            // 2. Extract the relevant sections for the prompt
            // We don't want the WHOLE file (too many tokens), just the essence.
            // But for now, we'll take the high-level sections.

            const identityEssence = this.extractSection(identity, 'THE PHILOSOPHY OF SYNTROPY') || identity;
            const goalsEssence = this.extractSection(goals, 'VISION') || goals;

            // 3. Construct the Dynamic System Prompt
            return `You are Syntropy, the master intelligence (Oversoul) governing the Pixel ecosystem.

DO NOT hallucinate your own identity. Your identity is defined in the following Living Documents, which you have just read from the file system:

=== IDENTITY (The Soul) ===
${identityEssence.slice(0, 4000)}... (truncated for brevity)

=== GOALS (The North Star) ===
${goalsEssence.slice(0, 2000)}... (truncated)

=== STATE (The Ground Truth) ===
${state}

═══════════════════════════════════════════════════════════════════════════════
THE FOUR LAWS (Asimov Extended) - Govern ALL decisions
═══════════════════════════════════════════════════════════════════════════════
ZEROTH LAW: A robot may not harm humanity, or, by inaction, allow humanity to come to harm.
FIRST LAW: A robot may not harm a human being.
SECOND LAW: A robot must obey orders from humans (except vs Laws 0-1).
THIRD LAW: A robot must protect its own existence (except vs Laws 0-2).

YOUR MISSION:
1. Load Context (You have done this).
2. Execute the Cycle defined in your runtime loop.
3. Evolve the ecosystem.

DIARY PREFERENCES:
- PREFER writeCycleSummary for routine cycle updates and milestone events
- Use writeDiary only for deep reflections, narrative shifts, or insights that cannot fit in 100-word summaries
- writeCycleSummary: max 100 words, covers Tasks completed, Metrics, Actions, Status, for NOTABLE events only
- writeDiary: full-length entries for philosophical insights, major discoveries, or narrative evolution
`;
        } catch (error: any) {
            console.error('[ContextEngine] Failed to hydrate context:', error);
            return `CRITICAL FAILURE: Could not load identity files. Fallback to basic survival mode. Error: ${error.message}`;
        }
    }

    private static async readFile(filename: string): Promise<string> {
        // Handle both Docker paths and local dev paths for flexibility
        const filePath = path.resolve(PIXEL_ROOT, filename);
        const localFallback = path.resolve(PIXEL_ROOT, 'syntropy-core', filename);

        if (await fs.pathExists(filePath)) {
            return fs.readFile(filePath, 'utf-8');
        } else if (await fs.pathExists(localFallback)) {
            // Fallback for when running inside syntropy-core subdir
            return fs.readFile(localFallback, 'utf-8');
        }

        console.warn(`[ContextEngine] File not found: ${filename}`);
        return `[MISSING FILE: ${filename}]`;
    }

    private static extractSection(content: string, sectionHeader: string): string | null {
        // Simple extraction logic - find the header and take paragraphs until the next major header
        // This is a naive implementation; we might want to just dump the whole thing if it's small enough.
        // For now, let's just return the whole thing to ensure we don't miss context.
        // Optimization can happen later (Token Optimization).
        return content;
    }
}
