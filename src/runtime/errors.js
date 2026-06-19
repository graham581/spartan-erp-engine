// Engine error taxonomy. Controllers/handlers throw these; the API layer (Phase 3)
// maps each to an HTTP status. Subclass name is carried on `.name` for logging.

export class EngineError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

/** A field/value failed meta-driven or controller validation. -> 400 */
export class ValidationError extends EngineError {}

/** Doctype or record not found. -> 404 */
export class NotFoundError extends EngineError {}

/** Caller lacks permission (docperm / permlevel / row-scope). -> 403 */
export class PermissionError extends EngineError {}

/** Illegal lifecycle/workflow transition (e.g. submitting a submitted doc). -> 409 */
export class StateError extends EngineError {}
