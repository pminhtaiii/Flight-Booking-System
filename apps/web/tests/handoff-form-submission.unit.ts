import assert from 'node:assert/strict';
import test from 'node:test';
import { appendHandoffCredential } from '../lib/handoffFormSubmission';

test('adds the in-memory credential only when the browser builds the form body', () => {
  const formData = new FormData();

  appendHandoffCredential(formData, 'chk_handoff_v1_credential');

  assert.deepEqual(Array.from(formData.entries()), [
    ['handoffToken', 'chk_handoff_v1_credential'],
  ]);
});
