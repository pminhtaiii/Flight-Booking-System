import React from 'react';

interface UnsafeChatBubbleProps {
  rawHtml: string;
}

export const UnsafeChatBubble: React.FC<UnsafeChatBubbleProps> = ({ rawHtml }) => {
  // VIOLATION: Direct interpolation of unescaped HTML into dangerouslySetInnerHTML
  return (
    <div className="chat-bubble">
      <div dangerouslySetInnerHTML={{ __html: rawHtml }} />
    </div>
  );
};
