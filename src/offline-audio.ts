import { apiWebSocketUrl } from './api';

export type OfflineRecording={id:string;patientId:string;visitId:string;languageCode:string;blob:Blob;createdAt:string;transcript?:string;retryAt?:number;visitType?:string;visitDate?:string;followup?:string;temperatureC?:number;patientNameSnapshot?:string;ageYearsSnapshot?:number};

const databaseName='arova-offline-audio';
const storeName='recordings';
function openQueue():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(databaseName,1);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(storeName))request.result.createObjectStore(storeName,{keyPath:'id'})};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('Could not open offline audio storage.'));
  });
}
export async function saveOfflineRecording(item:OfflineRecording):Promise<void>{
  const db=await openQueue();
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(storeName,'readwrite');tx.objectStore(storeName).put(item);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('Could not save the offline recording.'));tx.onabort=()=>reject(tx.error||new Error('Offline recording save was cancelled.'))})}finally{db.close()}
}
export async function listOfflineRecordings():Promise<OfflineRecording[]>{
  const db=await openQueue();
  try{return await new Promise((resolve,reject)=>{const request=db.transaction(storeName,'readonly').objectStore(storeName).getAll();request.onsuccess=()=>resolve(request.result as OfflineRecording[]);request.onerror=()=>reject(request.error||new Error('Could not load queued audio.'))})}finally{db.close()}
}
export async function deleteOfflineRecording(id:string):Promise<void>{
  const db=await openQueue();
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(storeName,'readwrite');tx.objectStore(storeName).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('Could not remove the queued recording.'))})}finally{db.close()}
}

function audioToFrames(buffer:AudioBuffer):Uint8Array[]{
  const samples=buffer.getChannelData(0);const ratio=buffer.sampleRate/16000;const length=Math.floor(samples.length/ratio);const output=new Int16Array(length);
  for(let i=0;i<length;i++){const position=i*ratio,lower=Math.floor(position),upper=Math.min(lower+1,samples.length-1),sample=samples[lower]+(samples[upper]-samples[lower])*(position-lower);output[i]=Math.max(-1,Math.min(1,sample))*32767}
  const frames:Uint8Array[]=[];
  for(let offset=0;offset<output.length;offset+=512){const bytes=new Uint8Array(1024),view=new DataView(bytes.buffer);for(let i=0;i<512;i++)view.setInt16(i*2,output[offset+i]||0,true);frames.push(bytes)}
  return frames;
}

export async function transcribeOfflineRecording(item:OfflineRecording):Promise<string>{
  let context:AudioContext;
  try{context=new AudioContext({sampleRate:16000})}catch{context=new AudioContext()}
  let frames:Uint8Array[];
  try{frames=audioToFrames(await context.decodeAudioData(await item.blob.arrayBuffer()))}finally{await context.close()}
  if(!frames.length)throw new Error('The saved recording did not contain readable audio.');
  const socket=new WebSocket(apiWebSocketUrl('/ws/stt'));socket.binaryType='arraybuffer';
  return await new Promise<string>((resolve,reject)=>{
    const segments:string[]=[];const ids=new Set<string>();let ready=false,committed=false,settled=false;let quietTimer:ReturnType<typeof setTimeout>|undefined;let totalTimer:ReturnType<typeof setTimeout>|undefined;
    const cleanup=()=>{if(quietTimer)clearTimeout(quietTimer);if(totalTimer)clearTimeout(totalTimer);if(socket.readyState===WebSocket.OPEN)socket.close()};
    const finish=(error?:Error)=>{if(settled)return;settled=true;cleanup();const transcript=segments.join(' ').trim();if(error)reject(error);else if(transcript)resolve(transcript);else reject(new Error('No transcript was returned for the queued recording.'))};
    const scheduleQuiet=()=>{if(quietTimer)clearTimeout(quietTimer);quietTimer=setTimeout(()=>finish(),6000)};
    const sendFrames=async()=>{
      for(const frame of frames){if(socket.readyState!==WebSocket.OPEN)return finish(new Error('STT connection closed before queued audio was sent.'));socket.send(frame.buffer as ArrayBuffer);await new Promise(r=>setTimeout(r,32))}
      const silence=new Uint8Array(1024);
      for(let i=0;i<32;i++){if(socket.readyState!==WebSocket.OPEN)return finish(new Error('STT connection closed before queued audio was finalized.'));socket.send(silence.slice().buffer);await new Promise(r=>setTimeout(r,32))}
      if(socket.readyState===WebSocket.OPEN){socket.send(JSON.stringify({type:'commit'}));committed=true;totalTimer=setTimeout(()=>finish(segments.length?undefined:new Error('Gnani did not return a transcript for the queued recording.')),20000);if(segments.length)scheduleQuiet()}
    };
    socket.onopen=()=>socket.send(JSON.stringify({type:'start',languageCode:item.languageCode,sampleRate:16000}));
    socket.onmessage=event=>{let message:any;try{message=JSON.parse(String(event.data))}catch{return}
      if(message.type==='ready'){ready=true;void sendFrames()}
      else if(message.type==='transcript'){const id=message.segment_id!=null?String(message.segment_id):message.segment_index!=null?`index-${message.segment_index}`:'';if(id&&ids.has(id))return;if(id)ids.add(id);const text=String(message.text||'').trim();if(text){segments.push(text);if(committed)scheduleQuiet()}}
      else if(message.type==='error')finish(new Error(message.message||'Gnani could not transcribe the queued recording.'));
      else if(message.type==='upstream_closed')finish(segments.length?undefined:new Error('Gnani closed before returning a transcript.'));
    };
    socket.onerror=()=>finish(new Error('Could not connect to Gnani to transcribe the saved recording.'));
    socket.onclose=()=>{if(!settled&&ready&&segments.length)finish();else if(!settled)finish(new Error('Gnani connection closed before transcription completed.'))};
    setTimeout(()=>{if(!ready)finish(new Error('Timed out connecting to Gnani for queued transcription.'))},15000);
  });
}
