import test from 'node:test';import assert from 'node:assert/strict';import {borrowStock,returnStock,validateItem} from './domain.js';
test('借出與分批歸還維持數量',()=>{let i={available:5,borrowed:0};i=borrowStock(i,3);assert.deepEqual(i,{available:2,borrowed:3});assert.deepEqual(returnStock(i,{remaining:3},1),{available:3,borrowed:2,remaining:2})});
test('阻擋超借、超還與負數',()=>{assert.throws(()=>borrowStock({available:1,borrowed:0},2));assert.throws(()=>borrowStock({available:1,borrowed:0},-1));assert.throws(()=>returnStock({available:1,borrowed:1},{remaining:0},1))});
test('匯入不悄悄修正異常',()=>{assert.throws(()=>validateItem({id:'001',name:'錄音筆',category:'輔具',total:1,borrowed:-1,available:2}));assert.throws(()=>validateItem({id:'001',name:'錄音筆',category:'輔具',total:2,borrowed:0,available:1}))});
