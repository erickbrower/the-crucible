// Worker entry point: register the tsx loader inside this thread, then load the TypeScript worker.
// (Worker threads do not inherit tsx from the parent process.)
import { register } from 'tsx/esm/api';
register();
await import('./worker.ts');
