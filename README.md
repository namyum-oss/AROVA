# AROVA

AROVA is a local-first healthcare documentation prototype for ASHA workers. It supports patient profiles, visit notes, reminders, local persistence, and live Gnani Prisma v3.0 speech-to-text.

## Run it

1. Install Node.js 22.13 or newer (the API uses Node's built-in SQLite module).
2. Run `npm install` once in this folder.
3. Run `npm run dev`.
4. Open the Vite URL shown in the terminal (usually `http://localhost:5173`).
5. Allow microphone access when the browser asks.

The dev command starts the Vite frontend and a local Express API on `127.0.0.1:3001`. Patient profiles, visits, and reminders are stored in the SQLite database at `server/arova.sqlite`. On the first API start, existing `server/data.json` data is imported into SQLite; the JSON file is retained as a backup and is no longer used for ongoing writes. The browser keeps a local copy and queues changes if the local API is unavailable, then retries when it reconnects.

## Gnani Prisma STT

The backend `.env` contains `GNANI_API_KEY` and is excluded from Git. The frontend never receives the key. The local API proxies `/ws/stt` to Gnani's Prisma v3.0 streaming endpoint, attaching the API key server-side. The browser streams mono 16 kHz PCM frames at real-time cadence; a separate complete compressed WebM recording remains available for playback. Transcribed segments appear in visit notes and must be reviewed and corrected by the ASHA worker before saving.

Choose one transcription language in Settings. AROVA sends that single language code to Gnani and only adds segments whose returned detected language matches the chosen code. Browser microphone access requires a secure context (localhost works for local development). Transcription requires an internet connection and working Gnani credentials.

## Render backend

Configure the Render web service with `npm ci` as its build command and `npm run api` as its start command. Set `GEMINI_API_KEY` in the service environment; `GNANI_API_KEY` is optional and enables speech transcription. Use `/api/health` as the health-check path. The backend listens on Render's `PORT` and public interface when that variable is set, and retains the local `API_PORT` behavior otherwise.

The SQLite database is stored in `server/arova.sqlite`. Render deployments need persistent storage mounted for that directory (or an external database) to retain records across restarts and deploys.

## Working features

- Create, search, edit, and delete patient profiles. Patient records include a dynamic checklist of blank profile fields to review.
- Record, edit, and delete visit notes; capture name/age from the patient profile and a measured temperature (°C) in a must-check table. Temperature-missing visits save as drafts and can be completed later from the report.
- Create, edit, and delete reminders.
- Print-ready visit reports are generated from each saved visit and contain the saved transcript and verified profile/visit fields only.
- Actual microphone recording, complete-recording playback, and live Prisma v3.0 speech transcription.
- Browser online/offline status and local API connection status.
- SQLite-backed local API storage, persistent browser cache, and automatic retry after API connectivity returns.
- Settings for worker name and primary village.
- Responsive dashboard, patient directory, community record counts, and reminders.

## Limits

- Audio is sent to Gnani for transcription when you start live transcription. This was explicitly enabled for the prototype. It is not saved to the local API or attached to a saved visit.
- Timbre text-to-speech, remote PostgreSQL synchronization, and frontend hosting are not configured. Reports are formatted saved records, not AI summaries.
- Sample profiles are synthetic. Do not enter real patient data into this prototype.
- The community view reports record counts only; AROVA does not diagnose or recommend treatment.
