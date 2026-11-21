/**
 * Report data contracts and deterministic documentation flags.
 * TODO: thresholds to be validated against current MoHFW guidelines by a clinician.
 * Flags describe documented observations only; they are not diagnoses or treatment advice.
 */
export const PROMPT_VERSION = 'arova-clinical-documentation-v1';

export const extractionTemplate = () => ({
  visit: { date: null, type: null },
  patient: { name: null, age_years: null, village: null },
  pregnancy: { gestation: null, lmp: null, edd: null, anc_visit_number: null },
  vitals: { bp_systolic: null, bp_diastolic: null, hb_g_dl: null, weight_kg: null, pulse: null, temperature_c: null },
  complaints: [], danger_signs_reported: [], medications_supplements: [], immunisation: [],
  child: { age_months: null, weight_kg: null, feeding: null, danger_signs: [] },
  follow_up: { next_visit_date: null, referral_advised: null },
  asha_notes: null, evidence: {}, missing_fields: [],
});

const requiredShape = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const template = extractionTemplate();
  const sameKeys = (a, b) => a && typeof a === 'object' && !Array.isArray(a) &&
    Object.keys(a).sort().join('|') === Object.keys(b).sort().join('|');
  for (const key of Object.keys(template)) if (!(key in value)) return false;
  for (const key of ['visit','patient','pregnancy','vitals','child','follow_up']) if (!sameKeys(value[key], template[key])) return false;
  for (const key of ['complaints','danger_signs_reported','medications_supplements','immunisation','missing_fields']) if (!Array.isArray(value[key])) return false;
  return sameKeys(value.medications_supplements[0] ?? {name:'',taking:null,note:null}, {name:'',taking:null,note:null}) &&
    sameKeys(value.immunisation[0] ?? {vaccine:'',status:null}, {vaccine:'',status:null}) &&
    value.evidence && typeof value.evidence === 'object' && !Array.isArray(value.evidence);
};

export function validateExtraction(value) {
  if (!requiredShape(value)) throw new Error('Extraction does not match the required report schema');
  const numeric = [value.patient.age_years, value.pregnancy.anc_visit_number, value.vitals.bp_systolic,
    value.vitals.bp_diastolic, value.vitals.hb_g_dl, value.vitals.weight_kg, value.vitals.pulse,
    value.vitals.temperature_c, value.child.age_months, value.child.weight_kg];
  if (numeric.some((v) => v !== null && (typeof v !== 'number' || !Number.isFinite(v)))) throw new Error('Numeric report values must be numbers or null');
  const nullableStrings = [value.visit.date, value.visit.type, value.patient.name, value.patient.village,
    value.pregnancy.gestation, value.pregnancy.lmp, value.pregnancy.edd, value.follow_up.next_visit_date, value.asha_notes];
  if (nullableStrings.some((v) => v !== null && typeof v !== 'string')) throw new Error('Text report values must be strings or null');
  return value;
}

export const RULE_THRESHOLDS = Object.freeze({ pregnancyBpSystolic: 140, pregnancyBpDiastolic: 90, severeHb: 7, moderateHb: 9.9 });

export function evaluateRiskFlags(extraction) {
  const x = validateExtraction(extraction);
  const flags = [];
  const add = (code, severity, message, recommended_action) => flags.push({code,severity,message,recommended_action});
  const pregnancyVisit = /anc|antenatal|maternal|pregnan/i.test(`${x.visit.type || ''} ${x.pregnancy.gestation || ''}`);
  const bpHigh = pregnancyVisit && x.vitals.bp_systolic !== null && x.vitals.bp_diastolic !== null &&
    (x.vitals.bp_systolic >= RULE_THRESHOLDS.pregnancyBpSystolic || x.vitals.bp_diastolic >= RULE_THRESHOLDS.pregnancyBpDiastolic);
  const concern = x.complaints.some((item) => /headache|visual disturbance|blurred vision|pedal edema|swelling/i.test(String(item))) ||
    x.danger_signs_reported.some((item) => /headache|visual disturbance|blurred vision|pedal edema|swelling/i.test(String(item)));
  if (bpHigh && concern) add('pregnancy_bp_with_concern','urgent','Elevated BP with a reported concern in pregnancy','Promptly contact the ANM or Medical Officer and follow the local referral protocol.');
  else if (bpHigh) add('pregnancy_elevated_bp','warning','Elevated blood pressure reading recorded during pregnancy','Arrange review with the ANM or Medical Officer according to local protocol.');
  if (pregnancyVisit && x.vitals.hb_g_dl !== null) {
    if (x.vitals.hb_g_dl < RULE_THRESHOLDS.severeHb) add('pregnancy_hb_low_urgent','urgent','Low haemoglobin value recorded during pregnancy','Promptly refer to the ANM or Medical Officer for assessment under local protocol.');
    else if (x.vitals.hb_g_dl <= RULE_THRESHOLDS.moderateHb) add('pregnancy_hb_low_warning','warning','Haemoglobin value in a range requiring clinical review','Share the recorded result with the ANM or Medical Officer for assessment.');
  }
  const urgentTerms = /vaginal bleeding|convulsion|seizure|reduced fetal movement|absent fetal movement|severe abdominal pain|leaking fluid|high fever/i;
  if (x.danger_signs_reported.some((item) => urgentTerms.test(String(item)))) add('pregnancy_danger_sign_reported','urgent','A pregnancy danger sign is documented','Contact the ANM or Medical Officer promptly and follow the local referral protocol.');
  if (x.child.danger_signs.length) add('newborn_danger_sign_reported','urgent','A child or newborn danger sign is documented','Promptly contact the ANM or Medical Officer and follow the local referral protocol.');
  if (x.medications_supplements.some((item) => /iron|folic/i.test(item.name) && item.taking === false)) add('ifa_not_taking','info','Iron-folic acid non-adherence is documented','Record the patient’s stated reason and discuss it with the ANM or Medical Officer.');
  if (x.immunisation.some((item) => item.status === 'overdue')) add('immunisation_overdue','warning','An overdue immunisation is documented','Check the immunisation card and coordinate follow-up with the local health facility.');
  return flags;
}

const reportEditSections=new Set(['chief_complaints','vitals_table','observations','assessment','plan','risk_flags','missing_information','maternal_findings','child_findings','patient_findings','caregiver_findings','medicines','symptoms_and_observations','counseling_and_actions','other_details','follow_up','items_to_verify']);
const normalizeEditText=value=>String(value??'').toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function applyReportOperations(report,operations,transcript){
 const next={...report};const applied=[];const spoken=normalizeEditText(transcript);const hasIntent=(action,text)=>action==='remove'?(/\b(remove|delete|omit|erase|take out)\b/i.test(text)||/हटा|निकाल|मिटा/.test(text)):(/\b(change|replace|correct|update)\b/i.test(text)||/बदल|सुधार/.test(text));
 for(const operation of Array.isArray(operations)?operations:[]){
  const {action,section,target,value}=operation||{};if(!['remove','replace'].includes(action)||!reportEditSections.has(section)||!String(target||'').trim())continue;
  if(!hasIntent(action,String(transcript||'')))continue;
  const targetWords=normalizeEditText(target).split(' ').filter(word=>word.length>2);if(!targetWords.length||!targetWords.some(word=>spoken.includes(word)))continue;
  const list=Array.isArray(next[section])?[...next[section]]:null;if(!list)continue;
  const index=list.findIndex(item=>{const text=normalizeEditText(typeof item==='string'?item:[item?.parameter,item?.field,item?.value,item?.message].filter(Boolean).join(' '));return text.includes(normalizeEditText(target))||targetWords.some(word=>text.split(' ').includes(word))});if(index<0)continue;
  if(action==='remove'){list.splice(index,1)}else{
   if(!String(value||'').trim())continue;
   const newText=normalizeEditText(value);const newWords=newText.split(' ').filter(word=>word.length>1);if(newWords.length&&!newWords.some(word=>spoken.includes(word)))continue;
   const current=list[index];if(typeof current==='string')list[index]=String(value);else if(current&&typeof current==='object'&&'value'in current)list[index]={...current,value:String(value)};else if(current&&typeof current==='object'&&'message'in current)list[index]={...current,message:String(value)};else continue;
  }
  next[section]=list;applied.push({action,section,target:String(target),value:action==='replace'?String(value):null});
 }
 return {report:next,applied};
}
