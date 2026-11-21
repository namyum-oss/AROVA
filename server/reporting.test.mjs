import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionTemplate, validateExtraction, evaluateRiskFlags, applyReportOperations } from './reporting.mjs';

const base = () => extractionTemplate();
const has = (x, code) => evaluateRiskFlags(x).some((flag) => flag.code === code);

test('extraction contract accepts explicit nulls and rejects guessed or malformed values', () => {
  const x = base();
  assert.equal(validateExtraction(x), x);
  x.vitals.hb_g_dl = 8;
  assert.equal(validateExtraction(x).vitals.hb_g_dl, 8);
  x.vitals.hb_g_dl = '8';
  assert.throws(() => validateExtraction(x), /must be numbers or null/);
  x.vitals.hb_g_dl = null;
  delete x.child;
  assert.throws(() => validateExtraction(x), /schema/);
});

test('pregnancy BP thresholds are inclusive and require both recorded components', () => {
  const x = base(); x.visit.type = 'ANC'; x.vitals.bp_systolic = 140; x.vitals.bp_diastolic = 89;
  assert.ok(has(x, 'pregnancy_elevated_bp'));
  x.vitals.bp_systolic = 139; x.vitals.bp_diastolic = 90;
  assert.ok(has(x, 'pregnancy_elevated_bp'));
  x.vitals.bp_diastolic = null;
  assert.equal(has(x, 'pregnancy_elevated_bp'), false);
});

test('pregnancy BP with documented concern adds urgent flag', () => {
  const x = base(); x.visit.type = 'ANC'; x.vitals.bp_systolic = 150; x.vitals.bp_diastolic = 95; x.complaints = ['headache'];
  assert.ok(has(x, 'pregnancy_bp_with_concern'));
});

test('haemoglobin thresholds cover <7, 7, 9.9, and above 9.9', () => {
  const x = base(); x.visit.type = 'ANC'; x.vitals.hb_g_dl = 6.9;
  assert.ok(has(x, 'pregnancy_hb_low_urgent'));
  x.vitals.hb_g_dl = 7;
  assert.ok(has(x, 'pregnancy_hb_low_warning'));
  x.vitals.hb_g_dl = 9.9;
  assert.ok(has(x, 'pregnancy_hb_low_warning'));
  x.vitals.hb_g_dl = 10;
  assert.equal(has(x, 'pregnancy_hb_low_warning'), false);
});

test('reported danger signs, newborn concerns, IFA and overdue immunisation map to flags', () => {
  const x = base(); x.danger_signs_reported = ['reduced fetal movement'];
  assert.ok(has(x, 'pregnancy_danger_sign_reported'));
  x.danger_signs_reported = []; x.child.danger_signs = ['poor feeding'];
  assert.ok(has(x, 'newborn_danger_sign_reported'));
  x.child.danger_signs = []; x.medications_supplements = [{name:'iron folic acid',taking:false,note:null}];
  assert.ok(has(x, 'ifa_not_taking'));
  x.medications_supplements = []; x.immunisation = [{vaccine:'DPT',status:'overdue'}];
  assert.ok(has(x, 'immunisation_overdue'));
});

test('missing vitals never produce numeric or risk values', () => {
  const x = base(); x.visit.type = 'ANC';
  assert.equal(x.vitals.bp_systolic, null);
  assert.equal(x.vitals.hb_g_dl, null);
  assert.deepEqual(evaluateRiskFlags(x), []);
});


test('voice corrections remove or replace only the explicitly named report item',()=>{
 const source={chief_complaints:['Headache','Fever'],vitals_table:[{parameter:'Temperature',value:'39 C',reference:'Not supplied',status:'recorded'}]};
 const removed=applyReportOperations(source,[{action:'remove',section:'chief_complaints',target:'Headache',value:''}],'Remove headache from the chief complaints');
 assert.deepEqual(removed.report.chief_complaints,['Fever']);assert.equal(removed.applied.length,1);
 const replaced=applyReportOperations(source,[{action:'replace',section:'vitals_table',target:'Temperature',value:'37 C'}],'Change temperature to 37 C');
 assert.equal(replaced.report.vitals_table[0].value,'37 C');
 const ambiguous=applyReportOperations(source,[{action:'remove',section:'chief_complaints',target:'Fever',value:''}],'Please update the report');
 assert.deepEqual(ambiguous.report,source);assert.equal(ambiguous.applied.length,0);
});
