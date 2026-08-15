require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  const referencePath = process.env.CHARACTER_REFERENCE_IMAGE || '';
  const outputPath = path.join(process.cwd(), 'data', 'assets', 'gemini-image-test.png');

  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const parts = [];
  if (referencePath) {
    if (!fs.existsSync(referencePath)) {
      throw new Error(`CHARACTER_REFERENCE_IMAGE does not exist: ${referencePath}`);
    }
    const ext = path.extname(referencePath).toLowerCase();
    const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    parts.push({ inlineData: { mimeType, data: fs.readFileSync(referencePath).toString('base64') } });
    parts.push({ text: 'Create a clean 16:9 educational illustration using the supplied character reference. Keep the same character identity and art style. Show the character sitting at a desk and thinking about investing. No text, no watermark.' });
  } else {
    parts.push({ text: 'Create a clean 16:9 educational illustration of a friendly recurring character sitting at a desk and thinking about investing. 2D modern educational style, no text, no watermark.' });
  }

  console.log(`Gemini image model: ${model}`);
  console.log(`Character reference: ${referencePath || '(not configured)'}`);
  console.log('Calling Gemini...');

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['IMAGE'] }
  });

  const responseParts = response.candidates?.[0]?.content?.parts || [];
  const imagePart = responseParts.find(part => part.inlineData?.data);
  if (!imagePart) {
    const text = responseParts.filter(part => part.text).map(part => part.text).join(' ');
    throw new Error(`Gemini returned no image data${text ? `; text response: ${text}` : ''}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(imagePart.inlineData.data, 'base64'));
  console.log(`SUCCESS: ${outputPath}`);
}

main().catch(error => {
  console.error('\nGEMINI IMAGE TEST FAILED');
  console.error(error.message);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
});
