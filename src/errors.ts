import TypedError = require('typed-error');

export class ValidationError extends TypedError {}
export class InternalInconsistencyError extends TypedError {}
