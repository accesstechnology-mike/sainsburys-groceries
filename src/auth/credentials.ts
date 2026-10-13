/** Email and password come from the environment only. They are never written to disk. */
export function readCredentials(): { email: string; password: string } | null {
  const email = process.env.SAINSBURYS_EMAIL || process.env.SAINSBURYS_USERNAME || "";
  const password = process.env.SAINSBURYS_PASSWORD || "";
  if (!email || !password) return null;
  return { email, password };
}
