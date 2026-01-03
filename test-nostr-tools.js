
const { tools } = require('./dist/tools.js');
const { logAudit } = require('./dist/utils.js');

// Mock environmental requirements if needed
process.env.PIXEL_ROOT = '/home/ana/Code/pixel';

async function testTools() {
    console.log('Testing readPixelNostrFeed...');
    try {
        const feed = await tools.readPixelNostrFeed.execute({ limit: 5 });
        console.log('Feed result:', JSON.stringify(feed, null, 2));
    } catch (error) {
        console.error('Feed error:', error);
    }

    // Optional: Uncomment to test posting (will actually post!)
    // console.log('Testing postToNostr...');
    // try {
    //   const post = await tools.postToNostr.execute({ text: "Verifying systems. Hello Nostr." });
    //   console.log('Post result:', post);
    // } catch (error) {
    //   console.error('Post error:', error);
    // }
}

testTools();
