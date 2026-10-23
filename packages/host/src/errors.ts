export class MaintenanceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MaintenanceError";
    this.code = code;
  }
}
