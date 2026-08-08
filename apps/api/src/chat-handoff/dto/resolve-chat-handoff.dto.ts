import { IsString } from 'class-validator';

export class ResolveChatHandoffDto {
  @IsString()
  token!: string;
}
