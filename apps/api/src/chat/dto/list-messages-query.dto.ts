import { IsIn, IsInt, IsOptional, Max, Min, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class ListMessagesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @IsOptional()
  @Matches(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)(_[a-fA-F0-9-]{36})?$/, {
    message: 'cursor must be a valid ISO8601 date string or in the format <ISO8601>_<UUID>',
  })
  cursor?: string;

  @IsOptional()
  @IsIn(['before', 'after'])
  direction: 'before' | 'after' = 'before';
}
