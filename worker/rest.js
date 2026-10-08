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
export async function rest(url,token,body){const r=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok){const e=Error('資料庫操作失敗：'+(d.error?.status||r.status));e.code=d.error?.status;e.status=r.status;throw e}return d}
export function database(env,token){
  const root=`projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`,base='https://firestore.googleapis.com/v1/'+root;
  const snapshot=(ref,d)=>({id:ref.id,exists:Boolean(d),ref,version:d?.updateTime,data:()=>decodeFields(d?.fields)});
  const doc=path=>{const ref={path,id:path.split('/').at(-1)};ref.get=async()=>{try{return snapshot(ref,await rest(base+'/'+path.split('/').map(encodeURIComponent).join('/'),token))}catch(e){if(e.status===404)return snapshot(ref,null);throw e}};return ref};
  const collection=(name,filter=null,sort=null)=>({where:(key,op,value)=>collection(name,{fieldFilter:{field:{fieldPath:key},op:'EQUAL',value:encodeValue(value)}},sort),orderBy:(key,direction)=>collection(name,filter,{field:{fieldPath:key},direction:direction==='desc'?'DESCENDING':'ASCENDING'}),get:async()=>{const rows=await rest(base+':runQuery',token,{structuredQuery:{from:[{collectionId:name}],...(filter?{where:filter}:{}),...(sort?{orderBy:[sort]}:{})}});return {docs:rows.filter(x=>x.document).map(x=>snapshot(doc(name+'/'+x.document.name.split('/').at(-1)),x.document))}}});
  return {doc,collection,runTransaction:async fn=>{for(let attempt=0;attempt<5;attempt++){const reads=new Map(),writes=[];const get=async ref=>{const s=await ref.get();reads.set(ref.path,s);return s};const tx={get,getAll:async(...refs)=>{const rows=await rest(base+':batchGet',token,{documents:refs.map(ref=>root+'/'+ref.path)});return refs.map(ref=>{const row=rows.find(x=>(x.found?.name||x.missing)===root+'/'+ref.path);if(!row)throw Error('資料庫批次回應不完整');const s=snapshot(ref,row.found);reads.set(ref.path,s);return s})},create:(ref,value)=>writes.push({update:{name:root+'/'+ref.path,fields:encodeFields(value)},currentDocument:{exists:false}}),update:(ref,value)=>{const s=reads.get(ref.path);if(!s?.exists)throw Error('更新前未讀取資料');writes.push({update:{name:root+'/'+ref.path,fields:encodeFields(value)},updateMask:{fieldPaths:Object.keys(value)},currentDocument:{updateTime:s.version}})}};try{const result=await fn(tx);if(writes.length)await rest(base+':commit',token,{writes});return result}catch(e){if(!['ABORTED','FAILED_PRECONDITION','ALREADY_EXISTS'].includes(e.code))throw e;if(attempt===4)throw Error('庫存正在更新，請稍後再試')}}}};
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
  return {...profile,email,ownerEmail};
}
