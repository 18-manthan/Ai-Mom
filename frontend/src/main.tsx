import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  ChevronUp,
  Copy,
  Mail,
  FileAudio,
  Info,
  LayoutList,
  LogOut,
  Monitor,
  MessageSquare,
  Moon,
  Pencil,
  Radio,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
} from "lucide-react";
import iMannLogo from "./assets/iMann.png";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8080";

type Meeting = {
  id: number;
  original_filename: string;
  status: "uploaded" | "processing" | "completed" | "failed";
  summary: string | null;
  summary_status: "not_started" | "queued" | "processing" | "completed" | "failed";
  summary_error: string | null;
  summary_preset: NotesPreset | null;
  generated_notes: GeneratedNote[];
  processing_seconds: number | null;
  summary_seconds: number | null;
  cleanup_status: "not_started" | "queued" | "processing" | "completed" | "failed";
  cleanup_error: string | null;
  cleanup_seconds: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  is_live: boolean;
  source: string | null;
  meeting_code: string | null;
  source_url: string | null;
  started_at: string | null;
  finished_at: string | null;
  segment_count: number;
  speakers: string[];
};

type NotesPreset = "short" | "detailed" | "citations" | "actions" | "team_sync" | "advice";

type Tab = "chat" | "notes" | "transcript" | "insights";
type Theme = "dark" | "light";
type AuthMode = "login" | "signup";
type AppView = "meetings" | "admin";

type AuthUser = {
  id: number;
  name: string;
  email: string;
  role: "super_admin" | "user";
  status: "pending" | "approved" | "rejected";
  created_at: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

type GeneratedNote = {
  id: string;
  preset: NotesPreset | string;
  title: string;
  content: string;
  created_at: string;
  seconds?: number | null;
};

type Segment = {
  start: number;
  end: number;
  speaker: string;
  text: string;
};

type ParticipantStat = {
  name: string;
  initials: string;
  color: string;
  seconds: number;
  words: number;
  turns: number;
  percent: number;
};

type MeetingDetail = Meeting & {
  language: string | null;
  language_probability: number | null;
  segments: Segment[];
  cleaned_segments: Segment[];
};

const NOTES_PRESETS: Array<{ value: NotesPreset; label: string; tag?: string }> = [
  { value: "short", label: "Short Summary" },
  { value: "detailed", label: "Detailed Summary" },
  { value: "citations", label: "Detailed Summary with Citations" },
  { value: "actions", label: "Summary and Action Items" },
  { value: "team_sync", label: "Team Sync - Project Updates" },
  { value: "advice", label: "Smart AI Advice", tag: "NEW" },
];

const SIDEBAR_ITEMS = [
  { label: "My Meetings", icon: FileAudio, active: true },
];

const GENERATING_NOTE_ID = "__generating_note__";
const AUTH_TOKEN_KEY = "imann.authToken";
const AUTH_ENABLED = import.meta.env.VITE_AUTH_ENABLED === "true";
const DEV_USER: AuthUser = {
  id: 0,
  name: "Manthan Chouhan",
  email: "manthanchouhan2003@gmail.com",
  role: "user",
  status: "approved",
  created_at: new Date().toISOString(),
};

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatDuration(seconds: number | null) {
  if (seconds === null || seconds === undefined) return "--";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;

  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function sourceLabel(source: string | null) {
  if (source === "google_meet") return "Google Meet";
  if (source === "microsoft_teams") return "Microsoft Teams";
  return source ? source.replace(/_/g, " ") : "Uploaded";
}

function statusLabel(meeting: Meeting) {
  if (meeting.is_live && meeting.status === "processing") return "Live captured";
  if (meeting.is_live) return `Live captured · ${meeting.status}`;
  return meeting.status;
}

function shouldShowMeetingMetaBadge(meeting: Meeting) {
  return meeting.is_live || Boolean(meeting.source) || meeting.segment_count > 0;
}

function parseBackendDate(value: string | null | undefined) {
  if (!value) return null;
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value);
  return new Date(hasTimezone ? value : `${value}Z`);
}

function meetingStartDate(meeting: Meeting) {
  return parseBackendDate(meeting.started_at ?? meeting.created_at) ?? new Date();
}

function formatMeetingStart(meeting: Meeting) {
  const date = meetingStartDate(meeting);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day = isToday ? "Today" : date.toDateString() === yesterday.toDateString() ? "Yesterday" : date.toLocaleDateString();
  return `${day} · ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatMeetingDateLabel(meeting: Meeting) {
  const date = meetingStartDate(meeting);
  return date.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfWeek(date: Date) {
  const next = startOfDay(date);
  const day = next.getDay();
  const offset = day === 0 ? 6 : day - 1;
  next.setDate(next.getDate() - offset);
  return next;
}

function isSameDay(first: Date, second: Date) {
  return startOfDay(first).getTime() === startOfDay(second).getTime();
}

function isSameWeek(first: Date, second: Date) {
  return startOfWeek(first).getTime() === startOfWeek(second).getTime();
}

function formatDayGroupLabel(date: Date) {
  return date.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatWeekGroupLabel(date: Date) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  const startMonth = start.toLocaleDateString([], { month: "long" });
  const endMonth = end.toLocaleDateString([], { month: "long" });

  if (sameMonth) {
    return `${startMonth} ${start.getDate()} - ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (sameYear) {
    return `${startMonth} ${start.getDate()} - ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${startMonth} ${start.getDate()}, ${start.getFullYear()} - ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
}

function formatMeetingRowSub(meeting: Meeting, groupKind: "day" | "week") {
  const date = meetingStartDate(meeting);
  if (groupKind === "day") {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

function formatMeetingClock(meeting: Meeting) {
  return meetingStartDate(meeting).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function meetingPeople(meeting: Meeting) {
  if (meeting.speakers?.length) return meeting.speakers.join(", ");
  return meeting.source ? sourceLabel(meeting.source) : "Uploaded recording";
}

function speakerInitials(name: string) {
  const cleaned = name.replace(/[()]/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "SP";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function normalizeParticipantName(value: string) {
  return value
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(?:meeting host|host|visitor|domain_disabled|domain disabled)\b/gi, "")
    .replace(/[\s:,-]+$/g, "")
    .trim();
}

function isValidParticipantName(value: string) {
  const name = normalizeParticipantName(value);
  const lower = name.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const badStarts = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "but",
    "can",
    "captions",
    "from",
    "good",
    "great",
    "have",
    "here",
    "how",
    "i",
    "im",
    "in",
    "is",
    "it",
    "language",
    "now",
    "okay",
    "ok",
    "participants",
    "please",
    "so",
    "speaker",
    "the",
    "this",
    "what",
    "you",
  ]);
  const badNameWords = new Set([
    "because",
    "can",
    "could",
    "did",
    "do",
    "does",
    "doing",
    "done",
    "know",
    "said",
    "say",
    "should",
    "that",
    "that's",
    "thats",
    "thing",
    "things",
    "think",
    "want",
    "wants",
    "why",
    "would",
  ]);

  if (!name || lower === "speaker" || lower === "you" || lower === "english" || lower.startsWith("language ")) {
    return false;
  }
  if (/[,!?]/.test(name) || !/^[A-Za-z0-9 .&'-]+$/.test(name)) {
    return false;
  }
  if (words.length < 2 || words.length > 5) {
    return false;
  }
  if (badStarts.has(words[0]) || words.some((word) => badNameWords.has(word))) {
    return false;
  }
  return /[a-z]/i.test(name);
}

function participantColor(index: number) {
  const colors = ["#ef3f55", "#9fbd08", "#7cda24", "#ffcf5d", "#7c8cff", "#f076c8", "#38bdf8"];
  return colors[index % colors.length];
}

function wordCount(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

function buildParticipantStats(segments: Segment[], knownSpeakers: string[] = []) {
  const stats = new Map<string, Omit<ParticipantStat, "initials" | "color" | "percent">>();

  knownSpeakers.forEach((speaker) => {
    const name = normalizeParticipantName(speaker);
    if (isValidParticipantName(name) && !stats.has(name)) {
      stats.set(name, { name, seconds: 0, words: 0, turns: 0 });
    }
  });

  segments.forEach((segment) => {
    const name = normalizeParticipantName(segment.speaker);
    if (!isValidParticipantName(name)) {
      return;
    }
    const existing = stats.get(name) ?? { name, seconds: 0, words: 0, turns: 0 };
    const seconds = Math.max(0, Number(segment.end || 0) - Number(segment.start || 0));
    existing.seconds += seconds;
    existing.words += wordCount(segment.text);
    existing.turns += 1;
    stats.set(name, existing);
  });

  const rows = Array.from(stats.values());
  const totalWords = rows.reduce((sum, item) => sum + item.words, 0);
  return rows
    .sort((first, second) => second.words - first.words)
    .map((item, index) => ({
      ...item,
      initials: speakerInitials(item.name),
      color: participantColor(index),
      percent: totalWords > 0 ? Math.round((item.words / totalWords) * 100) : 0,
    }));
}

function participantDonutGradient(stats: ParticipantStat[]) {
  if (stats.length === 0) {
    return "conic-gradient(var(--border) 0 360deg)";
  }
  let cursor = 0;
  const parts = stats.map((participant) => {
    const start = cursor;
    const sweep = Math.max(2, (participant.percent / 100) * 360);
    cursor += sweep;
    return `${participant.color} ${start}deg ${cursor}deg`;
  });
  return `conic-gradient(${parts.join(", ")})`;
}

function notesPresetLabel(preset: NotesPreset | null) {
  return NOTES_PRESETS.find((item) => item.value === preset)?.label ?? "Meeting notes";
}

function plainTextPreview(value: string | null | undefined, maxLength: number) {
  if (!value) return "";
  return value
    .split(/\n+/)
    .map((line) => line.trim().replace(/^#{1,6}\s*/, ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*(short summary|detailed summary(?: with citations)?|summary and action items|team sync - project updates|smart ai advice)\s*:?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function summaryPreview(summary: string | null) {
  if (!summary) return "Generate AI notes from one of the presets...";
  return plainTextPreview(summary, 90);
}

function notePreview(note: GeneratedNote) {
  return plainTextPreview(note.content, 82);
}

function formatNoteTime(value: string | null | undefined) {
  const date = parseBackendDate(value);
  if (!date) return "--";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderSummaryContent(summary: string) {
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    elements.push(
      <ul key={`list-${elements.length}`}>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>,
    );
  };

  summary.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      return;
    }

    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      flushList();
      elements.push(<h2 key={`h-${index}`}>{heading[1].replace(/\*\*/g, "")}</h2>);
      return;
    }

    if (/^\*\*.+\*\*:?$/.test(line)) {
      flushList();
      elements.push(<h2 key={`strong-${index}`}>{line.replace(/\*\*/g, "").replace(/:$/, "")}</h2>);
      return;
    }

    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      listItems.push(bullet[1].replace(/\*\*/g, ""));
      return;
    }

    flushList();
    elements.push(<p key={`p-${index}`}>{line.replace(/\*\*/g, "")}</p>);
  });

  flushList();
  return elements;
}

function ParticipantsStatsPanel({
  participantStats,
  participantTotalSeconds,
  participantDonut,
  processingSeconds,
}: {
  participantStats: ParticipantStat[];
  participantTotalSeconds: number;
  participantDonut: string;
  processingSeconds: number | null;
}) {
  return (
    <aside className="participant-panel" aria-label="Participants and speaking activity">
      <header>
        <span>Participants & Stats</span>
        <strong>{participantStats.length}</strong>
      </header>

      <div className="donut-wrap">
        <div
          className="participant-donut"
          style={{ "--donut": participantDonut } as React.CSSProperties}
          title={`${participantStats.length} participant${participantStats.length === 1 ? "" : "s"}`}
        >
          <strong>{Math.round(participantTotalSeconds / 60) || formatDuration(processingSeconds)}</strong>
          <span>{participantTotalSeconds > 0 ? "min" : "duration"}</span>
        </div>
      </div>

      <div className="participant-list">
        {participantStats.length === 0 && (
          <p className="participants-empty">No reliable participant names detected yet.</p>
        )}
        {participantStats.map((participant) => (
          <div className="participant-row" key={participant.name}>
            <span className="participant-dot" style={{ background: participant.color }} />
            <span className="participant-name" title={participant.name}>{participant.name}</span>
            <span className="participant-bar">
              <i style={{ width: `${Math.max(3, participant.percent)}%`, background: participant.color }} />
            </span>
            <strong>{participant.percent}%</strong>
            <div className="participant-tooltip">
              <b>{participant.name}</b>
              <span>{participant.turns} turn{participant.turns === 1 ? "" : "s"}</span>
              <span>{participant.words} words</span>
              <span>{formatDuration(participant.seconds)} speaking activity</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function formatBackendDateTime(value: string | null) {
  const date = parseBackendDate(value);
  return date ? date.toLocaleString() : "--";
}

function detailStatusText(meeting: MeetingDetail) {
  if (meeting.is_live && meeting.status === "completed") {
    return `Captured · ${formatDuration(meeting.processing_seconds)}`;
  }
  if (meeting.is_live && meeting.status === "processing") {
    return `Live now · ${meeting.segment_count || meeting.segments.length} segments`;
  }
  return `${meeting.status} · ${formatDuration(meeting.processing_seconds)}`;
}

function App() {
  const [authToken, setAuthToken] = useState(() => window.localStorage.getItem(AUTH_TOKEN_KEY) ?? "");
  const [user, setUser] = useState<AuthUser | null>(() => (AUTH_ENABLED ? null : DEV_USER));
  const [authLoading, setAuthLoading] = useState(AUTH_ENABLED && Boolean(authToken));
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [appView, setAppView] = useState<AppView>("meetings");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [adminUsers, setAdminUsers] = useState<AuthUser[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [meetingSearch, setMeetingSearch] = useState("");
  const [message, setMessage] = useState("");
  const [backendOnline, setBackendOnline] = useState(true);
  const [renamingMeetingId, setRenamingMeetingId] = useState<number | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [transcriptView, setTranscriptView] = useState<"raw" | "clean">("raw");
  const [activeTab, setActiveTab] = useState<Tab>("notes");
  const [notesPreset, setNotesPreset] = useState<NotesPreset>("short");
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [chatQuestion, setChatQuestion] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const savedTheme = window.localStorage.getItem("mom.theme");
    return savedTheme === "dark" ? "dark" : "light";
  });

  function setSession(token: string, nextUser: AuthUser) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
    setAuthToken(token);
    setUser(nextUser);
    setAuthMessage("");
  }

  function clearSession() {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
    setAuthToken("");
    setUser(null);
    setMeetings([]);
    setDetail(null);
    setSelectedId(null);
    setAppView("meetings");
  }

  async function apiFetch(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (AUTH_ENABLED && authToken) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (AUTH_ENABLED && (response.status === 401 || response.status === 403)) {
      if (path !== "/api/auth/me") {
        clearSession();
      }
    }
    return response;
  }

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthMessage("");
    const path = authMode === "login" ? "/api/auth/login" : "/api/auth/signup";
    const body = authMode === "login"
      ? { email: authEmail, password: authPassword }
      : { name: authName, email: authEmail, password: authPassword };

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail ?? "Authentication failed");
      }
      if (data.token && data.user) {
        setSession(data.token, data.user as AuthUser);
        setAuthPassword("");
        return;
      }
      setAuthMode("login");
      setAuthMessage(data.message ?? "Signup request submitted. Wait for Super Admin approval.");
      setAuthPassword("");
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Authentication failed");
    }
  }

  async function logout() {
    if (!AUTH_ENABLED) {
      setAccountMenuOpen(false);
      return;
    }
    if (authToken) {
      await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    }
    clearSession();
  }

  async function loadAdminUsers() {
    setAdminLoading(true);
    setMessage("");
    try {
      const response = await apiFetch("/api/admin/users", { cache: "no-store" });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Could not load users");
      }
      setAdminUsers((await response.json()) as AuthUser[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load users");
    } finally {
      setAdminLoading(false);
    }
  }

  async function moderateUser(userId: number, action: "approve" | "reject") {
    setMessage("");
    try {
      const response = await apiFetch(`/api/admin/users/${userId}/${action}`, { method: "POST" });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? `Could not ${action} user`);
      }
      await loadAdminUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not ${action} user`);
    }
  }

  async function loadMeetings() {
    const response = await apiFetch("/api/meetings", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Backend is not reachable.");
    }
    const data = (await response.json()) as Meeting[];
    setBackendOnline(true);
    setMeetings(data);
  }

  async function loadDetail(id: number) {
    const response = await apiFetch(`/api/meetings/${id}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Could not load meeting.");
    }
    setBackendOnline(true);
    setDetail((await response.json()) as MeetingDetail);
  }

  async function generateSummary(presetOverride?: NotesPreset) {
    if (!detail) return;
    setMessage("");
    const preset = presetOverride ?? notesPreset;
    setNotesPreset(preset);
    setSelectedNoteId(GENERATING_NOTE_ID);

    try {
      const response = await apiFetch(`/api/meetings/${detail.id}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Could not start summary generation");
      }
      const meeting = (await response.json()) as Meeting;
      const cachedNote = meeting.generated_notes?.find((note) => note.preset === preset && note.content);
      if (cachedNote) {
        setSelectedNoteId(cachedNote.id);
      }
      setDetail({ ...detail, ...meeting });
      await loadMeetings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start summary generation");
    }
  }

  async function cleanupTranscript() {
    if (!detail) return;
    setMessage("");

    try {
      const response = await apiFetch(`/api/meetings/${detail.id}/cleanup`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Could not start cleanup");
      }
      const meeting = (await response.json()) as Meeting;
      setDetail({ ...detail, ...meeting });
      await loadMeetings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start cleanup");
    }
  }

  async function askMeetingChat() {
    if (!detail || !chatQuestion.trim()) return;
    const question = chatQuestion.trim();
    setMessage("");
    setChatQuestion("");
    setChatMessages((items) => [...items, { role: "user", text: question }]);
    setChatLoading(true);

    try {
      const response = await apiFetch(`/api/meetings/${detail.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Could not answer this question");
      }
      const data = (await response.json()) as { answer: string };
      setChatMessages((items) => [...items, { role: "assistant", text: data.answer }]);
    } catch (error) {
      setChatMessages((items) => [
        ...items,
        {
          role: "assistant",
          text: error instanceof Error ? error.message : "Could not answer this question",
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  }

  async function deleteMeeting(meeting: Meeting) {
    const confirmed = window.confirm(`Delete "${meeting.original_filename}"?`);
    if (!confirmed) return;
    setMessage("");

    try {
      const response = await apiFetch(`/api/meetings/${meeting.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Delete failed");
      }

      const remaining = meetings.filter((item) => item.id !== meeting.id);
      setMeetings(remaining);
      if (selectedId === meeting.id) {
        const next = remaining[0] ?? null;
        setSelectedId(next?.id ?? null);
        setDetail(null);
        if (next) {
          await loadDetail(next.id);
        }
      }
      await loadMeetings();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Delete failed");
    }
  }

  function startRenaming(meeting: Meeting) {
    setRenamingMeetingId(meeting.id);
    setRenameTitle(meeting.original_filename);
    setMessage("");
  }

  function cancelRenaming() {
    setRenamingMeetingId(null);
    setRenameTitle("");
  }

  async function saveMeetingTitle(meetingId: number) {
    const title = renameTitle.trim();
    if (!title) {
      setMessage("Meeting title is required.");
      return;
    }

    setRenameSaving(true);
    setMessage("");

    try {
      const response = await apiFetch(`/api/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Could not update meeting title");
      }

      const meeting = (await response.json()) as Meeting;
      setMeetings((items) => items.map((item) => (item.id === meeting.id ? { ...item, ...meeting } : item)));
      setDetail((current) => (current?.id === meeting.id ? { ...current, ...meeting } : current));
      cancelRenaming();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update meeting title");
    } finally {
      setRenameSaving(false);
    }
  }

  useEffect(() => {
    if (!AUTH_ENABLED) {
      setAuthLoading(false);
      setUser(DEV_USER);
      return;
    }
    if (!authToken) {
      setAuthLoading(false);
      return;
    }

    fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Session expired");
        }
        const data = (await response.json()) as { user: AuthUser };
        setUser(data.user);
      })
      .catch(() => {
        clearSession();
      })
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!user || appView !== "meetings") return;
    loadMeetings().catch(() => {
      setBackendOnline(false);
      setMessage("Backend is not reachable.");
    });
  }, [user, appView]);

  useEffect(() => {
    if (user?.role === "super_admin" && appView === "admin") {
      loadAdminUsers();
    }
  }, [user?.role, appView]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("mom.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (user && selectedId !== null) {
      setChatMessages([]);
      setChatQuestion("");
      setSelectedNoteId(null);
      loadDetail(selectedId).catch(() => {
        setBackendOnline(false);
        setMessage("Could not load meeting. Backend may be stopped.");
      });
    }
  }, [selectedId, user]);

  useEffect(() => {
    if (detail && detail.cleaned_segments.length === 0 && transcriptView === "clean") {
      setTranscriptView("raw");
    }
    if (detail?.summary_preset) {
      setNotesPreset(detail.summary_preset);
    }
  }, [detail, transcriptView]);

  useEffect(() => {
    if (!detail || detail.summary_status === "queued" || detail.summary_status === "processing") return;
    const notes = detail.generated_notes ?? [];
    if (notes.length === 0) return;
    if (selectedNoteId === GENERATING_NOTE_ID) {
      setSelectedNoteId(notes[0].id);
    }
  }, [detail, selectedNoteId]);

  useEffect(() => {
    const active =
      detail?.status === "uploaded" ||
      detail?.status === "processing" ||
      detail?.cleanup_status === "queued" ||
      detail?.cleanup_status === "processing" ||
      detail?.summary_status === "queued" ||
      detail?.summary_status === "processing";
    if (!user || !active || selectedId === null) return;

    const timer = window.setInterval(() => {
      loadMeetings().catch(() => {
        setBackendOnline(false);
        setMessage("Backend is not reachable. Live status may be stale.");
      });
      loadDetail(selectedId).catch(() => {
        setBackendOnline(false);
        setMessage("Backend is not reachable. Live status may be stale.");
      });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [detail?.status, detail?.cleanup_status, detail?.summary_status, selectedId, user]);

  const canGenerateSummary =
    detail?.status === "completed" &&
    detail.summary_status !== "queued" &&
    detail.summary_status !== "processing";

  const summaryBusy =
    detail?.summary_status === "queued" || detail?.summary_status === "processing";

  const canCleanup =
    detail?.status === "completed" &&
    detail.cleanup_status !== "queued" &&
    detail.cleanup_status !== "processing";

  const canChat = detail?.status === "completed";

  const isTranscriptReady = detail?.status === "completed";

  const displayedSegments =
    isTranscriptReady && transcriptView === "clean" && detail?.cleaned_segments.length
      ? detail.cleaned_segments
      : isTranscriptReady
        ? detail?.segments ?? []
        : [];

  const insightSegments = useMemo(() => {
    if (!detail) return [];
    return detail.cleaned_segments.length ? detail.cleaned_segments : detail.segments;
  }, [detail]);

  const participantStats = useMemo(
    () => buildParticipantStats(insightSegments, detail?.speakers ?? []),
    [detail?.speakers, insightSegments],
  );

  const speakers = participantStats.map((participant) => participant.name);
  const participantTotalSeconds = participantStats.reduce((sum, participant) => sum + participant.seconds, 0);
  const participantDonut = participantDonutGradient(participantStats);

  const notesHistory = useMemo<GeneratedNote[]>(() => {
    if (!detail) return [];
    if (detail.generated_notes?.length) return detail.generated_notes;
    if (!detail.summary) return [];
    return [
      {
        id: "legacy-summary",
        preset: detail.summary_preset ?? "short",
        title: notesPresetLabel(detail.summary_preset),
        content: detail.summary,
        created_at: detail.updated_at,
        seconds: detail.summary_seconds,
      },
    ];
  }, [detail]);

  const selectedNote =
    selectedNoteId === null || selectedNoteId === GENERATING_NOTE_ID
      ? null
      : notesHistory.find((note) => note.id === selectedNoteId) ?? null;

  const filteredMeetings = useMemo(() => {
    const query = meetingSearch.trim().toLowerCase();
    if (!query) return meetings;
    return meetings.filter((meeting) => {
      const searchable = [
        meeting.original_filename,
        meetingPeople(meeting),
        sourceLabel(meeting.source),
        statusLabel(meeting),
        meeting.meeting_code ?? "",
        meeting.summary ?? "",
        ...(meeting.speakers ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [meetingSearch, meetings]);

  const groupedMeetings = useMemo(() => {
    const now = new Date();
    const groups: Array<{
      key: string;
      label: string;
      kind: "day" | "week";
      items: Meeting[];
    }> = [];
    const byKey = new Map<string, (typeof groups)[number]>();

    filteredMeetings.forEach((meeting) => {
      const date = meetingStartDate(meeting);
      const kind: "day" | "week" = isSameWeek(date, now) ? "day" : "week";
      const keyDate = kind === "day" ? startOfDay(date) : startOfWeek(date);
      const key = `${kind}-${keyDate.toISOString().slice(0, 10)}`;
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          kind,
          label: kind === "day" ? formatDayGroupLabel(date) : formatWeekGroupLabel(date),
          items: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }
      group.items.push(meeting);
    });

    return groups;
  }, [filteredMeetings]);

  if (authLoading) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <img src={iMannLogo} alt="iMann" />
          <h1>Loading iMann...</h1>
        </section>
      </main>
    );
  }

  if (AUTH_ENABLED && !user) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="auth-brand">
            <img src={iMannLogo} alt="iMann" />
            <span>Meeting intelligence workspace</span>
          </div>
          <h1>{authMode === "login" ? "Welcome back" : "Request access"}</h1>
          <p>
            {authMode === "login"
              ? "Login to access transcripts, AI notes, and meeting insights."
              : "Create your account. A Super Admin must approve it before access is enabled."}
          </p>
          <form className="auth-form" onSubmit={submitAuth}>
            {authMode === "signup" && (
              <label>
                Name
                <input value={authName} onChange={(event) => setAuthName(event.target.value)} placeholder="Manthan Chouhan" />
              </label>
            )}
            <label>
              Email
              <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="you@company.com" type="email" />
            </label>
            <label>
              Password
              <input value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Minimum 8 characters" type="password" />
            </label>
            {authMessage && <div className="auth-message">{authMessage}</div>}
            <button className="auth-submit" type="submit">
              {authMode === "login" ? "Login" : "Submit signup request"}
            </button>
          </form>
          <button
            className="auth-switch"
            type="button"
            onClick={() => {
              setAuthMode(authMode === "login" ? "signup" : "login");
              setAuthMessage("");
            }}
          >
            {authMode === "login" ? "Need access? Sign up" : "Already approved? Login"}
          </button>
          <small>First signup becomes Super Admin automatically.</small>
        </section>
      </main>
    );
  }

  const currentUser = user ?? DEV_USER;

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={iMannLogo} alt="iMann" />
        </div>

        <nav className="side-nav" aria-label="Main navigation">
          {SIDEBAR_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={appView === "meetings" ? "active" : ""}
                type="button"
                key={item.label}
                onClick={() => {
                  setAppView("meetings");
                  setSelectedId(null);
                  setDetail(null);
                  setActiveTab("notes");
                  loadMeetings().catch(() => {
                    setBackendOnline(false);
                    setMessage("Backend is not reachable.");
                  });
                }}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
          {currentUser.role === "super_admin" && (
            <button
              className={appView === "admin" ? "active" : ""}
              type="button"
              onClick={() => {
                setAppView("admin");
                setSelectedId(null);
                setDetail(null);
              }}
            >
              <ShieldCheck size={17} />
              <span>Super Admin</span>
            </button>
          )}
        </nav>

        <div className="account-menu-wrap">
          {accountMenuOpen && (
            <div className="account-popover">
              <div className="account-popover-head">
                <span className="row-avatar">{speakerInitials(currentUser.name)}</span>
                <div className="account-user-copy">
                  <strong>{currentUser.name}</strong>
                  <small>{currentUser.email}</small>
                </div>
              </div>

              <div className="account-menu-section">
                <span className="account-menu-label">Interface theme</span>
                <button type="button" onClick={() => setTheme("light")}>
                  <Sun size={16} />
                  Light
                  {theme === "light" && <Check size={15} />}
                </button>
                <button type="button" onClick={() => setTheme("dark")}>
                  <Moon size={16} />
                  Dark
                  {theme === "dark" && <Check size={15} />}
                </button>
                <button type="button" onClick={() => setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")}>
                  <Monitor size={16} />
                  Match system preference
                </button>
              </div>

              <div className="account-menu-section">
                <a href="mailto:manthanchouhan2003@gmail.com">
                  <Mail size={16} />
                  <span>
                    Contact Us
                    <small>+91 900985591</small>
                  </span>
                </a>
                {AUTH_ENABLED && (
                  <button type="button" onClick={logout}>
                    <LogOut size={16} />
                    Sign out
                  </button>
                )}
              </div>
            </div>
          )}
          <button className="user-card" type="button" onClick={() => setAccountMenuOpen((open) => !open)}>
            <span className="row-avatar">{speakerInitials(currentUser.name)}</span>
            <span className="user-card-copy">
              <strong>{currentUser.name}</strong>
              <small>{currentUser.email}</small>
            </span>
            <ChevronUp className={accountMenuOpen ? "account-chevron open" : "account-chevron"} size={16} />
          </button>
        </div>
      </aside>

      <div className="creator-credit">
        <span>Made with ❤️ by</span>
        <strong>Manthan Chouhan</strong>
        <a href="https://linkedin.com/in/manthan-chouhan-35ba4b220/" target="_blank" rel="noreferrer">
          AI DEV
        </a>
        <span>@ CIS </span>
      </div>

      <section className="content">
        <div className="top-banner">
          <strong>Use the iMann Chrome extension with Google Meet or Microsoft Teams captions for live capture.</strong>
        </div>

        {!backendOnline && (
          <div className="notice warning-box">
            Backend is not reachable. This view may be showing the last known meeting state.
          </div>
        )}

        {appView === "admin" && (
          <>
            <header className="page-head">
              <div className="page-title">
                <ShieldCheck size={18} />
                <h2>Super Admin</h2>
              </div>
              <button className="toolbar-chip" type="button" onClick={loadAdminUsers} disabled={adminLoading}>
                <ArrowUpDown size={15} />
                {adminLoading ? "Refreshing..." : "Refresh users"}
              </button>
            </header>
            {message && <p className="error page-error">{message}</p>}
          </>
        )}

        {appView === "meetings" && !detail && (
          <>
            <header className="page-head">
              <div className="page-title">
                <LayoutList size={18} />
                <h2>My Meetings</h2>
              </div>
            </header>
            {message && <p className="error page-error">{message}</p>}

            <label className="search-bar">
              <Search size={19} />
              <input
                value={meetingSearch}
                placeholder="Search for keywords, participants, labels, and more..."
                onChange={(event) => setMeetingSearch(event.target.value)}
              />
            </label>

            <div className="meeting-toolbar">
              <button className="toolbar-chip" type="button" onClick={loadMeetings}>
                <ArrowUpDown size={15} />
                Refresh meetings
              </button>
            </div>
          </>
        )}

        {appView === "meetings" && detail && (
          <>
            <header className="detail-head">
              <div>
                <button className="back-link" type="button" onClick={() => { setSelectedId(null); setDetail(null); }}>
                  <ArrowLeft size={16} />
                  My Meetings
                </button>
                <div className="detail-title-row">
                  {renamingMeetingId === detail.id ? (
                    <form
                      className="rename-inline detail-rename"
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveMeetingTitle(detail.id);
                      }}
                    >
                      <input
                        className="rename-input"
                        value={renameTitle}
                        autoFocus
                        maxLength={160}
                        onChange={(event) => setRenameTitle(event.target.value)}
                      />
                      <button className="rename-action primary" type="submit" disabled={renameSaving}>
                        Save
                      </button>
                      <button className="rename-action" type="button" onClick={cancelRenaming} disabled={renameSaving}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <h2>{detail.original_filename}</h2>
                      <button
                        className="icon-button title-edit-button"
                        type="button"
                        title="Update call title"
                        aria-label="Update call title"
                        onClick={() => startRenaming(detail)}
                      >
                        <Pencil size={15} />
                      </button>
                    </>
                  )}
                </div>
                <p>
                  <strong>{detailStatusText(detail)}</strong>
                  {detail.language && ` · Language: ${detail.language}`}
                </p>
                {detail.is_live && (
                  <div className="detail-meta">
                    <span className="source-chip">
                      <Radio size={12} />
                      {sourceLabel(detail.source)}
                    </span>
                    <details className="info-menu">
                      <summary>
                        <Info size={13} />
                        Info
                      </summary>
                      <div className="info-menu-panel">
                        {detail.meeting_code && (
                          <div>
                            <span>Meeting code</span>
                            <strong>{detail.meeting_code}</strong>
                          </div>
                        )}
                        {detail.started_at && (
                          <div>
                            <span>Started</span>
                            <strong>{formatBackendDateTime(detail.started_at)}</strong>
                          </div>
                        )}
                        {detail.finished_at && (
                          <div>
                            <span>Finished</span>
                            <strong>{formatBackendDateTime(detail.finished_at)}</strong>
                          </div>
                        )}
                        {detail.source_url && (
                          <div>
                            <span>Source</span>
                            <strong>{sourceLabel(detail.source)}</strong>
                          </div>
                        )}
                      </div>
                    </details>
                  </div>
                )}
              </div>
              <div className="speaker-count">
                {detail.is_live && detail.status === "processing" ? "Live" : `${speakers.length || 0} speakers`}
              </div>
            </header>

            {detail.error && <div className="notice error-box">{detail.error}</div>}

            <nav className="tabs" aria-label="Meeting dashboard">
              <button className={activeTab === "chat" ? "selected" : ""} disabled={!detail} onClick={() => setActiveTab("chat")}>
                <MessageSquare size={15} />
                AI Chat
              </button>
              <button className={activeTab === "transcript" ? "selected" : ""} disabled={!detail} onClick={() => setActiveTab("transcript")}>
                Transcript
              </button>
              <button className={activeTab === "notes" ? "selected" : ""} disabled={!detail} onClick={() => setActiveTab("notes")}>
                Notes
              </button>
              <button className={activeTab === "insights" ? "selected" : ""} disabled={!detail} onClick={() => setActiveTab("insights")}>
                Insights
              </button>
            </nav>
          </>
        )}

        <div className="workspace-scroll">
          {appView === "admin" && (
            <section className="admin-panel">
              <div className="admin-note">
                <strong>Signup approvals</strong>
                <span>Pending users cannot access iMann until a Super Admin approves them.</span>
              </div>
              <div className="admin-users">
                {adminUsers.length === 0 && <p className="empty">No users found.</p>}
                {adminUsers.map((item) => (
                  <article className="admin-user-row" key={item.id}>
                    <span className="row-avatar">{speakerInitials(item.name)}</span>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{item.email}</small>
                    </div>
                    <span className={`user-status ${item.status}`}>{item.status}</span>
                    <span className="user-role">{item.role === "super_admin" ? "Super Admin" : "User"}</span>
                    <div className="admin-user-actions">
                      <button type="button" disabled={item.status === "approved"} onClick={() => moderateUser(item.id, "approve")}>
                        Approve
                      </button>
                      <button type="button" disabled={item.status === "rejected" || item.role === "super_admin"} onClick={() => moderateUser(item.id, "reject")}>
                        Reject
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {appView === "meetings" && !detail && (
            <section className="meeting-dashboard">
              {meetings.length === 0 && <p className="empty">No meetings yet.</p>}
              {meetings.length > 0 && filteredMeetings.length === 0 && (
                <p className="empty">No meetings found for "{meetingSearch.trim()}".</p>
              )}
              {groupedMeetings.map((group) => (
                <React.Fragment key={group.key}>
                  <div className="meeting-date-group">{group.label}</div>
                  {group.items.map((meeting) => (
                    <article className="meeting-row" key={meeting.id}>
                      <button className="row-checkbox" type="button" aria-label="Select meeting" />
                      <div className="row-time">
                        <strong>{meeting.processing_seconds !== null ? formatDuration(meeting.processing_seconds) : statusLabel(meeting)}</strong>
                        <span>{formatMeetingRowSub(meeting, group.kind)}</span>
                      </div>
                      {renamingMeetingId === meeting.id ? (
                        <div className="row-main row-main-static">
                          <span className="row-avatar">{meeting.original_filename.slice(0, 1).toUpperCase()}</span>
                          <form
                            className="rename-inline row-rename"
                            onSubmit={(event) => {
                              event.preventDefault();
                              saveMeetingTitle(meeting.id);
                            }}
                          >
                            <input
                              className="rename-input"
                              value={renameTitle}
                              autoFocus
                              maxLength={160}
                              onChange={(event) => setRenameTitle(event.target.value)}
                            />
                            <button className="rename-action primary" type="submit" disabled={renameSaving}>
                              Save
                            </button>
                            <button className="rename-action" type="button" onClick={cancelRenaming} disabled={renameSaving}>
                              Cancel
                            </button>
                          </form>
                        </div>
                      ) : (
                        <button
                          className="row-main"
                          type="button"
                          onClick={() => {
                            setSelectedId(meeting.id);
                            setActiveTab(meeting.summary ? "notes" : "transcript");
                          }}
                        >
                          <span className="row-avatar">{meeting.original_filename.slice(0, 1).toUpperCase()}</span>
                          <span>
                            <strong>{meeting.original_filename}</strong>
                            <small>{meetingPeople(meeting)}</small>
                            {meeting.summary && <p>{plainTextPreview(meeting.summary, 190)}...</p>}
                          </span>
                        </button>
                      )}
                      <div className="row-actions">
                        {shouldShowMeetingMetaBadge(meeting) && (
                          <span className={meeting.status === "processing" && meeting.is_live ? "live-badge active" : "live-badge"}>
                            {meeting.is_live && <Radio size={12} />}
                            {meeting.source ? sourceLabel(meeting.source) : ""}
                            {meeting.source && meeting.segment_count ? " · " : ""}
                            {meeting.segment_count ? `${meeting.segment_count} lines` : ""}
                          </span>
                        )}
                        <button
                          title="Update call title"
                          type="button"
                          onClick={() => startRenaming(meeting)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          title="Delete meeting"
                          type="button"
                          onClick={() => deleteMeeting(meeting)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                </React.Fragment>
              ))}
            </section>
          )}

          {appView === "meetings" && detail && (
            <div className="meeting-detail-shell">
              <div className="meeting-detail-main">
              {activeTab === "chat" && (
                <section className="dashboard-panel">
                  <section className="meeting-chat">
                    <aside className="chat-rail">
                      <button className="new-note-button" type="button" onClick={() => {
                        setChatMessages([]);
                        setChatQuestion("");
                      }}>
                        + New Chat
                      </button>
                      <button className="note-thread active" type="button">
                        <MessageSquare size={16} />
                        <span>
                          <strong>Meeting Q&A</strong>
                          <small>Ask anything from this transcript</small>
                          <time>{formatMeetingStart(detail)}</time>
                        </span>
                      </button>
                    </aside>

                    <article className="chat-workspace">
                      <div className="chat-center">
                        <h3>
                          <Sparkles size={22} />
                          Ask iMann about this meeting
                        </h3>
                        <div className="prompt-grid chat-suggestions">
                          {[
                            "What are the key decisions?",
                            "List action items",
                            "What risks were discussed?",
                            "Summarize follow-ups",
                          ].map((prompt) => (
                            <button
                              key={prompt}
                              type="button"
                              disabled={!canChat || chatLoading}
                              onClick={() => setChatQuestion(prompt)}
                            >
                              <span>✨</span>
                              <strong>{prompt}</strong>
                            </button>
                          ))}
                        </div>

                        <div className="chat-thread" aria-live="polite">
                          {chatMessages.length === 0 && (
                            <div className="chat-empty">
                              {canChat
                                ? "Ask a question about decisions, blockers, action items, speakers, or any topic discussed in this meeting."
                                : "AI Chat will be available after transcription is completed."}
                            </div>
                          )}
                          {chatMessages.map((item, index) => (
                            <div className={`chat-bubble ${item.role}`} key={`${item.role}-${index}`}>
                              <strong>{item.role === "user" ? "You" : "iMann"}</strong>
                              <p>{item.text}</p>
                            </div>
                          ))}
                          {chatLoading && (
                            <div className="chat-bubble assistant">
                              <strong>iMann</strong>
                              <p>Thinking through the meeting transcript...</p>
                            </div>
                          )}
                        </div>

                        <form
                          className="chat-composer"
                          onSubmit={(event) => {
                            event.preventDefault();
                            askMeetingChat();
                          }}
                        >
                          <textarea
                            value={chatQuestion}
                            disabled={!canChat || chatLoading}
                            placeholder={
                              canChat
                                ? "Ask anything about this meeting..."
                                : "Chat is available after transcription is completed."
                            }
                            onChange={(event) => setChatQuestion(event.target.value)}
                          />
                          <button className="primary" type="submit" disabled={!canChat || chatLoading || !chatQuestion.trim()}>
                            <Send size={15} />
                            Ask AI
                          </button>
                        </form>
                      </div>
                    </article>
                  </section>
                </section>
              )}

              {activeTab === "notes" && (
                <section className="dashboard-panel">
                  <section className="notes-studio">
                    <aside className="notes-rail">
                      <button
                        className="new-note-button"
                        type="button"
                        onClick={() => setSelectedNoteId(null)}
                      >
                        + New notes
                      </button>
                      {notesHistory.length === 0 && (
                        <p className="notes-empty">Generated notes will appear here.</p>
                      )}
                      {notesHistory.map((note) => (
                        <button
                          className={selectedNote?.id === note.id ? "note-thread active" : "note-thread"}
                          key={note.id}
                          type="button"
                          onClick={() => setSelectedNoteId(note.id)}
                        >
                          <FileAudio size={16} />
                          <span>
                            <strong>{note.title}</strong>
                            <small>{notePreview(note)}</small>
                            <time>{formatNoteTime(note.created_at)}</time>
                          </span>
                        </button>
                      ))}
                    </aside>

                    <section className="notes-main-workspace">
                      {selectedNote ? (
                        <article className="summary-document notes-viewer">
                          <header className="document-head">
                            <h3>
                              <FileAudio size={18} />
                              {selectedNote.title}
                            </h3>
                            <button
                              type="button"
                              title="Copy notes"
                              onClick={() => navigator.clipboard?.writeText(selectedNote.content)}
                            >
                              <Copy size={17} />
                            </button>
                          </header>
                          <div className="summary-content">
                            {renderSummaryContent(selectedNote.content)}
                          </div>
                        </article>
                      ) : selectedNoteId === GENERATING_NOTE_ID ? (
                        <article className="summary-document notes-viewer">
                          <header className="document-head">
                            <h3>
                              <Sparkles size={18} />
                              Generating {notesPresetLabel(notesPreset)}...
                            </h3>
                          </header>
                          <div className="summary-content">
                            <p>iMann is generating this note. It will open here and save in the sidebar automatically.</p>
                          </div>
                        </article>
                      ) : (
                        <section className="notes-generator">
                          <section className="ai-prompt-panel">
                            <h3>
                              <Sparkles size={22} />
                              Generate AI notes
                            </h3>
                            <p className="prompt-help">
                              Click a note type. The generated response will open as a new saved note.
                            </p>
                            <div className="prompt-grid">
                              {NOTES_PRESETS.map((preset) => {
                                const isActivePreset = notesPreset === preset.value;
                                const isGeneratingPreset = summaryBusy && isActivePreset;
                                return (
                                  <button
                                    key={preset.value}
                                    type="button"
                                    className={isActivePreset ? "selected" : ""}
                                    disabled={!canGenerateSummary}
                                    onClick={() => generateSummary(preset.value)}
                                    title={
                                      detail.status !== "completed"
                                        ? "Available after transcription is completed"
                                        : isGeneratingPreset
                                          ? "Generating this note type..."
                                          : `Generate ${preset.label}`
                                    }
                                  >
                                    <span>{isGeneratingPreset ? "…" : "✨"}</span>
                                    <strong>{isGeneratingPreset ? "Generating..." : preset.label}</strong>
                                    {preset.tag && <small>{preset.tag}</small>}
                                  </button>
                                );
                              })}
                            </div>
                            {!canGenerateSummary && (
                              <p className="prompt-help">
                                {summaryBusy
                                  ? "AI notes are being generated. The new note will open automatically when ready."
                                  : "AI notes will be available after transcription is completed."}
                              </p>
                            )}
                          </section>

                          {detail.summary_error && <div className="notice error-box inline-error">{detail.summary_error}</div>}
                        </section>
                      )}
                    </section>
                  </section>
                </section>
              )}

              {activeTab === "transcript" && (
                <section className="dashboard-panel">
                <div className="tool-row transcript-cleanup-card">
                  <div>
                    <h3>AI Cleanup</h3>
                    <p>
                      Make the transcript cleaner by reducing repeated captions and improving readability.
                      {" "}
                      Status: {detail.cleanup_status.replace("_", " ")}
                      {detail.cleanup_seconds !== null &&
                        ` · ${formatDuration(detail.cleanup_seconds)}`}
                    </p>
                  </div>
                  <button className="secondary" disabled={!canCleanup} onClick={cleanupTranscript}>
                    <Sparkles size={16} />
                    AI Cleanup
                  </button>
                </div>
                {detail.cleanup_error && <div className="notice error-box inline-error">{detail.cleanup_error}</div>}
                <div className="transcript-head">
                  <div>
                    <h3>{detail.is_live && detail.status === "processing" ? "Live Transcript" : "Transcript"}</h3>
                    {detail.is_live && detail.status === "processing" && (
                      <p className="live-caption-state">
                        Capturing captions. Transcript will appear after Stop.
                      </p>
                    )}
                  </div>
                  <div className="segmented">
                    <button
                      className={transcriptView === "raw" ? "selected" : ""}
                      onClick={() => setTranscriptView("raw")}
                    >
                      Raw
                    </button>
                    <button
                      className={transcriptView === "clean" ? "selected" : ""}
                      disabled={detail.cleaned_segments.length === 0}
                      onClick={() => setTranscriptView("clean")}
                    >
                      Clean
                    </button>
                  </div>
                </div>
                {displayedSegments.length === 0 && (
                  <div className="notice">
                    {detail.status === "processing"
                      ? "Transcription is still running. The transcript will appear after the process is completed."
                      : "Transcript will appear after processing."}
                  </div>
                )}
                <div className="transcript-stream">
                  {displayedSegments.map((segment, index) => (
                    <article className="line" key={`${segment.start}-${index}`}>
                      <div className="meta">
                        <span className="speaker-avatar">{speakerInitials(segment.speaker)}</span>
                        <time>{formatTime(segment.start)}</time>
                      </div>
                      <div className="line-body">
                        <strong>{segment.speaker}</strong>
                        <p>{segment.text}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              )}

              {activeTab === "insights" && (
                <section className="dashboard-panel">
                  <section className="insights-main">
                    <div className="metric">
                      <span>Participants</span>
                      <strong>{participantStats.length || 0}</strong>
                    </div>
                    <div className="metric">
                      <span>Transcript Lines</span>
                      <strong>{insightSegments.length}</strong>
                    </div>
                    <div className="metric">
                      <span>Source</span>
                      <strong>{sourceLabel(detail.source)}</strong>
                    </div>
                    <div className="metric">
                      <span>Cleaned Transcript</span>
                      <strong>{detail.cleaned_segments.length ? "Ready" : "Not yet"}</strong>
                    </div>
                    <article className="insight-note">
                      <h3>Participant detection</h3>
                      <p>
                        Participant stats are calculated from the finalized transcript turns. Generic labels and caption
                        noise are ignored so speaker count stays closer to the real meeting.
                      </p>
                    </article>
                  </section>
                </section>
              )}
              </div>
              <ParticipantsStatsPanel
                participantStats={participantStats}
                participantTotalSeconds={participantTotalSeconds}
                participantDonut={participantDonut}
                processingSeconds={detail.processing_seconds}
              />
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
