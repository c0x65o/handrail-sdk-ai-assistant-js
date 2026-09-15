import type { ProviderAdapterError } from "./index.js";

/** Trusted input-preparation failures are distinct from a provider outage. Only
 * fixed messages leave the adapter boundary; never include native error text. */
export class ProviderInputPreparationError extends Error {
  readonly failure: ProviderAdapterError;
  constructor(reason: "forbidden" | "unavailable" | "changed" | "missing") {
    const failure: ProviderAdapterError = reason === "unavailable"
      ? { kind: "provider", code: "upstream_unavailable", retryable: true,
        message: "Saved files could not be prepared. Check access and try again." }
      : { kind: "client", code: reason === "forbidden" ? "forbidden" : "invalid_request", retryable: false,
        message: reason === "forbidden" ? "Access to the saved files is no longer available."
          : reason === "missing" ? "A saved file is no longer available. Upload the file again."
            : "A saved file changed while preparing this request. Select it again." };
    super(failure.message);
    this.name = "ProviderInputPreparationError";
    this.failure = Object.freeze(failure);
  }
}
