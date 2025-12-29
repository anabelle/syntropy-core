import { tools } from './src/tools';
import { DB_PATH, AUDIT_LOG_PATH } from './src/config';
import * as fs from 'fs-extra';

async function testSyntropy() {
    console.log("--- SYNTROPY HEALTH CHECK ---");
    console.log(`DB Path: ${DB_PATH}`);
    console.log(`Audit Log Path: ${AUDIT_LOG_PATH}`);

    console.log("\n1. Testing 'readContinuity'...");
    const continuity = await tools.readContinuity.execute({}, { toolCallId: 'test', messages: [] });
    if (typeof continuity === 'string') {
        console.log("✅ Successfully read Continuity Ledger.");
        console.log(`Content length: ${continuity.length} characters.`);
    } else {
        console.log("❌ Failed to read Continuity Ledger:", continuity);
    }

    console.log("\n2. Testing 'checkTreasury'...");
    const treasury = await tools.checkTreasury.execute({ confirm: true }, { toolCallId: 'test', messages: [] });
    if (treasury && !('error' in treasury)) {
        console.log("✅ Successfully checked treasury via SQLite.");
        console.log(`Treasury result: ${JSON.stringify(treasury)}`);
    } else {
        console.log("❌ Failed to check treasury:", treasury);
    }

    console.log("\n3. Testing 'getEcosystemStatus' (expect failure in non-pm2 env)...");
    const status = await tools.getEcosystemStatus.execute({ confirm: true }, { toolCallId: 'test', messages: [] });
    console.log(`Status result: ${JSON.stringify(status).slice(0, 100)}...`);

    console.log("\n--- HEALTH CHECK COMPLETE ---");
}

testSyntropy().catch(console.error);
