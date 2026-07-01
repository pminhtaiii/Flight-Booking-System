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
  status: 'CONFIRMED' | 'PENDING' | 'CANCELLED';
  createdAt: Date;
};

export type MessageSender = 'USER' | 'AGENT';

export type MessageType = 'STANDARD' | 'SUMMARY';

export type ChatSession = {
  id: string;
  userId: string;
  title?: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  messages?: ChatMessage[];
};

export type ChatMessage = {
  id: string;
  sessionId: string;
  sender: MessageSender;
  type: MessageType;
  content: string;
  createdAt: string;
};
