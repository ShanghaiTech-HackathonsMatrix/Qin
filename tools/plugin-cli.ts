import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {zipSync} from 'fflate';
import {readPluginPackage} from '../apps/shell/src/core/external-package.ts';

const [command,input,output]=process.argv.slice(2);
try{
  if(command==='pack'&&input&&output){
    const root=resolve(input),bytes=zipSync({'manifest.json':new Uint8Array(await readFile(resolve(root,'manifest.json'))),'bundle.js':new Uint8Array(await readFile(resolve(root,'bundle.js')))},{level:6});
    const p=readPluginPackage(bytes);await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(resolve(output),bytes);
    console.log(`已打包 ${p.manifest.id} ${p.manifest.version}（${bytes.length} 字节）→ ${resolve(output)}`);
  }else if(command==='validate'&&input){
    const p=readPluginPackage(new Uint8Array(await readFile(resolve(input))));console.log(`包结构与 API 校验通过：${p.manifest.id} ${p.manifest.version}（尚未执行代码）`);
  }else throw Error('用法：node tools/plugin-cli.ts pack <插件目录> <输出.mtp> 或 validate <插件.mtp>');
}catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}
