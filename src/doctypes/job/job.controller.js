import { Document, registerController } from '../../runtime/document.js';
import { nextSeries } from '../../runtime/naming.js';
import { ValidationError } from '../../runtime/errors.js';

/**
 * JobController — VIC/ACT naming override.
 *
 * insert() intercepts Document.insert() to assign the entity-specific naming
 * series BEFORE super.insert() calls resolveName (which short-circuits when
 * this.doc.name is already set — naming.js:14/document.js:54).
 *
 * Naming series:
 *   VIC -> 'VIC-.#####' -> VIC-00001, VIC-00002, …
 *   ACT -> 'ACT-.#####' -> ACT-00001, ACT-00002, …
 *   Independent per-prefix counters in tab_series (naming.js:42).
 *
 * Self-registers at import time (Ground-truth #1, workorder §0).
 * Consumers MUST import this module (even without using a named export) so
 * newDoc('Job', …) returns a JobController instance.
 */
export class JobController extends Document {
  async insert() {
    if (!this.doc.name) {
      const e = this.doc.entity;
      if (e !== 'VIC' && e !== 'ACT') {
        throw new ValidationError(`Job.entity must be VIC or ACT (got: ${String(e)})`);
      }
      this.doc.name = await nextSeries(`${e}-.#####`, this.store);
    }
    return super.insert();
  }
}

// Import-time side-effect: register so newDoc('Job', …) returns a JobController.
registerController('Job', JobController);
