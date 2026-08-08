import { IsInt, IsString, Min } from 'class-validator';

/**
 * DTO for creating a chat handoff claim.
 * All fields are server-derived or attested; no client-supplied IDs,
 * idempotency keys, or session fields are accepted.
 */
export class CreateChatHandoffDto {
  /**
   * Attestation hash of the offer selection, produced by the agent.
   */
  @IsString()
  selectionAttestationHash!: string;

  /**
   * Index of the selected offer within the snapshot (1-based).
   */
  @IsInt()
  @Min(1)
  selectedOfferIndex!: number;
}
