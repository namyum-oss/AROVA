import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVisitFacts } from '../src/report-extraction.ts';

test('finds only explicit values in mixed Hindi and English notes', () => {
  const result = extractVisitFacts('सीता देवी 24 साल, 7 महीने की गर्भवती, BP 150/95 है, हीमोग्लोबिन 8, पैर में सूजन है, सिरदर्द है', 'Maternal health check');
  assert.deepEqual(result.facts.map(x => [x.label,x.value]), [
    ['Blood pressure','150/95 mmHg'], ['Haemoglobin','8 g/dL'], ['Gestational age','7 months, as reported'],
  ]);
  assert.deepEqual(result.complaints.map(x => x.label), ['Headache','Pedal edema / foot swelling']);
  assert.equal(result.facts.some(x => x.label === 'Weight'), false);
});

test('does not invent missing BP or Hb and extracts a stated temperature', () => {
  const result = extractVisitFacts('temperature 100°C है', 'Routine check-in');
  assert.deepEqual(result.facts.map(x => [x.label,x.value]), [['Temperature','100 °C']]);
  assert.deepEqual(result.missing, ['Blood pressure','Haemoglobin']);
});
