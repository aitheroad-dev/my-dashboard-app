/** Carries an HTTP status so routes can return client errors vs upstream failures. */
export class ToolError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}
