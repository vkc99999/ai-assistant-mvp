import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
import engine


def result(text='A', cost=.001):
    return {'text':text, 'model':'test', 'provider':'test', 'cost':cost, 'seconds':.1, 'truncated':False}


class ReviewTests(unittest.IsolatedAsyncioTestCase):
    async def test_fallback_is_explicit_and_preserves_diagnostics(self):
        with patch.object(engine,'targets',return_value=['groq:a','gemini:b']), patch.object(engine,'generate',new=AsyncMock(side_effect=[engine.ProviderError('busy'),result()])):
            answer=await engine.answer('hi')
        self.assertEqual(answer['warnings'],['busy'])

    async def test_independent_answers_do_not_see_original(self):
        calls=[]
        async def fake(prompt,target,limit=900):
            calls.append(prompt)
            return result('Conclusion unchanged. Four.')
        req=main.ChallengeRequest(message='Two plus two?',original_answer='ORIGINAL_SECRET_MARKER',context=[main.ContextItem(question='Format',answer='brief')])
        with patch.object(engine,'generate',side_effect=fake):
            answer=await engine.challenge(req)
        self.assertEqual(len(calls),5)
        self.assertNotIn('ORIGINAL_SECRET_MARKER', calls[0])
        self.assertNotIn('ORIGINAL_SECRET_MARKER', calls[1])
        self.assertIn('ORIGINAL_SECRET_MARKER',calls[2])
        self.assertTrue(all('brief' in p for p in calls))
        self.assertEqual(answer['status'],'complete')
        self.assertAlmostEqual(answer['cost'],.005)

    async def test_partial_failure_never_claims_consensus(self):
        with patch.object(engine,'generate',new=AsyncMock(side_effect=[result(),engine.ProviderError('No credits')])) as mock:
            answer=await engine.challenge(main.ChallengeRequest(message='Hi',original_answer='Hello'))
        self.assertEqual(answer['status'],'incomplete')
        self.assertIsNone(answer['reply'])
        self.assertEqual(mock.await_count,2)

    async def test_critique_failure_stops_synthesis(self):
        with patch.object(engine,'generate',new=AsyncMock(side_effect=[result(),result(),result(),engine.ProviderError('busy')])) as mock:
            answer=await engine.challenge(main.ChallengeRequest(message='Hi',original_answer='Hello'))
        self.assertEqual(answer['status'],'incomplete')
        self.assertEqual(mock.await_count,4)

    async def test_truncated_response_retries_and_accounts_for_both_calls(self):
        partial = {**result(cost=.002), 'truncated': True}
        with patch.object(engine, 'generate', new=AsyncMock(side_effect=[partial,result(cost=.003)])) as mock:
            reply = await engine.council_generate('Question', 'openrouter:test', 1600)
        self.assertFalse(reply['truncated'])
        self.assertAlmostEqual(reply['cost'], .005)
        self.assertEqual(mock.call_args.args[2], 3200)

    async def test_persistently_truncated_stage_never_reaches_synthesis(self):
        partial = {**result(), 'truncated': True}
        with patch.object(engine, 'council_generate', new=AsyncMock(return_value=partial)) as mock:
            reply = await engine.challenge(main.ChallengeRequest(message='Hi', original_answer='Hello'))
        self.assertEqual(reply['status'], 'incomplete')
        self.assertEqual(mock.await_count, 2)
        self.assertTrue(reply['warnings'])

    async def test_truncated_chair_is_not_a_completed_review(self):
        with patch.object(engine, 'council_generate', new=AsyncMock(side_effect=[result(),result(),result(),result(),{**result(), 'truncated':True}])):
            reply = await engine.challenge(main.ChallengeRequest(message='Hi',original_answer='Hello'))
        self.assertEqual(reply['status'], 'incomplete')
        self.assertIsNone(reply['reply'])
        self.assertAlmostEqual(reply['cost'], .005)

    async def test_gemini_reserves_reasoning_space(self):
        import httpx
        async def post(*args, **kwargs):
            body = kwargs['json']
            self.assertEqual(body['max_tokens'], 3648)
            self.assertEqual(body['reasoning']['max_tokens'], 2048)
            return httpx.Response(200, json={'choices':[{'message':{'content':'Complete.'},'finish_reason':'stop'}]})
        with patch.dict(os.environ, {'OPENROUTER_API_KEY':'secret'}), patch.object(httpx.AsyncClient,'post',side_effect=post):
            reply = await engine.generate('Hi', 'openrouter:google/gemini-2.5-pro', 1600)
        self.assertFalse(reply['truncated'])

    def test_unknown_cost_not_reported_as_free(self):
        self.assertIsNone(engine.total_cost([result(),result(cost=None)]))

    async def test_provider_error_is_sanitized_and_output_bounded(self):
        import httpx
        async def post(*args,**kwargs):
            self.assertEqual(kwargs['json']['max_tokens'],900)
            return httpx.Response(402, json={'error':{'message':'private-provider-message'}})
        with patch.dict(os.environ, {'OPENROUTER_API_KEY':'secret'}), patch.object(httpx.AsyncClient,'post',side_effect=post):
            with self.assertRaisesRegex(engine.ProviderError,'needs credits'):
                await engine.generate('hi','openrouter:test')
