export const wizardRpcBridgeReadyMarker =
  "CLAWSEMBLY_WIZARD_RPC_BRIDGE_READY";

export function resolveGatewayClientModulePath(
  files: Record<string, Uint8Array>
): string {
  const decoder = new TextDecoder();
  for (const [path, bytes] of Object.entries(files)) {
    if (!/^\/dist\/client-[A-Za-z0-9_-]+\.js$/u.test(path)) continue;
    const source = decoder.decode(bytes);
    if (
      source.includes("GatewayClient as t")
      && source.includes("loadDeviceAuthToken as n")
    ) {
      return path;
    }
  }
  throw new Error(
    "The pinned OpenClaw package is missing its GatewayClient facade"
  );
}

export function createOpenClawWizardRpcBridgeHarness(options: {
  clientModulePath: string;
  gatewayToken: string;
  gatewayUrl: string;
  openclawVersion: string;
}): string {
  const {
    clientModulePath,
    gatewayToken,
    gatewayUrl,
    openclawVersion
  } = options;
  return [
    "Promise.all([",
    `import(${JSON.stringify(`file:///openclaw${clientModulePath}`)}),`,
    "import('node:fs'),",
    "import('file:///openclaw/dist/config/config.js')",
    "]).then(([clientModule,fsModule,configModule])=>{",
    "const GatewayClient=clientModule.t;",
    "const fs=fsModule.default??fsModule;",
    "const requests='/control/requests';",
    "const responses='/control/responses';",
    "const gatewayConfigPath=",
    "'/gateway/.clawsembly-gateway-state/openclaw.json';",
    "const configIO=configModule.createConfigIO({",
    "configPath:gatewayConfigPath,observe:false});",
    "fs.mkdirSync(requests,{recursive:true});",
    "fs.mkdirSync(responses,{recursive:true});",
    "let processing=false;",
    "let ready=false;",
    "const write=(id,value)=>{",
    "const temporary=responses+'/.tmp_'+id;",
    "const target=responses+'/'+id+'.json';",
    "fs.writeFileSync(temporary,JSON.stringify(value));",
    "fs.renameSync(temporary,target);",
    "};",
    "const inspectConfig=async(providerId)=>{",
    "const snapshot=await configIO.readConfigFileSnapshot({observe:false});",
    "const provider=snapshot?.config?.models?.providers?.[providerId];",
    "const models=Array.isArray(provider?.models)?provider.models:[];",
    "return {hash:snapshot?.hash,",
    "primaryModel:snapshot?.config?.agents?.defaults?.model?.primary,",
    "providerId,providerApi:provider?.api,",
    "providerBaseUrl:provider?.baseUrl,",
    "apiKeyConfigured:provider!=null&&provider.apiKey!=null,",
    "modelIds:models.map((model)=>model?.id).filter((id)=>",
    "typeof id==='string')};",
    "};",
    "const patchConfig=async(params)=>{",
    "if(typeof params.raw!=='string'||typeof params.baseHash!=='string')",
    "throw new Error('invalid_config_patch');",
    "const prepared=await configIO.readConfigFileSnapshotForWrite();",
    "const snapshot=prepared.snapshot;",
    "if(!snapshot.valid)throw new Error('invalid_openclaw_config');",
    "if(snapshot.hash!==params.baseHash)",
    "throw new Error('config_changed_since_inspection');",
    "const patch=JSON.parse(params.raw);",
    "const current=snapshot.sourceConfig??{};",
    "const next={...current,agents:{...(current.agents??{}),",
    "defaults:{...(current.agents?.defaults??{}),",
    "model:{...(current.agents?.defaults?.model??{}),",
    "...(patch.agents?.defaults?.model??{})}}},",
    "models:{...(current.models??{}),",
    "providers:{...(current.models?.providers??{}),",
    "...(patch.models?.providers??{})}}};",
    "const persisted=await configIO.writeConfigFile(next,{",
    "...prepared.writeOptions,baseSnapshot:snapshot,",
    "skipRuntimeSnapshotRefresh:true,skipOutputLogs:true});",
    "return {ok:true,path:gatewayConfigPath,",
    "persistedHash:persisted?.persistedHash};",
    "};",
    "const processMailbox=async()=>{",
    "if(processing)return;processing=true;",
    "try{",
    "const names=fs.readdirSync(requests).filter((name)=>",
    "/^[A-Za-z0-9_-]{1,128}\\.json$/.test(name)).sort();",
    "for(const name of names){",
    "const id=name.slice(0,-5);const path=requests+'/'+name;",
    "try{",
    "const request=JSON.parse(fs.readFileSync(path,'utf8'));",
    "if(request.id!==id||typeof request.method!=='string'||",
    "!request.params||typeof request.params!=='object'||",
    "Array.isArray(request.params))throw new Error('invalid_rpc_request');",
    "let result;",
    "if(request.method==='clawsembly.config.inspect'){",
    "const providerId=request.params.providerId;",
    "if(typeof providerId!=='string'||!providerId)",
    "throw new Error('invalid_provider_id');",
    "result=await inspectConfig(providerId);",
    "}else if(request.method==='clawsembly.config.active-model'){",
    "const listing=await client.request('agents.list',{},",
    "{timeoutMs:120000});",
    "const agents=Array.isArray(listing?.agents)?listing.agents:[];",
    "result={agents:agents.map((agent)=>({id:agent?.id,",
    "model:agent?.model}))};",
    "}else if(request.method==='clawsembly.config.patch'){",
    "result=await patchConfig(request.params);",
    "}else{",
    "result=await client.request(request.method,request.params,",
    "{timeoutMs:120000});",
    "}",
    "write(id,{schemaVersion:1,ok:true,result});",
    "}catch(error){",
    "write(id,{schemaVersion:1,ok:false,error:",
    "error instanceof Error?error.message:String(error)});",
    "}finally{try{fs.unlinkSync(path)}catch{}}",
    "}",
    "}finally{processing=false}",
    "};",
    "const client=new GatewayClient({",
    `url:${JSON.stringify(gatewayUrl)},`,
    `token:${JSON.stringify(gatewayToken)},`,
    "deviceIdentity:null,",
    "instanceId:'clawsembly-wizard-rpc',",
    "clientName:'cli',",
    "clientDisplayName:'Clawsembly Wizard RPC bridge',",
    `clientVersion:${JSON.stringify(openclawVersion)},`,
    "platform:'linux',",
    "mode:'cli',",
    "role:'operator',",
    "scopes:['operator.admin'],",
    "minProtocol:4,maxProtocol:4,requestTimeoutMs:120000,",
    "onHelloOk:()=>{",
    "ready=true;",
    `console.log(${JSON.stringify(wizardRpcBridgeReadyMarker)});`,
    "},",
    "onClose:(code,reason)=>{",
    "ready=false;console.error('wizard rpc bridge closed '+code+' '+reason)",
    "},",
    "onConnectError:(error)=>{",
    "console.error('wizard rpc bridge connect error '+",
    "(error?.stack??String(error)))",
    "}",
    "});",
    "client.start();",
    "setInterval(()=>{void processMailbox()},20);",
    "}).catch((error)=>{",
    "console.error(error?.stack??String(error));process.exit(1)",
    "});"
  ].join("");
}
