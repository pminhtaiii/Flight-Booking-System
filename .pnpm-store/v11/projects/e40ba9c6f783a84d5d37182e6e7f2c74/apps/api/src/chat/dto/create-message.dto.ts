import { MessageSender, MessageType } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateMessageDto {
  @IsEnum(MessageSender)
  @IsNotEmpty()
  sender!: MessageSender;

  @IsOptional()
  @IsEnum(MessageType)
  type?: MessageType = MessageType.STANDARD;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  content!: string;
}
