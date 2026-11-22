import dotenv from 'dotenv';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { openDatabase, readData, readVisitFieldRequirements, saveAiReport, readReportVersions, undoReportVersion, confirmReport, writeData } from './database.mjs';
import { applyReportOperations } from './reporting.mjs';
const root=dirname(fileURLToPath(import.meta.url));
dotenv.config({path:resolve(root,'..','.env')});
if(!process.env.GEMINI_API_KEY?.trim()){
 console.error('AROVA cannot start: GEMINI_API_KEY is missing. Add it to the project .env file (see .env.example) and restart AROVA.');
 process.exit(1);
}
const {generateVisitReport,correctReport,deidentifyForVoice}=await import('./gemini.mjs');
const app=express();
const allowedOrigins=new Set((process.env.FRONTEND_ORIGINS||process.env.FRONTEND_ORIGIN||'https://arova-git-master-vanilla-latte1.vercel.app').split(',').map(origin=>origin.trim()).filter(Boolean));
const isAllowedOrigin=origin=>allowedOrigins.has(origin)||(!process.env.PORT&&/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
app.use((req,res,next)=>{
 const origin=req.get('Origin');
 if(!origin)return next();
 if(!isAllowedOrigin(origin))return res.status(403).json({error:'This origin is not allowed.'});
 res.setHeader('Access-Control-Allow-Origin',origin);
 res.setHeader('Access-Control-Allow-Credentials','true');
 res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
 res.setHeader('Access-Control-Allow-Headers',req.get('Access-Control-Request-Headers')||'Content-Type');
 res.vary('Origin');
 if(req.method==='OPTIONS')return res.sendStatus(204);
 next();
});
app.use(express.json({limit:'5mb'}));
const seed={patients:[],reminders:[]};
const db=openDatabase(resolve(root,'arova.sqlite'),resolve(root,'data.json'),seed);
const sessions=new Map();
const sessionCookie='arova_session';
const workerConfigured=()=>Boolean(db.prepare('SELECT id FROM worker_credentials WHERE id=1').get());
const cookieValue=req=>{const prefix=`${sessionCookie}=`;return String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(prefix))?.slice(prefix.length)||''};
const sessionFor=req=>{const token=cookieValue(req);const session=sessions.get(token);if(!session)return null;if(session.expiresAt<Date.now()){sessions.delete(token);return null}return session};
const requireRole=role=>(req,res,next)=>{const session=sessionFor(req);if(!session)return res.status(401).json({error:'Please sign in to continue.'});if(session.role!==role)return res.status(403).json({error:'This account does not have access to this page.'});req.arovaSession=session;next()};
const passwordRecord=password=>{const salt=randomBytes(16).toString('hex');return {salt,hash:scryptSync(password,salt,64).toString('hex')}};
const verifyPassword=(password,salt,stored)=>{try{const actual=scryptSync(password,salt,64);const expected=Buffer.from(stored,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected)}catch{return false}};
const sessionCookieAttributes=process.env.NODE_ENV==='production'?'; SameSite=None; Secure':'; SameSite=Strict';
const createSession=(res,role,patientId)=>{const token=randomBytes(32).toString('hex');sessions.set(token,{role,patientId,expiresAt:Date.now()+12*60*60*1000});res.setHeader('Set-Cookie',`${sessionCookie}=${token}; HttpOnly; Path=/; Max-Age=43200${sessionCookieAttributes}`)};
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'arova-local-api',sttConfigured:Boolean(process.env.GNANI_API_KEY),ttsConfigured:Boolean(process.env.GNANI_TTS_API_KEY||process.env.GNANI_API_KEY)}));
app.get('/api/connectivity',async(_req,res)=>{const probes=['https://www.gstatic.com/generate_204','https://connectivitycheck.gstatic.com/generate_204'].map(url=>fetch(url,{method:'HEAD',signal:AbortSignal.timeout(7000),cache:'no-store'}).then(response=>response.status===204));const results=await Promise.allSettled(probes);const internet=results.some(result=>result.status==='fulfilled'&&result.value);res.set('Cache-Control','no-store').json({internet,checkedAt:new Date().toISOString()})});
app.get('/api/auth/setup-status',(_req,res)=>res.json({workerSetupRequired:!workerConfigured()}));
app.get('/api/auth/session',(req,res)=>{const session=sessionFor(req);if(!session)return res.status(401).json({authenticated:false});res.json({authenticated:true,role:session.role,patientId:session.patientId||null})});
app.post('/api/auth/worker/setup',(req,res)=>{if(workerConfigured())return res.status(409).json({error:'The ASHA worker account is already set up. Sign in instead.'});const username=String(req.body?.username||'').trim();const password=String(req.body?.password||'');if(username.length<3||password.length<8)return res.status(400).json({error:'Use a username of at least 3 characters and a password of at least 8 characters.'});const {salt,hash}=passwordRecord(password);try{db.prepare('INSERT INTO worker_credentials(id,username,password_salt,password_hash,created_at) VALUES(1,?,?,?,?)').run(username,salt,hash,new Date().toISOString());createSession(res,'worker');res.status(201).json({role:'worker'})}catch{return res.status(409).json({error:'The worker account could not be created. Try a different username.'})}});
app.post('/api/auth/worker/login',(req,res)=>{const username=String(req.body?.username||'').trim();const password=String(req.body?.password||'');const account=db.prepare('SELECT username,password_salt,password_hash FROM worker_credentials WHERE id=1').get();if(!account||username!==account.username||!verifyPassword(password,account.password_salt,account.password_hash))return res.status(401).json({error:'Username or password is incorrect.'});createSession(res,'worker');res.json({role:'worker'})});
app.post('/api/auth/patient/login',(req,res)=>{const patientId=String(req.body?.patientId||'').trim();const password=String(req.body?.password||'');const account=db.prepare('SELECT password_salt,password_hash FROM patient_credentials WHERE patient_id=?').get(patientId);if(!account||!verifyPassword(password,account.password_salt,account.password_hash))return res.status(401).json({error:'Patient ID or password is incorrect.'});if(!db.prepare('SELECT id FROM patients WHERE id=?').get(patientId))return res.status(401).json({error:'Patient ID or password is incorrect.'});createSession(res,'patient',patientId);res.json({role:'patient'})});
app.post('/api/auth/logout',(req,res)=>{const token=cookieValue(req);if(token)sessions.delete(token);res.setHeader('Set-Cookie',`${sessionCookie}=; HttpOnly; Path=/; Max-Age=0${sessionCookieAttributes}`);res.json({ok:true})});
app.get('/api/patient/me',requireRole('patient'),(req,res)=>{const patient=readData(db).patients.find(item=>item.id===req.arovaSession.patientId);if(!patient)return res.status(404).json({error:'Patient record is unavailable.'});res.set('Cache-Control','no-store').json(patient)});
app.post('/api/patients/:patientId/access',requireRole('worker'),(req,res)=>{const patientId=String(req.params.patientId||'');if(!db.prepare('SELECT id FROM patients WHERE id=?').get(patientId))return res.status(404).json({error:'Patient record was not found.'});const password=String(req.body?.password||'');if(password.length<8)return res.status(400).json({error:'Patient passwords must be at least 8 characters.'});const {salt,hash}=passwordRecord(password);db.prepare('INSERT INTO patient_credentials(patient_id,password_salt,password_hash,created_at) VALUES(?,?,?,?) ON CONFLICT(patient_id) DO UPDATE SET password_salt=excluded.password_salt,password_hash=excluded.password_hash,created_at=excluded.created_at').run(patientId,salt,hash,new Date().toISOString());res.json({ok:true})});
app.use('/api',(req,res,next)=>{const session=sessionFor(req);if(!session)return res.status(401).json({error:'Please sign in as an ASHA worker to continue.'});if(session.role!=='worker')return res.status(403).json({error:'This endpoint is only available to ASHA workers.'});req.arovaSession=session;next()});
app.get('/api/visit-fields',(_req,res)=>res.json(readVisitFieldRequirements(db)));
app.get('/api/data',(_req,res)=>res.json(readData(db)));
app.put('/api/data',(req,res)=>{const {patients,reminders}=req.body||{};if(!Array.isArray(patients)||!Array.isArray(reminders))return res.status(400).json({error:'Expected patient and reminder lists'});try{writeData(db,{patients,reminders});res.json({ok:true,savedAt:new Date().toISOString(),storage:'sqlite'})}catch(error){res.status(400).json({error:error instanceof Error?error.message:'Could not save records'})}});
app.post('/api/reports/:visitId/generate',async(req,res)=>{
 const data=readData(db);let patient,visit;
 for(const candidate of data.patients){const found=candidate.notes.find(item=>item.id===req.params.visitId);if(found){patient=candidate;visit=found;break}}
 if(!patient||!visit)return res.status(404).json({error:'Saved visit was not found.'});
 if(!(visit.transcript||visit.notes||'').trim())return res.status(400).json({error:'Add a transcript before generating the report.'});
 try{const localPatient={...patient,motherName:data.patients.find(candidate=>candidate.id===patient.motherId)?.name||''};const result=await generateVisitReport({transcript:visit.transcript||visit.notes,patient:localPatient});result.version=saveAiReport(db,visit.id,result);res.json(result)}
 catch(error){const status=Number(error?.status)||502;res.status(status>=400&&status<=599?status:502).json({error:error instanceof Error?error.message:'Report generation failed. Please retry.'})}
});

const audioCache=new Map();
function findVisit(visitId){const data=readData(db);for(const patient of data.patients){const visit=patient.notes.find(item=>item.id===visitId);if(visit)return {data,patient,visit}}return null}
app.get('/api/reports/:visitId/versions',(req,res)=>{if(!findVisit(req.params.visitId))return res.status(404).json({error:'Saved visit was not found.'});res.json(readReportVersions(db,req.params.visitId))});
app.post('/api/reports/:visitId/undo',(req,res)=>{const previous=undoReportVersion(db,req.params.visitId);if(!previous)return res.status(409).json({error:'There is no earlier report version to restore.'});res.json(previous)});
app.post('/api/reports/:visitId/confirm',(req,res)=>{const found=findVisit(req.params.visitId);if(!found?.visit.aiReport)return res.status(404).json({error:'Generate a report before confirming it.'});const report={...found.visit.aiReport,status:'confirmed'};report.version=saveAiReport(db,found.visit.id,report,{source:'manual',patch:{status:'confirmed'}});confirmReport(db,found.visit.id);res.json({ok:true,status:'confirmed',report})});
app.post('/api/reports/:visitId/speak',async(req,res)=>{
 const found=findVisit(req.params.visitId);if(!found)return res.status(404).json({error:'Saved visit was not found.'});
 const key=process.env.GNANI_TTS_API_KEY||process.env.GNANI_API_KEY;if(!key)return res.status(503).json({error:'Gnani TTS is not configured in the backend .env file.'});
 const report=found.visit.aiReport?.report;if(!report)return res.status(409).json({error:'Generate the report before reading it aloud.'});
 const includeName=process.env.READBACK_INCLUDE_NAME==='true';const voice=process.env.GNANI_TTS_VOICE||'Kaveri';const language=req.body?.language||'hi-IN';const scope=req.body?.scope==='changes'?'changes':'full';
 const latest=readReportVersions(db,found.visit.id)[0];const speakData=scope==='changes'?(latest?.patchJson||{}):report;if(scope==='changes'&&!Object.keys(speakData).length)return res.status(409).json({error:'There are no saved report changes to read aloud.'});
 const chunks=[];const add=(label,value)=>{if(value===null||value===undefined||value==='')return;if(Array.isArray(value)){for(const item of value)add(label,item);return}if(typeof value==='object'){if(value.parameter)add(`${value.parameter}`,`${value.value||'Not reported'}${value.unit?` ${value.unit}`:''}`);else if(value.field)add(value.field,`${value.value||''}${value.unit?` ${value.unit}`:''}`);else if(value.message)add(label,`${value.message}${value.recommended_action?`. ${value.recommended_action}`:''}`);else for(const [key,item] of Object.entries(value))add(key,item);return}chunks.push(label?`${label}: ${String(value)}`:String(value))};if(scope==='changes'){for(const [key,value] of Object.entries(speakData))add(key.replaceAll('_',' '),value)}else{add('',speakData.patient_summary||speakData.encounter_summary);add('Chief complaints',speakData.chief_complaints);add('Vitals',speakData.vitals_table);add('Observations',speakData.observations);add('Assessment for clinician review',speakData.assessment);add('Risk flags',speakData.risk_flags);add('Actions and plan',speakData.plan);add('Counseling and actions',speakData.counseling_and_actions);add('Follow-up',speakData.follow_up);add('Information not reported',speakData.missing_information);add('Items to verify',speakData.items_to_verify);if(chunks.length===0)add('',speakData.simple_summary_local)}
 let script=chunks.join('. ').slice(0,7000);const voicePatient=includeName?{...found.patient,name:''}:found.patient;if(includeName)script=`${found.patient.name}. ${script}`;script=deidentifyForVoice(script,voicePatient);if(!script.trim())return res.status(409).json({error:'The report has no readable details yet. Generate or edit the report first.'});
 const {createHash}=await import('node:crypto');const cacheKey=createHash('sha256').update(`${script}|${voice}|${language}`).digest('hex');
 try{let audio=audioCache.get(cacheKey);if(!audio){const response=await fetch('https://api.vachana.ai/api/v1/tts/inference',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key-ID':key},body:JSON.stringify({text:script,voice,model:process.env.GNANI_TTS_MODEL||'timbre-v2.5',language,speed:1.0,audio_config:{sample_rate:24000,num_channels:1,sample_width:2,encoding:'linear_pcm',container:'wav'}}),signal:AbortSignal.timeout(30000)});if(!response.ok){let detail='';try{const errorBody=await response.json();detail=errorBody?.error?.message||errorBody?.message||errorBody?.detail?.message||''}catch{}if(response.status===403)throw new Error('Gnani denied TTS access (403). Confirm the TTS key has the TTS service scope.');if(response.status===429||response.status>=500)throw new Error('Gnani TTS is temporarily unavailable. Retry in a moment.');throw new Error(detail||`Gnani TTS returned HTTP ${response.status}`)}audio=Buffer.from(await response.arrayBuffer());audioCache.set(cacheKey,audio)}res.set('Content-Type','audio/wav').set('Cache-Control','no-store').send(audio)}catch(error){res.status(502).json({error:error instanceof Error?error.message:'Read-back generation failed. Retry.'})}
});
function multipartAudio(buffer,contentType){const boundary=/boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType||'')?.slice(1).find(Boolean);if(!boundary)throw new Error('Audio upload must use multipart/form-data.');const body=buffer.toString('latin1');const start=body.indexOf('\r\n\r\n');if(start<0)throw new Error('Audio file was missing from the upload.');const header=body.slice(0,start);if(!/name="audio_file"/.test(header))throw new Error('Upload an audio_file field.');let end=body.indexOf(`\r\n--${boundary}`,start+4);if(end<0)throw new Error('Audio upload was incomplete.');return buffer.subarray(start+4,end)}
app.post('/api/reports/:visitId/correct',express.raw({type:'multipart/form-data',limit:'8mb'}),async(req,res)=>{
 const found=findVisit(req.params.visitId);if(!found)return res.status(404).json({error:'Saved visit was not found.'});if(!process.env.GNANI_API_KEY)return res.status(503).json({error:'Gnani STT is not configured in the backend .env file.'});if(!found.visit.aiReport)return res.status(409).json({error:'Generate the report before requesting a correction.'});
 let audio;try{audio=multipartAudio(req.body,req.headers['content-type'])}catch(error){return res.status(400).json({error:error.message})}
 const form=new FormData();form.append('audio_file',new Blob([audio],{type:'audio/wav'}),'correction.wav');form.append('model','prisma-v3.0');form.append('language_code',req.query.language||'indic-auto');form.append('format','transcribe');form.append('keyterms','blood pressure,BP,haemoglobin,hemoglobin,temperature,weight,pulse,pregnancy,ANC,LMP,EDD,iron folic acid,IFA,headache,swelling,fever,abdominal pain,fetal movement,feeding,breastfeeding,immunisation,immunization,bleeding,newborn,baby weight');
 try{
  const stt=await fetch('https://api.vachana.ai/stt/v3',{method:'POST',headers:{'X-API-Key-ID':process.env.GNANI_API_KEY},body:form,signal:AbortSignal.timeout(40000)});
  if(!stt.ok)throw new Error(`Gnani STT returned HTTP ${stt.status}`);
  const result=await stt.json();const spoken=String(result.transcript||'').trim();if(!spoken)return res.status(422).json({error:'No speech was recognized. Try again or edit the report manually.'});
  const correction=await correctReport({transcript:spoken,patient:found.patient,currentReport:found.visit.aiReport.report});
  const patch={};const text=spoken.toLowerCase();if(correction.patch?.title&&/title|heading|शीर्षक/i.test(text))patch.title=correction.patch.title;if(correction.patch?.encounter_summary&&/summary|सारांश|encounter/i.test(text))patch.encounter_summary=correction.patch.encounter_summary;
  const edit=applyReportOperations(found.visit.aiReport.report,correction.operations,spoken);
  const applied=edit.applied.length>0||Object.keys(patch).length>0;
  if(!applied)return res.json({transcript:spoken,clarifyingQuestion:correction.clarifying_question||'I heard the correction, but need the exact report item and the requested change. Try “remove [item] from [section]” or “change [item] to [new value].”',spokenConfirmation:'No report changes were made.',report:found.visit.aiReport});
  const next={...found.visit.aiReport,report:{...edit.report,...patch},status:'draft'};
  next.version=saveAiReport(db,found.visit.id,next,{source:'voice',patch:{...patch,operations:edit.applied},correctionTranscript:spoken});
  res.json({transcript:spoken,spokenConfirmation:correction.spoken_confirmation,patch:{...patch,operations:edit.applied},report:next});
 }catch(error){const status=Number(error?.status)||502;res.status(status>=400&&status<=599?status:502).json({error:error instanceof Error?error.message:'Voice correction failed. Retry.'})}
});

const server=createServer(app);
const sttWss=new WebSocketServer({server,path:'/ws/stt'});
sttWss.on('connection',(client,request)=>{
 const origin=request.headers.origin;
 if(origin&&!isAllowedOrigin(origin)){client.close(1008,'Origin is not allowed');return}
 const session=sessionFor(request);if(session?.role!=='worker'){client.close(1008,'ASHA worker sign-in required');return}
 let upstream=null,started=false;
 const fail=(message)=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'error',message}))};
 client.on('message',(raw,isBinary)=>{
  if(!started){
   let config;try{config=JSON.parse(raw.toString())}catch{return fail('Invalid STT session configuration')}
   if(config.type!=='start')return fail('Start an STT session before streaming audio');
   if(!process.env.GNANI_API_KEY)return fail('Gnani STT key is not configured in the backend .env file');
   const supportedLanguages=new Set(['hi-IN','en-IN','bn-IN','gu-IN','kn-IN','ml-IN','mr-IN','pa-IN','ta-IN','te-IN']);
   const languageCode=supportedLanguages.has(config.languageCode)?config.languageCode:'hi-IN';
   started=true;
   // WebSocket headers are Latin-1 in Node. Keep keyterms ASCII so the
   // constructor cannot throw on Hindi strings before an STT session opens.
   const sttKeyterms=['blood pressure','BP','systolic','diastolic','hemoglobin','haemoglobin','Hb','temperature','weight','pulse','heart rate','oxygen saturation','SpO2','respiratory rate','height','mid upper arm circumference','MUAC','pregnancy','pregnant','ANC','LMP','EDD','trimester','iron folic acid','IFA','iron tablet','calcium','headache','swelling','fever','dizziness','abdominal pain','fetal movement','feeding','breastfeeding','immunisation','immunization','vaccination','diarrhea','vomiting','cough','pneumonia','danger sign','urine','blood sugar','hemorrhage','bleeding','delivery','newborn','baby weight','birth weight','vaccination card','gestational age','gravida','parity','lochia','jaundice','dehydration','rash','saturation','midwife'];
   try {
    upstream=new WebSocket('wss://api.vachana.ai/stt/v3/stream',{headers:{'x-api-key-id':process.env.GNANI_API_KEY,'model':'prisma-v3.0','language_code':languageCode,'format':'transcribe','keyterms':JSON.stringify(sttKeyterms),'topic':'ASHA community health visit documentation; maternal, pregnancy, newborn and child health; symptoms, medicines, measurements and follow-up','x-sample-rate':'16000','x-idle-timeout-sec':'120','x-max-speech-s':'90','x-min-silence-ms':'1000','x-min-speech-ms':'80','x-min-segment-ms':'100','x-vad-threshold':'0.5'}});
   } catch (error) { fail(`Could not start Gnani STT: ${error instanceof Error?error.message:'invalid connection settings'}`); return; }
   upstream.on('open',()=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'ready'}))});
   upstream.on('message',(payload,binary)=>{if(client.readyState===WebSocket.OPEN)client.send(payload,{binary})});
   upstream.on('unexpected-response',()=>fail('Gnani rejected the connection. Check the API key and account access.'));
   upstream.on('error',()=>fail('Could not connect to Gnani STT. Check your internet connection and API key.'));
   upstream.on('close',(code,reason)=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'upstream_closed',code,reason:reason.toString()}))});
   return;
  }
  if(!upstream||upstream.readyState!==WebSocket.OPEN)return fail('Gnani STT connection is not ready');
  if(isBinary){if(raw.length<=8192)upstream.send(raw,{binary:true});else fail('Audio frame exceeded the streaming limit');return}
  try{const control=JSON.parse(raw.toString());if(control.type==='commit'||control.type==='update_settings')upstream.send(JSON.stringify(control));}catch{fail('Invalid streaming control message')}
 });
 client.on('close',()=>{if(upstream&&upstream.readyState<WebSocket.CLOSING)upstream.close()});
 client.on('error',()=>{if(upstream&&upstream.readyState<WebSocket.OPEN)upstream.close()});
});
const port=Number(process.env.PORT||process.env.API_PORT||3001);
const host=process.env.PORT?'0.0.0.0':'127.0.0.1';
server.listen(port,host,()=>console.log(`AROVA API ready at http://${host}:${port}`));
