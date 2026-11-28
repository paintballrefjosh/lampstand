import { describe, expect, it } from "vitest";
import { signinErrorMessage, signinFailureFor } from "./signin-failure";

describe("signinFailureFor", () => {
  it("blames the credentials only when the API judged them", () => {
    expect(signinFailureFor(401)).toBe("credentials");
    expect(signinFailureFor(400)).toBe("credentials");
  });

  it("keeps the specific refusals", () => {
    expect(signinFailureFor(401, "account_deleted")).toBe("account_deleted");
    expect(signinFailureFor(429, "too_many_attempts")).toBe("too_many_attempts");
    // The general rate limiter answers 429 without a code.
    expect(signinFailureFor(429)).toBe("too_many_attempts");
  });

  it("reports a server that could not answer as unavailable", () => {
    for (const status of [404, 408, 500, 502, 503, 504]) {
      expect(signinFailureFor(status)).toBe("unavailable");
    }
    expect(signinFailureFor(500, "account_deleted")).toBe("unavailable");
  });
});

describe("signinErrorMessage", () => {
  it("does not say invalid credentials when the server was unavailable", () => {
    const message = signinErrorMessage("CredentialsSignin", "unavailable");
    expect(message).toContain("Your password was not rejected");
    expect(message).not.toContain("Invalid credentials");
  });

  it("keeps the other messages", () => {
    expect(signinErrorMessage("CredentialsSignin", "credentials")).toBe("Invalid credentials");
    expect(signinErrorMessage("AccountDeleted")).toContain("deleted");
    expect(signinErrorMessage("CredentialsSignin", "account_deleted")).toContain("deleted");
    expect(signinErrorMessage("CredentialsSignin", "too_many_attempts")).toContain("Too many");
    expect(signinErrorMessage("AccessDenied")).toBe("AccessDenied");
    expect(signinErrorMessage()).toBeUndefined();
  });
});
