import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CommitSeatDto {
  @IsUUID('4') intentPassengerId!: string;
  @IsString() @IsNotEmpty() segmentId!: string;
  @IsString() @IsNotEmpty() serviceId!: string;
}

export class CommitBaggageDto {
  @IsUUID('4') intentPassengerId!: string;
  @IsString() @IsNotEmpty() serviceId!: string;
  @IsInt() @Min(1) @Max(99) quantity!: number;
}

export class CommitAncillarySelectionDto {
  @IsInt() @Min(0) expectedVersion!: number;
  @IsString() @IsNotEmpty() catalogFingerprint!: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CommitSeatDto)
  seats!: CommitSeatDto[];
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CommitBaggageDto)
  baggage!: CommitBaggageDto[];
}
