import { RELEASE_SYNC,newVariant,newQuickJSWASMModule } from 'quickjs-emscripten';
import wasmData from '@jitl/quickjs-wasmfile-release-sync/wasm?url&inline';
/** 内嵌 WASM，无需 fetch，不放宽应用的 connect-src 策略。按需初始化。 */
export function sandboxModule(){
  const bytes=Uint8Array.from(atob(wasmData.slice(wasmData.indexOf(',')+1)),c=>c.charCodeAt(0));
  return newQuickJSWASMModule(newVariant(RELEASE_SYNC,{wasmBinary:bytes.buffer}));
}
