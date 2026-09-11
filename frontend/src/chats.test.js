import test from 'node:test';
import assert from 'node:assert/strict';
import { readChats, writeChats, historyFor } from './chats.js';
test('saved chats round-trip and interrupted work becomes retryable', () => {
  const store = new Map(); globalThis.localStorage = { getItem:k=>store.get(k), setItem:(k,v)=>store.set(k,v) };
  writeChats({ active:'a', chats:[{id:'a',title:'One',messages:[{prompt:'hello',answer:'',status:'loading',reviewing:true}]}] });
  const state=readChats();
  assert.equal(state.active,'a'); assert.equal(state.chats[0].messages[0].status,'stopped');
  assert.equal(state.chats[0].messages[0].reviewing,false);
});
test('history excludes failed answers and is bounded',()=> {
  const messages=Array.from({length:10},(_,i)=>({prompt:String(i),answer:'OK',status:'complete'}));
  messages.push({prompt:'fail',status:'failed'});
  assert.equal(historyFor(messages).length,6); assert.equal(historyFor(messages)[0].prompt,'4');
});
test('storage failure is surfaced',()=>{ globalThis.localStorage={setItem:()=>{throw Error();}};assert.equal(writeChats({}),false); });
