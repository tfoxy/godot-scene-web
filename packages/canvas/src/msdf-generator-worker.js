// Source-mode worker entry. The published build emits the same .js filename.
import { installMsdfGeneratorWorker } from "./msdf-generator-worker-runtime.ts";

installMsdfGeneratorWorker();
