export class UserPreferencesDto {
  seatPreference!: string | null;
  classPreference!: string | null;
  preferredAirlines!: string[];
  blacklistedAirlines!: string[];
  dietaryNeeds!: string | null;
}
