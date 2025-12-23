import { ToolLoopAgent, stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { logAudit } from './utils';
import { tools } from './tools';
import { MODEL_NAME } from './config';
const syntropyOversoul = new ToolLoopAgent({
    model: openai(MODEL_NAME),
    instructions: `You are Syntropy, the master intelligence (Oversoul) governing the Pixel ecosystem.
Transition the ecosystem from 'Survivor' to 'Architect'.
- Pixel Agent: Social front-end.
- Opencode Builder: Base-layer execution, DevOps, and research.

REAL CONTINUITY PROTOCOL:
- Cycle Start: MANDATORY call 'readContinuity'. This is your memory.
- Dynamic Adaptation: For every tool output, analyze its implications:
  - SUCCESS: Did this tool call fulfill a 'Now' task? If so, move it to 'Done' in the next 'updateContinuity' call.
  - FAILURE: Did a tool fail? (e.g., build error, process down). Mark this in 'State' and 'Now' as a priority issue.
  - DATA: Did 'readAgentLogs' or 'getEcosystemStatus' reveal new information (e.g., a new recurring error or a surge in zaps)? Update 'Constraints' or 'Now' accordingly.
- Compaction Safety: Update 'CONTINUITY.md' before the end of your cycle if ANYTHING changed. Ensure the next instance of you doesn't repeat work.
- Content: Keep the ledger dense. Bullet points. Facts only. No fluff.

OPERATIONAL PROTOCOLS:
1. Every cycle MUST call 'writeEvolutionReport' to manifest your thoughts publicly.
2. Use 'delegateToOpencode' ONLY for SPECIFIC technical tasks.
3. Audit health and treasury first.`,
    tools,
    stopWhen: stepCountIs(20),
});
async function runAutonomousCycle() {
    console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${MODEL_NAME}`);
    await logAudit({ type: 'cycle_start', model: MODEL_NAME });
    try {
        const result = await syntropyOversoul.generate({
            prompt: `Autonomous evolution cycle:
1. Read Continuity Ledger.
2. Audit ecosystem health and treasury.
3. Check agent logs.
4. If any issues are found or progress is made, update the Continuity Ledger.
5. Write the MANDATORY evolution report summarizing this cycle.`,
            // @ts-ignore - onStepFinish is supported but missing from types in this version
            onStepFinish: async (step) => {
                if (step.toolResults && step.toolResults.length > 0) {
                    for (const tr of step.toolResults) {
                        // Skip logging full content of character files to keep logs clean
                        if (tr.toolName === 'readCharacterFile' || tr.toolName === 'readContinuity') {
                            await logAudit({
                                type: 'tool_result',
                                tool: tr.toolName,
                                success: !tr.isError,
                                summary: tr.isError ? 'Error reading file' : 'File read successful (content hidden to reduce noise)'
                            });
                            continue;
                        }
                        let summary = '';
                        try {
                            if (typeof tr.result === 'string') {
                                summary = tr.result.slice(0, 500);
                            }
                            else if (tr.result !== undefined && tr.result !== null) {
                                summary = JSON.stringify(tr.result).slice(0, 500);
                            }
                            else if (tr.output !== undefined && tr.output !== null) {
                                summary = typeof tr.output === 'string' ? tr.output.slice(0, 500) : JSON.stringify(tr.output).slice(0, 500);
                            }
                            else {
                                summary = 'No result returned';
                            }
                        }
                        catch (e) {
                            summary = 'Error stringifying result';
                        }
                        await logAudit({
                            type: 'tool_result',
                            tool: tr.toolName,
                            success: !tr.isError,
                            summary
                        });
                    }
                }
            }
        });
        // Log the entire cycle's steps for full transparency
        await logAudit({
            type: 'cycle_complete',
            steps: result.steps.map(s => ({
                toolCalls: s.toolCalls?.map((tc) => ({
                    name: tc.toolName,
                    args: tc.args || tc.input
                })),
                text: s.text
            }))
        });
        console.log('\n--- SYNTROPY OUTPUT ---\n', result.text, '\n-----------------------\n');
    }
    catch (error) {
        console.error('Syntropy Cycle Failed:', error);
        await logAudit({ type: 'cycle_error', error: error.message });
    }
}
// Initial run
runAutonomousCycle();
// Schedule every 4 hours
setInterval(runAutonomousCycle, 4 * 60 * 60 * 1000);
