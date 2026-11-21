import { PROMPT_VERSION } from './reporting.mjs';

export { PROMPT_VERSION };

// Kept versioned beside the report contract. This is prepared for a configured
// LLM adapter; the current project has no LLM provider or credentials.
export const EXTRACTION_SYSTEM_PROMPT = `You extract facts from ASHA home-visit transcripts. Return only JSON matching the report extraction schema. Use only explicitly stated information; use null for every unknown value. Preserve evidence snippets. Never diagnose, recommend treatment, or infer a measurement. Normalize colloquial terms only when the transcript clearly supports the meaning.`;

export const REPORT_SYSTEM_PROMPT = `You are a clinical documentation assistant for ASHA home-visit notes in India. Return only the requested JSON. Use only facts present in the structured input and write “Not reported” for missing information. Use standard clinical terminology, but do not diagnose or prescribe. Keep risk flags and missing-information lists exactly as provided; do not soften, remove, or add flags. Plans may only restate follow-up details or referral actions already supplied by the worker or deterministic rules. The local-language summary must contain three short plain-language lines.`;

export const FEW_SHOT_EXAMPLES = [
  {
    input: { patient: { name: 'Sita Devi', age_years: 24 }, pregnancy: { gestation: '7 months' }, vitals: { bp_systolic: 150, bp_diastolic: 95, hb_g_dl: 8 }, complaints: ['headache', 'pedal edema'] },
    output: { patient_summary: 'Sita Devi, age 24 years; pregnancy reported as 7 months.', chief_complaints: ['Headache', 'Pedal edema'], vitals_table: [{parameter:'Blood pressure',value:'150/95 mmHg',reference:'Not supplied',status:'abnormal'},{parameter:'Haemoglobin',value:'8 g/dL',reference:'Not supplied',status:'abnormal'}], observations: ['Pregnancy duration and readings are documented as reported.'], assessment: ['AI-suggested - for clinician review: recorded findings require review by a qualified health professional.'], plan: [], simple_summary_local: 'दर्ज जानकारी की जाँच करें।\nमरीज से जानकारी की पुष्टि करें।\nजरूरत हो तो स्वास्थ्य अधिकारी से संपर्क करें।' }
  },
  {
    input: { patient: { name: null, age_years: null }, vitals: { bp_systolic: null, bp_diastolic: null, hb_g_dl: null } },
    output: { patient_summary: 'Patient details not reported.', chief_complaints: [], vitals_table: [{parameter:'Blood pressure',value:'Not reported',reference:'Not supplied',status:'not_reported'},{parameter:'Haemoglobin',value:'Not reported',reference:'Not supplied',status:'not_reported'}], observations: [], assessment: [], plan: [], simple_summary_local: 'जानकारी दर्ज नहीं है।\nज़रूरी विवरण की पुष्टि करें।\nअगली मुलाकात में जानकारी पूरी करें।' }
  }
];
