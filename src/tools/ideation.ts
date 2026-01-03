import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  PIXEL_ROOT
} from '../config';
import { logAudit } from '../utils';

const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');

export const ideationTools = {
  tendIdeaGarden: tool({
    description: `Tend the Idea Garden (IDEAS.md). Use at the END of each cycle to nurture creative ideas.

Actions:
- 'read': View all current seeds with their watering counts
- 'plant': Add a new seed from this cycle's observations (max 1 per cycle)
- 'water': Add a thought to an existing seed (exactly 1 per cycle)
- 'harvest': Move a mature idea (5+ waterings) to CONTINUITY.md pending tasks
- 'compost': Archive a stale or failed idea
- 'research': Spawn a worker to research external sources for a seed

Rules:
- Water ONE existing seed per cycle (if any exist)
- Plant at most ONE new seed per cycle
- Harvest requires 5+ waterings AND clear implementation path
- Research spawns a worker with webfetch capability

The garden enables ideas to mature over multiple cycles before becoming tasks.`,

    inputSchema: z.object({
      action: z.enum(['read', 'plant', 'water', 'harvest', 'compost', 'research']).describe('Action to perform'),
      seedTitle: z.string().optional().describe('Title of the seed (required for water/harvest/compost/research)'),
      content: z.string().optional().describe('For plant: the idea origin. For water: new thought. For harvest: task description. For research: research query.'),
      author: z.enum(['Syntropy', 'Human']).default('Syntropy').describe('Who is tending the garden')
    }),

    execute: async ({ action, seedTitle, content, author }) => {
      console.log(`[SYNTROPY] Tool: tendIdeaGarden (action=${action}, seed=${seedTitle || 'N/A'})`);

      const IDEAS_PATH = isDocker
        ? path.resolve(PIXEL_ROOT, 'IDEAS.md')
        : path.resolve(PIXEL_ROOT, 'syntropy-core/IDEAS.md');

      const CONTINUITY_PATH = isDocker
        ? path.resolve(PIXEL_ROOT, 'CONTINUITY.md')
        : path.resolve(PIXEL_ROOT, 'syntropy-core/CONTINUITY.md');

      try {
        let garden = '';
        if (await fs.pathExists(IDEAS_PATH)) {
          garden = await fs.readFile(IDEAS_PATH, 'utf-8');
        } else {
          garden = `# 🌱 Idea Garden

> Persistent workspace for incubating ideas.

## 🌱 Seeds (0-2 waterings)

## 🌿 Sprouting (3-4 waterings)

## 🌸 Ready to Harvest (5+ waterings)

## 🍂 Compost
 `;
        }

        const timestamp = new Date().toISOString().split('T')[0];

        if (action === 'read') {
          const seedPattern = /### (.+)\n[\s\S]*?- \*\*Waterings\*\*: (\d+)/g;
          const seeds: Array<{ title: string; waterings: number; section: string }> = [];

          const sections = ['Seeds', 'Sprouting', 'Ready to Harvest', 'Compost'];
          for (const section of sections) {
            const sectionPattern = new RegExp(`## [🌱🌿🌸🍂] ${section}[^#]*`, 'g');
            const sectionMatch = garden.match(sectionPattern);
            if (sectionMatch) {
              let match;
              const sectionContent = sectionMatch[0];
              const localPattern = /### (.+)\n[\s\S]*?- \*\*Waterings\*\*: (\d+)/g;
              while ((match = localPattern.exec(sectionContent)) !== null) {
                seeds.push({
                  title: match[1].trim(),
                  waterings: parseInt(match[2]),
                  section
                });
              }
            }
          }

          const humanEdits = garden.match(/- \[[\d-]+ Human\] .+/g) || [];

          await logAudit({ type: 'idea_garden_read', seedCount: seeds.length });
          return {
            seeds,
            total: seeds.length,
            humanEdits: humanEdits.length,
            hint: seeds.length === 0
              ? "Garden is empty. Use action='plant' to add a seed."
              : humanEdits.length > 0
                ? `Found ${humanEdits.length} human contribution(s). Acknowledge and water those seeds.`
                : `Water one seed with action='water'.`
          };
        }

        if (action === 'plant') {
          if (!seedTitle || !content) {
            return { error: "Both 'seedTitle' and 'content' (origin) are required for planting" };
          }

          const newSeed = `
### ${seedTitle}
- **Planted**: ${timestamp} by ${author}
- **Origin**: ${content}
- **Waterings**: 0
- **Log**:
 `;

          garden = garden.replace(
            /## 🌱 Seeds \(0-2 waterings\)\n/,
            `## 🌱 Seeds (0-2 waterings)\n${newSeed}`
          );

          await fs.writeFile(IDEAS_PATH, garden);
          await logAudit({ type: 'idea_garden_plant', seedTitle, author });

          return { success: true, action: 'planted', seedTitle, message: `Seed "${seedTitle}" planted in the garden.` };
        }

        if (action === 'water') {
          if (!seedTitle || !content) {
            return { error: "Both 'seedTitle' and 'content' (new thought) are required for watering" };
          }

          const seedRegex = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=###|## 🌿|## 🌸|## 🍂|$)`);
          const seedMatch = garden.match(seedRegex);

          if (!seedMatch) {
            return { error: `Seed "${seedTitle}" not found in garden` };
          }

          let seedContent = seedMatch[1];

          const wateringMatch = seedContent.match(/- \*\*Waterings\*\*: (\d+)/);
          const currentCount = wateringMatch ? parseInt(wateringMatch[1]) : 0;
          const newCount = currentCount + 1;

          seedContent = seedContent.replace(
            /- \*\*Waterings\*\*: \d+/,
            `- **Waterings**: ${newCount}`
          );

          const logEntry = `  - [${timestamp} ${author}] ${content}\n`;
          seedContent = seedContent.replace(
            /- \*\*Log\*\*:\n/,
            `- **Log**:\n${logEntry}`
          );

          garden = garden.replace(seedMatch[0], `### ${seedTitle}\n${seedContent}`);

          if (newCount >= 5) {
            const fullSeed = `### ${seedTitle}\n${seedContent}`;
            garden = garden.replace(fullSeed, '');
            garden = garden.replace(
              /## 🌸 Ready to Harvest \(5\+ waterings\)\n/,
              `## 🌸 Ready to Harvest (5+ waterings)\n\n${fullSeed}`
            );
          } else if (newCount >= 3) {
            const fullSeed = `### ${seedTitle}\n${seedContent}`;
            garden = garden.replace(fullSeed, '');
            garden = garden.replace(
              /## 🌿 Sprouting \(3-4 waterings\)\n/,
              `## 🌿 Sprouting (3-4 waterings)\n\n${fullSeed}`
            );
          }

          garden = garden.replace(/\n{3,}/g, '\n\n');

          await fs.writeFile(IDEAS_PATH, garden);
          await logAudit({ type: 'idea_garden_water', seedTitle, newCount, author });

          const statusMsg = newCount >= 5
            ? 'READY TO HARVEST! Consider using harvest action.'
            : newCount >= 3
              ? 'Sprouting! Getting closer to actionable.'
              : `${5 - newCount} more waterings until harvest-ready.`;

          return {
            success: true,
            action: 'watered',
            seedTitle,
            newCount,
            status: statusMsg
          };
        }

        if (action === 'harvest') {
          if (!seedTitle) {
            return { error: "'seedTitle' is required for harvesting" };
          }

          const seedRegex = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=###|## 🌿|## 🌸|## 🍂|$)`);
          const seedMatch = garden.match(seedRegex);

          if (!seedMatch) {
            return { error: `Seed "${seedTitle}" not found` };
          }

          const seedContent = seedMatch[1];
          const wateringMatch = seedContent.match(/- \*\*Waterings\*\*: (\d+)/);
          const waterings = wateringMatch ? parseInt(wateringMatch[1]) : 0;

          if (waterings < 5) {
            return {
              error: `Seed only has ${waterings} waterings. Need 5+ for harvest.`,
              hint: 'Keep watering until the idea is mature.'
            };
          }

          const logMatch = seedContent.match(/- \*\*Log\*\*:\n([\s\S]*)/);
          const logContent = logMatch ? logMatch[1].trim() : '';

          const taskEntry = `
### ${seedTitle} (from Idea Garden)
- **Origin**: Harvested from Idea Garden (${waterings} waterings)
- **Summary**: ${content || 'See implementation notes below'}
- **Implementation Notes**:
${logContent.split('\n').map((l: string) => `  ${l}`).join('\n')}
 `;

          const fullSeed = `### ${seedTitle}\n${seedContent}`;
          garden = garden.replace(fullSeed, '');
          garden = garden.replace(
            /## 🍂 Compost\n/,
            `## 🍂 Compost\n\n${fullSeed.replace(/- \*\*Waterings\*\*: \d+/, '- **Waterings**: HARVESTED')}`
          );

          const compostMatchH = garden.match(/## 🍂 Compost([\s\S]*)/);
          if (compostMatchH) {
            const content = compostMatchH[1];
            const headers = [...content.matchAll(/\n### /g)];
            if (headers.length > 5 && headers[5].index !== undefined) {
              garden = garden.replace(content, content.slice(0, headers[5].index));
            }
          }

          await fs.writeFile(IDEAS_PATH, garden);

          let continuity = await fs.readFile(CONTINUITY_PATH, 'utf-8');
          continuity = continuity.replace(
            /## 📬 Pending Tasks\n\n/,
            `## 📬 Pending Tasks\n\n${taskEntry}\n`
          );
          await fs.writeFile(CONTINUITY_PATH, continuity);

          await logAudit({ type: 'idea_garden_harvest', seedTitle, waterings });

          return {
            success: true,
            action: 'harvested',
            seedTitle,
            message: `"${seedTitle}" harvested and added to CONTINUITY.md pending tasks!`
          };
        }

        if (action === 'compost') {
          if (!seedTitle) {
            return { error: "'seedTitle' is required for composting" };
          }

          const seedRegex = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=###|## 🌿|## 🌸|## 🍂|$)`);
          const seedMatch = garden.match(seedRegex);

          if (!seedMatch) {
            return { error: `Seed "${seedTitle}" not found` };
          }

          const fullSeed = seedMatch[0];
          garden = garden.replace(fullSeed, '');

          const compostNote = content ? `  - [${timestamp} ${author}] COMPOSTED: ${content}\n` : '';
          const updatedSeed = fullSeed.replace(
            /- \*\*Log\*\*:\n/,
            `- **Log**:\n${compostNote}`
          );

          garden = garden.replace(
            /## 🍂 Compost\n/,
            `## 🍂 Compost\n\n${updatedSeed}`
          );

          const compostMatchC = garden.match(/## 🍂 Compost([\s\S]*)/);
          if (compostMatchC) {
            const content = compostMatchC[1];
            const headers = [...content.matchAll(/\n### /g)];
            if (headers.length > 5 && headers[5].index !== undefined) {
              garden = garden.replace(content, content.slice(0, headers[5].index));
            }
          }

          garden = garden.replace(/\n{3,}/g, '\n\n');
          await fs.writeFile(IDEAS_PATH, garden);
          await logAudit({ type: 'idea_garden_compost', seedTitle, reason: content });

          return {
            success: true,
            action: 'composted',
            seedTitle,
            message: `"${seedTitle}" moved to compost. Learning preserved.`
          };
        }

        if (action === 'research') {
          if (!seedTitle || !content) {
            return { error: "Both 'seedTitle' and 'content' (research query) are required" };
          }

          const { spawnWorkerInternal } = await import('../worker-tools');

          const researchTask = `RESEARCH TASK for Idea Garden seed: "${seedTitle}"

Research the topic: ${content}

Use the webfetch tool to:
1. Find 2-3 relevant articles, GitHub repos, or documentation
2. Summarize key insights from each source
3. Suggest implementation approaches based on findings

Write your findings as a summary at the end.

FORMAT YOUR RESPONSE:
## Research: ${seedTitle}
### Sources Found
- [Source 1 title](url): Key insight
- [Source 2 title](url): Key insight

### Key Findings
1. ...
2. ...

### Recommendations for Implementation
1. ...
 `;

          const result = await spawnWorkerInternal({
            task: researchTask,
            context: `Research for Idea Garden seed. Use webfetch tool to access external URLs and gather information.`,
            priority: 'normal'
          });

          if ('error' in result) {
            return { error: result.error };
          }

          await logAudit({ type: 'idea_garden_research', seedTitle, taskId: result.taskId });

          return {
            success: true,
            action: 'research_spawned',
            seedTitle,
            taskId: result.taskId,
            message: `Research worker spawned for "${seedTitle}". Check status with checkWorkerStatus("${result.taskId}"). Results will inform next watering.`
          };
        }

        return { error: `Unknown action: ${action}` };

      } catch (error: any) {
        await logAudit({ type: 'idea_garden_error', action, error: error.message });
        return { error: `Idea Garden error: ${error.message}` };
      }
    }
  })
};
