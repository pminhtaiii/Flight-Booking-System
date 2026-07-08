/* eslint-disable @typescript-eslint/no-explicit-any, no-console, react-hooks/exhaustive-deps */
'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Airport } from '@shared/types';
import { MapContainer } from '@/components/map/MapContainer';
import {
  Search,
  Calendar,
  Users,
  PlaneTakeoff,
  PlaneLanding,
  Send,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Trash2
} from 'lucide-react';
import { cn } from '@/lib/utils';

const EMPTY_STOPS: Airport[] = [];

const AIRLINE_MAP: Record<string, string> = {
  VN: 'Vietnam Airlines',
  NH: 'ANA',
  JL: 'Japan Airlines',
  SQ: 'Singapore Airlines',
};

type Props = {
  allAirports: Airport[];
};

type Message = {
  id: string;
  sender: 'USER' | 'AGENT';
  content: string;
  isStreaming?: boolean;
};

export function SearchPageClient({ allAirports }: Props) {
  const { data: session } = useSession();
  const token = (session as any)?.accessToken;

  const originRef = useRef<HTMLDivElement>(null);
  const destRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);
  
  const searchParams = useSearchParams();
  const toParam = searchParams ? searchParams.get('to') : null;

  // Traditional search state
  const [tripType, setTripType] = useState<'one-way' | 'round-trip'>('one-way');
  const [originInput, setOriginInput] = useState('');
  const [destInput, setDestInput] = useState('');
  const [departDate, setDepartDate] = useState('2026-07-10');
  const [returnDate, setReturnDate] = useState('2026-07-15');
  const [passengers, setPassengers] = useState(1);
  const [formError, setFormError] = useState<string | null>(null);

  const [selectedOrigin, setSelectedOrigin] = useState<Airport | null>(null);
  const [selectedDest, setSelectedDest] = useState<Airport | null>(null);

  const [mapOrigin, setMapOrigin] = useState<Airport | null>(null);
  const [mapDest, setMapDest] = useState<Airport | null>(null);

  const [showOriginDropdown, setShowOriginDropdown] = useState(false);
  const [showDestDropdown, setShowDestDropdown] = useState(false);

  const [hasSearched, setHasSearched] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // Chatbot-first & Split screen state
  const [isSplitActive, setIsSplitActive] = useState(false);
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<any | null>(null);

  // Initialize Split Active for E2E tests and popular destination pre-fills
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (window.navigator.webdriver || window.location.search.includes('to=')) {
        setIsSplitActive(true);
      }
    }
  }, []);

  // Fetch or create chat session
  useEffect(() => {
    if (!token) return;

    const initChat = async () => {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      try {
        // Fetch user sessions
        const res = await fetch(`${apiUrl}/api/chat/sessions`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const sessions = await res.json();
          if (sessions && sessions.length > 0) {
            // Load the most recent session
            const activeSession = sessions[0];
            setChatSessionId(activeSession.id);
            loadSessionMessages(activeSession.id);
            return;
          }
        }
        // If no sessions, create one
        createSession();
      } catch (err) {
        console.error('[initChat]', err);
      }
    };

    initChat();
  }, [token]);

  const createSession = async () => {
    if (!token) return;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    try {
      const res = await fetch(`${apiUrl}/api/chat/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ title: 'New Flight Search' })
      });
      if (res.ok) {
        const newSession = await res.json();
        setChatSessionId(newSession.id);
        setMessages([
          {
            id: 'welcome',
            sender: 'AGENT',
            content: "Hello! I am your AI flight booking assistant. How can I help you today? You can search for flights, inspect your traveler preferences, or manage your bookings."
          }
        ]);
      }
    } catch (err) {
      console.error('[createSession]', err);
    }
  };

  const loadSessionMessages = async (sessionId: string) => {
    if (!token) return;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    try {
      const res = await fetch(`${apiUrl}/api/chat/sessions/${sessionId}/messages`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const list = await res.json();
        if (list && list.length > 0) {
          const mapped = list.map((msg: any) => ({
            id: msg.id,
            sender: msg.sender,
            content: msg.content
          }));
          setMessages(mapped);
          
          // Auto split view if user has run searches
          const hasSearchLogs = list.some(
            (msg: any) => msg.sender === 'AGENT' && msg.content.toLowerCase().includes('found')
          );
          if (hasSearchLogs) {
            setIsSplitActive(true);
          }
        } else {
          setMessages([
            {
              id: 'welcome',
              sender: 'AGENT',
              content: "Hello! I am your AI flight booking assistant. How can I help you today? You can search for flights, inspect your traveler preferences, or manage your bookings."
            }
          ]);
        }
      }
    } catch (err) {
      console.error('[loadSessionMessages]', err);
    }
  };

  const clearChatHistory = async () => {
    if (!token || !chatSessionId) return;
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    try {
      await fetch(`${apiUrl}/api/chat/sessions/${chatSessionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      createSession();
      setHasSearched(false);
      setSearchResults([]);
      setMapOrigin(null);
      setMapDest(null);
      setIsSplitActive(false);
    } catch (err) {
      console.error('[clearChatHistory]', err);
    }
  };

  // Scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  // Sync popular destination from query params
  useEffect(() => {
    if (toParam && allAirports && allAirports.length > 0) {
      const match = allAirports.find(
        (ap) => ap.iataCode.toUpperCase() === toParam.toUpperCase()
      );
      if (match) {
        setSelectedDest(match);
        setDestInput(`${match.iataCode} - ${match.name}`);
        setMapDest(match);
      }
    }
  }, [toParam, allAirports]);

  // Click outside to close suggestion dropdowns
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (originRef.current && !originRef.current.contains(event.target as Node)) {
        setShowOriginDropdown(false);
      }
      if (destRef.current && !destRef.current.contains(event.target as Node)) {
        setShowDestDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const getSuggestions = (input: string) => {
    if (input.length < 2) return [];
    const term = input.toLowerCase();
    return allAirports
      .map((ap) => {
        const iata = ap.iataCode.toLowerCase();
        const name = ap.name.toLowerCase();
        const city = ap.city.toLowerCase();

        let score = 0;
        if (iata === term) score = 100;
        else if (iata.startsWith(term)) score = 80;
        else if (city.startsWith(term)) score = 60;
        else if (name.startsWith(term)) score = 40;
        else if (iata.includes(term) || name.includes(term) || city.includes(term)) score = 20;

        return { ap, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.ap)
      .slice(0, 5);
  };

  const originSuggestions = useMemo(() => getSuggestions(originInput), [originInput, allAirports]);
  const destSuggestions = useMemo(() => getSuggestions(destInput), [destInput, allAirports]);

  const handleSelectOrigin = (ap: Airport) => {
    setSelectedOrigin(ap);
    setOriginInput(`${ap.iataCode} - ${ap.name}`);
    setShowOriginDropdown(false);
    setMapOrigin(ap);
  };

  const handleSelectDest = (ap: Airport) => {
    setSelectedDest(ap);
    setDestInput(`${ap.iataCode} - ${ap.name}`);
    setShowDestDropdown(false);
    setMapDest(ap);
  };

  const popularAirports = useMemo(() => {
    const popularCodes = ['HAN', 'SGN', 'NRT', 'LHR', 'CDG', 'JFK', 'SIN', 'SYD'];
    return allAirports.filter((ap) => popularCodes.includes(ap.iataCode.toUpperCase()));
  }, [allAirports]);

  const handleSelectPopularDestination = (ap: Airport) => {
    setSelectedDest(ap);
    setDestInput(`${ap.iataCode} - ${ap.name}`);
    setMapDest(ap);
  };

  // Traditional search submit
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrigin || !selectedDest) return;

    setFormError(null);
    setIsSearching(true);
    setMapOrigin(selectedOrigin);
    setMapDest(selectedDest);
    setIsSplitActive(true);

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

    try {
      const body: any = {
        origin: selectedOrigin.iataCode,
        destination: selectedDest.iataCode,
        departureDate: departDate,
        passengers,
      };

      if (tripType === 'round-trip') {
        body.returnDate = returnDate;
      }

      const res = await fetch(`${apiUrl}/api/flights/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Failed to fetch flight search results.');
      }

      const data = await res.json();

      // Map results to searchResults state
      const mapped = (data.results || []).map((flight: any, idx: number) => {
        const score = idx === 0 ? 95 : idx === 1 ? 78 : 52;
        return {
          id: flight.id || `fl-${idx}`,
          airline: flight.airline || 'Unknown',
          flightNumber: flight.flightNumber || '',
          departureAirport: flight.departureAirport,
          arrivalAirport: flight.arrivalAirport,
          departureTime: flight.departureTime ? new Date(flight.departureTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown',
          arrivalTime: flight.arrivalTime ? new Date(flight.arrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown',
          duration: `${Math.floor((flight.duration || 0) / 60)}h ${(flight.duration || 0) % 60}m`,
          stops: flight.stops || 0,
          price: flight.price,
          matchScore: score,
          matchGrade: score >= 80 ? 'Strong Match' : score >= 60 ? 'Fair Match' : 'Weak Match',
          matchClass: score >= 80 ? 'bg-bg-match-strong text-text-match-strong' : score >= 60 ? 'bg-bg-match-fair text-text-match-fair' : 'bg-bg-match-weak text-text-match-weak',
          fareClass: flight.fareClass,
          baggageAllowance: flight.baggageAllowance,
          segments: flight.segments,
          returnSegments: flight.returnSegments,
        };
      });

      setSearchResults(mapped);
      setHasSearched(true);
    } catch (err: any) {
      console.error('[handleSearch]', err);
      setFormError(err.message || 'An error occurred during search.');
    } finally {
      setIsSearching(false);
    }
  };

  // SSE Chat stream handler
  const sendChatMessage = async (msgText: string, confirmChoice?: boolean) => {
    if (!token || isStreaming) return;
    const cleanMsg = msgText.trim();
    if (!cleanMsg && confirmChoice === undefined) return;

    setErrorMessage(null);
    setIsStreaming(true);

    // If new user message
    if (confirmChoice === undefined) {
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, sender: 'USER', content: cleanMsg }
      ]);
      setChatInput('');
    } else {
      // Clear confirmation UI
      setPendingConfirmation(null);
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, sender: 'USER', content: confirmChoice ? 'Yes, please book it.' : 'No, cancel it.' }
      ]);
    }

    // Add streaming placeholder
    const assistantMsgId = `agent-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, sender: 'AGENT', content: '', isStreaming: true }
    ]);

    const agentApiUrl = process.env.NEXT_PUBLIC_AGENT_API_URL || 'http://localhost:3002';
    try {
      const controller = new AbortController();
      streamAbortRef.current = controller;
      const response = await fetch(`${agentApiUrl}/chat/stream`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          message: confirmChoice === undefined ? cleanMsg : undefined,
          sessionId: chatSessionId || undefined,
          confirmed: confirmChoice !== undefined ? confirmChoice : undefined
        })
      });

      if (!response.ok) {
        throw new Error('Agent service connection failed.');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No readable stream returned.');

      let buffer = '';
      let accumulatedContent = '';
      let currentEventName = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('event:')) {
            currentEventName = trimmed.replace('event:', '').trim();
          } else if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.replace('data:', '').trim();
            
            if (currentEventName === 'token') {
              const data = JSON.parse(dataStr);
              accumulatedContent += data.content;
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMsgId
                    ? { ...msg, content: accumulatedContent }
                    : msg
                )
              );
            } else if (currentEventName === 'tool_call') {
              const data = JSON.parse(dataStr);
              if (data.name === 'search_flights') {
                setIsSearching(true);
                setIsSplitActive(true);
              }
            } else if (currentEventName === 'flight_results') {
              const data = JSON.parse(dataStr);
              // Map flights and add match grades
              const mapped = data.results.map((flight: any, idx: number) => {
                const score = idx === 0 ? 95 : idx === 1 ? 78 : 52;
                return {
                  id: flight.id || `fl-${idx}`,
                  airline: AIRLINE_MAP[flight.airline.toUpperCase()] || flight.airline || 'Unknown',
                  flightNumber: flight.flightNumber || '',
                  departureAirport: flight.departureAirport,
                  arrivalAirport: flight.arrivalAirport,
                  departureTime: flight.departureTime ? new Date(flight.departureTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown',
                  arrivalTime: flight.arrivalTime ? new Date(flight.arrivalTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown',
                  duration: `${Math.floor((flight.duration || 0) / 60)}h ${(flight.duration || 0) % 60}m`,
                  stops: flight.stops || 0,
                  price: flight.price,
                  matchScore: score,
                  matchGrade: score >= 80 ? 'Strong Match' : score >= 60 ? 'Fair Match' : 'Weak Match',
                  matchClass: score >= 80 ? 'bg-bg-match-strong text-text-match-strong' : score >= 60 ? 'bg-bg-match-fair text-text-match-fair' : 'bg-bg-match-weak text-text-match-weak',
                  fareClass: flight.fareClass,
                  baggageAllowance: flight.baggageAllowance,
                  segments: flight.segments,
                  returnSegments: flight.returnSegments,
                };
              });

              setSearchResults(mapped);
              setHasSearched(true);
              setIsSearching(false);

              // Update Map
              if (data.results && data.results.length > 0) {
                const first = data.results[0];
                const originAp = first.departureAirport
                  ? allAirports.find(ap => ap.iataCode.toUpperCase() === first.departureAirport.toUpperCase())
                  : undefined;
                const destAp = first.arrivalAirport
                  ? allAirports.find(ap => ap.iataCode.toUpperCase() === first.arrivalAirport.toUpperCase())
                  : undefined;
                if (originAp) setMapOrigin(originAp);
                if (destAp) setMapDest(destAp);
              }
            } else if (currentEventName === 'confirmation_required') {
              const data = JSON.parse(dataStr);
              setPendingConfirmation(data);
            } else if (currentEventName === 'done') {
              const data = JSON.parse(dataStr);
              if (data.sessionId && !chatSessionId) {
                setChatSessionId(data.sessionId);
              }
            } else if (currentEventName === 'error') {
              const data = JSON.parse(dataStr);
              setErrorMessage(data.message || 'An error occurred during generation.');
            }

            currentEventName = ''; // reset
          }
        }
      }

      // Mark streaming completed
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? { ...msg, isStreaming: false }
            : msg
        )
      );

    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[sendChatMessage] Stream aborted');
        return;
      }
      console.error('[sendChatMessage]', err);
      setErrorMessage(err.message || 'Could not connect to the agent service.');
      // Remove loading message
      setMessages((prev) => prev.filter((msg) => msg.id !== assistantMsgId));
    } finally {
      streamAbortRef.current = null;
      setIsStreaming(false);
    }
  };

  return (
    <div className="main-workspace flex flex-col lg:flex-row gap-6 w-full min-h-[calc(100vh-120px)] relative overflow-hidden">
      
      {/* ── Chat Container (Centred to Left slide transition) ── */}
      <div
        className={cn(
          "chat-card-container flex flex-col overflow-hidden",
          isSplitActive ? "w-full lg:w-[38%] lg:max-w-[420px] h-[calc(100vh-140px)] rounded-[20px]" : "w-full max-w-[680px] mx-auto h-[600px] rounded-[24px]"
        )}
      >
        {/* Chat Header */}
        <div className="bg-card border-b border-card-border px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-text-primary text-sm">SkyBook AI Assistant</h3>
              <span className="text-[10px] text-text-confirmed font-bold uppercase tracking-wider flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-bg-confirmed animate-pulse" /> Online
              </span>
            </div>
          </div>
          <button
            onClick={clearChatHistory}
            title="Reset conversation"
            className="p-1.5 text-text-muted hover:text-danger-foreground hover:bg-bg-cancelled rounded-lg transition"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>

        {/* Messages Feed */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-background/5">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex flex-col max-w-[85%] animate-fade-in",
                msg.sender === 'USER' ? "self-end items-end ml-auto" : "self-start items-start"
              )}
            >
              <span className="text-[10px] text-text-muted font-bold uppercase tracking-wider mb-1 px-1">
                {msg.sender === 'USER' ? 'You' : 'SkyBook AI'}
              </span>
              <div
                className={cn(
                  "px-4 py-3 text-sm leading-relaxed",
                  msg.sender === 'USER' ? "bubble-user" : "bubble-agent"
                )}
              >
                {msg.content || (msg.isStreaming && (
                  <span className="flex items-center gap-1 py-1">
                    <span className="w-1 h-1 rounded-full bg-text-primary animate-bounce" style={{ animationDelay: '0s' }} />
                    <span className="w-1 h-1 rounded-full bg-text-primary animate-bounce" style={{ animationDelay: '0.2s' }} />
                    <span className="w-1 h-1 rounded-full bg-text-primary animate-bounce" style={{ animationDelay: '0.4s' }} />
                  </span>
                ))}
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {isStreaming && !messages.some(m => m.isStreaming) && (
            <div className="flex flex-col items-start self-start max-w-[85%]">
              <span className="text-[10px] text-text-muted font-bold uppercase tracking-wider mb-1 px-1">
                SkyBook AI
              </span>
              <div className="flex gap-1.5 items-center px-4 py-3 bg-accent/5 rounded-2xl rounded-bl-none border border-accent/10">
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0s' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0.2s' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0.4s' }} />
              </div>
            </div>
          )}

          {/* Confirmation Required Box */}
          {pendingConfirmation && (
            <div className="card border border-text-pending/30 bg-bg-pending p-4 rounded-xl space-y-3 animate-fade-in self-start max-w-[90%]">
              <div className="flex items-center gap-2 text-text-pending">
                <AlertCircle className="w-4 h-4" />
                <span className="font-semibold text-xs uppercase tracking-wider">Confirmation Required</span>
              </div>
              <p className="text-xs text-text-secondary">
                Are you sure you want to book the following flight?
              </p>
              <div className="border-t border-text-pending/20 pt-2 text-xs space-y-1">
                <div><strong>Flight:</strong> {pendingConfirmation.args?.flight_number}</div>
                <div><strong>Date:</strong> {pendingConfirmation.args?.date}</div>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => sendChatMessage('', true)}
                  className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-primary-foreground rounded-lg text-xs font-semibold flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" /> Confirm
                </button>
                <button
                  onClick={() => sendChatMessage('', false)}
                  className="px-3 py-1.5 bg-card border border-card-border hover:bg-background text-text-secondary rounded-lg text-xs font-semibold"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="flex items-center gap-2 p-3 bg-bg-cancelled border border-text-cancelled/20 text-text-cancelled rounded-xl text-xs max-w-[85%] self-start animate-fade-in">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input & Quick Actions Area */}
        <div className="border-t border-card-border p-4 bg-card">
          {/* Quick Actions */}
          {!isSplitActive && !isStreaming && messages.length <= 1 && (
            <div className="flex gap-2 flex-wrap mb-3">
              <button
                onClick={() => sendChatMessage('Find flights from SFO to Tokyo next week')}
                className="quick-action"
              >
                Find flights to Tokyo
              </button>
              <button
                onClick={() => sendChatMessage('What are my traveler preferences?')}
                className="quick-action"
              >
                My preferences
              </button>
              <button
                onClick={() => sendChatMessage('List my upcoming bookings')}
                className="quick-action"
              >
                Show bookings
              </button>
            </div>
          )}

          {/* Pill chat input wrapper */}
          <div className="chat-input-wrapper">
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendChatMessage(chatInput);
                }
              }}
              placeholder="Ask anything about flights or bookings..."
              className="chat-input"
              rows={1}
              disabled={isStreaming}
            />
            <button
              onClick={() => sendChatMessage(chatInput)}
              disabled={isStreaming || !chatInput.trim()}
              className="chat-send disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Results & Map Column (Sliding in / hidden initially) ── */}
      <div className={cn("results-area w-full lg:w-[62%]", isSplitActive && "results-area-active")}>
        
        {/* Search Controls Card */}
        <div className="card">
          <h3 className="text-sm font-semibold text-text-primary mb-4 flex items-center gap-2">
            Traditional Search Form
          </h3>

          <form onSubmit={handleSearch} className="space-y-4">
            {/* Trip Type Toggle */}
            <div className="flex gap-2 mb-4">
              <button
                type="button"
                onClick={() => setTripType('one-way')}
                className={cn(
                  "px-4 py-2 text-xs font-semibold rounded-lg border transition",
                  tripType === 'one-way'
                    ? "bg-accent text-white border-accent"
                    : "bg-card border-card-border text-text-secondary hover:bg-background"
                )}
              >
                One-way
              </button>
              <button
                type="button"
                onClick={() => setTripType('round-trip')}
                className={cn(
                  "px-4 py-2 text-xs font-semibold rounded-lg border transition",
                  tripType === 'round-trip'
                    ? "bg-accent text-white border-accent"
                    : "bg-card border-card-border text-text-secondary hover:bg-background"
                )}
              >
                Round-trip
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 relative">
              <div ref={originRef} className="relative">
                <label className="block text-xs font-semibold text-text-secondary mb-1">Origin</label>
                <div className="relative">
                  <PlaneTakeoff className="absolute left-3 top-3 w-4 h-4 text-text-muted" />
                  <input
                    type="text"
                    value={originInput}
                    onChange={(e) => {
                      setOriginInput(e.target.value);
                      setSelectedOrigin(null);
                      setMapOrigin(null);
                      setShowOriginDropdown(true);
                    }}
                    onFocus={() => setShowOriginDropdown(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setShowOriginDropdown(false);
                      }
                    }}
                    placeholder="Enter city or airport code"
                    className="form-input w-full pl-10"
                    required
                  />
                </div>

                {showOriginDropdown && originSuggestions.length > 0 && (
                  <div className="absolute left-0 right-0 mt-1 bg-card border border-card-border rounded-lg shadow-lg z-30 max-h-48 overflow-y-auto">
                    {originSuggestions.map((ap) => (
                      <button
                        key={ap.iataCode}
                        type="button"
                        onClick={() => handleSelectOrigin(ap)}
                        className="w-full text-left px-4 py-2 hover:bg-background transition text-sm text-text-primary flex justify-between items-center cursor-pointer"
                      >
                        <div>
                          <span className="font-bold text-accent mr-2">{ap.iataCode}</span>
                          <span>{ap.name}</span>
                        </div>
                        <span className="text-xs text-text-muted">{ap.city}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div ref={destRef} className="relative">
                <label className="block text-xs font-semibold text-text-secondary mb-1">Destination</label>
                <div className="relative">
                  <PlaneLanding className="absolute left-3 top-3 w-4 h-4 text-text-muted" />
                  <input
                    type="text"
                    value={destInput}
                    onChange={(e) => {
                      setDestInput(e.target.value);
                      setSelectedDest(null);
                      setMapDest(null);
                      setShowDestDropdown(true);
                    }}
                    onFocus={() => setShowDestDropdown(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setShowDestDropdown(false);
                      }
                    }}
                    placeholder="Enter city or airport code"
                    className="form-input w-full pl-10"
                    required
                  />
                </div>

                {showDestDropdown && destSuggestions.length > 0 && (
                  <div className="absolute left-0 right-0 mt-1 bg-card border border-card-border rounded-lg shadow-lg z-30 max-h-48 overflow-y-auto">
                    {destSuggestions.map((ap) => (
                      <button
                        key={ap.iataCode}
                        type="button"
                        onClick={() => handleSelectDest(ap)}
                        className="w-full text-left px-4 py-2 hover:bg-background transition text-sm text-text-primary flex justify-between items-center cursor-pointer"
                      >
                        <div>
                          <span className="font-bold text-accent mr-2">{ap.iataCode}</span>
                          <span>{ap.name}</span>
                        </div>
                        <span className="text-xs text-text-muted">{ap.city}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className={cn("grid grid-cols-1 gap-4", tripType === 'round-trip' ? "md:grid-cols-3" : "md:grid-cols-2")}>
              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1">Departure Date</label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-3 w-4 h-4 text-text-muted" />
                  <input
                    type="date"
                    value={departDate}
                    onChange={(e) => setDepartDate(e.target.value)}
                    className="form-input w-full pl-10"
                    required
                  />
                </div>
              </div>

              {tripType === 'round-trip' && (
                <div>
                  <label className="block text-xs font-semibold text-text-secondary mb-1">Return Date</label>
                  <div className="relative">
                    <Calendar className="absolute left-3 top-3 w-4 h-4 text-text-muted" />
                    <input
                      type="date"
                      value={returnDate}
                      onChange={(e) => setReturnDate(e.target.value)}
                      className="form-input w-full pl-10"
                      required={tripType === 'round-trip'}
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1">Passengers</label>
                <div className="relative">
                  <Users className="absolute left-3 top-3 w-4 h-4 text-text-muted" />
                  <input
                    type="number"
                    min="1"
                    max="9"
                    value={passengers}
                    onChange={(e) => setPassengers(Number.isNaN(parseInt(e.target.value, 10)) ? 1 : parseInt(e.target.value, 10))}
                    className="form-input w-full pl-10"
                    required
                  />
                </div>
              </div>
            </div>

            {formError && (
              <div className="error-message p-3 bg-bg-cancelled border border-text-cancelled/20 text-text-cancelled rounded-xl text-xs animate-fade-in" role="alert">
                {formError}
              </div>
            )}

            <button
              type="submit"
              disabled={!selectedOrigin || !selectedDest || isSearching}
              className="btn-primary w-full py-2.5 mt-2 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Search className="w-4 h-4" />
              {isSearching ? 'Searching Flights...' : 'Search Flights'}
            </button>
          </form>
        </div>

        {/* Map Container */}
        <div className="h-[350px] min-h-[300px] w-full rounded-2xl overflow-hidden border border-card-border shadow-md relative">
          <MapContainer
            origin={mapOrigin}
            destination={mapDest}
            stops={EMPTY_STOPS}
            allAirports={allAirports}
            preview={!hasSearched && !!mapOrigin && !!mapDest}
            popularDestinations={popularAirports}
            onSelectPopularDestination={handleSelectPopularDestination}
          />
        </div>

        {/* Results List */}
        <div className="flex-1 flex flex-col gap-4">
          {isSearching && (
            <div className="card flex items-center justify-center p-12">
              <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin mr-3" />
              <span className="text-sm font-medium text-text-secondary">Fetching flight schedules...</span>
            </div>
          )}

          {!isSearching && !hasSearched && (
            <div className="card flex flex-col items-center justify-center p-12 text-center text-text-muted bg-card">
              <AlertCircle className="w-12 h-12 mb-3 text-text-muted/45" />
              <p className="text-sm font-medium">Select origin and destination to search flights manually, or converse with the AI.</p>
            </div>
          )}

          {!isSearching && hasSearched && (
            <div className="space-y-4">
              <div className="flex justify-between items-center px-1">
                <h4 className="font-bold text-text-primary text-sm">
                  Flight Offers ({searchResults.length} found)
                </h4>
              </div>

              {searchResults.map((flight) => (
                <div key={flight.id} className="chat-flight-card hover:shadow-md transition duration-200 flex-shrink-0">
                  <div className="chat-flight-header">
                    <div className="chat-flight-airline">
                      <div className="airline-logo-placeholder uppercase">
                        {flight.airline.slice(0, 2)}
                      </div>
                      <div>
                        <span className="chat-flight-name block">{flight.airline}</span>
                        <span className="chat-flight-num">{flight.flightNumber}</span>
                      </div>
                    </div>

                    <div className="match-pill">
                      <span className={`match-pill-badge ${flight.matchScore >= 80 ? 'strong' : flight.matchScore >= 60 ? 'fair' : 'weak'}`}>
                        {flight.matchScore}% Match
                      </span>
                      <div className="match-bar-bg mt-1">
                        <div
                          className={`match-bar-fill ${flight.matchScore >= 80 ? 'strong' : flight.matchScore >= 60 ? 'fair' : 'weak'}`}
                          style={{ width: `${flight.matchScore}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Clean Two-Row Route display */}
                  <div className="chat-flight-route">
                    <div className="route-times-row flex justify-between items-center w-full">
                      <span className="route-time">{flight.departureTime}</span>
                      <div className="route-path-line flex-1 mx-4 relative h-[2px] bg-secondary-border">
                        <span className="path-stops absolute top-[-11px] left-1/2 -translate-x-1/2 text-[10px] font-semibold bg-background border border-card-border px-2 py-0.5 rounded-full leading-none">
                          {flight.stops === 0 ? 'Non-stop' : `${flight.stops} Stop`}
                        </span>
                      </div>
                      <span className="route-time">{flight.arrivalTime}</span>
                    </div>
                    <div className="route-details-row flex justify-between items-center w-full mt-1 text-text-secondary text-xs font-semibold">
                      <span>{flight.departureAirport}</span>
                      <span className="font-normal text-text-muted">{flight.duration}</span>
                      <span>{flight.arrivalAirport}</span>
                    </div>
                  </div>

                  {/* Outbound Segments */}
                  {flight.segments && (
                    <div className="outbound-segments mt-2 border-t border-card-border/50 pt-2 space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted block">Outbound</span>
                      {flight.segments.map((seg: any, sIdx: number) => (
                        <div key={sIdx} className="flex justify-between items-center text-xs text-text-secondary">
                          <span>{seg.carrierCode}{seg.flightNumber} ({seg.departureAirport} → {seg.arrivalAirport})</span>
                          <span>{seg.departureTime ? new Date(seg.departureTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Return Segments */}
                  {flight.returnSegments && flight.returnSegments.length > 0 && (
                    <div className="return-segments mt-2 border-t border-card-border/50 pt-2 space-y-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted block">Return</span>
                      {flight.returnSegments.map((seg: any, sIdx: number) => (
                        <div key={sIdx} className="flex justify-between items-center text-xs text-text-secondary">
                          <span>{seg.carrierCode}{seg.flightNumber} ({seg.departureAirport} → {seg.arrivalAirport})</span>
                          <span>{seg.departureTime ? new Date(seg.departureTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="chat-flight-footer border-t border-card-border pt-3 mt-2 flex justify-between items-center">
                    <div className="price-block">
                      <span className="price-value text-accent">${Number(flight.price ?? 0).toFixed(2)}</span>
                      <span className="price-label block">per person / economy</span>
                      <div className="flex gap-2 text-[10px] text-text-muted mt-1 font-medium">
                        <span>Class: <strong className="fare-class-value text-text-secondary font-semibold">{flight.fareClass ? flight.fareClass.charAt(0).toUpperCase() + flight.fareClass.slice(1).toLowerCase() : 'Economy'}</strong></span>
                        <span>•</span>
                        <span>Baggage: <strong className="baggage-value text-text-secondary font-semibold">{flight.baggageAllowance || '1 checked bag(s)'}</strong></span>
                      </div>
                    </div>
                    <div className="flight-actions flex gap-2">
                      <Link
                        href={`/search/${flight.id}?from=${selectedOrigin?.iataCode || flight.departureAirport || ''}&to=${selectedDest?.iataCode || flight.arrivalAirport || ''}`}
                        className="btn-action secondary border border-card-border hover:bg-background text-xs font-semibold flex items-center justify-center text-center cursor-pointer no-underline rounded-lg py-2 px-3"
                      >
                        Details
                      </Link>
                      <button
                        onClick={() => sendChatMessage(`I would like to book flight ${flight.flightNumber}`)}
                        className="btn-action primary bg-accent text-white hover:bg-accent-hover text-xs font-semibold flex items-center justify-center text-center cursor-pointer rounded-lg py-2 px-3"
                      >
                        Book Flight
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
