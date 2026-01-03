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
        const plant = await garden.execute({ action: 'plant', seedTitle: 'Evolution', content: 'Base idea', author }, mockOptions);
        expect(plant.success).toBe(true);
        // 2. Duplicate check
        const dup = await garden.execute({ action: 'plant', seedTitle: 'Evolution', content: 'Dup', author }, mockOptions);
        expect(dup.error).toBeDefined();
        // 3. Read
        const read1 = await garden.execute({ action: 'read', author }, mockOptions);
        expect(read1.seeds).toHaveLength(1);
        expect(read1.seeds[0].title).toBe('Evolution');
        expect(read1.seeds[0].section).toBe('Seeds');
        // 4. Water to Sprouting (needs 3)
        await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W1', author }, mockOptions);
        await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W2', author }, mockOptions);
        const water3 = await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W3', author }, mockOptions);
        expect(water3.status).toBe('Sprouting!');
        const read2 = await garden.execute({ action: 'read', author }, mockOptions);
        expect(read2.seeds[0].section).toBe('Sprouting');
        // 5. Water to Ready (needs 5)
        await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W4', author }, mockOptions);
        const water5 = await garden.execute({ action: 'water', seedTitle: 'Evolution', content: 'W5', author }, mockOptions);
        expect(water5.status).toBe('READY TO HARVEST!');
        // 6. Harvest
        const harvest = await garden.execute({ action: 'harvest', seedTitle: 'Evolution', content: 'Task', author }, mockOptions);
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
        await garden.execute({ action: 'plant', seedTitle: 'Stale Idea', content: '...', author: 'Human' }, mockOptions);
        const compost = await garden.execute({ action: 'compost', seedTitle: 'Stale Idea', content: 'Too boring', author: 'Syntropy' }, mockOptions);
        expect(compost.success).toBe(true);
        const ideas = await fs.readFile(path.resolve(testRoot, 'IDEAS.md'), 'utf-8');
        expect(ideas).toContain('COMPOSTED: Too boring');
    });
});
