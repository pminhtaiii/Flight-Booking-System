import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export type BookingTab = 'upcoming' | 'past';

export class BookingListQueryDto {
  @IsOptional()
  @IsIn(['upcoming', 'past'])
  tab: BookingTab = 'upcoming';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}
