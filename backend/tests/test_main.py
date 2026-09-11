import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


class ClarificationParserTests(unittest.TestCase):
    def test_parses_structured_questions_and_removes_duplicate_options(self):
        raw = json.dumps(
            {
                "questions": [
                    {
                        "question": "Preferred depth?",
                        "options": ["Brief", "Detailed", "brief"],
                    }
                ]
            }
        )

        questions = main.parse_clarifications(raw)

        self.assertEqual(questions[0].question, "Preferred depth?")
        self.assertEqual(questions[0].options, ["Brief", "Detailed"])

    def test_accepts_the_original_prototype_response_shape(self):
        raw = '```json\n{"Preferred format?": ["List", "Narrative"]}\n```'

        questions = main.parse_clarifications(raw)

        self.assertEqual(questions[0].question, "Preferred format?")
        self.assertEqual(questions[0].options, ["List", "Narrative"])

    def test_caps_questions_at_three(self):
        raw = json.dumps({"questions": [{"question": f"Question {i}?", "options": ["A", "B"]} for i in range(6)]})
        self.assertEqual(len(main.parse_clarifications(raw)), 3)

    def test_allows_an_already_clear_request(self):
        self.assertEqual(main.parse_clarifications('{"questions": []}'), [])


class PromptTests(unittest.TestCase):
    def test_memory_is_available_to_clarification_prompt(self):
        memory = [main.ContextItem(question="Preferred language?", answer="Python")]

        prompt = main.build_clarification_prompt("Show an example", memory)

        self.assertIn("Preferred language?: Python", prompt)
        self.assertIn("Show an example", prompt)

    def test_answer_prompt_keeps_request_and_context_separate(self):
        context = [main.ContextItem(question="Preferred depth?", answer="Detailed")]

        prompt = main.build_answer_prompt("Explain Kafka", context)

        self.assertIn("Preferred depth?: Detailed", prompt)
        self.assertTrue(prompt.endswith("Explain Kafka"))


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_health(self):
        response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "running"})

    def test_chat_has_a_stable_response_shape(self):
        with patch.object(main.engine, "answer", new=AsyncMock(return_value={"text": "Hello there"})):
            response = self.client.post("/api/chat", json={"message": "Hello"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"reply": "Hello there", "metadata": {}})

    def test_clarify_returns_normalized_questions(self):
        provider_response = (
            '{"questions":[{"question":"Preferred depth?",'
            '"options":["Brief","Detailed"]}]}',
            "gemini",
        )
        with patch.object(
            main.engine,
            "clarify",
            new=AsyncMock(return_value={"text": provider_response[0], "provider": provider_response[1]}),
        ):
            response = self.client.post(
                "/api/clarify",
                json={"message": "Explain Kafka", "memory": []},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["provider"], "gemini")
        self.assertEqual(response.json()["questions"][0]["options"], ["Brief", "Detailed"])

    def test_personalization_routes_known_context_and_limits_batch(self):
        mock = AsyncMock(return_value={"text": json.dumps({"questions": [{"question": f"Detail {i}?", "options": ["A", "Prefer not to say"]} for i in range(5)], "relevant_memory": [0, 99]}), "provider": "openrouter"})
        with patch.object(main.engine, "clarify", new=mock):
            response = self.client.post("/api/clarify", json={"message": "Hair loss options", "personalize": True, "memory": [{"question": "Age?", "answer": "35"}]})
        self.assertEqual(len(response.json()["questions"]), 3)
        self.assertEqual(response.json()["relevant_memory"], [0])
        self.assertIn("PERSONALIZATION MODE", mock.call_args.args[0])
        self.assertIn("Age?: 35", mock.call_args.args[0])

    def test_detail_round_preserves_choices_and_cannot_request_another_round(self):
        mock = AsyncMock(return_value={"text": '{"questions":[],"resolve_intent":true}', "provider":"openrouter"})
        with patch.object(main.engine, "clarify", new=mock):
            response = self.client.post("/api/clarify", json={"message":"I want to go out", "detail_round":True, "confirmed":[{"question":"Activity?","answer":"Dine out"}]})
        self.assertFalse(response.json()["resolve_intent"])
        self.assertIn("Activity?: Dine out", mock.call_args.args[0])
        self.assertIn("DETAIL ROUND", mock.call_args.args[0])

    def test_rejects_an_empty_message(self):
        response = self.client.post("/api/chat", json={"message": ""})

        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
