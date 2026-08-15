# Cognitive Angle image generation

The Cognitive Angle pipeline keeps narration local with Kokoro and uses an external image provider for scene artwork.

## Provider order

With `IMAGE_PROVIDER=auto`, the production agent tries:

1. OpenRouter
2. Pollinations
3. OpenAI (if configured)
4. Gemini only when `ALLOW_GEMINI_IMAGE_FALLBACK=true`

The pipeline fails instead of creating placeholder images when all real providers fail.

## Recommended OpenRouter setup

OpenRouter does not currently offer a free image-generation model. The free tier is for free-variant models, while image generation uses paid image endpoints. The recommended low-cost reference-capable model is:

```env
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_IMAGE_MODEL=black-forest-labs/flux.2-klein-4b
IMAGE_PROVIDER=openrouter
IMAGE_SIZE=1280x720
```

FLUX.2 Klein 4B supports reference images through OpenRouter's `input_references` and is currently priced per output megapixel.

## Pollinations fallback

Pollinations currently requires an API key for generation:

```env
POLLINATIONS_API_KEY=sk_...
POLLINATIONS_IMAGE_MODEL=kontext
```

If both keys are present and `IMAGE_PROVIDER=auto`, OpenRouter is tried first and Pollinations is used as a fallback.

## Character reference

Put the channel character reference at a stable path, for example:

```env
CHARACTER_REFERENCE_IMAGE=C:\AI\youtube-automation-agent\data\character\character-reference.png
```

The OpenRouter provider sends the local reference as a base64 data URL. Pollinations sends the local reference as a multipart image edit. The scene prompt explicitly instructs the model to preserve the recurring character's identity, proportions, clothing language and illustration style.

## Test before running the full automation

After pulling the branch and configuring `.env`, run:

```powershell
node scripts/test-image-provider.js
```

A successful test produces:

```text
data\assets\image-provider-test.png
```

Do not start daily automation until this test succeeds.
