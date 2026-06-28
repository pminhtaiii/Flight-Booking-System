export type User = {
  id: string;
  email: string;
  name?: string;
  createdAt: Date;
};

export type Flight = {
  id: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: Date;
  arrivalTime: Date;
  price: number;
};

export type Booking = {
  id: string;
  userId: string;
  flightId: string;
  status: 'confirmed' | 'pending' | 'cancelled';
  createdAt: Date;
};
