import { TURNSTILE_VERIFY_URL } from "./config";

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Verifies a Turnstile token with Cloudflare's siteverify endpoint.
 * Returns false (fails closed) on any network or parsing error.
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  remoteIp: string | undefined,
): Promise<boolean> {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    if (!res.ok) {
      console.warn(JSON.stringify({ event: "turnstile_http_error", status: res.status }));
      return false;
    }
    const data = (await res.json()) as SiteverifyResponse;
    if (!data.success) {
      console.warn(
        JSON.stringify({ event: "turnstile_rejected", errorCodes: data["error-codes"] ?? [] }),
      );
    }
    return data.success === true;
  } catch {
    console.warn(JSON.stringify({ event: "turnstile_unreachable" }));
    return false;
  }
}
