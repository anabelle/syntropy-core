import { expect, test, describe, beforeAll, afterAll, mock } from "bun:test";
import * as fs from "fs-extra";
import * as path from "path";

// ============================================
// ENVIRONMENT OVERRIDE
// ============================================
const TEST_ROOT = path.resolve(process.cwd(), "test-data-ideation");
process.env.PIXEL_ROOT = TEST_ROOT;
process.env.DOCKER = "false";

// Mock config to point to our test root
mock.module("../config", () => ({
    PIXEL_ROOT: TEST_ROOT,
    PIXEL_AGENT_DIR: path.resolve(TEST_ROOT, "pixel-agent"),
    MODEL_NAME: "test-model",
    MODEL_PROVIDER: "test-provider"
}));

// Mock side effects
mock.module("../utils", () => ({
    logAudit: () => Promise.resolve(),
    syncAll: () => Promise.resolve(true)
}));

// Mock worker tools to avoid spawning real workers during tests
mock.module("../worker-tools", () => ({
    spawnWorkerInternal: () => Promise.resolve({ taskId: "test-task-123" })
}));

import { ideationTools } from "./ideation";

describe("Ideation Tools - Harvesting Resilience", () => {
    const IDEAS_PATH = path.resolve(TEST_ROOT, "IDEAS.md");
    const CONTINUITY_PATH = path.resolve(TEST_ROOT, "CONTINUITY.md");

    beforeAll(async () => {
        await fs.ensureDir(TEST_ROOT);
    });

    afterAll(async () => {
        await fs.remove(TEST_ROOT);
    });

    const setupIdeasFile = async () => {
        const ideasContent = `# 🌱 Idea Garden

## 🌱 Seeds (0-2 waterings)

## 🌿 Sprouting (3-4 waterings)

## 🌸 Ready to Harvest (5+ waterings)

### Mature Idea
- **Planted**: 2026-01-01 by Syntropy
- **Origin**: Initial thought
- **Waterings**: 5
- **Log**:
  - [2026-01-01] Watering 1
  - [2026-01-01] Watering 2
  - [2026-01-01] Watering 3
  - [2026-01-01] Watering 4
  - [2026-01-01] Watering 5

## 🍂 Compost
`;
        await fs.writeFile(IDEAS_PATH, ideasContent);
    };

    test("Strategy 1: Robust Harvest via SYNTROPY:PENDING Anchor", async () => {
        await setupIdeasFile();
        const continuityContent = `# Continuity Ledger
## 📬 Inbox
### 📋 Pending Actions <!-- SYNTROPY:PENDING -->
1. Existing task
`;
        await fs.writeFile(CONTINUITY_PATH, continuityContent);

        const result: any = await (ideationTools.tendIdeaGarden.execute as any)({
            action: "harvest",
            seedTitle: "Mature Idea",
            content: "Implement the mature idea"
        });

        if (!result || !result.success) console.error("TEST ERROR LOG:", JSON.stringify(result));
        expect(result && result.success).toBe(true);

        const updatedContinuity = await fs.readFile(CONTINUITY_PATH, "utf-8");
        expect(updatedContinuity).toContain("### 📋 Pending Actions <!-- SYNTROPY:PENDING -->");
        expect(updatedContinuity).toContain("### Mature Idea (from Idea Garden)");
        expect(updatedContinuity).toContain("- **Origin**: Harvested from Idea Garden (5 waterings)");
    });

    test("Strategy 2: Robust Harvest via Fuzzy Header Matching", async () => {
        await setupIdeasFile();
        const continuityContent = `# Continuity Ledger
## 📬 Inbox
## 🚀 Strategic Actions
- Do thing 1
`;
        await fs.writeFile(CONTINUITY_PATH, continuityContent);

        const result: any = await (ideationTools.tendIdeaGarden.execute as any)({
            action: "harvest",
            seedTitle: "Mature Idea",
            content: "Implement the mature idea"
        });

        expect(result && result.success).toBe(true);

        const updatedContinuity = await fs.readFile(CONTINUITY_PATH, "utf-8");
        expect(updatedContinuity).toContain("## 🚀 Strategic Actions");
        expect(updatedContinuity).toContain("### Mature Idea (from Idea Garden)");
    });

    test("Strategy 2b: Fuzzy Header Matching (Urgent Tasks)", async () => {
        await setupIdeasFile();
        const continuityContent = `# Continuity Ledger
## 📬 Inbox
## 🚨 Urgent Tasks
- Fix bug
`;
        await fs.writeFile(CONTINUITY_PATH, continuityContent);

        const result: any = await (ideationTools.tendIdeaGarden.execute as any)({
            action: "harvest",
            seedTitle: "Mature Idea",
            content: "Implement the mature idea"
        });

        if (!result || !result.success) console.error("TEST ERROR LOG:", JSON.stringify(result));
        expect(result && result.success).toBe(true);

        const updatedContinuity = await fs.readFile(CONTINUITY_PATH, "utf-8");
        expect(updatedContinuity).toContain("## 🚨 Urgent Tasks");
        expect(updatedContinuity).toContain("### Mature Idea (from Idea Garden)");
    });

    test("Strategy 4: Append to End if no matching headers found", async () => {
        await setupIdeasFile();
        const continuityContent = `# Continuity Ledger
# Totally different structure
Only random text here.
`;
        await fs.writeFile(CONTINUITY_PATH, continuityContent);

        const result: any = await (ideationTools.tendIdeaGarden.execute as any)({
            action: "harvest",
            seedTitle: "Mature Idea",
            content: "Implement the mature idea"
        });

        expect(result && result.success).toBe(true);

        const updatedContinuity = await fs.readFile(CONTINUITY_PATH, "utf-8");
        expect(updatedContinuity).toContain("## 📬 Pending Tasks <!-- SYNTROPY:PENDING -->");
        expect(updatedContinuity).toContain("### Mature Idea (from Idea Garden)");
    });
});
