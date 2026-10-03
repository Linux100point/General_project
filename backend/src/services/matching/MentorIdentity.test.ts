import assert from 'node:assert/strict';
import test from 'node:test';
import { createMentorIdFromFileName, normalizeMentorNameFromFileName } from './MentorIdentity';

test('mentor ID is stable across extension, case, and surrounding whitespace changes', () => {
  assert.equal(createMentorIdFromFileName(' Ada Lovelace.PDF '), createMentorIdFromFileName('ada lovelace.pdf'));
  assert.equal(normalizeMentorNameFromFileName(' Ada Lovelace.PDF '), 'Ada Lovelace');
});

test('different filename identities receive different backend IDs', () => {
  assert.notEqual(createMentorIdFromFileName('Mentor A.pdf'), createMentorIdFromFileName('Mentor B.pdf'));
});