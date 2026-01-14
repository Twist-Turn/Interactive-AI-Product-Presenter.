# EcoBike X1 Virtual Showroom - System Architecture

A real-time voice-enabled AI agent with a custom-rendered avatar (Alex) that responds to user speech, lip-syncs live audio, and uses a grounded fact sheet with function calling (`sign_up`, `send_pricing_email`).

## Tech Stack & Models
- STT: OpenAI GPT-4o-transcribe (`detect_language=True`) for fast, multilingual transcription.
- LLM: OpenAI GPT-4o-mini (temperature 0.2) for grounded, low-latency responses + function calls.
- TTS: OpenAI GPT-4o-mini-tts, voice `ash`, instructions for concise professional tone.
- VAD: Silero VAD for start/stop detection.
- Turn Detection: MultilingualModel when available (interruption support).
- Noise Cancellation: LiveKit BVC.
- Transport: LiveKit (WebRTC) for sub-100ms media.

## Latency Strategy
1) Preemptive generation (`preemptive_generation=True`) so LLM starts mid-utterance.  
2) Streaming TTS and STT; VAD boundaries avoid dead air.  
3) Lightweight client lip-sync via Web Audio RMS + smoothing (`0.8 * prev + 0.2 * current`).  
4) Dual-room media (user audio vs. avatar video) to avoid contention.

## Data Flow (high level)
User mic → LiveKit room (audio) → Silero VAD → GPT-4o-transcribe → topic/sentiment tagging → GPT-4o-mini (+ fact sheet + tools) → OpenAI TTS → LiveKit room (agent audio) → browser audio + Web Audio RMS → canvas avatar lip-sync video → LiveKit avatar room → user sees animated avatar.

Function calls:
- `sign_up(email?)` → logs to `agent/logs/signups.jsonl`.
- `send_pricing_email(email?, notes?)` → logs to `agent/logs/pricing_emails.jsonl` (demo only; no real email).

## Run It Locally
### Prereqs
- Python 3.10+, Node.js 18+
- LiveKit project (URL + API key/secret)
- OpenAI key (for STT/LLM/TTS). Deepgram/ElevenLabs optional if you swap models.

### 1) Agent (Python)
```bash
cd agent
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt

cp .env.example .env               # set LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET + OpenAI keys
python agent.py download-files     # fetch VAD/turn/noise models
python agent.py start              # or: python agent.py dev
```

### 2) Web (Next.js)
```bash
cd ../web
npm install
cp .env.example .env.local         # set NEXT_PUBLIC_LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
# optional: NEXT_PUBLIC_DEFAULT_ROOM to force a room name matching the agent
npm run dev
```
Open http://localhost:3000, set the room (must match the agent’s room), click **Connect & Talk**, allow mic, and speak.

## Logs & Outputs
- Interaction logs: `agent/logs/interaction_logs.jsonl`
- Sign-ups: `agent/logs/signups.jsonl`
- Pricing email requests: `agent/logs/pricing_emails.jsonl` (demo; not actually sent)

## Key Settings (agent/agent.py)
- LLM: `openai.LLM(model="gpt-4o-mini", temperature=0.2)`
- STT: `openai.STT(model="gpt-4o-transcribe", detect_language=True)`
- TTS: `openai.TTS(model="gpt-4o-mini-tts", voice="ash")`
- VAD: `silero.VAD.load()`
- Turn detection: `MultilingualModel()` when available
- Preemptive generation: `preemptive_generation=True`

## Future Enhancements
- Swap in branded TTS voices
- Emotion-driven facial cues
- CRM integration for sign-ups/pricing emails
- Move logs to a DB for analytics
