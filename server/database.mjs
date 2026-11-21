import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import visitRequirements from '../shared/visit-requirements.json' with { type: 'json' };

export function openDatabase(filename, legacyJsonPath, seed) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_credentials (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS patient_credentials (patient_id TEXT PRIMARY KEY, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL,
      gender TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      village TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
      guardian TEXT NOT NULL DEFAULT '', relevant_info TEXT,
      profile_type TEXT NOT NULL DEFAULT 'general', mother_id TEXT REFERENCES patients(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '', transcript TEXT NOT NULL DEFAULT '', followup TEXT NOT NULL DEFAULT '',
      patient_name_snapshot TEXT, age_years_snapshot INTEGER, temperature_c REAL,
      completion_status TEXT NOT NULL DEFAULT 'draft', ai_report_json TEXT, UNIQUE(patient_id, position)
    );
    CREATE TABLE IF NOT EXISTS maternal_profiles (
      patient_id TEXT PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
      gestational_age TEXT, gravida INTEGER, parity INTEGER, lmp TEXT, edd TEXT, anc_visit_number INTEGER,
      extra_fields TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS child_profiles (
      patient_id TEXT PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
      mother_id TEXT REFERENCES patients(id) ON DELETE SET NULL,
      date_of_birth TEXT, age_months REAL, birth_weight_kg REAL, feeding TEXT,
      extra_fields TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS maternal_visit_data (
      visit_id TEXT PRIMARY KEY REFERENCES visits(id) ON DELETE CASCADE,
      bp_systolic REAL, bp_diastolic REAL, hb_g_dl REAL, weight_kg REAL, pulse REAL, temperature_c REAL,
      gestational_age TEXT, lmp TEXT, edd TEXT, anc_visit_number INTEGER
    );
    CREATE TABLE IF NOT EXISTS child_visit_data (
      visit_id TEXT PRIMARY KEY REFERENCES visits(id) ON DELETE CASCADE,
      age_months REAL, weight_kg REAL, feeding TEXT, danger_signs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS visit_observations (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK(category IN ('maternal','child','general')),
      field_key TEXT NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL,
      unit TEXT, evidence TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'transcript'
    );
    CREATE TABLE IF NOT EXISTS visit_field_requirements (
      visit_type TEXT NOT NULL, field_key TEXT NOT NULL, label TEXT NOT NULL,
      is_compulsory INTEGER NOT NULL CHECK(is_compulsory IN (0,1)),
      field_order INTEGER NOT NULL,
      PRIMARY KEY(visit_type, field_key)
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      date TEXT NOT NULL, time TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS report_versions (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE, version INTEGER NOT NULL, report_json TEXT NOT NULL, patch_json TEXT, correction_transcript TEXT, source TEXT NOT NULL CHECK(source IN ('generated','voice','manual')), created_at TEXT NOT NULL, UNIQUE(report_id,version));
    CREATE INDEX IF NOT EXISTS report_versions_latest ON report_versions(report_id,version DESC);
    CREATE INDEX IF NOT EXISTS visits_patient_date ON visits(patient_id, date DESC);
    CREATE INDEX IF NOT EXISTS reminders_date ON reminders(date);
  `);
  ensureColumn(db,'patients','profile_type',"TEXT NOT NULL DEFAULT 'general'");
  ensureColumn(db,'patients','mother_id','TEXT REFERENCES patients(id) DEFERRABLE INITIALLY DEFERRED');
  ensureColumn(db,'visits','transcript',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'visits','ai_report_json','TEXT');
  db.exec("UPDATE visits SET transcript=notes WHERE transcript='' AND notes<>''");
  upgradeLegacyClinicalTables(db);
  const initialized = db.prepare("SELECT value FROM app_meta WHERE key='data_initialized'").get();
  const patientCount = db.prepare('SELECT COUNT(*) AS count FROM patients').get().count;
  if (!initialized && patientCount === 0) {
    let initial = seed;
    if (existsSync(legacyJsonPath)) {
      try { initial = JSON.parse(readFileSync(legacyJsonPath, 'utf8')); } catch { /* keep seed as safe fallback */ }
    }
    replaceData(db, initial);
  }
  db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES('data_initialized','1')").run();
  seedVisitFieldRequirements(db);
  return db;
}


function seedVisitFieldRequirements(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM visit_field_requirements');
    const insert = db.prepare('INSERT INTO visit_field_requirements(visit_type,field_key,label,is_compulsory,field_order) VALUES(?,?,?,?,?)');
    for (const visit of visitRequirements) visit.fields.forEach((field, index) => insert.run(visit.visitType, field.key, field.label, field.required ? 1 : 0, index));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function readVisitFieldRequirements(db) {
  const result = new Map();
  for (const row of db.prepare('SELECT visit_type,field_key,label,is_compulsory FROM visit_field_requirements ORDER BY visit_type,field_order').all()) {
    if (!result.has(row.visit_type)) result.set(row.visit_type, { visitType: row.visit_type, fields: [] });
    result.get(row.visit_type).fields.push({ key: row.field_key, label: row.label, required: Boolean(row.is_compulsory) });
  }
  return [...result.values()];
}

function upgradeLegacyClinicalTables(db) {
  db.exec(`
    UPDATE patients SET profile_type='maternal' WHERE profile_type='general' AND id IN (
      SELECT patient_id FROM visits WHERE lower(type) LIKE '%maternal%' OR lower(type) LIKE '%antenatal%' OR lower(type) LIKE '%pregnan%' OR lower(type) LIKE 'anc%'
    );
    UPDATE patients SET profile_type='child' WHERE profile_type='general' AND id IN (
      SELECT patient_id FROM visits WHERE lower(type) LIKE '%child%' OR lower(type) LIKE '%newborn%' OR lower(type) LIKE '%hbnc%' OR lower(type) LIKE '%immuni%'
    );
    UPDATE patients SET profile_type='child' WHERE profile_type='general' AND age < 18;
    INSERT OR IGNORE INTO maternal_profiles(patient_id) SELECT id FROM patients WHERE profile_type='maternal';
    INSERT OR IGNORE INTO child_profiles(patient_id) SELECT id FROM patients WHERE profile_type='child';
  `);
  const visits=db.prepare(`SELECT v.id,v.type,v.transcript,v.temperature_c,p.profile_type FROM visits v JOIN patients p ON p.id=v.patient_id WHERE NOT EXISTS(SELECT 1 FROM visit_observations o WHERE o.visit_id=v.id)`).all();
  const insert=db.prepare('INSERT OR IGNORE INTO visit_observations(id,visit_id,category,field_key,label,value,unit,evidence,source) VALUES(?,?,?,?,?,?,?,?,?)');
  const put=(row,key,label,value,unit,evidence)=>insert.run(`${row.id}-${key}`,row.id,row.profile_type==='maternal'?'maternal':row.profile_type==='child'?'child':'general',key,label,value,unit,evidence,'transcript');
  for(const row of visits){
    const source=row.transcript||'';
    const specs=[
      ['bp_systolic','Systolic blood pressure',/(?:\bBP\b|blood pressure|बीपी)\s*(?:है\s*)?([0-9]{2,3})\s*[/／]\s*([0-9]{2,3})/i,'mmHg',0],
      ['hb_g_dl','Haemoglobin',/(?:\bHb\b|haemoglobin|hemoglobin|हीमोग्लोबिन)\s*(?:है\s*)?([0-9]+(?:\.[0-9]+)?)/i,'g/dL',0],
      ['weight_kg','Weight',/(?:weight|वजन)\s*(?:is|है)?\s*([0-9]+(?:\.[0-9]+)?)\s*(kg|किलो)?/i,'kg',0],
    ];
    for(const [key,label,re,unit,index] of specs){const match=source.match(re);if(match)put(row,key,label,match[index+1],unit,match[0]);if(key==='bp_systolic'&&match)put(row,'bp_diastolic','Diastolic blood pressure',match[2],'mmHg',match[0]);}
    if(row.temperature_c!==null)put(row,'temperature_c','Body temperature',String(row.temperature_c),'°C','Entered as a measured visit field');
    if(source.trim())for(const [key,label,re] of [['headache','Headache',/\bheadache\b|सिरदर्द/i],['pedal_edema','Pedal edema / foot swelling',/pedal edema|swelling of (?:the )?feet|पैर में सूजन/i],['dizziness','Dizziness',/\bdizziness\b|\bchakkar\b|चक्कर/i],['fever','Fever',/\bfever\b|बुखार/i]]){const match=source.match(re);if(match)put(row,key,label,'Reported',null,match[0]);}
    syncVisitSubtypeData(db,row.id,row.profile_type,row.temperature_c);
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function replaceData(db, data) {
  if (!data || !Array.isArray(data.patients) || !Array.isArray(data.reminders)) throw new Error('Invalid application data');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM reminders; DELETE FROM patients;');
    const insertPatient = db.prepare(`INSERT INTO patients(id,name,age,gender,phone,village,address,guardian,relevant_info,profile_type,mother_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const insertVisit = db.prepare(`INSERT INTO visits(id,patient_id,position,date,type,notes,transcript,followup,patient_name_snapshot,age_years_snapshot,temperature_c,completion_status,ai_report_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertMaternal = db.prepare('INSERT INTO maternal_profiles(patient_id,gestational_age,gravida,parity,lmp,edd,anc_visit_number,extra_fields) VALUES(?,?,?,?,?,?,?,?)');
    const insertChild = db.prepare('INSERT INTO child_profiles(patient_id,mother_id,date_of_birth,age_months,birth_weight_kg,feeding,extra_fields) VALUES(?,?,?,?,?,?,?)');
    for (const patient of data.patients) {
      if (!patient || typeof patient.id !== 'string' || typeof patient.name !== 'string' || !Number.isFinite(Number(patient.age))) throw new Error('Invalid patient record');
      const profileType=['maternal','child','general'].includes(patient.profileType)?patient.profileType:'general';
      insertPatient.run(patient.id,patient.name,Number(patient.age),patient.gender||'',patient.phone||'',patient.village||'',patient.address||'',patient.guardian||'',patient.relevantInfo||null,profileType,null);
    }
    for (const patient of data.patients) {
      const type=['maternal','child','general'].includes(patient.profileType)?patient.profileType:'general';
      if (type==='maternal') { const m=patient.maternalProfile||{}; insertMaternal.run(patient.id,m.gestationalAge||null,m.gravida??null,m.parity??null,m.lmp||null,m.edd||null,m.ancVisitNumber??null,JSON.stringify(m.extraFields||{})); }
      if (type==='child') { const c=patient.childProfile||{}; insertChild.run(patient.id,patient.motherId||null,c.dateOfBirth||null,c.ageMonths??null,c.birthWeightKg??null,c.feeding||null,JSON.stringify(c.extraFields||{})); }
      for (const [position, visit] of (patient.notes||[]).entries()) {
        insertVisit.run(visit.id,patient.id,position,visit.date||'',visit.type||'',visit.notes||'',visit.transcript||visit.notes||'',visit.followup||'',visit.patientNameSnapshot||null,visit.ageYearsSnapshot??null,visit.temperatureC??null,visit.completionStatus||'draft',visit.aiReport?JSON.stringify(visit.aiReport):null);
        persistVisitData(db,visit,type);
      }
    }
    const insertReminder = db.prepare(`INSERT INTO reminders(id,patient_id,date,time,type,note) VALUES(?,?,?,?,?,?)`);
    db.prepare('DELETE FROM patient_credentials WHERE patient_id NOT IN (SELECT id FROM patients)').run();
    for (const reminder of data.reminders) {
      insertReminder.run(reminder.id,reminder.patientId,reminder.date||'',reminder.time||'',reminder.type||'',reminder.note||'');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function persistVisitData(db, visit, profileType) {
  const observations=Array.isArray(visit.observations)?visit.observations:[];
  const category=observations[0]?.category|| (profileType==='maternal'?'maternal':profileType==='child'?'child':'general');
  const insert=db.prepare('INSERT INTO visit_observations(id,visit_id,category,field_key,label,value,unit,evidence,source) VALUES(?,?,?,?,?,?,?,?,?)');
  observations.forEach((item,index)=>insert.run(item.id||`${visit.id}-${index}`,visit.id,item.category||category,item.fieldKey||item.label?.toLowerCase().replace(/[^a-z0-9]+/g,'_')||`field_${index}`,item.label||'Recorded field',String(item.value??''),item.unit||null,item.evidence||'',item.source||'transcript'));
  syncVisitSubtypeData(db,visit.id,category,visit.temperatureC);
}

function syncVisitSubtypeData(db,visitId,profileType,temperatureC) {
  const all=db.prepare('SELECT category,field_key,value,label FROM visit_observations WHERE visit_id=?').all(visitId);
  const categories=new Set(all.map(item=>item.category).filter(category=>category==='maternal'||category==='child'));
  if(!categories.size&& (profileType==='maternal'||profileType==='child'))categories.add(profileType);
  for(const category of categories){
    const observations=all.filter(item=>item.category===category);
    const values=new Map(observations.map(item=>[item.field_key,String(item.value??'')]));
    const numeric=(key)=>{const match=values.get(key)?.match(/-?\d+(?:\.\d+)?/);return match?Number(match[0]):null};
    const weightValue=values.get('weight_kg');
    const weightNumber=weightValue?.match(/-?\d+(?:\.\d+)?/);
    const weightKg=weightNumber?( /(?:^|\s)(?:g|gram|grams|ग्राम)(?:$|\s)/i.test(weightValue||'')&&!/kg|kilo/i.test(weightValue||'')?Number(weightNumber[0])/1000:Number(weightNumber[0])):null;
    if(category==='maternal') db.prepare('INSERT OR REPLACE INTO maternal_visit_data(visit_id,bp_systolic,bp_diastolic,hb_g_dl,weight_kg,pulse,temperature_c,gestational_age,lmp,edd,anc_visit_number) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(visitId,numeric('bp_systolic'),numeric('bp_diastolic'),numeric('hb_g_dl')??numeric('haemoglobin'),weightKg,numeric('pulse'),temperatureC??numeric('temperature_c'),values.get('gestational_age')||null,values.get('lmp')||null,values.get('edd')||null,numeric('anc_visit_number'));
    if(category==='child') db.prepare('INSERT OR REPLACE INTO child_visit_data(visit_id,age_months,weight_kg,feeding,danger_signs) VALUES(?,?,?,?,?)').run(visitId,numeric('age_months'),weightKg,values.get('feeding')||null,JSON.stringify(observations.filter(x=>x.field_key==='danger_signs_reported'||/danger|poor feeding|breathing|fever|convulsion|seizure/i.test(x.label||'')).flatMap(x=>String(x.value||'').split(/[,;\n]/).map(value=>value.trim()).filter(Boolean))));
  }
}

export function readData(db) {
  const patients = db.prepare('SELECT id,name,age,gender,phone,village,address,guardian,relevant_info,profile_type,mother_id FROM patients ORDER BY rowid').all().map((row) => ({
    id:row.id,name:row.name,age:row.age,gender:row.gender,phone:row.phone,village:row.village,address:row.address,guardian:row.guardian,
    ...(row.relevant_info ? {relevantInfo:row.relevant_info} : {}),profileType:row.profile_type,...(row.mother_id?{motherId:row.mother_id}:{}),notes:[]
  }));
  for (const row of db.prepare('SELECT * FROM maternal_profiles').all()) { const p=patients.find(item=>item.id===row.patient_id); if(p)p.maternalProfile={gestationalAge:row.gestational_age,gravida:row.gravida,parity:row.parity,lmp:row.lmp,edd:row.edd,ancVisitNumber:row.anc_visit_number,extraFields:JSON.parse(row.extra_fields||'{}')}; }
  for (const row of db.prepare('SELECT * FROM child_profiles').all()) { const p=patients.find(item=>item.id===row.patient_id); if(p){p.motherId=row.mother_id||undefined;p.childProfile={dateOfBirth:row.date_of_birth,ageMonths:row.age_months,birthWeightKg:row.birth_weight_kg,feeding:row.feeding,extraFields:JSON.parse(row.extra_fields||'{}')};} }
  const byId = new Map(patients.map((patient) => [patient.id,patient]));
  const visits = db.prepare('SELECT * FROM visits ORDER BY patient_id, position').all();
  for (const row of visits) byId.get(row.patient_id)?.notes.push({
    id:row.id,date:row.date,type:row.type,notes:row.transcript||row.notes,transcript:row.transcript||row.notes,followup:row.followup,
    ...(row.patient_name_snapshot ? {patientNameSnapshot:row.patient_name_snapshot} : {}),
    ...(row.age_years_snapshot !== null ? {ageYearsSnapshot:row.age_years_snapshot} : {}),
    ...(row.temperature_c !== null ? {temperatureC:row.temperature_c} : {}),completionStatus:row.completion_status,
    ...(row.ai_report_json?{aiReport:JSON.parse(row.ai_report_json)}:{}),
    observations:db.prepare('SELECT category,field_key AS fieldKey,label,value,unit,evidence,source FROM visit_observations WHERE visit_id=?').all(row.id)
  });
  const reminders = db.prepare('SELECT id,patient_id,date,time,type,note FROM reminders ORDER BY rowid').all().map((row) => ({id:row.id,patientId:row.patient_id,date:row.date,time:row.time,type:row.type,note:row.note}));
  return { patients, reminders };
}

export function writeData(db, data) { replaceData(db, data); }

export function saveAiReport(db,visitId,report,{source='generated',patch=null,correctionTranscript=null}={}){
 const result=db.prepare('UPDATE visits SET ai_report_json=? WHERE id=?').run(JSON.stringify(report),visitId);
 if(result.changes!==1)throw new Error('Saved visit was not found.');
 const version=(db.prepare('SELECT COALESCE(MAX(version),0)+1 AS next FROM report_versions WHERE report_id=?').get(visitId)).next;
 db.prepare('INSERT INTO report_versions(id,report_id,version,report_json,patch_json,correction_transcript,source,created_at) VALUES(?,?,?,?,?,?,?,?)').run(`${visitId}-v${version}`,visitId,version,JSON.stringify(report),patch?JSON.stringify(patch):null,correctionTranscript,source,new Date().toISOString());
 return version;
}
export function readReportVersions(db,visitId){return db.prepare('SELECT id,version,report_json AS reportJson,patch_json AS patchJson,correction_transcript AS correctionTranscript,source,created_at AS createdAt FROM report_versions WHERE report_id=? ORDER BY version DESC').all(visitId).map(row=>({...row,reportJson:JSON.parse(row.reportJson),patchJson:row.patchJson?JSON.parse(row.patchJson):null}));}
export function undoReportVersion(db,visitId){
 const rows=db.prepare('SELECT version,report_json FROM report_versions WHERE report_id=? ORDER BY version DESC LIMIT 2').all(visitId);
 if(rows.length<2)return null;
 const previous=JSON.parse(rows[1].report_json);
 db.prepare('DELETE FROM report_versions WHERE report_id=? AND version=?').run(visitId,rows[0].version);
 db.prepare('UPDATE visits SET ai_report_json=? WHERE id=?').run(JSON.stringify(previous),visitId);
 return previous;
}
export function confirmReport(db,visitId){const result=db.prepare("UPDATE visits SET completion_status='complete' WHERE id=? AND ai_report_json IS NOT NULL").run(visitId);return result.changes===1;}


export function defaultDatabasePaths(moduleUrl) {
  const root = dirname(new URL(moduleUrl).pathname);
  return { sqlite:resolve(root,'arova.sqlite'), legacyJson:resolve(root,'data.json') };
}
