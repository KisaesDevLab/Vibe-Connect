// Retrieves the session X25519 keypair that Verify.tsx stored in sessionStorage.
export function getSessionKeys(): { publicKey: string; secretKey: string } | null {
  const publicKey = sessionStorage.getItem('sessionPublicKey');
  const secretKey = sessionStorage.getItem('sessionSecretKey');
  if (!publicKey || !secretKey) return null;
  return { publicKey, secretKey };
}
