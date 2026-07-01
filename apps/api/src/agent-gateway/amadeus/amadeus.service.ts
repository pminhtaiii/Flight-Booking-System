import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { FlightSearchQueryDto } from '../dto/flight-search-query.dto';
import { AmadeusFlightSearchResponse } from './amadeus.types';

@Injectable()
export class AmadeusService {
  private readonly logger = new Logger(AmadeusService.name);
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;

  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    this.apiKey = process.env.AMADEUS_API_KEY || '';
    this.apiSecret = process.env.AMADEUS_API_SECRET || '';
    this.baseUrl = process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com';

    if (!this.apiKey || !this.apiSecret) {
      this.logger.warn('Amadeus API Key or Secret is not configured.');
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    // Safety margin of 30 seconds
    const safetyMarginMs = 30 * 1000;

    if (this.accessToken && now + safetyMarginMs < this.tokenExpiresAt) {
      return this.accessToken;
    }

    try {
      this.logger.log('Fetching new Amadeus OAuth2 token...');
      const response = await fetch(`${this.baseUrl}/v1/security/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.apiKey,
          client_secret: this.apiSecret,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to fetch Amadeus token: ${response.status} ${errorText}`);
        throw new Error(`Token fetch failed: ${response.statusText}`);
      }

      const data = (await response.json()) as { access_token: string; expires_in: number };
      this.accessToken = data.access_token;
      // expires_in is in seconds, convert to absolute timestamp in milliseconds
      this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
      return this.accessToken;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error fetching Amadeus access token: ${msg}`);
      throw new HttpException(
        {
          message: 'Upstream Amadeus authentication failed',
          code: 'UPSTREAM_UNAVAILABLE',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async searchFlights(query: FlightSearchQueryDto): Promise<AmadeusFlightSearchResponse> {
    try {
      const token = await this.getAccessToken();

      const { origin, destination, date, passengers } = query;
      const params = new URLSearchParams({
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate: date,
        adults: String(passengers),
        max: '20',
      });

      const response = await fetch(`${this.baseUrl}/v2/shopping/flight-offers?${params.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Amadeus API flight offers search error: ${response.status} ${errorText}`);
        throw new Error(`Upstream returned error status ${response.status}`);
      }

      const responseData = (await response.json()) as AmadeusFlightSearchResponse;
      return responseData;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error during Amadeus flight search: ${msg}`);
      throw new HttpException(
        {
          message: 'Upstream flight search service is temporarily unavailable',
          code: 'UPSTREAM_UNAVAILABLE',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
