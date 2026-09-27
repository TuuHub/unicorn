// A source API answered with a non-2xx status. The cycle turns `status` into a
// stable sync error code ("unauthorized", "http_503") a model can act on.
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}
