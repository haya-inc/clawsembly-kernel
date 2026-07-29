export const byokLoopbackPort = 18_794;
export const byokLoopbackReadyMarker = "CLAWSEMBLY_BYOK_BRIDGE_LISTENING";

export function createByokLoopbackBrokerHarness(options?: {
  timeoutMs?: number;
}): string {
  const timeoutMs = options?.timeoutMs ?? 180_000;
  return [
    "Promise.all([import('node:http'),import('node:fs')]).then(([httpModule,fsModule])=>{",
    "const http=httpModule.default??httpModule;",
    "const fs=fsModule.default??fsModule;",
    "const root='/bridge';",
    "const requests=root+'/requests';",
    "const responses=root+'/responses';",
    "fs.mkdirSync(requests,{recursive:true});",
    "fs.mkdirSync(responses,{recursive:true});",
    "let sequence=0;",
    "const server=http.createServer((request,response)=>{",
    "if(request.method!=='POST'||request.url!=='/v1/chat/completions'){",
    "response.writeHead(404,{'content-type':'application/json'});",
    "response.end(JSON.stringify({error:{code:'not_found'}}));return}",
    "const chunks=[];let bytes=0;",
    "request.on('data',(chunk)=>{bytes+=chunk.length;",
    "if(bytes>2097152){request.destroy();return}chunks.push(chunk)});",
    "request.on('end',()=>{",
    "if(bytes>2097152){response.writeHead(413);response.end();return}",
    "const id=Date.now().toString(36)+'_'+(++sequence).toString(36);",
    "const body=Buffer.concat(chunks).toString('utf8');",
    "const record=JSON.stringify({schemaVersion:1,id,method:'POST',",
    "path:'/v1/chat/completions',",
    "authorization:String(request.headers.authorization??''),body});",
    "const temporary=requests+'/.tmp_'+id;",
    "const requestPath=requests+'/'+id+'.json';",
    "const responsePath=responses+'/'+id+'.json';",
    "fs.writeFileSync(temporary,record);fs.renameSync(temporary,requestPath);",
    "const started=Date.now();",
    "const timer=setInterval(()=>{",
    "if(Date.now()-started>",
    String(timeoutMs),
    "){clearInterval(timer);response.writeHead(504,{'content-type':'application/json'});",
    "response.end(JSON.stringify({error:{code:'bridge_timeout'}}));return}",
    "if(!fs.existsSync(responsePath))return;",
    "try{const bridge=JSON.parse(fs.readFileSync(responsePath,'utf8'));",
    "fs.unlinkSync(responsePath);clearInterval(timer);",
    "response.writeHead(Number(bridge.status)||502,bridge.headers??{});",
    "response.end(Buffer.from(String(bridge.bodyBase64??''),'base64'))}",
    "catch(error){clearInterval(timer);response.writeHead(502,",
    "{'content-type':'application/json'});",
    "response.end(JSON.stringify({error:{code:'invalid_bridge_response'}}))}",
    "},20);",
    "});",
    "});",
    `server.listen(${byokLoopbackPort},'127.0.0.1',()=>`,
    `{console.log('${byokLoopbackReadyMarker}')});`,
    "}).catch((error)=>{console.error(error?.stack??String(error));process.exit(1)});"
  ].join("");
}
