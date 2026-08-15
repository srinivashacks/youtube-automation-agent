import argparse
import os
import re
import numpy as np
import soundfile as sf
from kokoro import KPipeline


def split_text(text, max_chars=2800):
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks = []
    current = ""
    for paragraph in paragraphs:
        candidate = f"{current}\n\n{paragraph}" if current else paragraph
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            chunks.append(current)
        while len(paragraph) > max_chars:
            cut = paragraph.rfind(" ", 0, max_chars)
            if cut < max_chars // 2:
                cut = max_chars
            chunks.append(paragraph[:cut].strip())
            paragraph = paragraph[cut:].strip()
        current = paragraph
    if current:
        chunks.append(current)
    return chunks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--voice", default=os.getenv("KOKORO_VOICE", "am_michael"))
    parser.add_argument("--speed", type=float, default=float(os.getenv("KOKORO_SPEED", "1.0")))
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        raise ValueError("Kokoro input text is empty")

    pipeline = KPipeline(lang_code=os.getenv("KOKORO_LANG", "a"))
    audio_chunks = []
    for index, chunk in enumerate(split_text(text)):
        print(f"KOKORO_CHUNK {index + 1}", flush=True)
        generator = pipeline(chunk, voice=args.voice, speed=args.speed)
        for _, _, audio in generator:
            audio_chunks.append(np.asarray(audio, dtype=np.float32))

    if not audio_chunks:
        raise RuntimeError("Kokoro produced no audio")

    audio = np.concatenate(audio_chunks)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    sf.write(args.output, audio, 24000, subtype="PCM_16")
    print(f"KOKORO_DONE {args.output}", flush=True)


if __name__ == "__main__":
    main()
