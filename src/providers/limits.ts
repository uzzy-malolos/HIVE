/** Explicit per-request limits do not alter saved provider or model defaults. */
export function outputTokenLimit(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 32_768)) {
    throw new Error("maxOutputTokens must be an integer from 1 to 32768.");
  }
  return value;
}
