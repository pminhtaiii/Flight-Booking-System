export interface ClaimTokenPayload {
  userId: string;  // UUID of the user
  iat: number;     // Unix timestamp (seconds) when token was minted
}
