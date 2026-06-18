/** Raised by controller validate()/hook logic — the engine's frappe.throw analogue. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
