# Cognitive Angle manual production workflow

This workflow is intentionally different from the stock daily generator. You provide the finished script and thumbnail. The local pipeline handles visual planning, SEO, Kokoro narration, subtitles and final video assembly.

## What you provide

- A finished English script: `.txt` or Markdown converted to `.txt`
- A finished YouTube thumbnail: `.png`, `.jpg` or `.webp`
- Your recurring 2D character available in Google Flow as a character/reference

## What the pipeline produces

1. SEO metadata from the script: title, alternatives, description, tags, hashtags and chapter suggestions.
2. A visual storyboard with 10-16 scene prompts for an 8-12 minute video (fewer for shorter videos).
3. `flow-prompts.txt` for line-by-line Flow extensions.
4. `flow-prompts.csv` for extensions that support CSV queues.
5. Local Kokoro narration using `am_michael`.
6. SRT subtitles.
7. A 1080p MP4 assembled from the downloaded Flow images and local narration.
8. The supplied thumbnail is copied into the production job and is never regenerated.

## Commands

Prepare a job:

```powershell
npm run cognitive:prepare -- C:\path\to\script.txt C:\path\to\thumbnail.png
```

The command prints the SEO output and all visual prompts. It creates a job under `data/flow/<jobId>/`.

Generate images in Google Flow using the prompt queue. The generated files must be downloaded in scene order as `image_001.png`, `image_002.png`, etc. Put them into:

```text
data/flow/<jobId>/downloads/
```

Then assemble:

```powershell
npm run cognitive:assemble -- <jobId>
```

The final video is written under `data/videos/` and subtitles under `data/captions/`.

## Google Flow

Google Flow supports image generation with image/character references. If you have created a named character in the Flow project, keep that character available while generating the queue. The prompt planner is designed to preserve the same recurring Cognitive Angle character across scenes.

A Chrome Flow queue extension can be used as the browser-side worker. The repository does not automate Google account sessions or scrape Flow itself. This keeps the Node application independent of Google's UI changes. Use an extension that supports one-prompt-per-line or CSV import and automatic downloads. Always verify the extension's current permissions and terms before installing it.

## Strict no-paid-image rule

This manual workflow does not call Gemini image generation, OpenRouter image generation, OpenAI image generation or Replicate. Google Flow generation happens in the user's browser account and therefore follows whatever Flow access/credits that account has. Kokoro and FFmpeg remain local.

## Recommended folder mapping

```text
data/
  cognitive-input/
  flow/
    <jobId>/
      script.txt
      seo.json
      scene-plan.json
      flow-prompts.txt
      flow-prompts.csv
      thumbnail.png
      downloads/
        image_001.png
        image_002.png
        ...
  audio/
  captions/
  videos/
```
