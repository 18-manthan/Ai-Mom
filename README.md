# iMann - Live Meeting Intelligence

Lightweight AI meeting assistant for botless Google Meet and Microsoft Teams live caption capture.

## Stack

- Backend: FastAPI, SQLite
- Live transcription: Chrome/Edge extension captures Google Meet and Microsoft Teams captions
- Speaker labels: preserved from meeting-platform caption metadata when available
- Notes: OpenAI or Groq API, generated on demand from selectable presets
- Cleanup: OpenAI or Groq API, keeps raw transcript and adds a cleaned transcript view
- Frontend: React + Vite

## Requirements

- Python 3.11+
- Node.js 20+
- `OPENAI_API_KEY` or `GROQ_API_KEY` for cleanup and summaries

No Whisper model, no `ffmpeg`, no Hugging Face token, and no GPU are required for the default live-caption workflow.

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
TRANSCRIPT_DIR=backend/transcripts
```

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

## Authentication

iMann includes lightweight built-in authentication for deployment:

- First signup becomes the approved **Super Admin** automatically.
- Later signups are created as **pending**.
- Pending users cannot login until the Super Admin approves them.
- Super Admin can approve or reject users from the **Super Admin** page in the dashboard.

The dashboard APIs require login. The browser extension live-capture endpoints remain available so Google Meet and Microsoft Teams caption capture can continue working from meeting pages.

## Live Capture

iMann includes a local Chrome/Edge extension for botless Google Meet and Microsoft Teams web capture.

1. Run MOM with `./start.sh`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `extension/` folder.
5. Join Google Meet or Microsoft Teams in the browser, turn on captions, then click **Start** in the iMann panel.

See `extension/README.md` for extension notes.

## API

- `GET /api/meetings` lists meetings
- `GET /api/meetings/{id}` returns status, processing time, summary, and transcript
- `POST /api/meetings/{id}/cleanup` starts AI transcript cleanup after transcription
- `POST /api/meetings/{id}/summary` starts AI notes generation after transcription. Body: `{"preset":"short"}`
- `DELETE /api/meetings/{id}` deletes a meeting and its generated files

### Live Meeting API

The browser extension sends live caption segments into iMann:

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

The default branch is optimized for lightweight deployment and live captions. Uploaded audio/video transcription with Whisper has been removed from the default install to reduce server size and CPU requirements. Cleanup and notes generation are intentionally manual: finish the live meeting first, then click **AI Cleanup** or choose a notes preset when you want to spend an AI API call. Notes prefer the cleaned transcript when available.
