# MOM - Minimal AI Meeting Transcription

Local-first meeting transcription MVP.

## Stack

- Backend: FastAPI, SQLite
- Transcription: faster-whisper on CPU with `int8`
- Speaker labels: local token-free audio feature clustering
- Notes: OpenAI or Groq API, generated on demand from selectable presets
- Cleanup: OpenAI or Groq API, keeps raw transcript and adds a cleaned transcript view
- Frontend: React + Vite

## Requirements

- Python 3.11+
- Node.js 20+
- `ffmpeg` installed and available on PATH
- `OPENAI_API_KEY` or `GROQ_API_KEY` for cleanup and summaries

No Hugging Face token and no GPU are required.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set your AI provider and API key in `.env`.

OpenAI:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-5-mini
```

Groq:

```bash
AI_PROVIDER=groq
GROQ_API_KEY=your_groq_key
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_BASE_URL=https://api.groq.com/openai/v1
```

By default, generated runtime files stay under `backend/`:

```bash
DATABASE_URL=sqlite:///./backend/mom.db
UPLOAD_DIR=backend/uploads
TRANSCRIPT_DIR=backend/transcripts
```

For better Hindi + English accuracy, change this in `.env` if your CPU/RAM can handle it:

```bash
WHISPER_MODEL=medium
```

## Speed Tuning

CPU transcription speed depends mostly on model size and beam size.

Fastest local mode:

```bash
WHISPER_MODEL=base
WHISPER_BEAM_SIZE=1
WHISPER_COMPUTE_TYPE=int8
ENABLE_DIARIZATION=false
```

Balanced MVP mode:

```bash
WHISPER_MODEL=small
WHISPER_BEAM_SIZE=1
WHISPER_COMPUTE_TYPE=int8
ENABLE_DIARIZATION=true
```

Better accuracy, slower CPU mode:

```bash
WHISPER_MODEL=medium
WHISPER_BEAM_SIZE=1
WHISPER_COMPUTE_TYPE=int8
ENABLE_DIARIZATION=true
```

If meetings are mostly one language, setting `WHISPER_LANGUAGE=en` or `WHISPER_LANGUAGE=hi` can avoid language auto-detection and slightly speed up the run. Keep it blank for mixed Hindi + English meetings.

## Run Backend

```bash
uvicorn backend.app.main:app --reload
```

Backend runs on `http://localhost:8000`.

## Run Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

## Run Both

```bash
./start.sh
```

This starts the backend and frontend, then opens the UI at `http://127.0.0.1:5173`.

Optional overrides:

```bash
BACKEND_PORT=8001 FRONTEND_PORT=5174 ./start.sh
OPEN_UI=false ./start.sh
```

## Google Meet Live Capture

MOM includes a local Chrome/Edge extension scaffold for botless Google Meet capture.

1. Run MOM with `./start.sh`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `extension/` folder.
5. Join Google Meet in the browser, turn on captions, then click **Start** in the MOM panel.

See `extension/README.md` for extension notes.

## API

- `POST /api/meetings` uploads MP3, WAV, MP4, or M4A
- `GET /api/meetings` lists meetings
- `GET /api/meetings/{id}` returns status, processing time, summary, and transcript
- `POST /api/meetings/{id}/cleanup` starts AI transcript cleanup after transcription
- `POST /api/meetings/{id}/summary` starts AI notes generation after transcription. Body: `{"preset":"short"}`
- `DELETE /api/meetings/{id}` deletes a meeting and its generated files

### Live Meeting API

Phase 1 for botless capture lets a browser extension send live caption segments into MOM:

- `POST /api/live-meetings` starts a live meeting. Body: `{"title":"Weekly Sync","source":"google_meet"}`
- `POST /api/live-meetings/{id}/segments` appends or updates a caption segment.
- `POST /api/live-meetings/{id}/finish` marks the live meeting as completed so cleanup and notes can run.

Segment body:

```json
{
  "speaker": "Amit",
  "text": "Let's finalize the roadmap today.",
  "start": 12.4,
  "end": 16.8,
  "external_id": "caption-line-123",
  "source": "google_meet",
  "is_final": true
}
```

`external_id` is optional, but useful for live captions because meeting apps often update the same caption line while someone is still speaking.

## Notes

The Phase 1 speaker labeling is fully local and token-free. It clusters audio features around transcript segments, so it is useful for an MVP but not as accurate as Pyannote-style diarization. Cleanup and notes generation are intentionally manual: upload and transcription finish first, then click **AI Cleanup** or choose a notes preset and click **Generate Notes** when you want to spend an AI API call. Notes prefer the cleaned transcript when available.
