import React from 'react';

interface SafeChatBubbleProps {
  sanitizedContent: string;
}

export const SafeChatBubble: React.FC<SafeChatBubbleProps> = ({ sanitizedContent }) => {
  // Compliant: Renders text safely through React JSX element interpolation without innerHTML
  return (
    <div className="chat-bubble">
      <div>{sanitizedContent}</div>
    </div>
  );
};
