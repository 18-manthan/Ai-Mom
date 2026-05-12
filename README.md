# MOM - Minimal AI Meeting Transcription

Local-first meeting transcription MVP.

## Stack

- Backend: FastAPI, SQLite
- Transcription: faster-whisper on CPU with `int8`
- Speaker labels: local token-free audio feature clustering
- Notes: OpenAI API, generated on demand from selectable presets
- Cleanup: OpenAI API, keeps raw transcript and adds a cleaned transcript view
- Frontend: React + Vite

## Requirements

- Python 3.11+
- Node.js 20+
- `ffmpeg` installed and available on PATH
- `OPENAI_API_KEY` for summaries

No Hugging Face token and no GPU are required.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`.

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

## API

- `POST /api/meetings` uploads MP3, WAV, MP4, or M4A
- `GET /api/meetings` lists meetings
- `GET /api/meetings/{id}` returns status, processing time, summary, and transcript
- `POST /api/meetings/{id}/cleanup` starts AI transcript cleanup after transcription
- `POST /api/meetings/{id}/summary` starts AI notes generation after transcription. Body: `{"preset":"short"}`
- `DELETE /api/meetings/{id}` deletes a meeting and its generated files

## Notes

The Phase 1 speaker labeling is fully local and token-free. It clusters audio features around transcript segments, so it is useful for an MVP but not as accurate as Pyannote-style diarization. Cleanup and notes generation are intentionally manual: upload and transcription finish first, then click **AI Cleanup** or choose a notes preset and click **Generate Notes** when you want to spend an OpenAI API call. Notes prefer the cleaned transcript when available.
