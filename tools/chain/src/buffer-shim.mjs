// Injected into the browser bundle by build.mjs: the libraries expect Node's Buffer everywhere.
import { Buffer } from "buffer";

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
export { Buffer };
