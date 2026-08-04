import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PassengerType } from '@prisma/client';

export class AgentBookingReadinessPassengerDto {
  @IsEnum(PassengerType)
  passengerType!: PassengerType;

  @IsInt()
  @Min(1)
  passengerOrdinal!: number;

  @IsString()
  @IsIn(['traveler_profile', 'inline'])
  sourceType!: 'traveler_profile' | 'inline';
}

export class AgentBookingReadinessRequestDto {
  @IsUUID('4')
  flightOfferId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @ValidateNested({ each: true })
  @Type(() => AgentBookingReadinessPassengerDto)
  passengers!: AgentBookingReadinessPassengerDto[];
}

export type AgentBookingReadinessResponseDto = {
  scope: 'DOMESTIC' | 'INTERNATIONAL' | 'UNKNOWN';
  ready: boolean;
  passengers: Array<{
    passengerType: PassengerType;
    passengerOrdinal: number;
    sections: Array<{
      name: string;
      fields: Array<{
        name: string;
        status: string;
        reason: string | null;
      }>;
    }>;
  }>;
  nextAction: 'COMPLETE_PROFILE' | 'CONTINUE_CHECKOUT';
};
