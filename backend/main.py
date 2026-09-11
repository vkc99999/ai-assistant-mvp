import json
import os
import re
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import engine

load_dotenv()




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


class HistoryTurn(BaseModel):
    prompt: str = Field(max_length=10000)
    answer: str = Field(max_length=12000)


class ChatRequest(BaseModel):
    personalize: bool = False
    message: str = Field(min_length=1, max_length=10_000)
    context: list[ContextItem] = Field(default_factory=list, max_length=30)
    history: list[HistoryTurn] = Field(default_factory=list, max_length=6)


class ChatResponse(BaseModel):
    reply: str
    metadata: dict = Field(default_factory=dict)


class ClarifyRequest(BaseModel):
    detail_round: bool = False
    confirmed: list[ContextItem] = Field(default_factory=list, max_length=30)
    personalize: bool = False
    message: str = Field(min_length=1, max_length=10_000)
    memory: list[ContextItem] = Field(default_factory=list, max_length=30)
    history: list[HistoryTurn] = Field(default_factory=list, max_length=6)


class ClarificationQuestion(BaseModel):
    question: str
    options: list[str]


class ClarifyResponse(BaseModel):
    resolve_intent: bool = False
    questions: list[ClarificationQuestion]
    provider: str
    challenge_recommended: bool = False
    reason: str = ""
    relevant_memory: list[int] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)


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

Ask zero to three concise clarification questions in ONE batch only where the current request is
still ambiguous. Collect all materially useful missing details together; there will be no second round.
Prefer one or two questions; use three when three distinct details materially improve the answer.
For "I want to go out", first ask what kind of outing: dine out, outdoor activity,
movie, or something else. Never infer dining intent from old restaurant preferences.
Saved preferences are not current plans: do not reuse past dates, party size, occasion,
or budget as current facts without confirmation. Reuse stable relevant facts only.
For a vague restaurant request such as "I want to eat out", collect missing city/area, cuisine,
and budget or dining style together (up to three). Do not invent the user's location; location options
can include "Use saved city" only when a saved city exists, or "I will type a city" and "No specific city".
For general scientific mechanism or comparative-evidence questions, answer directly with no questions
unless there is a real ambiguity that changes the answer. Interpret technical abbreviations in context;
do not replace an unfamiliar technical term with a superficially similar everyday word.
Do not ask the user to restate information already explicit or strongly implied in their question. Do not repeat anything already resolved by the known context.
Ask age, sex, health or relationship details only if needed for this specific question, never as a routine checklist. General evidence questions do not require personal demographics. Restaurant searches need a city. Give two to five short, mutually distinct options for each question. Return only
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
    for item in raw_questions[:3]:
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


@app.get("/")
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "running"}


@app.post("/api/clarify", response_model=ClarifyResponse)
async def clarify(req: ClarifyRequest) -> ClarifyResponse:
    prompt = build_clarification_prompt(req.message.strip(), req.memory)
    if req.detail_round:
        prompt += "\nDETAIL ROUND: The broad intent has now been selected. Ask one final batch of up to three missing details that materially improve this specific activity. For dining collect missing city, cuisine, and budget/dining style. Reuse relevant stable memory. Do not ask the activity again. Return no questions if context is sufficient. There will be no more rounds."
    else:
        prompt += "\nIf the request is broad like 'I want to go out', ask ONLY the activity/intent question first and set resolve_intent=true. Otherwise collect useful missing details together and set resolve_intent=false."
    prompt += "\nAnswers confirmed for THIS request (take precedence over old memory):\n" + _format_context(req.confirmed)
    if req.personalize:
        prompt = ("Known user context:\n" + _format_context(req.memory) + "\nTopic the user wants to apply to their own situation:\n" + req.message + '\nReturn JSON: {"questions":[{"question":"...","options":["...","..."]}]}. Each question needs two to five short options. ')
        prompt += "\nPERSONALIZATION MODE: The user already received a general answer and has clicked Personalize this answer. Their NEW intent is how this topic relates to their own situation, not another explanation of the mechanism. This mode overrides the earlier rule to skip questions for clear general questions. Ask up to three materially relevant missing personal details together, with options. For hair-loss treatment suitability, age range, relevant sex-related physiology (not assumed from gender identity), and hair-loss pattern or Norwood stage may help. Norwood is not applicable to everyone; include Not sure / Not applicable where appropriate. Include Prefer not to say for sensitive details. For hair-loss topics, collect missing age range, relevant sex-related physiology, and hair-loss pattern/stage to frame personal relevance, while explaining that these details do not change the underlying mechanism. Skip details already in supplied memory or history. If nothing material is missing, return no questions."
    prompt += "\nPrevious conversation: " + json.dumps([h.model_dump() for h in req.history])
    prompt += "\nIn the JSON add challenge_recommended (boolean), reason (short reason), and relevant_memory (zero-based indexes of only relevant supplied memory items). Recommend challenge for consequential tradeoffs, disputed claims or uncertainty, not routine preferences. Do not assert correctness."
    try:
        result = await engine.clarify(prompt, 1200)
        payload = _json_object(result['text'])
        relevant = payload.get('relevant_memory', [])
        relevant = [i for i in relevant if type(i) is int and 0 <= i < len(req.memory)] if isinstance(relevant, list) else []
        return ClarifyResponse(resolve_intent=not req.detail_round and not req.personalize and payload.get('resolve_intent') is True, questions=parse_clarifications(result['text']),
            provider=result['provider'], challenge_recommended=payload.get('challenge_recommended') is True,
            reason=str(payload.get('reason', ''))[:250], relevant_memory=relevant,
            metadata={k:v for k,v in result.items() if k != 'text'})
    except engine.ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    except (ValueError, TypeError):
        # Malformed routing must not prevent the user getting an answer.
        return ClarifyResponse(questions=[], provider='unavailable', reason='Clarification was unavailable; you can still ask directly.')


@app.post("/api/chat", response_model=ChatResponse)
@app.post("/chat", response_model=ChatResponse, include_in_schema=False)
async def chat(req: ChatRequest) -> ChatResponse:
    try:
        result = await engine.answer(engine.ANSWER_RULES + ('Tailor the explanation to the supplied personal context, separating general evidence from personal suitability. ' if req.personalize else '') + engine.context_prompt(req))
        return ChatResponse(reply=result['text'], metadata={k:v for k,v in result.items() if k != 'text'})
    except engine.ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None


class ChallengeRequest(ChatRequest):
    original_answer: str = Field(min_length=1, max_length=12000)


@app.post('/api/challenge')
async def review_answer(req: ChallengeRequest):
    try:
        return await engine.challenge(req)
    except engine.ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
