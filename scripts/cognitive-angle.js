require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const { runKokoro } = require('../utils/kokoro-tts');
const { runFFmpeg, checkFFmpeg, ffmpegInstallHint } = require('../utils/ffmpeg');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const INPUT = path.join(DATA, 'cognitive-input');
const FLOW = path.join(DATA, 'flow');
const FLOW_DOWNLOADS = path.join(FLOW, 'downloads');
const AUDIO = path.join(DATA, 'audio');
const VIDEOS = path.join(DATA, 'videos');
const CAPTIONS = path.join(DATA, 'captions');

const env = process.env;
const textModel = env.COGNITIVE_TEXT_MODEL || 'gemini-3.5-flash';

async function ensureDirs() {
  for (const dir of [INPUT, FLOW, FLOW_DOWNLOADS, AUDIO, VIDEOS, CAPTIONS]) await fs.mkdir(dir, { recursive: true });
}

async function readScript(file) {
  const source = file || path.join(INPUT, 'script.txt');
  const text = await fs.readFile(source, 'utf8');
  if (!text.trim()) throw new Error(`Script is empty: ${source}`);
  return { source, text: text.trim() };
}

function titleFromScript(text) {
  const match = text.match(/^\s*#\s+(.+)$/m) || text.match(/^\s*Title\s*:\s*(.+)$/im);
  return match ? match[1].trim() : 'Cognitive Angle Video';
}

function stripProductionNotes(text) {
  return text
    .replace(/^\s*\[[^\]]+\]\s*$/gm, '')
    .replace(/^\s*Production Notes:?[\s\S]*$/im, '')
    .trim();
}

function cleanJson(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Gemini did not return a JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

async function geminiJson(instruction, schemaHint) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for scene planning and SEO');
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const prompt = `${instruction}\n\nReturn ONLY valid JSON. Do not use markdown fences. Follow this shape exactly:\n${schemaHint}`;
  const response = await ai.models.generateContent({
    model: textModel,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseMimeType: 'application/json' }
  });
  return cleanJson(response.text);
}

async function prepare(scriptFile, thumbnailFile) {
  await ensureDirs();
  const { source, text } = await readScript(scriptFile);
  const cleanScript = stripProductionNotes(text);
  const title = titleFromScript(cleanScript);

  const scenePlan = await geminiJson(
    `You are the visual director for Cognitive Angle, a YouTube channel using one recurring 2D illustrated character. Create a practical storyboard from the supplied script. Use 10-16 scenes for a 8-12 minute video, fewer for shorter scripts. Each scene must correspond to a meaningful passage, not arbitrary timestamps. Write detailed image prompts for Google Flow image generation. Prompts must preserve the SAME character and ask for a clean modern 2D educational illustration, cinematic 16:9 composition, expressive pose, clear action, simple readable background, no text, no watermark. Do not ask for image generation here.\n\nSCRIPT:\n${cleanScript}`,
    '{"scenes":[{"id":"scene_001","title":"","script_anchor":"","prompt":"","mood":"","duration_hint_seconds":30}]}'
  );

  const seo = await geminiJson(
    `You are the YouTube SEO editor for Cognitive Angle. Based only on this script, produce honest SEO metadata. Do not use clickbait claims that are unsupported. Include a strong title, 3 alternative titles, a 2-3 paragraph description, 10-15 tags, 3 hashtags, and chapter suggestions.\n\nSCRIPT:\n${cleanScript}`,
    '{"title":"","alternative_titles":[""],"description":"","tags":[""],"hashtags":[""],"chapters":[{"time":"00:00","title":""}]}'
  );

  const jobId = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const jobDir = path.join(FLOW, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, 'script.txt'), cleanScript);
  await fs.writeFile(path.join(jobDir, 'seo.json'), JSON.stringify(seo, null, 2));
  await fs.writeFile(path.join(jobDir, 'scene-plan.json'), JSON.stringify(scenePlan, null, 2));

  const prompts = scenePlan.scenes.map((s, i) => `${String(i + 1).padStart(3, '0')}|${s.id}|${s.prompt}`).join('\n');
  await fs.writeFile(path.join(jobDir, 'flow-prompts.txt'), prompts + '\n');
  await fs.writeFile(path.join(jobDir, 'flow-prompts.csv'), 'filename,scene_id,prompt\n' + scenePlan.scenes.map((s, i) => {
    const filename = `image_${String(i + 1).padStart(3, '0')}.png`;
    return `${filename},${s.id},"${String(s.prompt).replace(/"/g, '""')}"`;
  }).join('\n') + '\n');
  await fs.writeFile(path.join(jobDir, 'README.txt'), `Cognitive Angle production job\n\n1. Open Google Flow and your preferred Flow automation extension.\n2. Import flow-prompts.txt or flow-prompts.csv.\n3. Use the channel character/reference in Flow for every scene.\n4. Download images in the exact numbered order: image_001.png, image_002.png, ...\n5. Put the downloaded images into this job's downloads folder.\n6. Run: npm run cognitive:assemble -- ${jobId}\n\nThe thumbnail is intentionally supplied manually by the creator and is not generated by this pipeline.\n`);
  await fs.mkdir(path.join(jobDir, 'downloads'), { recursive: true });

  if (thumbnailFile) {
    const ext = path.extname(thumbnailFile).toLowerCase() || '.png';
    await fs.copyFile(thumbnailFile, path.join(jobDir, `thumbnail${ext}`));
  }

  console.log(`\nCognitive Angle job prepared: ${jobId}`);
  console.log(`Script: ${source}`);
  console.log(`Title: ${seo.title || title}`);
  console.log(`Scenes: ${scenePlan.scenes.length}`);
  console.log(`Job folder: ${jobDir}`);
  console.log('\nSEO OUTPUT');
  console.log(JSON.stringify(seo, null, 2));
  console.log('\nFLOW PROMPTS');
  scenePlan.scenes.forEach((s, i) => console.log(`${String(i + 1).padStart(3, '0')} ${s.id}: ${s.prompt}`));
  console.log('\nNext: generate/download the numbered images into the job downloads folder, then run:');
  console.log(`npm run cognitive:assemble -- ${jobId}`);
  return jobId;
}

async function getAudioDuration(file) {
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(ffprobe, ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(0);
      resolve(Number.parseFloat(String(stdout).trim()) || 0);
    });
  });
}

function srtTime(seconds) {
  const ms = Math.round((seconds % 1) * 1000);
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function makeCaptions(text, duration) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const wordsPerCaption = 10;
  const groups = [];
  for (let i = 0; i < words.length; i += wordsPerCaption) groups.push(words.slice(i, i + wordsPerCaption).join(' '));
  const per = duration / Math.max(groups.length, 1);
  return groups.map((g, i) => `${i + 1}\n${srtTime(i * per)} --> ${srtTime(Math.min(duration, (i + 1) * per))}\n${g}\n`).join('\n');
}

async function assemble(jobId) {
  await ensureDirs();
  if (!jobId) throw new Error('Usage: npm run cognitive:assemble -- <jobId>');
  const jobDir = path.join(FLOW, jobId);
  const plan = JSON.parse(await fs.readFile(path.join(jobDir, 'scene-plan.json'), 'utf8'));
  const script = await fs.readFile(path.join(jobDir, 'script.txt'), 'utf8');
  const downloadDir = path.join(jobDir, 'downloads');
  const files = (await fs.readdir(downloadDir)).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
  if (files.length < plan.scenes.length) throw new Error(`Expected ${plan.scenes.length} downloaded Flow images but found ${files.length}. Put the numbered images into ${downloadDir}`);

  const audioPath = path.join(AUDIO, `cognitive_${jobId}_narration.wav`);
  await runKokoro(script, audioPath, { info: console.log, warn: console.warn, error: console.error });
  const audioDuration = await getAudioDuration(audioPath);
  if (!audioDuration) throw new Error('Could not determine Kokoro audio duration');

  const captionsPath = path.join(CAPTIONS, `cognitive_${jobId}.srt`);
  await fs.writeFile(captionsPath, makeCaptions(script, audioDuration), 'utf8');

  const listPath = path.join(jobDir, 'ffmpeg-images.txt');
  await fs.writeFile(listPath, files.slice(0, plan.scenes.length).map(f => `file '${path.join(downloadDir, f).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const outputPath = path.join(VIDEOS, `cognitive_${jobId}.mp4`);

  if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
  const secondsPerImage = Math.max(2, audioDuration / plan.scenes.length);
  const inputArgs = [];
  files.slice(0, plan.scenes.length).forEach(f => inputArgs.push('-loop','1','-t',String(secondsPerImage),'-i',path.join(downloadDir,f)));
  const filters = [];
  let prev = '[0:v]';
  for (let i = 1; i < plan.scenes.length; i++) {
    const out = `[v${i}]`;
    filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=0.45:offset=${Math.max(0, i * (secondsPerImage - 0.45)).toFixed(2)}${out}`);
    prev = out;
  }
  filters.push(`${prev}scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v]`);
  await runFFmpeg([...inputArgs,'-filter_complex',filters.join(';'),'-map','[v]','-t',String(audioDuration),'-c:v','libx264','-r','30','-pix_fmt','yuv420p','-y',outputPath]);

  const subtitled = outputPath.replace(/\.mp4$/i, '_subtitled.mp4');
  await runFFmpeg(['-y','-i',outputPath,'-i',audioPath,'-vf',`subtitles=${captionsPath.replace(/\\/g,'\\\\').replace(/:/g,'\\:')}`,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-c:a','aac','-shortest','-pix_fmt','yuv420p',subtitled]);

  console.log(`\nFINAL VIDEO: ${subtitled}`);
  console.log(`AUDIO: ${audioPath}`);
  console.log(`CAPTIONS: ${captionsPath}`);
  console.log(`THUMBNAIL: ${await findThumbnail(jobDir) || 'not supplied'}`);
  console.log(`SEO: ${path.join(jobDir, 'seo.json')}`);
  return subtitled;
}

async function findThumbnail(jobDir) {
  const files = await fs.readdir(jobDir);
  const file = files.find(f => /^thumbnail\.(png|jpe?g|webp)$/i.test(f));
  return file ? path.join(jobDir, file) : null;
}

async function main() {
  await ensureDirs();
  const command = process.argv[2] || 'help';
  if (command === 'prepare') {
    await prepare(process.argv[3] || null, process.argv[4] || null);
  } else if (command === 'assemble') {
    await assemble(process.argv[3]);
  } else {
    console.log('Cognitive Angle manual workflow');
    console.log('Prepare:  npm run cognitive:prepare -- <script.txt> [thumbnail.png]');
    console.log('Assemble: npm run cognitive:assemble -- <jobId>');
  }
}

main().catch(err => { console.error(`\nCognitive Angle pipeline failed: ${err.message}`); process.exit(1); });
