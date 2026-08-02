import asyncio
import json
import logging
import os
import re
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from pydantic import BaseModel, Field

load_dotenv()

logger = logging.getLogger(__name__)

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
GROQ_MODEL = os.getenv("GROQ_MODEL", "groq/compound-mini")
PROVIDER_TIMEOUT_SECONDS = float(os.getenv("PROVIDER_TIMEOUT_SECONDS", "60"))


def _allowed_origins() -> list[str]:
    configured = os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173",
    )
    return [origin.strip() for origin in configured.split(",") if origin.strip()]


app = FastAPI(
    title="Personalized AI Assistant MVP",
    description="Clarification-first assistant with explicit user memory.",
    version="0.2.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class ContextItem(BaseModel):
    question: str = Field(min_length=1, max_length=300)
    answer: str = Field(min_length=1, max_length=500)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=10_000)
    context: list[ContextItem] = Field(default_factory=list, max_length=30)


class ChatResponse(BaseModel):
    reply: str


class ClarifyRequest(BaseModel):
    message: str = Field(min_length=1, max_length=10_000)
    memory: list[ContextItem] = Field(default_factory=list, max_length=30)


class ClarificationQuestion(BaseModel):
    question: str
    options: list[str]


class ClarifyResponse(BaseModel):
    questions: list[ClarificationQuestion]
    provider: str


def _format_context(context: list[ContextItem]) -> str:
    if not context:
        return "No previously confirmed context is available."
    return "\n".join(f"- {item.question}: {item.answer}" for item in context)


def build_clarification_prompt(message: str, memory: list[ContextItem]) -> str:
    return f"""
You help an AI assistant understand a user's intent before answering.

Known user context from choices the user explicitly asked to remember:
{_format_context(memory)}

Current request:
{message}

Ask up to four concise clarification questions only where the current request is
still ambiguous. Do not repeat anything already resolved by the known context.
Give two to five short, mutually distinct options for each question. Return only
valid JSON in this exact shape:
{{"questions": [{{"question": "...", "options": ["...", "..."]}}]}}

If the request is already clear, return {{"questions": []}}.
""".strip()


def build_answer_prompt(message: str, context: list[ContextItem]) -> str:
    if not context:
        return message
    return f"""
Use the following user-confirmed context when it is relevant. Do not mention the
context list or claim that every item is a permanent preference.

{_format_context(context)}

User request:
{message}
""".strip()


def _json_object(raw: str) -> dict[str, Any]:
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if not match:
            raise ValueError("The clarification provider did not return JSON") from None
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise ValueError("The clarification provider returned invalid JSON") from exc

    if not isinstance(payload, dict):
        raise ValueError("The clarification payload must be a JSON object")
    return payload


def parse_clarifications(raw: str) -> list[ClarificationQuestion]:
    payload = _json_object(raw)
    raw_questions = payload.get("questions")

    # Accept the original MVP's {"question": ["option"]} response shape too.
    if raw_questions is None:
        raw_questions = [
            {"question": question, "options": options}
            for question, options in payload.items()
        ]

    if not isinstance(raw_questions, list):
        raise ValueError("The questions field must be a list")

    questions: list[ClarificationQuestion] = []
    seen_questions: set[str] = set()
    for item in raw_questions[:4]:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question", "")).strip()
        raw_options = item.get("options", [])
        if not question or not isinstance(raw_options, list):
            continue

        options: list[str] = []
        seen_options: set[str] = set()
        for raw_option in raw_options:
            option = str(raw_option).strip()
            normalized = option.casefold()
            if option and normalized not in seen_options:
                options.append(option[:200])
                seen_options.add(normalized)
            if len(options) == 5:
                break

        normalized_question = question.casefold()
        if len(options) >= 2 and normalized_question not in seen_questions:
            questions.append(
                ClarificationQuestion(question=question[:300], options=options)
            )
            seen_questions.add(normalized_question)

    if raw_questions and not questions:
        raise ValueError("The clarification provider returned no usable questions")
    return questions


def _generate_with_gemini(prompt: str) -> str:
    client = genai.Client()
    result = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
    text = getattr(result, "text", None)
    if not text:
        raise ValueError("Gemini returned an empty response")
    return text


async def _generate_with_groq(prompt: str, api_key: str) -> str:
    async with httpx.AsyncClient(timeout=PROVIDER_TIMEOUT_SECONDS) as client:
        response = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": GROQ_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
            },
        )
        response.raise_for_status()
        payload = response.json()

    try:
        return payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("Groq returned an unexpected response") from exc


async def _clarification_text(prompt: str) -> tuple[str, str]:
    provider = os.getenv("CLARIFICATION_PROVIDER", "auto").strip().lower()
    groq_key = os.getenv("GROQ_API_KEY")

    if provider not in {"auto", "groq", "gemini"}:
        raise ValueError("CLARIFICATION_PROVIDER must be auto, groq, or gemini")
    if provider == "groq" and not groq_key:
        raise RuntimeError("GROQ_API_KEY is required when using the Groq provider")
    if provider == "groq" or (provider == "auto" and groq_key):
        return await _generate_with_groq(prompt, groq_key or ""), "groq"

    text = await asyncio.wait_for(
        asyncio.to_thread(_generate_with_gemini, prompt),
        timeout=PROVIDER_TIMEOUT_SECONDS,
    )
    return text, "gemini"


@app.get("/")
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "running"}


@app.post("/api/clarify", response_model=ClarifyResponse)
async def clarify(req: ClarifyRequest) -> ClarifyResponse:
    prompt = build_clarification_prompt(req.message.strip(), req.memory)
    try:
        raw, provider = await _clarification_text(prompt)
        return ClarifyResponse(
            questions=parse_clarifications(raw),
            provider=provider,
        )
    except (asyncio.TimeoutError, httpx.TimeoutException) as exc:
        raise HTTPException(status_code=504, detail="Clarification request timed out") from exc
    except (httpx.HTTPError, RuntimeError, ValueError) as exc:
        logger.exception("Clarification provider failed")
        raise HTTPException(status_code=502, detail="The clarification provider failed") from exc


@app.post("/api/chat", response_model=ChatResponse)
@app.post("/chat", response_model=ChatResponse, include_in_schema=False)
async def chat(req: ChatRequest) -> ChatResponse:
    prompt = build_answer_prompt(req.message.strip(), req.context)
    try:
        reply = await asyncio.wait_for(
            asyncio.to_thread(_generate_with_gemini, prompt),
            timeout=PROVIDER_TIMEOUT_SECONDS,
        )
        return ChatResponse(reply=reply)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Answer request timed out") from exc
    except Exception as exc:
        logger.exception("Answer provider failed")
        raise HTTPException(status_code=502, detail="The answer provider failed") from exc
