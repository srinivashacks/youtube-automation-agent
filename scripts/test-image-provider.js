require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

async function main() {
  const generator = new AIVideoGenerator();
  const output = path.join(__dirname, '..', 'data', 'assets', 'image-provider-test.png');
  const prompt = 'A clean modern 2D educational illustration of the Cognitive Angle recurring character sitting at a desk reading a book about habits, thoughtful expression, warm desk lamp, simple uncluttered room, polished digital illustration, cinematic 16:9 composition, no text, no watermark.';

  console.log(`IMAGE_PROVIDER=${process.env.IMAGE_PROVIDER || 'auto'}`);
  console.log(`Selected provider=${generator.imageProvider}`);
  console.log(`Character reference=${generator.characterReference || '(not configured)'}`);
  console.log('Generating one test image...');

  await generator.generateImage(prompt, output);
  const stat = await fs.stat(output);
  console.log(`SUCCESS: ${output}`);
  console.log(`File size: ${stat.size} bytes`);
}

main().catch(error => {
  console.error('IMAGE PROVIDER TEST FAILED');
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
