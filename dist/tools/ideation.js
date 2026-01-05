import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from '../config';
import { logAudit } from '../utils';
const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');
// --- Semantic Similarity Helpers ---
/**
 * Extract important keywords from a title/content, filtering out common words.
 */
function extractKeywords(text) {
    const stopwords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
        'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has',
        'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can',
        'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'our',
        'via', 'use', 'using', 'into', 'during', 'before', 'after', 'about', 'between',
        'through', 'under', 'over', 'each', 'all', 'any', 'both', 'more', 'most', 'other'
    ]);
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopwords.has(word));
}
/**
 * Calculate Jaccard similarity between two sets of keywords.
 */
function calculateSimilarity(keywords1, keywords2) {
    const set1 = new Set(keywords1);
    const set2 = new Set(keywords2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return union.size > 0 ? intersection.size / union.size : 0;
}
/**
 * Parse all seeds from the garden for similarity matching.
 */
function parseAllSeeds(garden) {
    const seeds = [];
    const seedPattern = /### ([^\r\n]+)[\r\n]+- \*\*Planted\*\*: [^\r\n]+[\r\n]+- \*\*Origin\*\*: ([^\r\n]+)[\r\n]+- \*\*Waterings\*\*: (\d+)/g;
    let match;
    while ((match = seedPattern.exec(garden)) !== null) {
        seeds.push({
            title: match[1].trim(),
            origin: match[2].trim(),
            waterings: parseInt(match[3]),
            section: 'Seeds' // We can refine this if needed
        });
    }
    return seeds;
}
/**
 * Find similar existing seeds based on title + origin content.
 */
function findSimilarSeeds(newTitle, newContent, existingSeeds) {
    const newKeywords = extractKeywords(`${newTitle} ${newContent}`);
    const matches = [];
    for (const seed of existingSeeds) {
        const existingKeywords = extractKeywords(`${seed.title} ${seed.origin}`);
        const similarity = calculateSimilarity(newKeywords, existingKeywords);
        if (similarity >= 0.3) { // 30% keyword overlap threshold
            matches.push({ seed, similarity });
        }
    }
    return matches.sort((a, b) => b.similarity - a.similarity);
}
export const ideationTools = {
    tendIdeaGarden: tool({
        description: `Tend the Idea Garden (IDEAS.md). Use at the END of each cycle to nurture creative ideas.

Actions:
- 'read': View all current seeds with their watering counts
- 'plant': Add a new seed from this cycle's observations (max 1 per cycle). BLOCKS if similar idea exists - water instead!
- 'water': Add a thought to an existing seed (exactly 1 per cycle). ALWAYS prefer this over planting duplicates!
- 'harvest': Move a mature idea (5+ waterings) to CONTINUITY.md pending tasks
- 'compost': Archive a stale or failed idea
- 'research': Spawn a worker to research external sources for a seed
- 'merge': Combine multiple similar seeds into one evolved idea (provide seedTitle as primary, mergeSeeds as array of titles to absorb)
- 'consolidate': Analyze garden for duplicate/similar ideas and suggest merges (no arguments needed)

Rules:
- Water ONE existing seed per cycle (if any exist)
- Plant at most ONE new seed per cycle
- BEFORE planting: Always check if a similar idea exists - water it instead!
- Harvest requires 5+ waterings AND clear implementation path
- Research spawns a worker with webfetch capability

The garden enables ideas to mature over multiple cycles before becoming tasks.`,
        inputSchema: z.object({
            action: z.enum(['read', 'plant', 'water', 'harvest', 'compost', 'research', 'merge', 'consolidate']).describe('Action to perform'),
            seedTitle: z.string().optional().describe('Title of the seed (required for water/harvest/compost/research/merge)'),
            content: z.string().optional().describe('For plant: the idea origin. For water: new thought. For harvest: task description. For research: research query. For merge: synthesis of combined ideas.'),
            mergeSeeds: z.array(z.string()).optional().describe('For merge: array of seed titles to absorb into the primary seed'),
            author: z.enum(['Syntropy', 'Human']).default('Syntropy').describe('Who is tending the garden')
        }),
        execute: async ({ action, seedTitle, content, mergeSeeds, author }) => {
            console.log(`[SYNTROPY] Tool: tendIdeaGarden (action=${action}, seed=${seedTitle || 'N/A'})`);
            const IDEAS_PATH = path.resolve(PIXEL_ROOT, 'IDEAS.md');
            const CONTINUITY_PATH = path.resolve(PIXEL_ROOT, 'CONTINUITY.md');
            const timestamp = new Date().toISOString().split('T')[0];
            try {
                let garden = '';
                if (await fs.pathExists(IDEAS_PATH)) {
                    garden = await fs.readFile(IDEAS_PATH, 'utf-8');
                }
                else {
                    garden = `# 🌱 Idea Garden

> Persistent workspace for incubating ideas.

## 🌱 Seeds (0-2 waterings)

## 🌿 Sprouting (3-4 waterings)

## 🌸 Ready to Harvest (5+ waterings)

## 🍂 Compost
 `;
                }
                if (action === 'read') {
                    const seeds = [];
                    const sections = ['Seeds', 'Sprouting', 'Ready to Harvest', 'Compost'];
                    for (const section of sections) {
                        // Updated regex: Match until the next major section header or end of file
                        const sectionPattern = new RegExp(`## [🌱🌿🌸🍂] ${section}[\\s\\S]*?(?=## [🌱🌿🌸🍂]|$)`, 'gu');
                        const sectionMatch = garden.match(sectionPattern);
                        if (sectionMatch) {
                            const sectionContent = sectionMatch[0];
                            // Robust pattern for matching seeds within the section
                            const seedPattern = /### ([^\r\n]+)[\r\n]+[\s\S]*?- \*\*Waterings\*\*: (\d+|HARVESTED)/gu;
                            let match;
                            while ((match = seedPattern.exec(sectionContent)) !== null) {
                                seeds.push({
                                    title: match[1].trim(),
                                    waterings: match[2] === 'HARVESTED' ? 99 : parseInt(match[2]),
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
                            : `Water one seed with action='water'. AVOID creating duplicates; if a similar idea exists, water it instead.`
                    };
                }
                if (action === 'plant') {
                    if (!seedTitle || !content) {
                        return { error: "Both 'seedTitle' and 'content' (origin) are required for planting" };
                    }
                    // Check if a seed with this title already exists
                    const existingPattern = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`, 'i');
                    if (existingPattern.test(garden)) {
                        return {
                            error: `A seed titled "${seedTitle}" already exists.`,
                            hint: `Use action='water' to add thoughts to the existing seed instead of planting a duplicate.`
                        };
                    }
                    // Check for semantically similar seeds (CRITICAL: prevents duplicate ideas)
                    const existingSeeds = parseAllSeeds(garden);
                    const similarSeeds = findSimilarSeeds(seedTitle, content, existingSeeds);
                    if (similarSeeds.length > 0) {
                        const suggestions = similarSeeds.slice(0, 3).map(({ seed, similarity }) => `- "${seed.title}" (${Math.round(similarity * 100)}% similar, ${seed.waterings} waterings)`).join('\n');
                        return {
                            error: `BLOCKED: Found ${similarSeeds.length} similar idea(s) already in the garden.`,
                            similarSeeds: similarSeeds.slice(0, 3).map(s => ({
                                title: s.seed.title,
                                similarity: Math.round(s.similarity * 100),
                                waterings: s.seed.waterings
                            })),
                            hint: `WATER an existing seed instead of planting a duplicate!\n\nSimilar seeds:\n${suggestions}\n\nUse action='water' with seedTitle set to the most relevant existing seed, adding your new insight as the content.`,
                            action: 'water_instead'
                        };
                    }
                    const newSeed = `
### ${seedTitle}
- **Planted**: ${timestamp} by ${author}
- **Origin**: ${content}
- **Waterings**: 0
- **Log**:
 `;
                    // Prepend to Seeds section
                    garden = garden.replace(/## 🌱 Seeds \(0-2 waterings\)\n/, `## 🌱 Seeds (0-2 waterings)\n${newSeed}`);
                    await fs.writeFile(IDEAS_PATH, garden);
                    await logAudit({ type: 'idea_garden_plant', seedTitle, author });
                    return { success: true, action: 'planted', seedTitle, message: `Seed "${seedTitle}" planted in the garden.` };
                }
                if (action === 'water') {
                    if (!seedTitle || !content) {
                        return { error: "Both 'seedTitle' and 'content' (new thought) are required for watering" };
                    }
                    const seedRegex = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=###|## [🌱🌿🌸🍂]|$)`);
                    const seedMatch = garden.match(seedRegex);
                    if (!seedMatch) {
                        return { error: `Seed "${seedTitle}" not found in garden` };
                    }
                    let seedContent = seedMatch[1];
                    const wateringMatch = seedContent.match(/- \*\*Waterings\*\*: (\d+)/);
                    const currentCount = wateringMatch ? parseInt(wateringMatch[1]) : 0;
                    const newCount = currentCount + 1;
                    seedContent = seedContent.replace(/- \*\*Waterings\*\*: \d+/, `- **Waterings**: ${newCount}`);
                    const logEntry = `  - [${timestamp} ${author}] ${content}\n`;
                    seedContent = seedContent.replace(/- \*\*Log\*\*:\n/, `- **Log**:\n${logEntry}`);
                    const updatedFullSeed = `### ${seedTitle}\n${seedContent}`;
                    garden = garden.replace(seedMatch[0], updatedFullSeed);
                    if (newCount >= 5) {
                        garden = garden.replace(updatedFullSeed, '');
                        garden = garden.replace(/## 🌸 Ready to Harvest \(5\+ waterings\)\n/, `## 🌸 Ready to Harvest (5+ waterings)\n\n${updatedFullSeed}`);
                    }
                    else if (newCount >= 3 && !garden.includes(`## 🌿 Sprouting (3-4 waterings)\n\n${updatedFullSeed}`)) {
                        // Only move if not already in Sprouting (to avoid repeat moves if already there)
                        // But wait, the standard flow moves it FROM Seeds TO Sprouting.
                        garden = garden.replace(updatedFullSeed, '');
                        garden = garden.replace(/## 🌿 Sprouting \(3-4 waterings\)\n/, `## 🌿 Sprouting (3-4 waterings)\n\n${updatedFullSeed}`);
                    }
                    garden = garden.replace(/\n{3,}/g, '\n\n');
                    await fs.writeFile(IDEAS_PATH, garden);
                    await logAudit({ type: 'idea_garden_water', seedTitle, newCount, author });
                    return {
                        success: true,
                        action: 'watered',
                        seedTitle,
                        newCount,
                        status: newCount >= 5 ? 'READY TO HARVEST!' : newCount >= 3 ? 'Sprouting!' : `${5 - newCount} more until harvest.`
                    };
                }
                if (action === 'harvest') {
                    if (!seedTitle)
                        return { error: "'seedTitle' is required" };
                    const seedRegex = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=###|## [🌱🌿🌸🍂]|$)`);
                    const seedMatch = garden.match(seedRegex);
                    if (!seedMatch)
                        return { error: `Seed "${seedTitle}" not found` };
                    const seedContent = seedMatch[1];
                    const wateringMatch = seedContent.match(/- \*\*Waterings\*\*: (\d+)/);
                    const waterings = wateringMatch ? parseInt(wateringMatch[1]) : 0;
                    if (waterings < 5) {
                        return { error: `Seed only has ${waterings} waterings. Need 5+ for harvest.` };
                    }
                    const logMatch = seedContent.match(/- \*\*Log\*\*:\n([\s\S]*)/);
                    const logContent = logMatch ? logMatch[1].trim() : '';
                    const taskEntry = `
### ${seedTitle} (from Idea Garden)
- **Origin**: Harvested from Idea Garden (${waterings} waterings)
- **Summary**: ${content || 'See implementation notes below'}
- **Implementation Notes**:
${logContent.split('\n').map((l) => `  ${l}`).join('\n')}
 `;
                    // Move to Compost
                    const timestamp = new Date().toISOString().split('T')[0];
                    const fullSeed = `### ${seedTitle}\n${seedContent}`;
                    garden = garden.replace(fullSeed, '');
                    const harvestedSeed = fullSeed
                        .replace(/- \*\*Waterings\*\*: \d+/, '- **Waterings**: HARVESTED')
                        .replace(/- \*\*Log\*\*:\n/, `- **Log**:\n  - [${timestamp} ${author}] HARVESTED: Moved to CONTINUITY.md\n`);
                    garden = garden.replace(/## 🍂 Compost\n/, `## 🍂 Compost\n\n${harvestedSeed}`);
                    // Safeguard: Limit compost to 5 items
                    const compostMatchH = garden.match(/## 🍂 Compost([\s\S]*)/);
                    if (compostMatchH) {
                        const compostContent = compostMatchH[1];
                        const headers = [...compostContent.matchAll(/\n### /g)];
                        if (headers.length > 5 && headers[5].index !== undefined) {
                            garden = garden.replace(compostContent, compostContent.slice(0, headers[5].index));
                        }
                    }
                    garden = garden.replace(/\n{3,}/g, '\n\n');
                    await fs.writeFile(IDEAS_PATH, garden);
                    // Update CONTINUITY.md - RESISTANT TO STOCHASTIC HEADER CHANGES
                    let continuity = await fs.readFile(CONTINUITY_PATH, 'utf-8');
                    // Strategy 1: Look for the invariant anchor (Best Practice)
                    const PENDING_ANCHOR = '<!-- SYNTROPY:PENDING -->';
                    if (continuity.includes(PENDING_ANCHOR)) {
                        continuity = continuity.replace(PENDING_ANCHOR, `${PENDING_ANCHOR}\n\n${taskEntry}`);
                    }
                    // Strategy 2: Fuzzy matching for common headers (Resilience)
                    else if (continuity.match(/[#]{2,3}\s*.*(?:Pending|Tasks|Actions).*/i)) {
                        continuity = continuity.replace(/([#]{2,3}\s*.*(?:Pending|Tasks|Actions).*\n)/i, `$1\n${taskEntry}\n`);
                    }
                    // Strategy 3: Specific fallbacks (Legacy Support)
                    else if (continuity.includes('## 🎯 IMMEDIATE NEXT ACTIONS')) {
                        continuity = continuity.replace(/## 🎯 IMMEDIATE NEXT ACTIONS/, `## � Pending Tasks\n\n${taskEntry}\n\n## 🎯 IMMEDIATE NEXT ACTIONS`);
                    }
                    // Strategy 4: Append at the end (Emergency)
                    else {
                        continuity += `\n\n## 📬 Pending Tasks ${PENDING_ANCHOR}\n\n${taskEntry}\n`;
                    }
                    await fs.writeFile(CONTINUITY_PATH, continuity);
                    await logAudit({ type: 'idea_garden_harvest', seedTitle, waterings });
                    return { success: true, action: 'harvested', seedTitle, message: `"${seedTitle}" harvested to CONTINUITY.md!` };
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
                    const updatedSeed = fullSeed.replace(/- \*\*Log\*\*:\n/, `- **Log**:\n${compostNote}`);
                    garden = garden.replace(/## 🍂 Compost\n/, `## 🍂 Compost\n\n${updatedSeed}`);
                    const compostMatchC = garden.match(/## 🍂 Compost([\s\S]*)/);
                    if (compostMatchC) {
                        const compostContent = compostMatchC[1];
                        const headers = [...compostContent.matchAll(/\n### /g)];
                        if (headers.length > 5 && headers[5].index !== undefined) {
                            garden = garden.replace(compostContent, compostContent.slice(0, headers[5].index));
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
                if (action === 'merge') {
                    if (!seedTitle || !content || !mergeSeeds || mergeSeeds.length === 0) {
                        return {
                            error: "For merge: 'seedTitle' (primary seed), 'content' (synthesis), and 'mergeSeeds' (array of titles to absorb) are all required"
                        };
                    }
                    // Find the primary seed
                    const primaryRegex = new RegExp(`### ${seedTitle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n([\\s\\S]*?)(?=###|## [🌱🌿🌸🍂]|$)`);
                    const primaryMatch = garden.match(primaryRegex);
                    if (!primaryMatch) {
                        return { error: `Primary seed "${seedTitle}" not found in garden` };
                    }
                    let totalWaterings = 0;
                    const mergedLogs = [];
                    const absorbedTitles = [];
                    // Extract watering count from primary
                    const primaryWateringMatch = primaryMatch[1].match(/- \*\*Waterings\*\*: (\d+)/);
                    totalWaterings += primaryWateringMatch ? parseInt(primaryWateringMatch[1]) : 0;
                    // Process each seed to absorb
                    for (const absorbTitle of mergeSeeds) {
                        const absorbRegex = new RegExp(`### ${absorbTitle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n([\\s\\S]*?)(?=###|## [🌱🌿🌸🍂]|$)`);
                        const absorbMatch = garden.match(absorbRegex);
                        if (absorbMatch) {
                            // Extract waterings
                            const absorbWateringMatch = absorbMatch[1].match(/- \*\*Waterings\*\*: (\d+)/);
                            totalWaterings += absorbWateringMatch ? parseInt(absorbWateringMatch[1]) : 0;
                            // Extract origin for merged log
                            const originMatch = absorbMatch[1].match(/- \*\*Origin\*\*: ([^\r\n]+)/);
                            if (originMatch) {
                                mergedLogs.push(`[MERGED from "${absorbTitle}"] ${originMatch[1]}`);
                            }
                            // Remove the absorbed seed
                            garden = garden.replace(`### ${absorbTitle}\n${absorbMatch[1]}`, '');
                            absorbedTitles.push(absorbTitle);
                        }
                    }
                    // Update the primary seed with merged info
                    const timestamp = new Date().toISOString().split('T')[0];
                    const mergeLogEntry = `  - [${timestamp} ${author}] EVOLVED: ${content} (Merged ${absorbedTitles.length} related ideas: ${absorbedTitles.join(', ')})\n`;
                    let updatedPrimaryContent = primaryMatch[1];
                    // Update waterings count
                    updatedPrimaryContent = updatedPrimaryContent.replace(/- \*\*Waterings\*\*: \d+/, `- **Waterings**: ${totalWaterings}`);
                    // Add merge log entry
                    updatedPrimaryContent = updatedPrimaryContent.replace(/- \*\*Log\*\*:\n/, `- **Log**:\n${mergeLogEntry}`);
                    garden = garden.replace(primaryMatch[0], `### ${seedTitle}\n${updatedPrimaryContent}`);
                    garden = garden.replace(/\n{3,}/g, '\n\n');
                    await fs.writeFile(IDEAS_PATH, garden);
                    await logAudit({ type: 'idea_garden_merge', primarySeed: seedTitle, absorbed: absorbedTitles, newWaterings: totalWaterings });
                    return {
                        success: true,
                        action: 'merged',
                        primarySeed: seedTitle,
                        absorbed: absorbedTitles,
                        newWaterings: totalWaterings,
                        message: `Merged ${absorbedTitles.length} seeds into "${seedTitle}". Now has ${totalWaterings} waterings.`
                    };
                }
                if (action === 'consolidate') {
                    // Analyze all seeds for similarity and suggest merges
                    const existingSeeds = parseAllSeeds(garden);
                    const similarityGroups = [];
                    const processed = new Set(); // Use index instead of title!
                    for (let i = 0; i < existingSeeds.length; i++) {
                        if (processed.has(i))
                            continue;
                        const seed = existingSeeds[i];
                        const keywords = extractKeywords(`${seed.title} ${seed.origin}`);
                        const group = [seed];
                        processed.add(i);
                        for (let j = i + 1; j < existingSeeds.length; j++) {
                            if (processed.has(j))
                                continue;
                            const other = existingSeeds[j];
                            // Check for exact title match OR semantic similarity
                            const exactTitleMatch = seed.title.toLowerCase() === other.title.toLowerCase();
                            const otherKeywords = extractKeywords(`${other.title} ${other.origin}`);
                            const similarity = calculateSimilarity(keywords, otherKeywords);
                            if (exactTitleMatch || similarity >= 0.25) { // Lowered threshold, added exact match
                                group.push(other);
                                processed.add(j);
                            }
                        }
                        if (group.length > 1) {
                            similarityGroups.push({
                                seeds: group.sort((a, b) => b.waterings - a.waterings), // Most watered first
                                similarity: 0.5 // Average similarity (simplified)
                            });
                        }
                    }
                    if (similarityGroups.length === 0) {
                        return {
                            success: true,
                            action: 'consolidated',
                            duplicatesFound: 0,
                            message: 'Garden is clean! No similar ideas detected.'
                        };
                    }
                    const suggestions = similarityGroups.map((group, i) => {
                        const primary = group.seeds[0];
                        const toMerge = group.seeds.slice(1);
                        return {
                            group: i + 1,
                            primarySeed: primary.title,
                            primaryWaterings: primary.waterings,
                            toMerge: toMerge.map(s => ({ title: s.title, waterings: s.waterings })),
                            mergeCommand: `action='merge', seedTitle='${primary.title}', mergeSeeds=[${toMerge.map(s => `'${s.title}'`).join(', ')}], content='Consolidated insight synthesizing related ideas'`
                        };
                    });
                    await logAudit({ type: 'idea_garden_consolidate', groupsFound: similarityGroups.length });
                    return {
                        success: true,
                        action: 'consolidated',
                        duplicatesFound: similarityGroups.length,
                        suggestions,
                        hint: 'Use the merge action to combine each group. The seed with most waterings is suggested as primary.',
                        message: `Found ${similarityGroups.length} groups of similar ideas that could be merged!`
                    };
                }
                return { error: `Unknown action: ${action}` };
            }
            catch (error) {
                await logAudit({ type: 'idea_garden_error', action, error: error.message });
                return { error: `Idea Garden error: ${error.message}` };
            }
        }
    })
};
