import {
  IsInt,
  IsString,
  Min,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'IsAttestationValidAndConsistent', async: false })
export class IsAttestationValidAndConsistentConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as CreateChatHandoffDto;
    const hasHash =
      typeof dto.selectionAttestationHash === 'string' &&
      dto.selectionAttestationHash.trim().length > 0;
    const hasAttestation = typeof dto.attestation === 'string' && dto.attestation.trim().length > 0;

    // At least one must be provided
    if (!hasHash && !hasAttestation) {
      return false;
    }

    // If both are provided, they must be identical
    if (hasHash && hasAttestation && dto.selectionAttestationHash !== dto.attestation) {
      return false;
    }

    return true;
  }

  defaultMessage(_args: ValidationArguments): string {
    return 'Either selectionAttestationHash or attestation must be provided, and if both are provided they must be identical';
  }
}

/**
 * DTO for creating a chat handoff claim.
 * All fields are server-derived or attested; no client-supplied IDs,
 * idempotency keys, or session fields are accepted.
 */
export class CreateChatHandoffDto {
  /**
   * Attestation hash or signed token of the offer selection, produced by the agent.
   */
  @ValidateIf(
    (o: CreateChatHandoffDto) => !o.attestation || o.selectionAttestationHash !== undefined,
  )
  @IsString()
  selectionAttestationHash?: string;

  /**
   * Alias for selectionAttestationHash.
   */
  @ValidateIf(
    (o: CreateChatHandoffDto) => !o.selectionAttestationHash || o.attestation !== undefined,
  )
  @IsString()
  attestation?: string;

  /**
   * Index of the selected offer within the snapshot (1-based).
   */
  @IsInt()
  @Min(1)
  @Validate(IsAttestationValidAndConsistentConstraint)
  selectedOfferIndex!: number;
}
