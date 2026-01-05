import { expect, test, describe, beforeAll, afterAll, mock, spyOn } from "bun:test";
import * as fs from "fs-extra";
import * as path from "path";
import * as crypto from "crypto";

// ============================================
// ENVIRONMENT OVERRIDE
// ============================================
// We point PIXEL_ROOT to a test-data folder so the REAL tools
// will target our test files instead of the production files.
const TEST_ROOT = path.resolve(process.cwd(), "test-data-continuity");
process.env.PIXEL_ROOT = TEST_ROOT;
process.env.DOCKER = "false"; // Force local-style paths in tools

// Now import the ACTUAL tools
import { readIdentity, evolveIdentity, readVision, updateVision } from "./continuity";
import * as utils from "../utils";

// Mock side effects to avoid hanging on git/audit log writes
mock.module("../utils", () => ({
    logAudit: () => Promise.resolve(),
    syncAll: () => Promise.resolve(true)
}));

function getChecksum(content: string): string {
    return crypto.createHash("md5").update(content).digest("hex").slice(0, 8);
}

describe("Continuity Tools - Identity & Vision Evolution (REAL TOOLS)", () => {
    const AGENTS_PATH = path.resolve(TEST_ROOT, "AGENTS.md");
    const VISION_PATH = path.resolve(TEST_ROOT, "VISION.md");

    beforeAll(async () => {
        await fs.ensureDir(TEST_ROOT);
    });

    afterAll(async () => {
        await fs.remove(TEST_ROOT);
    });

    describe("AGENTS.md (Identity)", () => {
        test("Happy Path: Read → Correct Checksum → Evolution Success", async () => {
            const initialContent = "Initial Soul #1";
            await fs.writeFile(AGENTS_PATH, initialContent);
            const expectedChecksum = getChecksum(initialContent);

            // 1. Read using the REAL tool
            const readResult: any = await (readIdentity.execute as any)({});
            expect(readResult.content).toBe(initialContent);
            expect(readResult.contextChecksum).toBe(expectedChecksum);

            // 2. Evolve using the REAL tool
            const newContent = "Evolved Soul #1";
            const evolveResult: any = await (evolveIdentity.execute as any)({
                content: newContent,
                reason: "Testing real tool",
                contextChecksum: readResult.contextChecksum
            });

            expect(evolveResult.success).toBe(true);

            // 3. Verify on disk
            const diskContent = await fs.readFile(AGENTS_PATH, "utf-8");
            expect(diskContent).toBe(newContent);
        });

        test("Security Path: Stale Checksum → Rejection", async () => {
            await fs.writeFile(AGENTS_PATH, "Fresh Data");

            const evolveResult: any = await (evolveIdentity.execute as any)({
                content: "Hacked Data",
                reason: "Bypass test",
                contextChecksum: "stale-or-wrong"
            });

            expect(evolveResult.error).toBe("Safety Violation: stale_context");

            // Verify no write
            const diskContent = await fs.readFile(AGENTS_PATH, "utf-8");
            expect(diskContent).toBe("Fresh Data");
        });
    });

    describe("VISION.md (Vision)", () => {
        test("Happy Path: Read → Correct Checksum → Update Success", async () => {
            const initialVision = "Vision #1";
            await fs.writeFile(VISION_PATH, initialVision);
            const expectedChecksum = getChecksum(initialVision);

            // 1. Read
            const readResult: any = await (readVision.execute as any)({});
            expect(readResult.contextChecksum).toBe(expectedChecksum);

            // 2. Update
            const newVision = "Vision #2";
            const updateResult: any = await (updateVision.execute as any)({
                content: newVision,
                reason: "Evolving goals",
                contextChecksum: readResult.contextChecksum
            });

            expect(updateResult.success).toBe(true);
            expect(await fs.readFile(VISION_PATH, "utf-8")).toBe(newVision);
        });

        test("Security Path: Failed Update on stale checksum", async () => {
            await fs.writeFile(VISION_PATH, "Current Vision");

            const updateResult: any = await (updateVision.execute as any)({
                content: "Conflicting Vision",
                reason: "Race condition test",
                contextChecksum: "old-checksum"
            });

            expect(updateResult.error).toBe("Safety Violation: stale_context");
        });
    });
});
