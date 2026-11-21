import { GoogleGenAI } from '@google/genai';
import { evaluateRiskFlags, extractionTemplate } from './reporting.mjs';

const apiKey=process.env.GEMINI_API_KEY?.trim();
if(!apiKey)throw new Error('GEMINI_API_KEY is missing. Add it to the project .env file (see .env.example) and restart AROVA.');
const model=process.env.GEMINI_MODEL?.trim()||'gemini-3.8-flash';
const ai=new GoogleGenAI({apiKey,httpOptions:{retryOptions:{attempts:1}}});

const findingSchema={type:'object',properties:{subject:{type:'string',enum:['maternal','child','patient','caregiver','unclear']},kind:{type:'string',enum:['measurement','symptom','medicine','history','feeding','counseling','follow_up','other']},field:{type:'string'},value:{type:'string'},unit:{type:'string'},source_quote:{type:'string'},needs_verification:{type:'boolean'}},required:['subject','kind','field','value','unit','source_quote','needs_verification']};
const extractionSchema={type:'object',properties:{findings:{type:'array',items:findingSchema},follow_up_mentions:{type:'array',items:{type:'string'}},other_details:{type:'array',items:{type:'string'}},unclear_or_missing:{type:'array',items:{type:'string'}}},required:['findings','follow_up_mentions','other_details','unclear_or_missing']};
const reportSchema={type:'object',properties:{title:{type:'string'},patient_summary:{type:'string'},chief_complaints:{type:'array',items:{type:'string'}},vitals_table:{type:'array',items:{type:'object',properties:{parameter:{type:'string'},value:{type:'string'},reference:{type:'string'},status:{type:'string',enum:['recorded','abnormal','not_reported','unclear']}},required:['parameter','value','reference','status']}},observations:{type:'array',items:{type:'string'}},assessment:{type:'array',items:{type:'string'}},plan:{type:'array',items:{type:'string'}},simple_summary_local:{type:'string'},encounter_summary:{type:'string'},maternal_findings:{type:'array',items:findingSchema},child_findings:{type:'array',items:findingSchema},patient_findings:{type:'array',items:findingSchema},caregiver_findings:{type:'array',items:findingSchema},medicines:{type:'array',items:findingSchema},symptoms_and_observations:{type:'array',items:findingSchema},counseling_and_actions:{type:'array',items:findingSchema},other_details:{type:'array',items:{type:'string'}},follow_up:{type:'array',items:{type:'string'}},items_to_verify:{type:'array',items:{type:'string'}},literal_transcript:{type:'string'}},required:['title','patient_summary','chief_complaints','vitals_table','observations','assessment','plan','simple_summary_local','encounter_summary','maternal_findings','child_findings','patient_findings','caregiver_findings','medicines','symptoms_and_observations','counseling_and_actions','other_details','follow_up','items_to_verify','literal_transcript']};

export class GeminiReportError extends Error{
  constructor(message,status=502){super(message);this.name='GeminiReportError';this.status=status;}
}
const statusOf=error=>Number(error?.status||error?.statusCode||error?.response?.status||0);
const retryable=status=>status===429||(status>=500&&status<=599);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function retryDelayMs(error,status,attempt){
  if(status===429){
    const detail=String(error?.message||'');
    const retryIn=detail.match(/retry(?:\s+in|\s+after)\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?)/i);
    if(retryIn){const amount=Number(retryIn[1]);const unit=retryIn[2].toLowerCase();const multiplier=unit==='ms'?1:/^(m|min|mins|minutes?)$/.test(unit)?60000:1000;return Math.min(120000,Math.max(1000,Math.ceil(amount*multiplier)));}
    return [2000,5000,12000][attempt]||12000;
  }
  return [500,1000,2000][attempt]||2000;
}

async function generateStructured(schema,prompt){
  for(let attempt=0;;attempt++){
    try{
      const response=await ai.models.generateContent({model,contents:prompt,config:{responseMimeType:'application/json',responseJsonSchema:schema,}});
      if(!response.text)throw new GeminiReportError('Gemini returned an empty structured response.');
      try{return JSON.parse(response.text)}catch{throw new GeminiReportError('Gemini returned invalid structured report data.');}
    }catch(error){
      if(error instanceof GeminiReportError)throw error;
      const status=statusOf(error);
      if(!retryable(status)||attempt>=3){
        const message=status===429?'Gemini is rate-limiting requests right now. Wait briefly, then select Retry. No report changes were saved.':retryable(status)?'Gemini is temporarily unavailable right now. Select Retry in a moment. No report changes were saved.':'Gemini could not generate this report. Check the server configuration and retry.';
        throw new GeminiReportError(message,status||502);
      }
      await sleep(retryDelayMs(error,status,attempt));
    }
  }
}

const escapeRegExp=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function deidentifyTranscript(transcript,patient){
  let text=String(transcript||'');
  const restore=[];
  const values=[];
  const add=(value,minimum=3)=>{
    if(value===null||value===undefined)return;
    if(typeof value==='object'){for(const nested of Object.values(value))add(nested);return;}
    if(typeof value==='boolean'||typeof value==='number')return;
    const normalized=String(value).trim();
    if(normalized.length>=minimum)values.push(normalized);
  };
  add(patient.name,1);add(patient.id,1);add(patient.phone,1);add(patient.address,2);add(patient.village,2);add(patient.guardian,1);add(patient.relevantInfo);add(patient.gender,2);add(patient.age);add(patient.maternalProfile);add(patient.childProfile);add(patient.motherName,1);
  const unique=[...new Set(values)].sort((a,b)=>b.length-a.length);
  for(const [index,value] of unique.entries()){
    const token=`[PROFILE_${index+1}]`;
    const pattern=new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`,'giu');
    if(pattern.test(text)){pattern.lastIndex=0;text=text.replace(pattern,token);restore.push([token,value]);}
  }
  const profileNumbers=[
    [patient.age,'(?:age|aged|उम्र|आयु)'],
    [patient.maternalProfile?.gravida,'(?:gravida|गर्भधारण)'],
    [patient.maternalProfile?.parity,'(?:parity|प्रसव)'],
    [patient.maternalProfile?.ancVisitNumber,'(?:ANC(?:\\s+visit)?(?:\\s+number)?|antenatal visit|एएनसी)'],
    [patient.childProfile?.ageMonths,'(?:child age|baby age|age|उम्र|आयु)'],
    [patient.childProfile?.birthWeightKg,'(?:birth weight|जन्म के समय वजन)'],
  ];
  for(const [index,[value,label]] of profileNumbers.entries()){
    if(value===null||value===undefined)continue;
    const token=`[PROFILE_NUMBER_${index+1}]`;
    const pattern=new RegExp(`(?:${label})\\s*(?:is|was|है|था|नंबर)?\\s*${escapeRegExp(String(value))}(?![\\d.])(?:\\s*(?:years?|yrs?|months?|साल|वर्ष|महीने|kg|किलो))?`,'giu');
    if(pattern.test(text)){pattern.lastIndex=0;text=text.replace(pattern,token);restore.push([token,String(value)]);}
  }
  const fixedPatterns=[
    [/(?:\+?91[\s-]?)?[6-9]\d{9}\b/g,'[REDACTED_CONTACT]'],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[REDACTED_EMAIL]'],
    [/\bAR-\d{3,}\b/gi,'[REDACTED_RECORD_ID]'],
    [/\b(?:\d[ -]*?){12}\b/g,'[REDACTED_ID_NUMBER]'],
  ];
  for(const [pattern,token] of fixedPatterns)text=text.replace(pattern,token);
  return {text,restore};
}
function restoreLocally(value,mappings){
  if(typeof value==='string')return mappings.reduce((text,[token,replacement])=>text.split(token).join(replacement),value);
  if(Array.isArray(value))return value.map(item=>restoreLocally(item,mappings));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,restoreLocally(item,mappings)]));
  return value;
}
const sourceQuote=f=>f.source_quote||'';
function mergeExtractionIntoReport(extraction,report){
  const add=(key,finding)=>{report[key]=Array.isArray(report[key])?report[key]:[];if(!report[key].some(item=>item.field===finding.field&&item.value===finding.value&&item.subject===finding.subject))report[key].push(finding)};
  for(const finding of extraction.findings||[]){
    if(finding.kind==='medicine')add('medicines',finding);
    else if(finding.kind==='symptom')add('symptoms_and_observations',finding);
    else if(finding.kind==='counseling')add('counseling_and_actions',finding);
    else if(finding.subject==='maternal')add('maternal_findings',finding);
    else if(finding.subject==='child')add('child_findings',finding);
    else if(finding.subject==='caregiver')add('caregiver_findings',finding);
    else add('patient_findings',finding);
  }
  report.other_details=[...new Set([...(report.other_details||[]),...(extraction.other_details||[])])];
  const extractedFollowUps=(extraction.findings||[]).filter(f=>f.kind==='follow_up').map(f=>[f.field,f.value].filter(Boolean).join(': '));
  report.follow_up=[...new Set([...(report.follow_up||[]),...(extraction.follow_up_mentions||[]),...extractedFollowUps])];
  report.items_to_verify=[...new Set([...(report.items_to_verify||[]),...(extraction.unclear_or_missing||[])])];
  return report;
}

export async function generateVisitReport({transcript,patient}){
  const {text,restore}=deidentifyTranscript(transcript,patient||{});
  const extraction=await generateStructured(extractionSchema,`Extract every distinct detail from this de-identified community-health visit transcript. Return only facts explicitly stated. Do not diagnose, infer, add treatment advice, or omit repeated distinct readings. Preserve units and exact source quotes. Mark ambiguous content for verification. Classify each finding by subject and kind. The only patient content in this request is the transcript below; bracketed PROFILE and REDACTED tokens are placeholders.\n\nTRANSCRIPT:\n${text}`);
  const report=await generateStructured(reportSchema,`Create a professional, clinician-readable community health visit documentation report using only this de-identified transcript. This is documentation, not diagnosis or treatment advice. Do not infer or add facts. Include every distinct detail in the appropriate structured section, preserve source quotes, values and units, and include ambiguous or unclear details in items_to_verify. Return patient_summary, chief_complaints, vitals_table, observations, assessment, plan, and simple_summary_local as well as the detailed legacy sections. Vitals must list every distinct stated measurement; use Not reported for absent readings and status not_reported. Use assessment wording only as AI-suggested for clinician review, never a diagnosis. Plans may repeat only worker-stated actions, referrals, or follow-up. The local-language summary should be concise and contain only recorded information. Keep literal_transcript exactly equal to the transcript text below. The only patient content in this request is the transcript; bracketed tokens are placeholders.\n\nTRANSCRIPT:\n${text}`);
  const restoredExtraction=restoreLocally(extraction,restore);
  const restoredReport=restoreLocally(report,restore);
  restoredReport.literal_transcript=String(transcript||'');
  mergeExtractionIntoReport(restoredExtraction,restoredReport);
  const deterministic=buildDeterministicDocumentation(restoredExtraction,String(transcript||''));
  Object.assign(restoredReport,deterministic);
  return {model,generatedAt:new Date().toISOString(),status:'draft',version:1,extraction:restoredExtraction,report:restoredReport};
}


function buildDeterministicDocumentation(extraction, transcript){
 const x=extractionTemplate();
 x.visit.type=extraction.follow_up_mentions?.[0]||null;
 for(const finding of extraction.findings||[]){
  const text=`${finding.field} ${finding.value} ${finding.unit}`.toLowerCase();
  const num=Number(String(finding.value).match(/-?\d+(?:\.\d+)?/)?.[0]);
  if(/blood pressure|\bbp\b|रक्तचाप/.test(text)){const pair=String(finding.value).match(/(\d{2,3})\s*[/\-]\s*(\d{2,3})/);if(pair){x.vitals.bp_systolic=Number(pair[1]);x.vitals.bp_diastolic=Number(pair[2]);}else if(Number.isFinite(num)&&/systolic/.test(text))x.vitals.bp_systolic=num;else if(Number.isFinite(num)&&/diastolic/.test(text))x.vitals.bp_diastolic=num;}
  if(/haemoglobin|hemoglobin|\bhb\b/.test(text)&&Number.isFinite(num))x.vitals.hb_g_dl=num;
  if(/temperature/.test(text)&&Number.isFinite(num))x.vitals.temperature_c=num;
  if(/weight/.test(text)&&Number.isFinite(num))x.vitals.weight_kg=num;
  if(/pregnan|antenatal|\banc\b|maternal/.test(finding.subject+' '+text))x.visit.type=x.visit.type||'Maternal health check';
  if(finding.kind==='symptom')x.complaints.push(finding.value);
  if(/bleeding|convulsion|seizure|reduced fetal movement|absent fetal movement|severe abdominal pain|leaking fluid|headache|blurred vision|swelling/i.test(finding.value)&&finding.kind==='symptom')x.danger_signs_reported.push(finding.value);
  if(finding.subject==='child'&&finding.kind==='symptom')x.child.danger_signs.push(finding.value);
  if(finding.kind==='medicine')x.medications_supplements.push({name:finding.field||finding.value,taking:/not taking|stopped|missed|does not take/i.test(finding.value)?false:/taking|takes|taking regularly/i.test(finding.value)?true:null,note:finding.value});
 }
 const flags=evaluateRiskFlags(x);
 const missing=[];
 if(!/\d{2,3}\s*[/\-]\s*\d{2,3}/.test(transcript)&&/maternal|pregnan|anc/i.test(transcript))missing.push('Blood pressure: not reported');
 if(!/\d+(?:\.\d+)?\s*(?:°?c|degrees?)/i.test(transcript))missing.push('Temperature: not reported');
 if(!extraction.findings?.some(f=>/main concern|complaint|symptom/i.test(f.field)))missing.push('Main concern or symptoms: not clearly identified');
 return {risk_flags:flags,missing_information:missing};
}

const correctionSchema={type:'object',properties:{patch:{type:'object',properties:{title:{type:'string'},encounter_summary:{type:'string'}},required:[]},operations:{type:'array',items:{type:'object',properties:{action:{type:'string',enum:['remove','replace']},section:{type:'string',enum:['chief_complaints','vitals_table','observations','assessment','plan','risk_flags','missing_information','maternal_findings','child_findings','patient_findings','caregiver_findings','medicines','symptoms_and_observations','counseling_and_actions','other_details','follow_up','items_to_verify']},target:{type:'string'},value:{type:'string'}},required:['action','section','target','value']}},spoken_confirmation:{type:'string'},clarifying_question:{type:'string'}},required:['patch','operations','spoken_confirmation','clarifying_question']};
export async function correctReport({transcript,patient,currentReport}){
 const {text,restore}=deidentifyTranscript(transcript,patient||{});
 const reportText=deidentifyTranscript(JSON.stringify(currentReport),patient||{}).text;
 const result=await generateStructured(correctionSchema,`Interpret a spoken request to remove one specific existing report item or replace one specific value. Prefer an operations entry with action remove or replace, exact section, exact target taken from current report, and replacement value. Do not add facts, interpret clinical meaning, or change unmentioned items. Use only items actually present in the report. If target, action, section, or replacement is ambiguous, return no operation and ask one short clarifying_question. Use patch only for title or encounter_summary when explicitly asked. The current report is ${reportText}. Spoken correction: ${text}`);
 result.patch=restoreLocally(result.patch,restore);
 result.spoken_confirmation=restoreLocally(result.spoken_confirmation,restore);
 result.clarifying_question=restoreLocally(result.clarifying_question,restore);
 return result;
}
export function deidentifyForVoice(text,patient){return deidentifyTranscript(text,patient||{}).text;}

const readbackSchema={type:'object',properties:{script:{type:'string'}},required:['script']};
export async function generateReadbackScript({report,patient,language,scope='full'}){
 const safe=deidentifyTranscript(JSON.stringify(report||{}),patient||{}).text;
 const languageNames={'hi-IN':'Hindi','en-IN':'English','bn-IN':'Bengali','gu-IN':'Gujarati','kn-IN':'Kannada','ml-IN':'Malayalam','mr-IN':'Marathi','pa-IN':'Punjabi','ta-IN':'Tamil','te-IN':'Telugu'};
 const result=await generateStructured(readbackSchema,`Write a concise spoken read-back in ${languageNames[language]||'Hindi'} for an ASHA worker to read to the patient. This is documentation, never diagnosis or treatment. Use only the sanitized JSON facts below. Avoid patient name, village, phone, IDs, and other identifiers. Include the reported vitals first, then complaints, any deterministic risk flags with their recorded action, documented plan, and missing key information. Keep the full script under about 80 words. ${scope==='changes'?'Read only the updated fields in this JSON patch.':''} Do not invent or interpret. JSON: ${safe}`);
 return result.script;
}
