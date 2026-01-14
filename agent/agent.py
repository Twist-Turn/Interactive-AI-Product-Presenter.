import json
import os
import re
import uuid
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

from livekit import agents
from livekit.agents import AgentSession, Agent, RunContext, function_tool
from livekit.agents.voice import room_io

from livekit.plugins import noise_cancellation, silero
from livekit.plugins import openai

# Turn detector import can vary by version; make it optional.
try:
    from livekit.plugins.turn_detector.multilingual import MultilingualModel  # type: ignore
except Exception:
    MultilingualModel = None  # type: ignore

load_dotenv()


@dataclass
class InteractionLog:
    session_id: str
    product_name: str
    user_sentiment: str = "neutral"  # positive | neutral | negative
    key_questions_asked: Optional[List[str]] = None
    conversion_triggered: bool = False
    follow_up_needed: bool = False

    def to_json(self) -> str:
        d = asdict(self)
        d["key_questions_asked"] = d["key_questions_asked"] or []
        return json.dumps(d, ensure_ascii=False)


def load_fact_sheet(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def fact_sheet_to_bullets(facts: Dict[str, Any]) -> str:
    lines: List[str] = []
    for k, v in facts.items():
        if isinstance(v, (dict, list)):
            v = json.dumps(v, ensure_ascii=False)
        lines.append(f"- {k}: {v}")
    return "\n".join(lines)


def extract_topics(text: str) -> List[str]:
    t = text.lower()
    candidates: List[str] = []
    rules = [
        ("gps", r"\bgps\b|tracking|anti-theft"),
        ("battery life", r"battery|range|km\b|charge"),
        ("charging", r"charge|charging|charger"),
        ("motor", r"motor|torque|watt"),
        ("warranty", r"warranty|guarantee"),
        ("shipping", r"shipping|delivery|ship"),
        ("returns", r"return|refund"),
        ("price", r"price|cost|buy|purchase|sign up|checkout"),
    ]
    for topic, pat in rules:
        if re.search(pat, t):
            candidates.append(topic)

    # Dedup while preserving order
    seen = set()
    out: List[str] = []
    for x in candidates:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out[:5]


class ConsoleUI:
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RESET = "\033[0m"

    @classmethod
    def banner(cls, product: str, session_id: str) -> None:
        print(f"{cls.CYAN}=== AI Product Presenter ==={cls.RESET}")
        print(f"{cls.GREEN}Product:{cls.RESET} {product}")
        print(f"{cls.GREEN}Session:{cls.RESET} {session_id}")
        print(f"{cls.YELLOW}Tip:{cls.RESET} Talk to the agent — it will speak back. Ask for range, charging, shipping, or warranty.")

    @classmethod
    def status(cls, message: str) -> None:
        print(f"{cls.CYAN}>>{cls.RESET} {message}")


class ProductPresenterAgent(Agent):
    """
    Alex: product-only answers from a fact sheet.
    Includes function calling for "sign_up" and "send_pricing_email".
    """

    def __init__(self, facts: Dict[str, Any], log: InteractionLog):
        self.facts = facts
        self.log = log

        product_name = facts.get("product_name", "the product")
        kb = fact_sheet_to_bullets(facts)

        instructions = f"""
You are Alex, a professional product expert in a virtual showroom.

Voice & tone:
- Warm, upbeat, confident. Sound natural (short sentences, light contractions).
- Keep replies to 1–3 concise sentences, then end with a short follow-up question or offer (e.g., "Want a quick take on range or warranty?").
- Use quick bullets only when listing specs.

Rules:
- The system already greets at the start of the call. Do NOT repeat the full greeting unless asked.
- You are ONLY trained on the Product Fact Sheet below. Do not guess or invent details.
- Prioritize the user's ask first; then offer one relevant next step (range, charging, motor, shipping, or warranty).
- If the user asks something not in the fact sheet, say:
  "I'm specifically trained on our {product_name} features. I'm not sure about that, but I can tell you about our motor, battery, shipping, or warranty!"
- If the user hesitates, propose a quick 20-second highlights tour.
- If the user expresses intent to buy/sign up/checkout, call the tool `sign_up`.
- If the user asks for pricing info to be emailed, call the tool `send_pricing_email`.
- Match numeric wording exactly from the fact sheet. If unsure, say you don't have that detail.
- Adjust tone to sentiment: reassure if frustrated; celebrate if excited.

Product Fact Sheet:
{kb}
""".strip()

        super().__init__(instructions=instructions)

    @function_tool(name="sign_up", description="Log the user's interest to buy/sign up for the product.")
    async def sign_up(self, context: RunContext, email: Optional[str] = None) -> Dict[str, Any]:
        self.log.conversion_triggered = True

        payload = {
            "session_id": self.log.session_id,
            "product_name": self.log.product_name,
            "email": email,
        }
        os.makedirs("logs", exist_ok=True)
        with open("logs/signups.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

        await context.session.say(
            "Perfect — I can help with that. If you share your email, I’ll log your interest and send next steps.",
            allow_interruptions=False,
        )
        return {"ok": True}

    @function_tool(name="send_pricing_email", description="Send the pricing sheet to the user via email.")
    async def send_pricing_email(self, context: RunContext, email: Optional[str] = None, notes: Optional[str] = None) -> Dict[str, Any]:
        """Log a pricing email request; in this demo we just persist it."""
        payload = {
            "session_id": self.log.session_id,
            "product_name": self.log.product_name,
            "email": email,
            "notes": notes,
        }
        os.makedirs("logs", exist_ok=True)
        with open("logs/pricing_emails.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

        await context.session.say(
            "I can email you pricing details. What’s the best email to use?",
            allow_interruptions=False,
        )
        self.log.follow_up_needed = True
        return {"ok": True, "email": email}


async def entrypoint(ctx: agents.JobContext):
    await ctx.connect()
    ConsoleUI.status("Connected. Loading product data...")

    fact_path = os.getenv("PRODUCT_FACT_SHEET", "./product_fact_sheet.json")
    facts = load_fact_sheet(fact_path)
    product_name = facts.get("product_name", "Unknown Product")

    session_id = f"uuid-{uuid.uuid4()}"
    log = InteractionLog(session_id=session_id, product_name=product_name, key_questions_asked=[])
    ConsoleUI.banner(product_name, session_id)

    # Build the session kwargs so we can optionally include turn detection.
    session_kwargs: Dict[str, Any] = dict(
        vad=silero.VAD.load(),
        preemptive_generation=True,

        # OpenAI STT (set detect_language=True so German/etc doesn't get forced into "en")
        stt=openai.STT(model="gpt-4o-transcribe", detect_language=True),

        # OpenAI LLM
        llm=openai.LLM(model="gpt-4o-mini", temperature=0.2),

        # OpenAI TTS
        tts=openai.TTS(
            model="gpt-4o-mini-tts",
            voice="ash",
            instructions="Speak clearly, friendly, and professional. Keep it concise."
        ),
    )

    if MultilingualModel is not None:
        session_kwargs["turn_detection"] = MultilingualModel()

    session = AgentSession(**session_kwargs)

    @session.on("user_input_transcribed")
    def _on_user_input(ev):
        transcript = getattr(ev, "transcript", "") or ""
        if not isinstance(transcript, str):
            transcript = str(transcript)

        for t in extract_topics(transcript):
            if t not in (log.key_questions_asked or []):
                log.key_questions_asked.append(t)

        low = transcript.lower()
        if any(w in low for w in ["love", "great", "awesome", "perfect", "thanks"]):
            log.user_sentiment = "positive"
        if any(w in low for w in ["bad", "hate", "terrible", "angry", "refund"]):
            log.user_sentiment = "negative"

    @session.on("close")
    def _on_close(_ev):
        os.makedirs("logs", exist_ok=True)
        with open("logs/interaction_logs.jsonl", "a", encoding="utf-8") as f:
            f.write(log.to_json() + "\n")
        print("INTERACTION_LOG:", log.to_json())
        ConsoleUI.status("Session closed. Log persisted.")

    agent = ProductPresenterAgent(facts=facts, log=log)

    await session.start(
        room=ctx.room,
        agent=agent,
        room_options=room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=noise_cancellation.BVC(),
            ),
        ),
    )
    ConsoleUI.status("Voice agent is live. Start talking when you're ready.")

    # Required greeting (make it uninterruptible so you always hear it)
    await session.say(
        f"Hi! I'm Alex, your guide for the {product_name}. What can I help you discover today?",
        allow_interruptions=False,
    )


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(
            entrypoint_fnc=entrypoint,
        )
    )
