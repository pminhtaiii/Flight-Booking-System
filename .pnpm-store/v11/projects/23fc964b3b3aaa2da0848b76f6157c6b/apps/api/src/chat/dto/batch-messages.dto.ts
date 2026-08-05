import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateMessageDto } from './create-message.dto';

export class BatchMessagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateMessageDto)
  messages!: CreateMessageDto[];
}
