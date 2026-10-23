import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Writable=require('../../shared/writable-input');

/** Only immutable image helpers share this original AIM cache. App and peer
 * APK processes keep their own private translation directories. AIM owns
 * source-digest, translation-format and host-configuration invalidation;
 * unrelated runner changes must not discard those entries. */
export async function compositionCache(userDataDir,_supplier,signal){
 signal?.throwIfAborted();
 const directory=path.join(userDataDir,'android','native-cache','art-composition');
 Writable.assertOwnDirectory(userDataDir,directory);
 return directory;
}
