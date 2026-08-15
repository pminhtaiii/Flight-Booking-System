import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * DTO for creating a chat handoff claim.
 * All fields are server-derived or attested; no client-supplied IDs,
 * idempotency keys, or session fields are accepted.
 */
export class CreateChatHandoffDto {
  /**
   * Attestation hash or signed token of the offer selection, produced by the agent.
   */
  @IsOptional()
  @IsString()
  selectionAttestationHash?: string;

  /**
   * Alias for selectionAttestationHash.
   */
  @IsOptional()
  @IsString()
  attestation?: string;

  /**
   * Index of the selected offer within the snapshot (1-based).
   */
  @IsInt()
  @Min(1)
  selectedOfferIndex!: number;
}

