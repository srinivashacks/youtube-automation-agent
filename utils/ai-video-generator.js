const OpenAI = require('openai');
const Replicate = require('replicate');
const fs = require('fs').promises;
const path = require('path');
const { pathToFileURL } = require('url');
const axios = require('axios');
const FormData = require('form-data');
const { Logger } = require('./logger');
const { runFFmpeg, checkFFmpeg, ffmpegInstallHint } = require('./ffmpeg');
const { runKokoro } = require('./kokoro-tts');

class AIVideoGenerator {
  constructor(credentials = {}) {
    this.logger = new Logger('AIVideoGenerator');
    const openaiKey = credentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = credentials.replicate?.apiKey || process.env.REPLICATE_API_KEY;
    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    this.openRouterKey = credentials.openrouter?.apiKey || process.env.OPENROUTER_API_KEY || '';
    this.pollinationsKey = credentials.pollinations?.apiKey || process.env.POLLINATIONS_API_KEY || '';

    if (openaiKey) this.openai = new OpenAI({ apiKey: openaiKey });
    if (replicateKey) this.replicate = new Replicate({ auth: replicateKey });

    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.gemini = new GoogleGenAI({ apiKey: geminiKey });
        this.logger.info('Gemini media service initialized');
      } catch (error) {
        this.logger.warn('Gemini media service unavailable:', error.message);
      }
    }

    this.characterReference = process.env.CHARACTER_REFERENCE_IMAGE || '';
    this.kokoroVoice = process.env.KOKORO_VOICE || 'am_michael';
    this.imageProvider = this.selectImageProvider();
    this.logger.info(`Local Kokoro TTS configured (voice: ${this.kokoroVoice})`);
    this.logger.info(`Image provider configured: ${this.imageProvider}`);
    if (this.characterReference) this.logger.info(`Character reference configured: ${this.characterReference}`);
  }

  selectImageProvider() {
    const requested = (process.env.IMAGE_PROVIDER || 'auto').toLowerCase();
    const available = new Set();
    if (this.openRouterKey) available.add('openrouter');
    if (this.pollinationsKey) available.add('pollinations');
    if (this.openai) available.add('openai');
    if (this.gemini) available.add('gemini');

    if (requested !== 'auto') {
      if (!available.has(requested)) {
        throw new Error(`IMAGE_PROVIDER=${requested} is configured but its API key/client is missing`);
      }
      return requested;
    }

    // Prefer OpenRouter because it provides a single switchable image API and supports local reference images.
    if (available.has('openrouter')) return 'openrouter';
    if (available.has('pollinations')) return 'pollinations';
    if (available.has('openai')) return 'openai';
    if (available.has('gemini')) return 'gemini';
    return 'none';
  }

  async generateTTSAudio(text, outputPath) {
    this.logger.info(`Generating local Kokoro narration (${this.kokoroVoice})...`);
    return runKokoro(text, outputPath, this.logger);
  }

  async generateVisualAssets(prompt, style = 'cognitive-angle', count = 1) {
    this.logger.info(`Generating ${count} character-aware visual asset(s) with ${this.imageProvider}`);
    const localPaths = [];
    for (let i = 0; i < count; i++) {
      const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
      await this.generateImage(this.enhanceVisualPrompt(prompt, style), imagePath);
      localPaths.push(imagePath);
    }
    return localPaths;
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    const providers = this.getImageProviderOrder();
    let lastError;
    for (const provider of providers) {
      try {
        this.logger.info(`Generating image with ${provider}...`);
        if (provider === 'openrouter') return await this.generateOpenRouterImage(prompt, imagePath);
        if (provider === 'pollinations') return await this.generatePollinationsImage(prompt, imagePath);
        if (provider === 'openai') return await this.generateOpenAIImage(prompt, imagePath);
        if (provider === 'gemini') return await this.generateGeminiImage(prompt, imagePath);
      } catch (error) {
        lastError = error;
        this.logger.warn(`${provider} image generation failed: ${error.message}`);
        if (providers.length > 1) this.logger.info(`Trying next image provider...`);
      }
    }
    throw new Error(`All image providers failed. ${lastError?.message || 'No image provider configured.'}`);
  }

  getImageProviderOrder() {
    const requested = (process.env.IMAGE_PROVIDER || 'auto').toLowerCase();
    if (requested !== 'auto') return [requested];
    const providers = [];
    if (this.openRouterKey) providers.push('openrouter');
    if (this.pollinationsKey) providers.push('pollinations');
    // Keep paid OpenAI and Gemini as optional emergency fallbacks only.
    if (this.openai) providers.push('openai');
    if (this.gemini && process.env.ALLOW_GEMINI_IMAGE_FALLBACK === 'true') providers.push('gemini');
    return providers;
  }

  async generateOpenRouterImage(prompt, imagePath) {
    const model = process.env.OPENROUTER_IMAGE_MODEL || 'black-forest-labs/flux.2-klein-4b';
    const payload = {
      model,
      prompt,
      n: 1,
      size: process.env.IMAGE_SIZE || '1280x720',
      output_format: 'png'
    };

    if (this.characterReference) {
      const reference = await fs.readFile(this.characterReference);
      const ext = path.extname(this.characterReference).toLowerCase();
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      payload.input_references = [{
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${reference.toString('base64')}` }
      }];
    }

    const response = await axios.post('https://openrouter.ai/api/v1/images', payload, {
      headers: {
        Authorization: `Bearer ${this.openRouterKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Cognitive Angle YouTube Automation'
      },
      timeout: 180000
    });

    const image = response.data?.data?.[0];
    if (!image) throw new Error(`OpenRouter returned no image: ${JSON.stringify(response.data).slice(0, 500)}`);
    if (image.b64_json) {
      await fs.writeFile(imagePath, Buffer.from(image.b64_json, 'base64'));
    } else if (image.url) {
      await this.downloadImage(image.url, imagePath);
    } else {
      throw new Error('OpenRouter returned neither b64_json nor url');
    }
    this.logger.info(`OpenRouter image generated: ${imagePath}`);
    return imagePath;
  }

  async generatePollinationsImage(prompt, imagePath) {
    const model = process.env.POLLINATIONS_IMAGE_MODEL || 'kontext';
    const form = new FormData();
    form.append('image', await fs.readFile(this.characterReference), {
      filename: path.basename(this.characterReference),
      contentType: this.characterReference.toLowerCase().endsWith('.jpg') || this.characterReference.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
    });
    form.append('prompt', prompt);
    form.append('model', model);
    form.append('size', process.env.IMAGE_SIZE || '1280x720');
    form.append('response_format', 'b64_json');

    const response = await axios.post('https://gen.pollinations.ai/v1/images/edits', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${this.pollinationsKey}` },
      timeout: 180000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    const image = response.data?.data?.[0];
    if (!image?.b64_json) throw new Error(`Pollinations returned no image: ${JSON.stringify(response.data).slice(0, 500)}`);
    await fs.writeFile(imagePath, Buffer.from(image.b64_json, 'base64'));
    this.logger.info(`Pollinations image generated: ${imagePath}`);
    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
    const parts = [];
    if (this.characterReference) {
      const reference = await fs.readFile(this.characterReference);
      const ext = path.extname(this.characterReference).toLowerCase();
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      parts.push({ inlineData: { mimeType, data: reference.toString('base64') } });
      parts.push({ text: `${prompt}\nUse the supplied character reference as the SAME recurring character. Preserve face, hair, body proportions, clothing language and 2D art style. Change only the pose, expression, setting and action needed by the scene. Do not redesign the character.` });
    } else {
      parts.push({ text: prompt });
    }

    const response = await this.gemini.models.generateContent({ model, contents: [{ role: 'user', parts }] });
    const responseParts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = responseParts.find(part => part.inlineData?.data);
    if (!imagePart) throw new Error('Gemini image generation returned no image data');
    await fs.writeFile(imagePath, Buffer.from(imagePart.inlineData.data, 'base64'));
    return imagePath;
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
      prompt,
      n: 1,
      size: '1536x1024',
      quality: 'high'
    });
    if (response.data[0].b64_json) {
      await fs.writeFile(imagePath, Buffer.from(response.data[0].b64_json, 'base64'));
    } else if (response.data[0].url) {
      await this.downloadImage(response.data[0].url, imagePath);
    } else {
      throw new Error('Image provider returned no image');
    }
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const characterInstruction = this.characterReference
      ? 'Use the supplied character reference as the same recurring Cognitive Angle character. Preserve identity, face, hair, proportions, clothing language and illustration style; change only pose, expression, action and setting.'
      : 'Use a consistent recurring 2D Cognitive Angle character design.';
    return `${prompt}. Visual style: clean modern 2D educational illustration for the YouTube channel Cognitive Angle. ${characterInstruction} Expressive but natural face, readable composition, cinematic 16:9 framing, subtle depth, polished digital illustration, no text, no watermark.`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({ method: 'GET', url, responseType: 'arraybuffer', timeout: 180000 });
    await fs.writeFile(outputPath, response.data);
  }

  async generateVideo(script, visualAssets, audioPath, outputPath) {
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    return this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating Cognitive Angle slideshow video...');
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const slidesDir = path.join(path.dirname(outputPath), 'slides');
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const imageAssets = await this.filterImageAssets(visualAssets);
      await page.setContent(this.createSlideshowHTML(script, imageAssets));
      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
      await page.waitForTimeout(500);
      const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
      await fs.mkdir(slidesDir, { recursive: true });
      const stills = [];
      for (let i = 0; i < slideCount; i++) {
        await page.evaluate(index => document.querySelectorAll('.slide').forEach((slide, s) => slide.classList.toggle('active', s === index)), i);
        const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: stillPath });
        stills.push(stillPath);
      }
      const duration = await this.getAudioDuration(audioPath) || this.calculateScriptDuration(script);
      const visualPath = outputPath.replace(/\.mp4$/i, '_visual.mp4');
      await this.renderSlidesToVideo(stills, duration, visualPath);
      await this.addAudioToVideo(visualPath, audioPath, outputPath);
      return outputPath;
    } finally {
      await browser.close().catch(() => {});
      await this.cleanupDirectory(slidesDir);
    }
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath) {
    if (!stills.length) throw new Error('No visual assets were generated');
    const fade = 0.5;
    const perSlide = Math.max(2, totalDuration / stills.length);
    const args = ['-y'];
    for (const still of stills) args.push('-loop', '1', '-t', perSlide.toFixed(2), '-framerate', '30', '-i', still);
    if (stills.length === 1) {
      args.push('-vf', 'format=yuv420p', '-c:v', 'libx264', '-r', '30', videoPath);
      await runFFmpeg(args);
      return videoPath;
    }
    const filters = [];
    let prev = '[0:v]';
    for (let i = 1; i < stills.length; i++) {
      const out = `[v${i}]`;
      const offset = (i * (perSlide - fade)).toFixed(2);
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
      prev = out;
    }
    filters.push(`${prev}format=yuv420p[vfinal]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vfinal]', '-c:v', 'libx264', '-r', '30', videoPath);
    await runFFmpeg(args);
    return videoPath;
  }

  async filterImageAssets(visualAssets = []) {
    const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];
    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !extensions.has(path.extname(asset).toLowerCase())) continue;
      try { await fs.access(asset); images.push(pathToFileURL(asset).href); } catch (_) {}
    }
    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    const title = this.escapeHTML(script.title || 'Cognitive Angle');
    const slides = [];
    slides.push(`<div class="slide active">${visualAssets[0] ? `<img src="${visualAssets[0]}"/>` : ''}<div><h1>${title}</h1></div></div>`);
    if (script.mainContent?.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const asset = visualAssets[Math.min(index + 1, visualAssets.length - 1)];
        slides.push(`<div class="slide">${asset ? `<img src="${asset}"/>` : ''}<div><h2>${this.escapeHTML(section.title || '')}</h2></div></div>`);
      });
    }
    slides.push('<div class="slide"><div><h2>Cognitive Angle</h2><p>Think better. Live better. Build better.</p></div></div>');
    return `<!doctype html><html><head><style>
      html,body{margin:0;width:1920px;height:1080px;background:#111;overflow:hidden;font-family:Arial,sans-serif}
      .slide{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;background:#111}
      .slide.active{opacity:1}.slide img{position:absolute;width:100%;height:100%;object-fit:cover}.slide:after{content:'';position:absolute;inset:0;background:rgba(0,0,0,.22)}
      .slide>div{position:relative;z-index:2;text-align:center;color:white;padding:60px;text-shadow:0 3px 15px rgba(0,0,0,.7)}
      h1{font-size:76px;max-width:1500px;margin:0}h2{font-size:62px;max-width:1500px;margin:0}p{font-size:36px}
    </style></head><body>${slides.join('')}</body></html>`;
  }

  escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  async getAudioDuration(audioPath) {
    try {
      const { execFile } = require('child_process');
      const ffmpeg = require('./ffmpeg');
      const executable = await ffmpeg.resolveFFmpegPath();
      return await new Promise(resolve => {
        execFile(executable, ['-i', audioPath], { windowsHide: true }, (_, stdout, stderr) => {
          const match = `${stdout}\n${stderr}`.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (!match) return resolve(0);
          resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
        });
      });
    } catch (_) { return 0; }
  }

  calculateScriptDuration(script) {
    const words = JSON.stringify(script || {}).replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean).length;
    return Math.max(30, Math.ceil((words / 150) * 60));
  }

  async addAudioToVideo(videoPath, audioPath, outputPath) {
    const muxPath = videoPath === outputPath ? outputPath.replace(/\.mp4$/i, '_muxed.mp4') : outputPath;
    await runFFmpeg(['-y', '-i', videoPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-shortest', muxPath]);
    if (muxPath !== outputPath) await fs.rename(muxPath, outputPath);
    return outputPath;
  }

  async generateThumbnail(script, style = 'cognitive-angle') {
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);
    await this.generateImage(`YouTube thumbnail for "${script.title || 'Cognitive Angle'}". ${style}. Strong visual hierarchy, clean 2D educational character, expressive face, bold composition, no tiny text.`, thumbnailPath);
    return { path: thumbnailPath, dimensions: { width: 1280, height: 720 }, fileSize: await this.getFileSize(thumbnailPath) };
  }

  async getFileSize(filePath) { return (await fs.stat(filePath)).size; }

  async downloadVideo(url, outputPath) {
    const response = await axios({ method: 'GET', url, responseType: 'arraybuffer' });
    await fs.writeFile(outputPath, response.data);
    return outputPath;
  }

  async cleanupDirectory(dirPath) {
    try { for (const file of await fs.readdir(dirPath)) await fs.unlink(path.join(dirPath, file)); await fs.rmdir(dirPath); } catch (_) {}
  }
}

module.exports = { AIVideoGenerator };
