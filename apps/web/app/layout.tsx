import { ChatWidget } from '@/components/chat/ChatWidget';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata = {
  title: 'Flight Booking System',
  description: 'Secure flight booking platform with AI-guided assistance.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          {children}
          <ChatWidget />
        </Providers>
      </body>
    </html>
  );
}
