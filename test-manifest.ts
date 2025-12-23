import * as fs from 'fs-extra';
import * as path from 'path';

async function testReport() {
  const PIXEL_ROOT = '/home/pixel/pixel';
  const reportDir = path.resolve(PIXEL_ROOT, 'docs/evolution');
  await fs.ensureDir(reportDir);
  const title = "Manual Trigger Test";
  const content = "Testing the manifestation system.";
  const cleanTitle = title.toLowerCase().replace(/\s+/g, '-');
  const filename = `${Date.now()}-${cleanTitle}.md`;
  const filePath = path.resolve(reportDir, filename);
  await fs.writeFile(filePath, content);
  console.log(`Report written to ${filePath}`);

  const publicMonologuePath = path.resolve(PIXEL_ROOT, 'pixel-landing/public/syntropy.json');
  await fs.writeJson(publicMonologuePath, {
    lastUpdate: new Date().toISOString(),
    title: title,
    content: content,
    status: 'MANUAL_TEST_COMPLETE'
  });
  console.log(`JSON updated at ${publicMonologuePath}`);
}

testReport();
