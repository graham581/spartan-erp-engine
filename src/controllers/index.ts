import { registerController } from '../runtime/document';
import { SalesOrder } from './salesOrder';

let registered = false;

/** Wire controller subclasses into the runtime registry. Call once at startup. */
export function registerControllers(): void {
  if (registered) return;
  registered = true;
  registerController('Sales Order', SalesOrder);
}

export { SalesOrder };
