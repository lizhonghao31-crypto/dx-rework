import {InvalidStoredFileError} from './file-content-validation.js';
/** Opaque CAD original: never parse/execute it or claim vendor-format interoperability.
 * Byte size/hash are verified by the existing immutable upload pipeline. */
export function validateOpaquePlotContent(content:Uint8Array){
 const bytes=Buffer.from(content),prefix=bytes.subarray(0,256).toString('utf8').replace(/^\uFEFF/,'').trimStart();
 if(bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4]))||!bytes.length||prefix.startsWith('<')||/^(?:%PDF-|MZ|#!)/.test(prefix)||/^\s*(?:javascript:|data:text\/html)/i.test(prefix))throw new InvalidStoredFileError();
}
