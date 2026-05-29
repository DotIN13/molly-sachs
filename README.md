# Molly Sachs

A real-time AI voice companion desktop app with desktop awareness. Molly observes your workspace, remembers what you're doing, and chats with you naturally via voice or text.

## Architecture

- **Frontend** — Electron + React 19 + TypeScript + Vite + Tailwind CSS
- **Backend** — Python FastAPI + Pipecat WebRTC pipeline
- **Voice** — Cartesia TTS, Soniox or Cartesia STT
- **LLM** — Google Gemini (3.1 Flash Lite)
- **Memory** — SQLite for messages, LanceDB for vector embeddings (optional)
- **Observer** — Periodic desktop screenshots analyzed by Gemini for context

## Setup

### Prerequisites

- Node.js 20+
- Python 3.12+
- [uvicorn](https://www.uvicorn.org/) (installed via requirements)

### Backend

```bash
cd backend
python -m venv venv
.\venv\Scripts\activate  # Windows
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in your API keys:

```env
GEMINI_API_KEY=your_gemini_key
CARTESIA_API_KEY=your_cartesia_key
SONIOX_API_KEY=your_soniox_key    # optional, for Soniox STT
DEBUG=true                         # optional, enables debug UI
```

### Frontend

```bash
cd frontend
npm install
```

### Run

```bash
cd frontend
npm run dev
```

This starts three processes via `concurrently`:
- Vite dev server (`localhost:5173`)
- Electron app (connects to Vite)
- Python backend (`localhost:8000`)

## Settings

Configure in-app via the settings gear:
- **API Config** — Gemini, Cartesia, Soniox keys
- **Speech** — Voice ID, speed, emotion, STT provider/language
- **Observers** — Screen capture interval, Gemini processing interval

## Debug Mode

Set `DEBUG=true` in `.env` to unlock the debug panel in Settings > Observers:
- **Capture Now** — Force an immediate screenshot
- **Process Now** — Force Gemini to process observations immediately
