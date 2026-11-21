import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, readData, writeData, saveAiReport, readReportVersions, undoReportVersion, confirmReport } from './database.mjs';

test('migrates legacy JSON data into normalized SQLite tables and preserves nested visits', () => {
  const dir = mkdtempSync(join(tmpdir(),'arova-sql-'));
  const json = join(dir,'data.json');
  const dbPath = join(dir,'arova.sqlite');
  const source = {patients:[
    {id:'C1',name:'Child',age:1,gender:'Female',phone:'',village:'A',address:'',guardian:'',profileType:'child',motherId:'M1',childProfile:{ageMonths:12,birthWeightKg:2.5,feeding:'As reported'},notes:[{id:'V2',date:'2026-01-03',type:'Child wellness',notes:'weight 8 kg',observations:[{category:'child',fieldKey:'weight_kg',label:'Weight',value:'8 kg',evidence:'weight 8 kg'}]}]},
    {id:'M1',name:'Parent',age:30,gender:'Female',phone:'',village:'A',address:'',guardian:'',profileType:'maternal',maternalProfile:{gestationalAge:'Not currently pregnant',gravida:2,parity:1,lmp:'',edd:'',ancVisitNumber:null},notes:[{id:'V1',date:'2026-01-01',type:'ANC',notes:'BP 120/80',followup:'',temperatureC:36.8,completionStatus:'complete',observations:[{category:'maternal',fieldKey:'bp_systolic',label:'Systolic BP',value:'120 mmHg',evidence:'BP 120/80'}]}]}
  ],reminders:[{id:'R1',patientId:'M1',date:'2026-01-02',time:'09:00',type:'Follow-up',note:''}]};
  writeFileSync(json,JSON.stringify(source));
  const db = openDatabase(dbPath,json,{patients:[],reminders:[]});
  const migrated=readData(db);
  assert.equal(migrated.patients.find(p=>p.id==='M1').profileType,'maternal');
  assert.equal(migrated.patients.find(p=>p.id==='M1').maternalProfile.gravida,2);
  assert.equal(migrated.patients.find(p=>p.id==='C1').motherId,'M1');
  assert.equal(migrated.patients.find(p=>p.id==='C1').childProfile.birthWeightKg,2.5);
  assert.equal(migrated.patients.find(p=>p.id==='M1').notes[0].transcript,'BP 120/80');
  assert.equal(migrated.patients.find(p=>p.id==='C1').notes[0].observations[0].fieldKey,'weight_kg');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM maternal_profiles').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM child_profiles').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM maternal_visit_data').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM child_visit_data').get().n,1);
  db.close(); rmSync(dir,{recursive:true,force:true});
});

test('replaces data transactionally and preserves the prior data on invalid input', () => {
  const dir = mkdtempSync(join(tmpdir(),'arova-sql-'));
  const db = openDatabase(join(dir,'arova.sqlite'),join(dir,'missing.json'),{patients:[{id:'P1',name:'Example',age:30,notes:[]}],reminders:[]});
  const before = readData(db);
  assert.throws(() => writeData(db,{patients:[{id:'P2',name:'Invalid',age:'unknown'}],reminders:[]}));
  assert.deepEqual(readData(db),before);
  db.close(); rmSync(dir,{recursive:true,force:true});
});

test('retains data inside relational child and maternal tables after API-style replacement', () => {
  const dir=mkdtempSync(join(tmpdir(),'arova-sql-'));
  const db=openDatabase(join(dir,'arova.sqlite'),join(dir,'missing.json'),{patients:[],reminders:[]});
  writeData(db,{patients:[
    {id:'M1',name:'Parent',age:25,profileType:'maternal',maternalProfile:{gravida:1,parity:0},notes:[]},
    {id:'C1',name:'Child',age:0,profileType:'child',motherId:'M1',childProfile:{birthWeightKg:3},notes:[{id:'V1',date:'2026-05-01',type:'HBNC',notes:'feeding okay',observations:[{category:'child',fieldKey:'feeding',label:'Feeding',value:'okay',evidence:'feeding okay'}]}]}
  ],reminders:[]});
  assert.equal(db.prepare('SELECT gravida FROM maternal_profiles WHERE patient_id=?').get('M1').gravida,1);
  assert.equal(db.prepare('SELECT birth_weight_kg FROM child_profiles WHERE patient_id=?').get('C1').birth_weight_kg,3);
  assert.equal(db.prepare('SELECT value FROM visit_observations WHERE field_key=?').get('feeding').value,'okay');
  db.close();rmSync(dir,{recursive:true,force:true});
});


test('stores report revisions, restores the previous version, and confirms the saved report',()=>{
 const dir=mkdtempSync(join(tmpdir(),'arova-report-'));
 const db=openDatabase(join(dir,'arova.sqlite'),join(dir,'missing.json'),{patients:[{id:'P1',name:'Fake Patient',age:30,notes:[{id:'V1',date:'2026-01-01',type:'Routine check-in',notes:'Fake fixture'}]}],reminders:[]});
 const one={status:'draft',report:{encounter_summary:'first'}};const two={status:'draft',report:{encounter_summary:'corrected'}};
 saveAiReport(db,'V1',one);saveAiReport(db,'V1',two,{source:'voice',patch:{encounter_summary:'corrected'},correctionTranscript:'fake correction'});
 assert.equal(readReportVersions(db,'V1').length,2);
 assert.equal(undoReportVersion(db,'V1').report.encounter_summary,'first');
 assert.equal(readReportVersions(db,'V1').length,1);
 saveAiReport(db,'V1',one);assert.equal(confirmReport(db,'V1'),true);
 db.close();rmSync(dir,{recursive:true,force:true});
});
