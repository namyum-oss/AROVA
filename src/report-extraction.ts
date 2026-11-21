export type ExtractedFact = { label: string; value: string; evidence: string; category: 'maternal' | 'child' | 'general' };
export type VisitExtraction = { facts: ExtractedFact[]; complaints: ExtractedFact[]; missing: string[] };
type Category = ExtractedFact['category'];

/** Extracts only values that appear in the worker-reviewed transcript. */
export function extractVisitFacts(transcript: string, visitType: string, profileType: Category = 'general'): VisitExtraction {
  const original = transcript || '';
  const text = original.replace(/[०-९]/g, digit => String('०१२३४५६७८९'.indexOf(digit)));
  const facts: ExtractedFact[] = [];
  const complaints: ExtractedFact[] = [];
  const childContext = /child|baby|newborn|infant|बच्चे|बच्चा|शिशु|नवजात/i;
  const addMatch = (label: string, re: RegExp, format: (match: RegExpMatchArray) => string, explicitCategory?: Category) => {
    const match = text.match(re);
    if (match) {
      const start = match.index || 0;
      const evidence = original.slice(start, start + match[0].length);
      const surrounding = text.slice(Math.max(0, start - 32), Math.min(text.length, start + match[0].length + 32));
      const category = explicitCategory || (childContext.test(surrounding) ? 'child' : profileType);
      facts.push({ label, value: format(match), evidence, category });
    }
  };
  addMatch('Blood pressure', /(?:\bBP\b|blood pressure|बीपी)\s*(?:(?:is|was|है|था|रहा)\s*)?([0-9]{2,3})\s*(?:\/|／|\bby\b|\bover\b|पर)\s*([0-9]{2,3})/i, m => `${m[1]}/${m[2]} mmHg`);
  addMatch('Haemoglobin', /(?:\bHb\b|haemoglobin|hemoglobin|हीमोग्लोबिन)\s*(?:(?:is|was|है|था|रहा)\s*)?([0-9]+(?:\.[0-9]+)?)/i, m => `${m[1]} g/dL`, 'maternal');
  addMatch('Gestational age', /([0-9]+)\s*(?:weeks?|months?|हफ्ते|सप्ताह|महीने)\s*(?:की\s*)?(?:pregnant|pregnancy|गर्भवती|गर्भावस्था)/i, m => `${m[1]} ${/week|हफ्त|सप्ताह/i.test(m[0]) ? 'weeks' : 'months'}, as reported`, 'maternal');
  addMatch('ANC visit number', /(?:\bANC\b|antenatal visit|एएनसी)\s*(?:visit|number|नंबर|संख्या)?\s*(?:is|है|नंबर)?\s*([0-9]{1,2})/i, m => m[1], 'maternal');
  addMatch('Child weight', /(?:(?:baby|child|newborn|infant|बच्चे|बच्चा|शिशु|नवजात).{0,28}(?:weight|वजन)|(?:weight|वजन).{0,22}(?:baby|child|newborn|infant|बच्चे|बच्चा|शिशु|नवजात))\s*(?:(?:is|was|है|था|का)\s*)?([0-9]+(?:\.[0-9]+)?)\s*(kg|kgs|kilograms?|किलो|किलोग्राम|grams?|g|ग्राम)?/i, m => `${m[1]} ${m[2] || 'unit not stated'}`, 'child');
  addMatch('Weight', /(?:weight|weighs?|वजन)\s*(?:(?:is|was|है|था|का)\s*)?([0-9]+(?:\.[0-9]+)?)\s*(kg|kgs|kilograms?|किलो|किलोग्राम|grams?|g|ग्राम)?/i, m => `${m[1]} ${m[2] || 'unit not stated'}`);
  addMatch('Temperature', /(?:temperature|temp\.?|तापमान|बुखार)\s*(?:(?:is|was|है|था|रहा)\s*)?([0-9]+(?:\.[0-9]+)?)\s*(°\s*C|°?\s*F|degrees?\s*(?:C|F)|डिग्री)?/i, m => `${m[1]} ${m[2] || 'unit not stated'}`);
  addMatch('Pulse', /(?:\bpulse\b|\bheart rate\b|नाड़ी|धड़कन)\s*(?:(?:is|was|है|था)\s*)?([0-9]{2,3})/i, m => `${m[1]} beats/min`);
  addMatch('Oxygen saturation', /(?:\bSpO2\b|oxygen saturation|ऑक्सीजन)\s*(?:(?:is|was|है|था)\s*)?([0-9]{2,3})\s*%?/i, m => `${m[1]}%`);
  addMatch('Respiratory rate', /(?:respiratory rate|breathing rate|सांस की दर)\s*(?:(?:is|was|है|था)\s*)?([0-9]{1,3})/i, m => `${m[1]} breaths/min`);
  addMatch('Height', /(?:height|लंबाई|ऊंचाई)\s*(?:(?:is|was|है|था)\s*)?([0-9]+(?:\.[0-9]+)?)\s*(cm|centimeters?|मीटर|m)?/i, m => `${m[1]} ${m[2] || 'unit not stated'}`);
  addMatch('MUAC', /(?:\bMUAC\b|mid[- ]upper arm circumference|मध्य ऊपरी बांह)\s*(?:(?:is|was|है|था)\s*)?([0-9]+(?:\.[0-9]+)?)\s*(cm|centimeters?)?/i, m => `${m[1]} ${m[2] || 'unit not stated'}`);
  addMatch('Blood glucose', /(?:blood sugar|blood glucose|शुगर|रक्त शर्करा)\s*(?:(?:is|was|है|था)\s*)?([0-9]{2,3})\s*(mg\/?dL)?/i, m => `${m[1]} ${m[2] || 'unit not stated'}`);
  addMatch('Age', /(?:\bage\b|उम्र|आयु)\s*(?:(?:is|was|है|था)\s*)?([0-9]+(?:\.[0-9]+)?)\s*(years?|yrs?|साल|वर्ष)/i, m => `${m[1]} ${m[2]}, as reported`);
  addMatch('Child age', /(?:(?:child|baby|newborn|बच्चे|बच्चा|शिशु).{0,20}(?:age|उम्र|आयु)|(?:age|उम्र|आयु).{0,20}(?:child|baby|newborn|बच्चे|बच्चा|शिशु))\s*(?:(?:is|है)\s*)?([0-9]+(?:\.[0-9]+)?)\s*(months?|महीने|weeks?|हफ्ते|साल|years?)/i, m => `${m[1]} ${m[2]}, as reported`, 'child');
  const terms: Array<[string, RegExp]> = [
    ['Headache', /\bheadache\b|सिरदर्द/i], ['Pedal edema / foot swelling', /pedal edema|swelling of (?:the )?feet|feet are swollen|पैर में सूजन|पैरों में सूजन/i],
    ['Dizziness', /\bdizziness\b|\bchakkar\b|चक्कर/i], ['Fever', /\bfever\b|बुखार/i],
    ['Abdominal pain', /abdominal pain|stomach pain|पेट में दर्द|पेट दर्द/i], ['Poor feeding reported', /poor feeding|not feeding|feeding poorly|दूध नहीं पी|दूध कम पी/i],
    ['Diarrhoea reported', /diarrh?ea|loose motions?|दस्त|पतले दस्त/i], ['Vomiting reported', /\bvomiting\b|उल्टी/i],
    ['Vaginal bleeding reported', /vaginal bleeding|bleeding per vaginum|योनि से खून|रक्तस्राव/i],
    ['Convulsion reported', /\bconvulsion\b|\bseizure\b|\bfits\b|दौरा/i],
    ['Reduced fetal movement reported', /reduced fetal movement|no fetal movement|बच्चे की हलचल कम|हलचल नहीं/i],
    ['Leaking fluid reported', /leaking fluid|water leaking|पानी निकल/i],
    ['Breathing difficulty reported', /fast breathing|difficulty breathing|सांस लेने में दिक्कत/i],
    ['Cough reported', /\bcough\b|खांसी/i], ['Jaundice reported', /\bjaundice\b|पीलिया/i],
    ['IFA non-adherence reported', /(?:not taking|stopped|नहीं ले रही|नहीं लेता).{0,35}(?:iron|ifa|folic|आयरन|फोलिक)/i],
    ['Feeding information', /(?:breastfeeding|breast feeding|स्तनपान|दूध पी रहा|दूध पी रही)/i],
  ];
  for (const [label, re] of terms) {
    const match = text.match(re);
    if (match) {
      const start = match.index || 0;
      const evidence = original.slice(start, start + match[0].length);
      const surrounding = text.slice(Math.max(0, start - 32), Math.min(text.length, start + match[0].length + 32));
      complaints.push({ label, value: 'Reported', evidence, category: childContext.test(surrounding) ? 'child' : profileType });
    }
  }
  // Avoid repeating a child measurement as a generic weight as well.
  if (facts.some(item => item.label === 'Child weight')) {
    const childFact = facts.find(item => item.label === 'Child weight')!;
    const duplicate = facts.findIndex(item => item.label === 'Weight' && item.evidence === childFact.evidence);
    if (duplicate >= 0) facts.splice(duplicate, 1);
  }
  const lower = text.toLowerCase();
  const missing: string[] = [];
  if (!facts.some(f => f.label === 'Blood pressure')) missing.push('Blood pressure');
  if (!facts.some(f => f.label === 'Haemoglobin')) missing.push('Haemoglobin');
  if (/maternal|antenatal|pregnan|anc/i.test(`${visitType} ${profileType}`)) {
    if (!facts.some(f => f.label === 'Gestational age')) missing.push('Gestational age');
  }
  if (/child|newborn|hbnc|immuni/i.test(`${visitType} ${profileType}`)) {
    if (!facts.some(f => f.label === 'Child weight' || f.label === 'Weight')) missing.push('Child weight');
    if (!facts.some(f => f.label === 'Feeding information')) missing.push('Feeding information');
  }
  if (lower.trim() && !facts.length && !complaints.length) missing.push('No structured values could be identified; review the transcript');
  return { facts, complaints, missing };
}
