import {EventEmitter} from 'events'
/** Desktop command runtimes cannot execute on Android. Fail promptly and visibly. */
export function spawn(){const proc=new EventEmitter() as any;proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();proc.stdin={write:()=>false};proc.kill=()=>true;queueMicrotask(()=>proc.emit('error',new Error('Android cannot run desktop MCP commands')));return proc}
export default {spawn}
