import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle, RotateCcw, Send, ShieldCheck, X } from 'lucide-react';
import { apiFetch, ApiError } from '../lib/api';

interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
}

const STARTER_QUESTIONS = [
  'How do I register as a new student?',
  'How do I mark attendance with my Hall Ticket?',
  'Why is face verification not working?',
  'Which departments are supported?',
];

export const HelpChatbot: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, open, error]);

  async function sendQuestion(rawText: string) {
    const text = rawText.trim();
    if (!text || loading) return;

    setError(null);
    const userMsgId = `u-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      text,
    };
    const pairedHistory = messages
      .filter((m, idx, arr) => m.role === 'model' || (m.role === 'user' && arr[idx + 1]?.role === 'model'))
      .slice(-12);
    while (pairedHistory.length > 0 && pairedHistory[0].role !== 'user') {
      pairedHistory.shift();
    }
    const historyPayload = pairedHistory.map((m) => ({
      role: m.role,
      text: m.text,
    }));

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await apiFetch<{ reply?: string }>('/api/chat', {
        method: 'POST',
        skipAuth: true,
        body: JSON.stringify({
          message: text,
          history: historyPayload,
        }),
      });
      const replyText = res?.reply?.trim();
      if (!replyText) {
        throw new Error('The assistant returned an empty response. Please try again.');
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `m-${Date.now()}`,
          role: 'model',
          text: replyText,
        },
      ]);
    } catch (err: unknown) {
      setMessages((prev) => prev.filter((m) => m.id !== userMsgId));
      setInput(text);
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Unable to reach assistant right now.');
      }
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    sendQuestion(input);
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end">
      {open && (
        <div
          role="dialog"
          aria-label="SBIST Website Assistant"
          className="mb-3 w-[calc(100vw-2rem)] sm:w-96 h-[500px] max-h-[78vh] bg-white border border-slate-200 rounded-2xl shadow-xl flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-8 w-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
                <MessageCircle className="h-4 w-4 text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-bold truncate">SBIST Website Help</div>
                <div className="text-[11px] text-slate-300 flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3 text-emerald-400 shrink-0" />
                  <span className="truncate">Public Portal Guide · No Private Data</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setMessages([]);
                    setError(null);
                  }}
                  title="Clear conversation"
                  className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close help chat"
                className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Scrollable Message Thread */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50 text-xs">
            {messages.length === 0 ? (
              <div className="space-y-3">
                <div className="bg-white border border-slate-200 rounded-xl p-3.5 text-slate-700 leading-relaxed">
                  Welcome to the{' '}
                  <strong>Swarna Bharathi Institute of Science and Technology</strong> Smart Attendance
                  help assistant. Ask anything about student registration, face enrollment, marking
                  attendance, or portal features. Private student, staff, and admin data is never
                  accessible here.
                </div>
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold text-slate-500">Quick Questions</div>
                  <div className="flex flex-col gap-1.5">
                    {STARTER_QUESTIONS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => sendQuestion(q)}
                        className="text-left px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-800 hover:border-blue-400 hover:bg-blue-50/40 transition-colors"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-3.5 py-2.5 leading-relaxed whitespace-pre-wrap break-words ${
                      m.role === 'user'
                        ? 'bg-slate-900 text-white'
                        : 'bg-white border border-slate-200 text-slate-800'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))
            )}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-200 rounded-xl px-3.5 py-2 text-slate-500">
                  Thinking...
                </div>
              </div>
            )}
          </div>

          {error && (
            <div
              role="alert"
              className="mx-3 mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-start justify-between gap-2 shrink-0"
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                className="text-red-500 hover:text-red-700 shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Input Bar */}
          <form
            onSubmit={handleSubmit}
            className="p-3 bg-white border-t border-slate-200 flex items-center gap-2 shrink-0"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={1000}
              placeholder="Ask about registration, attendance, departments..."
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="p-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-40 shrink-0"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-slate-900 text-white text-xs font-semibold shadow-lg hover:bg-slate-800 border border-slate-700"
      >
        <MessageCircle className="h-4 w-4 text-blue-300" />
        <span>{open ? 'Hide Help' : 'Ask Website Help'}</span>
      </button>
    </div>
  );
};
