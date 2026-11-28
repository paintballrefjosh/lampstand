/**
 * Why a password sign-in did not succeed. "Invalid credentials" is said only when the API actually looked at them and
 * said no: when it cannot answer (database or storage down, API restarting), the person is told that instead, so
 * nobody goes off resetting a password that was fine.
 */
export type SigninFailure = "credentials" | "account_deleted" | "too_many_attempts" | "unavailable";

/** Long enough for a slow node to finish a password check, short enough that a stalled database is reported. */
export const SIGNIN_TIMEOUT_MS = 30_000;

/**
 * Judge the API's non-2xx answer to `verify-credentials`. Only 400 and 401 are a verdict on what was typed. Anything
 * else (a 5xx from a failed query, a 404 from a wrong internal token) says nothing about the password.
 */
export function signinFailureFor(status: number, code?: string): SigninFailure {
  if (status === 429) return "too_many_attempts";
  if (status === 401 && code === "account_deleted") return "account_deleted";
  if (status === 400 || status === 401) return "credentials";
  return "unavailable";
}

/**
 * What the sign-in page shows for the redirect Auth.js made: `?error=...&code=...`. Undefined = nothing went wrong.
 */
export function signinErrorMessage(error?: string, code?: string): string | undefined {
  if (error === "AccountDeleted" || code === "account_deleted") {
    return "This account has been deleted. Contact an administrator.";
  }
  if (code === "too_many_attempts") {
    return "Too many failed sign-in attempts for this account. Wait a few minutes and try again.";
  }
  if (code === "unavailable") {
    return "Sign-in is not working right now because the server or its database is not responding. Your password was not rejected. Try again in a few minutes, and tell an administrator if it carries on.";
  }
  if (error === "CredentialsSignin") return "Invalid credentials";
  return error;
}
