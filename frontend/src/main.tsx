import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileAudio, Info, Radio, RefreshCw, Sparkles, Trash2, UploadCloud } from "lucide-react";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

type Meeting = {
  id: number;
  original_filename: string;
  status: "uploaded" | "processing" | "completed" | "failed";
  summary: string | null;
  summary_status: "not_started" | "queued" | "processing" | "completed" | "failed";
  summary_error: string | null;
  summary_preset: NotesPreset | null;
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
};

type NotesPreset = "short" | "detailed" | "citations" | "actions" | "team_sync" | "advice";

type Tab = "notes" | "transcript" | "insights";

type Segment = {
  start: number;
  end: number;
  speaker: string;
  text: string;
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
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [transcriptView, setTranscriptView] = useState<"raw" | "clean">("raw");
  const [activeTab, setActiveTab] = useState<Tab>("notes");
  const [notesPreset, setNotesPreset] = useState<NotesPreset>("short");

  async function loadMeetings() {
    const response = await fetch(`${API_BASE}/api/meetings`);
    const data = (await response.json()) as Meeting[];
    setMeetings(data);
    if (selectedId === null && data.length > 0) {
      setSelectedId(data[0].id);
    }
  }

  async function loadDetail(id: number) {
    const response = await fetch(`${API_BASE}/api/meetings/${id}`);
    setDetail((await response.json()) as MeetingDetail);
  }

  async function upload() {
    if (!file) return;
    setUploading(true);
    setMessage("");
    const form = new FormData();
    form.append("file", file);

    try {
      const response = await fetch(`${API_BASE}/api/meetings`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Upload failed");
      }
      const meeting = (await response.json()) as Meeting;
      setSelectedId(meeting.id);
      setActiveTab("transcript");
      setFile(null);
      await loadMeetings();
      await loadDetail(meeting.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function generateSummary() {
    if (!detail) return;
    setMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/meetings/${detail.id}/summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: notesPreset }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail ?? "Could not start summary generation");
      }
      const meeting = (await response.json()) as Meeting;
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
      const response = await fetch(`${API_BASE}/api/meetings/${detail.id}/cleanup`, {
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

  async function deleteMeeting(meeting: Meeting) {
    const confirmed = window.confirm(`Delete "${meeting.original_filename}"?`);
    if (!confirmed) return;
    setMessage("");

    try {
      const response = await fetch(`${API_BASE}/api/meetings/${meeting.id}`, {
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

  useEffect(() => {
    loadMeetings().catch(() => setMessage("Backend is not reachable."));
  }, []);

  useEffect(() => {
    if (selectedId !== null) {
      loadDetail(selectedId).catch(() => setMessage("Could not load meeting."));
    }
  }, [selectedId]);

  useEffect(() => {
    if (detail && detail.cleaned_segments.length === 0 && transcriptView === "clean") {
      setTranscriptView("raw");
    }
    if (detail?.summary_preset) {
      setNotesPreset(detail.summary_preset);
    }
  }, [detail, transcriptView]);

  useEffect(() => {
    const active =
      detail?.status === "uploaded" ||
      detail?.status === "processing" ||
      detail?.cleanup_status === "queued" ||
      detail?.cleanup_status === "processing" ||
      detail?.summary_status === "queued" ||
      detail?.summary_status === "processing";
    if (!active || selectedId === null) return;

    const timer = window.setInterval(() => {
      loadMeetings().catch(() => undefined);
      loadDetail(selectedId).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [detail?.status, detail?.cleanup_status, detail?.summary_status, selectedId]);

  const speakers = useMemo(() => {
    const names = new Set(detail?.segments.map((segment) => segment.speaker) ?? []);
    return Array.from(names);
  }, [detail]);

  const canGenerateSummary =
    detail?.status === "completed" &&
    detail.summary_status !== "queued" &&
    detail.summary_status !== "processing";

  const canCleanup =
    detail?.status === "completed" &&
    detail.cleanup_status !== "queued" &&
    detail.cleanup_status !== "processing";

  const isTranscriptReady = detail?.status === "completed";

  const displayedSegments =
    isTranscriptReady && transcriptView === "clean" && detail?.cleaned_segments.length
      ? detail.cleaned_segments
      : isTranscriptReady
        ? detail?.segments ?? []
        : [];

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <FileAudio size={24} />
          <div>
            <h1>MOM</h1>
            <p>Meeting transcription</p>
          </div>
        </div>

        <details className="upload-drawer">
          <summary>
            <UploadCloud size={16} />
            Upload recording
          </summary>
          <div className="upload-drawer-body">
            <label className="file-drop compact">
              <UploadCloud size={20} />
              <span>{file ? file.name : "Choose audio/video file"}</span>
              <input
                type="file"
                accept=".mp3,.wav,.mp4,.m4a,audio/*,video/mp4"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <button className="primary" disabled={!file || uploading} onClick={upload}>
              {uploading ? "Uploading..." : "Upload"}
            </button>
            {message && <p className="error">{message}</p>}
          </div>
        </details>

        <div className="list-head">
          <span>Meetings</span>
          <button className="icon-button" title="Refresh" onClick={loadMeetings}>
            <RefreshCw size={16} />
          </button>
        </div>

        <nav className="meeting-list">
          {meetings.map((meeting) => (
            <div
              key={meeting.id}
              className={meeting.id === selectedId ? "meeting active" : "meeting"}
            >
              <button className="meeting-main" onClick={() => setSelectedId(meeting.id)}>
                <span>{meeting.original_filename}</span>
                <small className="meeting-start">{formatMeetingStart(meeting)}</small>
                <small data-status={meeting.status}>
                  {statusLabel(meeting)}
                  {meeting.processing_seconds !== null &&
                    ` · ${formatDuration(meeting.processing_seconds)}`}
                </small>
                {shouldShowMeetingMetaBadge(meeting) && (
                  <span className={meeting.status === "processing" && meeting.is_live ? "live-badge active" : "live-badge"}>
                    {meeting.is_live && (
                      <Radio size={12} />
                    )}
                    {meeting.source ? sourceLabel(meeting.source) : ""}
                    {meeting.source && meeting.segment_count ? " · " : ""}
                    {meeting.segment_count ? `${meeting.segment_count} lines` : ""}
                  </span>
                )}
              </button>
              <button
                className="delete-button"
                title="Delete meeting"
                onClick={() => deleteMeeting(meeting)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {meetings.length === 0 && <p className="empty">No meetings yet.</p>}
        </nav>
      </aside>

      <section className="content">
        {detail && (
          <>
            <header className="detail-head">
              <div>
                <h2>{detail.original_filename}</h2>
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
          </>
        )}

        <nav className="tabs" aria-label="Meeting dashboard">
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

        {!detail && (
          <div className="blank">
            <FileAudio size={36} />
            <p>Select a meeting from the list, or use Upload recording in the sidebar.</p>
          </div>
        )}

        {detail && (
          <>
            {activeTab === "notes" && (
              <section className="dashboard-panel">
                <div className="tool-row">
                  <div>
                    <h3>AI Cleanup</h3>
                    <p>
                      {detail.cleanup_status.replace("_", " ")}
                      {detail.cleanup_seconds !== null &&
                        ` · ${formatDuration(detail.cleanup_seconds)}`}
                    </p>
                  </div>
                  <button className="secondary" disabled={!canCleanup} onClick={cleanupTranscript}>
                    <Sparkles size={16} />
                    AI Cleanup
                  </button>
                </div>
                {detail.cleanup_error && <div className="notice error-box">{detail.cleanup_error}</div>}

                <div className="notes-builder">
                  <label>
                    <span>AI Notes Preset</span>
                    <select
                      value={notesPreset}
                      onChange={(event) => setNotesPreset(event.target.value as NotesPreset)}
                    >
                      {NOTES_PRESETS.map((preset) => (
                        <option key={preset.value} value={preset.value}>
                          {preset.label}{preset.tag ? ` [${preset.tag}]` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="primary inline" disabled={!canGenerateSummary} onClick={generateSummary}>
                    <Sparkles size={16} />
                    Generate Notes
                  </button>
                </div>

                <section className="summary">
                  <div className="summary-head">
                    <div>
                      <h3>Notes</h3>
                      <p>
                        {detail.summary_status.replace("_", " ")}
                        {detail.summary_preset && ` · ${detail.summary_preset}`}
                        {detail.summary_seconds !== null &&
                          ` · ${formatDuration(detail.summary_seconds)}`}
                      </p>
                    </div>
                  </div>
                  {detail.summary_error && <div className="notice error-box">{detail.summary_error}</div>}
                  <pre>
                    {detail.summary ??
                      (detail.summary_status === "processing" || detail.summary_status === "queued"
                        ? "Generating notes..."
                        : "Choose a preset and generate notes after transcription is completed.")}
                  </pre>
                </section>
              </section>
            )}

            {activeTab === "transcript" && (
              <section className="dashboard-panel">
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
                {displayedSegments.map((segment, index) => (
                  <article className="line" key={`${segment.start}-${index}`}>
                    <div className="meta">
                      <span>{segment.speaker}</span>
                      <time>
                        {formatTime(segment.start)} - {formatTime(segment.end)}
                      </time>
                    </div>
                    <p>{segment.text}</p>
                  </article>
                ))}
              </section>
            )}

            {activeTab === "insights" && (
              <section className="dashboard-panel insights-grid">
                <div className="metric">
                  <span>Speakers</span>
                  <strong>{speakers.length || 0}</strong>
                </div>
                <div className="metric">
                  <span>Raw Segments</span>
                  <strong>{detail.segments.length}</strong>
                </div>
                <div className="metric">
                  <span>Source</span>
                  <strong>{sourceLabel(detail.source)}</strong>
                </div>
                <div className="metric">
                  <span>Cleaned</span>
                  <strong>{detail.cleaned_segments.length ? "Yes" : "No"}</strong>
                </div>
                <div className="metric">
                  <span>Notes Preset</span>
                  <strong>{detail.summary_preset ?? "--"}</strong>
                </div>
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
