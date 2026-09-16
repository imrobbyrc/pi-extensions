export interface AuthResult {
  valid: boolean;
  error?: string;
}

export function validateAuth(token: string, expiresAt: number): AuthResult {
  if (!token || token.trim() === "") {
    return { valid: false, error: "Token required" };
  }
  if (Date.now() > expiresAt) {
    return { valid: false, error: "Token expired" };
  }
  return { valid: true };
}
