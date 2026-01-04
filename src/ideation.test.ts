
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from 'fs-extra';
import * as path from 'path';

describe("Idea Garden Tool", async () => {
    const testRoot = path.resolve(process.cwd(), 'test-garden-suite');

    beforeEach(async () => {
        await fs.ensureDir(testRoot);
        process.env.PIXEL_ROOT = testRoot;

        // Initial files
        await fs.writeFile(path.resolve(testRoot, 'IDEAS.md'), `# 🌱 Idea Garden

## 🌱 Seeds (0-2 waterings)

## 🌿 Sprouting (3-4 waterings)

## 🌸 Ready to Harvest (5+ waterings)

## 🍂 Compost
`);
        await fs.writeFile(path.resolve(testRoot, 'CONTINUITY.md'), "# Continuity\n\n## 📬 Pending Tasks\n");
    });

    afterEach(async () => {
        await fs.remove(testRoot);
    });

    const mockOptions = { toolCallId: 'test', messages: [] };

    it("should perform a full lifecycle: plant -> water -> sprout -> ready -> harvest", async () => {
        const { ideationTools } = await import('./tools/ideation');
        const garden = ideationTools.tendIdeaGarden;
        const author = 'Syntropy';

        // 1. Plant
        const plant = await garden.execute({ action: 'plant', seedTitle: 'Evolution', content: 'Base idea', author } as any, mockOptions) as any;
        expect(plant.success).toBe(true);

        // 2. Duplicate check
        const dup = await garden.execute({ action: 'plant', seedTitle: 'Evolution', content: 'Dup', author } as any, mockOptions) as any;
        expect(dup.error).toBeDefined();

        // 3. Read
        const read1 = await garden.execute({ action: 'read', author } as any, mockOptions) as any;
        expect(read1.seeds).toHaveLength(1);
        expect(read1.seeds[0].title).toBe('Evolution');
        expect(read1.seeds[0].section).toBe('Seeds');

        // 4. Water to Sprouting (needs 3)
        await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W1', author } as any, mockOptions);
        await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W2', author } as any, mockOptions);
        const water3 = await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W3', author } as any, mockOptions) as any;
        expect(water3.status).toBe('Sprouting!');

        const read2 = await garden.execute({ action: 'read', author } as any, mockOptions) as any;
        expect(read2.seeds[0].section).toBe('Sprouting');

        // 5. Water to Ready (needs 5)
        await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W4', author } as any, mockOptions);
        const water5 = await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W5', author } as any, mockOptions) as any;
        expect(water5.status).toBe('READY TO HARVEST!');

        // 6. Harvest
        const harvest = await garden.execute({ action: 'harvest', seedTitle: 'Evolution', content: 'Task', author } as any, mockOptions) as any;
        expect(harvest.success).toBe(true);

        // 7. Verify files
        const continuity = await fs.readFile(path.resolve(testRoot, 'CONTINUITY.md'), 'utf-8');
        expect(continuity).toContain('### Evolution (from Idea Garden)');

        const ideas = await fs.readFile(path.resolve(testRoot, 'IDEAS.md'), 'utf-8');
        expect(ideas).toContain('HARVESTED');
        expect(ideas).toContain('## 🍂 Compost');
    });

    it("should handle composting", async () => {
        const { ideationTools } = await import('./tools/ideation');
        const garden = ideationTools.tendIdeaGarden;

        await garden.execute({ action: 'plant', seedTitle: 'Stale Idea', content: '...', author: 'Human' } as any, mockOptions);
        const compost = await garden.execute({ action: 'compost', seedTitle: 'Stale Idea', content: 'Too boring', author: 'Syntropy' } as any, mockOptions) as any;

        expect(compost.success).toBe(true);
        const ideas = await fs.readFile(path.resolve(testRoot, 'IDEAS.md'), 'utf-8');
        expect(ideas).toContain('COMPOSTED: Too boring');
    });

    it("should block planting semantically similar ideas", async () => {
        const { ideationTools } = await import('./tools/ideation');
        const garden = ideationTools.tendIdeaGarden;

        // Plant first idea about character cascade
        const plant1 = await garden.execute({
            action: 'plant',
            seedTitle: 'Character Cascade Evolution',
            content: 'Testing cascade principle for character evolution and strategic adaptation',
            author: 'Syntropy'
        } as any, mockOptions) as any;
        expect(plant1.success).toBe(true);

        // Try to plant similar idea - should be BLOCKED
        const plant2 = await garden.execute({
            action: 'plant',
            seedTitle: 'Character Evolution Cascade Test',
            content: 'Apply cascade principle to character changes and strategic positioning',
            author: 'Syntropy'
        } as any, mockOptions) as any;

        expect(plant2.error).toBeDefined();
        expect(plant2.error).toContain('BLOCKED');
        expect(plant2.similarSeeds).toBeDefined();
        expect(plant2.similarSeeds.length).toBeGreaterThan(0);
        expect(plant2.action).toBe('water_instead');
    });

    it("should allow planting genuinely different ideas", async () => {
        const { ideationTools } = await import('./tools/ideation');
        const garden = ideationTools.tendIdeaGarden;

        // Plant idea about Lightning Network
        const plant1 = await garden.execute({
            action: 'plant',
            seedTitle: 'Lightning Node Deployment',
            content: 'Deploy Lightning Network node for passive income routing',
            author: 'Syntropy'
        } as any, mockOptions) as any;
        expect(plant1.success).toBe(true);

        // Plant completely different idea about documentation
        const plant2 = await garden.execute({
            action: 'plant',
            seedTitle: 'Auto Documentation Updates',
            content: 'Automatically update docs when schema changes',
            author: 'Syntropy'
        } as any, mockOptions) as any;

        expect(plant2.success).toBe(true);
        expect(plant2.error).toBeUndefined();
    });

    it("should merge multiple similar seeds into one", async () => {
        const { ideationTools } = await import('./tools/ideation');
        const garden = ideationTools.tendIdeaGarden;

        // Plant three related ideas
        await garden.execute({
            action: 'plant',
            seedTitle: 'Cascade Primary',
            content: 'Main cascade idea',
            author: 'Syntropy'
        } as any, mockOptions);

        // Water the primary seed once
        await garden.execute({
            action: 'water',
            seedTitle: 'Cascade Primary',
            content: 'Adding depth',
            author: 'Syntropy'
        } as any, mockOptions);

        await garden.execute({
            action: 'plant',
            seedTitle: 'Cascade Secondary',
            content: 'Related cascade thought',
            author: 'Syntropy'
        } as any, mockOptions);

        await garden.execute({
            action: 'plant',
            seedTitle: 'Cascade Tertiary',
            content: 'Another cascade angle',
            author: 'Syntropy'
        } as any, mockOptions);

        // Verify we have 3 seeds
        const read1 = await garden.execute({ action: 'read', author: 'Syntropy' } as any, mockOptions) as any;
        expect(read1.seeds).toHaveLength(3);

        // Merge secondary and tertiary into primary
        const merge = await garden.execute({
            action: 'merge',
            seedTitle: 'Cascade Primary',
            mergeSeeds: ['Cascade Secondary', 'Cascade Tertiary'],
            content: 'Unified cascade framework combining all perspectives',
            author: 'Syntropy'
        } as any, mockOptions) as any;

        expect(merge.success).toBe(true);
        expect(merge.action).toBe('merged');
        expect(merge.absorbed).toContain('Cascade Secondary');
        expect(merge.absorbed).toContain('Cascade Tertiary');
        expect(merge.newWaterings).toBe(1); // 1 from primary + 0 from each secondary

        // Verify only 1 seed remains
        const read2 = await garden.execute({ action: 'read', author: 'Syntropy' } as any, mockOptions) as any;
        expect(read2.seeds).toHaveLength(1);
        expect(read2.seeds[0].title).toBe('Cascade Primary');

        // Verify merge is logged
        const ideas = await fs.readFile(path.resolve(testRoot, 'IDEAS.md'), 'utf-8');
        expect(ideas).toContain('EVOLVED');
        expect(ideas).toContain('Merged 2 related ideas');
    });

    it("should consolidate garden and find similar idea groups", async () => {
        const { ideationTools } = await import('./tools/ideation');
        const garden = ideationTools.tendIdeaGarden;

        // Plant several similar ideas manually (bypassing similarity check by using very different origins)
        // Simulate legacy garden with duplicates
        await fs.writeFile(path.resolve(testRoot, 'IDEAS.md'), `# 🌱 Idea Garden

## 🌱 Seeds (0-2 waterings)

### Character Cascade Evolution
- **Planted**: 2026-01-04 by Syntropy
- **Origin**: Testing cascade principle for character evolution
- **Waterings**: 1
- **Log**:
  - [2026-01-04 Syntropy] First thought

### Character Evolution Testing
- **Planted**: 2026-01-04 by Syntropy
- **Origin**: Character cascade testing approach evolution
- **Waterings**: 0
- **Log**:

### Lightning Node Setup
- **Planted**: 2026-01-04 by Syntropy
- **Origin**: Deploy LN node for routing income
- **Waterings**: 0
- **Log**:

## 🌿 Sprouting (3-4 waterings)

## 🌸 Ready to Harvest (5+ waterings)

## 🍂 Compost
`);

        // Run consolidate
        const consolidate = await garden.execute({
            action: 'consolidate',
            author: 'Syntropy'
        } as any, mockOptions) as any;

        expect(consolidate.success).toBe(true);
        expect(consolidate.action).toBe('consolidated');
        expect(consolidate.duplicatesFound).toBeGreaterThanOrEqual(1);
        expect(consolidate.suggestions).toBeDefined();
        expect(consolidate.suggestions.length).toBeGreaterThan(0);

        // The first group should contain the character cascade ideas
        const firstGroup = consolidate.suggestions[0];
        expect(firstGroup.primarySeed).toBeDefined();
        expect(firstGroup.toMerge.length).toBeGreaterThan(0);
    });

    it("should return clean garden message when no duplicates exist", async () => {
        const { ideationTools } = await import('./tools/ideation');
        const garden = ideationTools.tendIdeaGarden;

        // Plant two completely different ideas
        await garden.execute({
            action: 'plant',
            seedTitle: 'Quantum Computing Research',
            content: 'Explore quantum algorithms for optimization',
            author: 'Syntropy'
        } as any, mockOptions);

        await garden.execute({
            action: 'plant',
            seedTitle: 'Recipe Database',
            content: 'Build database for cooking recipes',
            author: 'Human'
        } as any, mockOptions);

        // Run consolidate
        const consolidate = await garden.execute({
            action: 'consolidate',
            author: 'Syntropy'
        } as any, mockOptions) as any;

        expect(consolidate.success).toBe(true);
        expect(consolidate.duplicatesFound).toBe(0);
        expect(consolidate.message).toContain('clean');
    });
});
