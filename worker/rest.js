const encoder=new TextEncoder();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
let oauth;
export async function accessToken(env){
  if(oauth?.expires>Date.now()+60000&&oauth.project===env.FIREBASE_PROJECT_ID)return oauth.token;
  let account;try{account=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)}catch{throw Error('Firebase Secret 格式錯誤')}
  if(account.project_id!==env.FIREBASE_PROJECT_ID)throw Error('Firebase 憑證專案不符');
  const now=Math.floor(Date.now()/1000),part=b64(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})))+'.'+b64(encoder.encode(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
  const pem=account.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const assertion=part+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(part)));
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
  const d=await r.json();if(!r.ok||!d.access_token)throw Error('Firebase 憑證無法登入');oauth={project:env.FIREBASE_PROJECT_ID,token:d.access_token,expires:Date.now()+d.expires_in*1000};return oauth.token;
}
export function encodeValue(x){if(x===null)return {nullValue:null};if(typeof x==='boolean')return {booleanValue:x};if(typeof x==='number')return Number.isInteger(x)?{integerValue:String(x)}:{doubleValue:x};if(Array.isArray(x))return {arrayValue:{values:x.map(encodeValue)}};if(typeof x==='object')return {mapValue:{fields:encodeFields(x)}};return {stringValue:String(x)}}
export const encodeFields=x=>Object.fromEntries(Object.entries(x).map(([k,v])=>[k,encodeValue(v)]));
export function decodeValue(x){if('nullValue'in x)return null;if('integerValue'in x)return Number(x.integerValue);if('doubleValue'in x)return x.doubleValue;if('booleanValue'in x)return x.booleanValue;if('arrayValue'in x)return (x.arrayValue.values||[]).map(decodeValue);if('mapValue'in x)return decodeFields(x.mapValue.fields||{});return x.stringValue??x.timestampValue??''}
export const decodeFields=x=>Object.fromEntries(Object.entries(x||{}).map(([k,v])=>[k,decodeValue(v)]));
export async function rest(url,token,body){const r=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok){const detail=Array.isArray(d)?d.find(x=>x.error)?.error:d.error;const limited=r.status===429||detail?.status==='RESOURCE_EXHAUSTED';const e=Error(limited?'資料庫暫時忙碌或讀取額度已達上限，請稍後再試':'資料庫操作失敗：'+(detail?.status||r.status));e.code=detail?.status;e.status=r.status;throw e}return d}
function catalogBucket(id){if(/^\d{1,5}$/.test(id))return 'n'+String(Math.floor(Number(id)/100)).padStart(4,'0');let h=2166136261;for(const c of id)h=Math.imul(h^c.charCodeAt(0),16777619);return 's'+String(h>>>0).slice(-3)}
function catalogEntry(id,x){return {id,name:x.name||'',category:x.category||'',propertyId:x.propertyId||'',location:x.location||'',available:x.available,borrowed:x.borrowed,total:x.total,note:x.note||'',enabled:x.enabled!==false,createdBy:x.createdBy||''}}
function catalogChunk(rows){const json=JSON.stringify(rows);if(encoder.encode(json).length>850000)throw Error('物品目錄分組過大，請聯絡管理員');return {json}}
async function maintainCatalog(tx,reads,writes,doc,root){
 const changes=writes.filter(w=>(w.update?.name||w.delete||'').startsWith(root+'/items/'));if(!changes.length)return;
 const metaRef=doc('settings/catalogIndex'),oldMeta=await tx.get(metaRef),meta=oldMeta.exists?oldMeta.data():{};
 if(!meta.ready){tx.set(metaRef,{ready:false,changedAt:new Date().toISOString()});return}
 const ids=[...new Set(changes.map(w=>catalogBucket((w.update?.name||w.delete).split('/').at(-1))))],refs=ids.map(k=>doc('catalogChunks/'+k)),chunks=await tx.getAll(...refs),groups=new Map(ids.map((k,i)=>[k,chunks[i].exists?JSON.parse(chunks[i].data().json):[]]));
 const counts={...(meta.categoryCounts||{})},keys=new Set(meta.chunkIds||[]);let maximum=meta.maxAssetNumber||0;
 for(const w of changes){const path=(w.update?.name||w.delete).slice(root.length+1),id=path.split('/').at(-1),key=catalogBucket(id),rows=groups.get(key),index=rows.findIndex(x=>x.id===id),prior=index>=0?rows[index]:null;if(prior)counts[prior.category]=Math.max(0,(counts[prior.category]||0)-1);const old=reads.get(path);const value=w.delete?null:{...(old?.exists?old.data():{}),...decodeFields(w.update.fields)};if(index>=0)rows.splice(index,1);if(value&&!value.deleted){const entry=catalogEntry(id,value);rows.push(entry);counts[entry.category]=(counts[entry.category]||0)+1}if(/^\d{1,5}$/.test(id))maximum=Math.max(maximum,Number(id));}
 refs.forEach((ref,i)=>{const rows=groups.get(ids[i]);tx.set(ref,catalogChunk(rows));if(rows.length)keys.add(ids[i]);else keys.delete(ids[i])});
 tx.set(metaRef,{...meta,chunkIds:[...keys].sort(),categoryCounts:counts,maxAssetNumber:maximum,changedAt:new Date().toISOString()});
}
async function ensureCatalog(db){
 const ref=db.doc('settings/catalogIndex'),first=await ref.get();if(first.exists&&first.data().ready)return first.data();
 await db.runTransaction(async tx=>{const current=await tx.get(ref);if(current.exists&&current.data().ready)return;const stock=await db.collection('items').get(),groups=new Map(),counts=Object.create(null);let maximum=0;
 for(const d of stock.docs){if(/^\d{1,5}$/.test(d.id))maximum=Math.max(maximum,Number(d.id));const x=d.data();if(x.deleted)continue;const row=catalogEntry(d.id,x),key=catalogBucket(d.id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);counts[row.category]=(counts[row.category]||0)+1}
 const ids=[...groups.keys()].sort();if(ids.length>400)throw Error('目錄需分批初始化，請聯絡管理員');const refs=ids.map(k=>db.doc('catalogChunks/'+k));if(refs.length)await tx.getAll(...refs);refs.forEach((r,i)=>tx.set(r,catalogChunk(groups.get(ids[i]))));tx.set(ref,{ready:true,chunkIds:ids,categoryCounts:counts,maxAssetNumber:maximum,changedAt:new Date().toISOString()});
 });return (await ref.get()).data();
}
async function readCatalog(db){const meta=await ensureCatalog(db),refs=(meta.chunkIds||[]).map(k=>db.doc('catalogChunks/'+k));return db.runTransaction(async tx=>{const chunks=refs.length?await tx.getAll(...refs):[];if(chunks.some(s=>!s.exists))throw Error('物品目錄更新中，請稍後再試');return chunks.flatMap(s=>JSON.parse(s.data().json)).sort((a,b)=>a.id.localeCompare(b.id))})}

export function database(env,token){
  const root=`projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`,base='https://firestore.googleapis.com/v1/'+root;
  const snapshot=(ref,d)=>({id:ref.id,exists:Boolean(d),ref,version:d?.updateTime,data:()=>decodeFields(d?.fields)});
  const doc=path=>{const ref={path,id:path.split('/').at(-1)};ref.get=async()=>{try{return snapshot(ref,await rest(base+'/'+path.split('/').map(encodeURIComponent).join('/'),token))}catch(e){if(e.status===404)return snapshot(ref,null);throw e}};return ref};
  const collection=(name,filter=null,sort=null,maximum=null)=>({where:(key,op,value)=>collection(name,{fieldFilter:{field:{fieldPath:key},op:'EQUAL',value:encodeValue(value)}},sort,maximum),orderBy:(key,direction)=>collection(name,filter,{field:{fieldPath:key},direction:direction==='desc'?'DESCENDING':'ASCENDING'},maximum),limit:n=>collection(name,filter,sort,Math.max(1,Math.min(50,Number(n)||50))),get:async()=>{const rows=await rest(base+':runQuery',token,{structuredQuery:{from:[{collectionId:name}],...(filter?{where:filter}:{}),...(sort?{orderBy:[sort]}:{}),...(maximum?{limit:maximum}:{})}});return {docs:rows.filter(x=>x.document).map(x=>snapshot(doc(name+'/'+x.document.name.split('/').at(-1)),x.document))}}});
  return {doc,collection,runTransaction:async fn=>{for(let attempt=0;attempt<5;attempt++){const reads=new Map(),writes=[];const get=async ref=>{const s=await ref.get();reads.set(ref.path,s);return s};const tx={get,getAll:async(...refs)=>{const rows=await rest(base+':batchGet',token,{documents:refs.map(ref=>root+'/'+ref.path)});return refs.map(ref=>{const row=rows.find(x=>(x.found?.name||x.missing)===root+'/'+ref.path);if(!row)throw Error('資料庫批次回應不完整');const s=snapshot(ref,row.found);reads.set(ref.path,s);return s})},delete:ref=>{const old=reads.get(ref.path);if(!old?.exists)throw Error("刪除前未讀取資料");writes.push({delete:root+'/'+ref.path,currentDocument:{updateTime:old.version}})},set:(ref,value)=>{const old=reads.get(ref.path);if(!old)throw Error('設定前未讀取資料');writes.push({update:{name:root+'/'+ref.path,fields:encodeFields(value)},currentDocument:old.exists?{updateTime:old.version}:{exists:false}})},create:(ref,value)=>writes.push({update:{name:root+'/'+ref.path,fields:encodeFields(value)},currentDocument:{exists:false}}),update:(ref,value)=>{const s=reads.get(ref.path);if(!s?.exists)throw Error('更新前未讀取資料');writes.push({update:{name:root+'/'+ref.path,fields:encodeFields(value)},updateMask:{fieldPaths:Object.keys(value)},currentDocument:{updateTime:s.version}})}};try{const result=await fn(tx);await maintainCatalog(tx,reads,writes,doc,root);if(writes.length)await rest(base+':commit',token,{writes});return result}catch(e){if(!['ABORTED','FAILED_PRECONDITION','ALREADY_EXISTS'].includes(e.code))throw e;if(attempt===4)throw Error('庫存正在更新，請稍後再試')}}}};
}
export function allowed(profile){return profile&&profile.enabled!==false&&(profile.role==='admin'||profile.permissions?.resourceInventory===true||profile.allowedSystems?.includes('resourceInventory'))}
export async function portalManager(request,env){
  const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');if(!token)throw Error('請先登入入口帳號');
  const project=env.PORTAL_FIREBASE_PROJECT_ID;if(project!=='must-resource-center-portal')throw Error('入口專案設定不符');
  const r=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyBCaAVWxKmIUHbm-X0Dk4pAcnCyoMHPm7o',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})});const account=(await r.json()).users?.[0];if(!r.ok||!account?.emailVerified||account.disabled)throw Error('入口登入已失效，請重新登入');
  const email=account.email.toLowerCase(),base=`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/`;
  const read=async mail=>decodeFields((await rest(base+'portalUsers/'+encodeURIComponent(mail),token)).fields);
  const profile=await read(email);if(!allowed(profile))throw Error('請在入口開通資教物資管理權限');
  let ownerEmail=email;if(profile.role==='assistant'){ownerEmail=String(profile.ownerEmail||'').toLowerCase();if(!ownerEmail||!allowed(await read(ownerEmail)))throw Error('所屬老師尚未開通物資管理權限')}
  return {...profile,displayName:profile.displayName||account.displayName||'',email,ownerEmail};
}



