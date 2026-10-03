import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeAnchorSpan} from './native-anchors.js';
test('External text anchors find native PDF text across line breaks and preserve code point offsets',()=>{
 const block='读📚 原文\n公式',t={start:1,end:5,exact:'📚 原文'};assert.deepEqual(nativeAnchorSpan('标题读📚原文 公式页脚',block,t),[3,7]);
 assert.deepEqual(nativeAnchorSpan('We read slowly, noticing', 'We read slowly, noticing',{start:0,end:14,exact:'We read slowly'}),[0,12]);
});
test('Native overlay refuses ambiguous or changed original text instead of drawing on a guessed phrase',()=>{
 assert.equal(nativeAnchorSpan('原文 原文','原文',{start:0,end:2,exact:'原文'}),null);assert.equal(nativeAnchorSpan('原文','原文',{start:0,end:2,exact:'改文'}),null);assert.equal(nativeAnchorSpan('原文','改文',{start:0,end:2,exact:'改文'}),null);
});
