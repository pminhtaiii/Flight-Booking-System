import { IsString, Matches } from 'class-validator';
import { HANDOFF_CREDENTIAL_PATTERN } from '@shared/types';

export class ResolveChatHandoffBodyDto {
  @IsString()
  @Matches(HANDOFF_CREDENTIAL_PATTERN)
  handoffToken!: string;
}
