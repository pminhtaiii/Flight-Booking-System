import { IsOptional, IsString, Matches } from 'class-validator';
import { HANDOFF_CREDENTIAL_PATTERN } from '@shared/types';

export class ResolveChatHandoffDto {
  @IsOptional()
  @IsString()
  @Matches(HANDOFF_CREDENTIAL_PATTERN)
  token?: string;

  @IsOptional()
  @IsString()
  @Matches(HANDOFF_CREDENTIAL_PATTERN)
  handoffToken?: string;
}

